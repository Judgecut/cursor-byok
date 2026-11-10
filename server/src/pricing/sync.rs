//! Background & on-demand catalog synchronization with single-flight locking and clean shutdown.
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, Notify};
use tokio_util::sync::CancellationToken;

use crate::{network::NetworkClients, store::Store, Error, Result};

use super::{backfill::run_backfill_once, matcher::parse_models_dev_catalog};

pub const DEFAULT_MODELS_DEV_URL: &str = "https://models.dev/api.json";
pub const DEFAULT_SYNC_INTERVAL_HOURS: i64 = 6;
const SYNC_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const SYNC_HTTP_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PricingSyncState {
    pub auto_sync_enabled: bool,
    pub sync_interval_hours: i64,
    pub catalog_model_count: i64,
    pub last_attempted_at_ms: Option<i64>,
    pub last_synced_at_ms: Option<i64>,
    pub last_error: Option<String>,
    pub syncing: bool,
    pub backfilling: bool,
}

#[derive(Clone)]
pub struct PricingService {
    store: Store,
    clients: NetworkClients,
    catalog_url: String,
    sync_lock: Arc<Mutex<()>>,
    backfill_lock: Arc<Mutex<()>>,
    syncing: Arc<AtomicBool>,
    backfilling: Arc<AtomicBool>,
    backfill_pending: Arc<AtomicBool>,
    backfill_notify: Arc<Notify>,
}

struct ResetBoolOnDrop<'a>(&'a AtomicBool);

impl Drop for ResetBoolOnDrop<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl PricingService {
    pub fn new(store: Store, clients: NetworkClients) -> Self {
        Self::with_catalog_url(store, clients, DEFAULT_MODELS_DEV_URL)
    }

    pub fn with_catalog_url(
        store: Store,
        clients: NetworkClients,
        catalog_url: impl Into<String>,
    ) -> Self {
        Self {
            store,
            clients,
            catalog_url: catalog_url.into(),
            sync_lock: Arc::new(Mutex::new(())),
            backfill_lock: Arc::new(Mutex::new(())),
            syncing: Arc::new(AtomicBool::new(false)),
            backfilling: Arc::new(AtomicBool::new(false)),
            backfill_pending: Arc::new(AtomicBool::new(false)),
            backfill_notify: Arc::new(Notify::new()),
        }
    }

    /// Starts server-owned background sync (6-hour cadence) and historical backfill workers,
    /// cancelling both when the server shuts down.
    pub fn start(&self, shutdown: CancellationToken) {
        self.trigger_backfill();
        let sync_service = self.clone();
        let sync_shutdown = shutdown.clone();
        tokio::spawn(async move {
            sync_service.run_sync_loop(sync_shutdown).await;
        });

        let backfill_service = self.clone();
        tokio::spawn(async move {
            backfill_service.run_backfill_loop(shutdown).await;
        });
    }

    pub async fn status(&self) -> Result<PricingSyncState> {
        let mut state = self.store.pricing_sync_state().await?;
        state.syncing = self.syncing.load(Ordering::Acquire);
        state.backfilling = self.backfilling.load(Ordering::Acquire)
            || self.backfill_pending.load(Ordering::SeqCst);
        Ok(state)
    }

    pub async fn set_auto_sync(&self, enabled: bool) -> Result<PricingSyncState> {
        self.store.set_pricing_auto_sync(enabled).await?;
        self.status().await
    }

    pub async fn sync_now(&self) -> Result<PricingSyncState> {
        let _guard = self.sync_lock.lock().await;
        self.sync_once_locked(&CancellationToken::new()).await?;
        self.trigger_backfill_oneshot();
        self.status().await
    }

    pub async fn backfill_now(&self) -> Result<usize> {
        let shutdown = CancellationToken::new();
        let guard = self.backfill_lock.lock().await;
        let mut total = self
            .drain_backfill_with_guard(guard, &shutdown, true)
            .await?;
        while self.backfill_pending.load(Ordering::SeqCst) {
            let guard = self.backfill_lock.lock().await;
            total += self
                .drain_backfill_with_guard(guard, &shutdown, false)
                .await?;
        }
        Ok(total)
    }

    pub fn trigger_backfill(&self) {
        self.backfill_pending.store(true, Ordering::SeqCst);
        self.backfill_notify.notify_one();
    }

    /// Triggers coalesced background backfill even when `start()` was not invoked (e.g. standalone router tests).
    pub fn trigger_backfill_oneshot(&self) {
        self.trigger_backfill();
        let service = self.clone();
        tokio::spawn(async move {
            let _ = service
                .run_pending_backfill(&CancellationToken::new())
                .await;
        });
    }

    async fn run_sync_loop(&self, shutdown: CancellationToken) {
        loop {
            if shutdown.is_cancelled() {
                return;
            }
            let wait_duration = match self.store.pricing_sync_state().await {
                Ok(state) if state.auto_sync_enabled => {
                    let now = crate::store::now_ms();
                    match state.last_synced_at_ms {
                        None => Duration::ZERO,
                        Some(last) => {
                            let elapsed_ms = now.saturating_sub(last).max(0) as u64;
                            let interval_ms = SYNC_INTERVAL.as_millis() as u64;
                            if elapsed_ms >= interval_ms {
                                Duration::ZERO
                            } else {
                                Duration::from_millis(interval_ms - elapsed_ms)
                            }
                        }
                    }
                }
                _ => SYNC_INTERVAL,
            };

            if !wait_duration.is_zero() {
                tokio::select! {
                    () = shutdown.cancelled() => return,
                    () = tokio::time::sleep(wait_duration) => {}
                }
            }

            if shutdown.is_cancelled() {
                return;
            }

            if let Ok(state) = self.store.pricing_sync_state().await {
                if state.auto_sync_enabled {
                    let _guard = self.sync_lock.lock().await;
                    match self.sync_once_locked(&shutdown).await {
                        Ok(()) => self.trigger_backfill(),
                        Err(Error::Cancelled) => return,
                        Err(error) => {
                            tracing::warn!(%error, "background model pricing catalog sync failed");
                        }
                    }
                }
            }

            tokio::select! {
                () = shutdown.cancelled() => return,
                () = tokio::time::sleep(SYNC_INTERVAL) => {}
            }
        }
    }

    async fn run_backfill_loop(&self, shutdown: CancellationToken) {
        loop {
            if self.backfill_pending.load(Ordering::SeqCst) {
                let guard = tokio::select! {
                    () = shutdown.cancelled() => return,
                    guard = self.backfill_lock.lock() => guard,
                };
                if let Err(error) = self
                    .drain_backfill_with_guard(guard, &shutdown, false)
                    .await
                {
                    tracing::warn!(%error, "background historical cost backfill failed");
                }
                continue;
            }
            tokio::select! {
                () = shutdown.cancelled() => return,
                () = self.backfill_notify.notified() => {}
            }
        }
    }

    async fn run_pending_backfill(&self, shutdown: &CancellationToken) -> Result<usize> {
        let mut total = 0usize;
        while !shutdown.is_cancelled() && self.backfill_pending.load(Ordering::SeqCst) {
            let Ok(guard) = self.backfill_lock.try_lock() else {
                return Ok(total);
            };
            total += self
                .drain_backfill_with_guard(guard, shutdown, false)
                .await?;
        }
        Ok(total)
    }

    async fn drain_backfill_with_guard(
        &self,
        _guard: tokio::sync::MutexGuard<'_, ()>,
        shutdown: &CancellationToken,
        force_first: bool,
    ) -> Result<usize> {
        self.backfilling.store(true, Ordering::Release);
        let _reset = ResetBoolOnDrop(&self.backfilling);

        let mut total = 0usize;
        if force_first && !shutdown.is_cancelled() {
            self.backfill_pending.store(false, Ordering::SeqCst);
            total += run_backfill_once(&self.store, shutdown).await?;
        }
        while !shutdown.is_cancelled() && self.backfill_pending.swap(false, Ordering::SeqCst) {
            total += run_backfill_once(&self.store, shutdown).await?;
        }
        Ok(total)
    }

    async fn sync_once_locked(&self, shutdown: &CancellationToken) -> Result<()> {
        struct ResetSyncing<'a>(&'a AtomicBool);
        impl Drop for ResetSyncing<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }

        self.syncing.store(true, Ordering::Release);
        let _reset = ResetSyncing(&self.syncing);
        let attempted_at_ms = crate::store::now_ms();

        let fetch_result = async {
            let client = self.clients.default_client().await?;
            let response = tokio::select! {
                () = shutdown.cancelled() => return Err(Error::Cancelled),
                result = client.get(&self.catalog_url).timeout(SYNC_HTTP_TIMEOUT).send() => result?,
            };
            let status = response.status();
            if !status.is_success() {
                let message = response.text().await.unwrap_or_default();
                return Err(Error::Provider(format!(
                    "models.dev returned HTTP {status}: {}",
                    message.chars().take(200).collect::<String>()
                )));
            }
            let bytes = tokio::select! {
                () = shutdown.cancelled() => return Err(Error::Cancelled),
                result = response.bytes() => result?,
            };
            let synced_at_ms = crate::store::now_ms();
            let entries = parse_models_dev_catalog(&bytes, synced_at_ms)?;
            self.store
                .replace_pricing_catalog(&entries, attempted_at_ms, synced_at_ms)
                .await
        }
        .await;

        match fetch_result {
            Ok(()) => Ok(()),
            Err(Error::Cancelled) => Err(Error::Cancelled),
            Err(error) => {
                let _ = self
                    .store
                    .record_pricing_sync_failure(attempted_at_ms, &error.to_string())
                    .await;
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        model::{NewLlmCall, ProviderType, Usage},
        pricing::{BindingMode, PricingRates, SourceKind},
        store::SaveSupplierPricingInput,
    };

    async fn temp_store() -> (tempfile::TempDir, Store) {
        let directory = tempfile::tempdir().unwrap();
        let url = format!("sqlite://{}", directory.path().join("test.db").display());
        let store = Store::connect(&url).await.unwrap();
        store.set_pricing_auto_sync(false).await.unwrap();
        (directory, store)
    }

    async fn insert_finished_unpriced_call(store: &Store, call_id: &str, endpoint: &str) {
        store
            .start_llm_call(&NewLlmCall {
                call_id: call_id.into(),
                run_id: "r-sync-test".into(),
                conversation_id: "c-sync-test".into(),
                provider_call_index: 0,
                model_hash: "mh-sync".into(),
                provider_type: ProviderType::OpenAiResponses,
                provider_url: endpoint.into(),
                request_type: ProviderType::OpenAiResponses,
                request_url: endpoint.into(),
                model_id: "gpt-4o".into(),
                display_name: "GPT-4o".into(),
                reasoning_effort: None,
                fast: false,
                message_count: 1,
                tool_count: 0,
                detailed: false,
                origin: crate::model::CallOrigin::Run,
                streaming: true,
            })
            .await
            .unwrap();
        store
            .record_llm_usage(
                call_id,
                Usage {
                    input_tokens: Some(1_000_000),
                    output_tokens: Some(250_000),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        store
            .finish_llm_call(
                call_id,
                crate::store::CallFinish {
                    status: "completed",
                    finish_reason: Some("stop"),
                    elapsed_ms: 10,
                    generation_ms: None,
                    error_kind: None,
                    error_message: None,
                },
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn trigger_is_retained_while_backfill_lock_busy_and_drains_on_release() {
        let (_dir, store) = temp_store().await;
        let pricing = PricingService::with_catalog_url(
            store.clone(),
            NetworkClients::new(store.clone()),
            "http://127.0.0.1:1/unused",
        );
        let endpoint = "https://api.openai.com/v1/responses";
        insert_finished_unpriced_call(&store, "busy-backfill-call", endpoint).await;

        let lock_guard = pricing.backfill_lock.lock().await;
        let shutdown = CancellationToken::new();
        pricing.start(shutdown.clone());
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(pricing.backfill_pending.load(Ordering::SeqCst));

        // Simulate saving updated rates while the backfill lock is still held.
        store
            .save_supplier_pricing_config(
                &SaveSupplierPricingInput {
                    source_kind: SourceKind::Builtin,
                    endpoint_key: endpoint.into(),
                    model_id: "gpt-4o".into(),
                    binding_mode: BindingMode::Auto,
                    catalog_provider_id: None,
                    catalog_model_id: None,
                    custom_rates: PricingRates {
                        input_per_million: Some("3".into()),
                        output_per_million: Some("6".into()),
                        ..Default::default()
                    },
                },
                &[],
            )
            .await
            .unwrap();
        pricing.trigger_backfill_oneshot();
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(pricing.backfill_pending.load(Ordering::SeqCst));
        assert!(pricing.status().await.unwrap().backfilling);

        drop(lock_guard);

        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            let call = store
                .llm_call("busy-backfill-call")
                .await
                .unwrap()
                .expect("call exists");
            if call.cost_status.as_deref() == Some("priced") {
                assert_eq!(call.total_cost.as_deref(), Some("4.5"));
                assert!(call.cost_backfilled);
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for background backfill after lock release"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(!pricing.backfill_pending.load(Ordering::SeqCst));
        shutdown.cancel();
    }

    #[tokio::test]
    async fn standalone_oneshot_trigger_preserves_pending_flag_until_drained() {
        let (_dir, store) = temp_store().await;
        let pricing = PricingService::with_catalog_url(
            store.clone(),
            NetworkClients::new(store.clone()),
            "http://127.0.0.1:1/unused",
        );
        let endpoint = "https://api.openai.com/v1/responses";
        insert_finished_unpriced_call(&store, "oneshot-busy-call", endpoint).await;

        let lock_guard = pricing.backfill_lock.lock().await;
        store
            .save_supplier_pricing_config(
                &SaveSupplierPricingInput {
                    source_kind: SourceKind::Builtin,
                    endpoint_key: endpoint.into(),
                    model_id: "gpt-4o".into(),
                    binding_mode: BindingMode::Auto,
                    catalog_provider_id: None,
                    catalog_model_id: None,
                    custom_rates: PricingRates {
                        input_per_million: Some("4".into()),
                        output_per_million: Some("8".into()),
                        ..Default::default()
                    },
                },
                &[],
            )
            .await
            .unwrap();
        pricing.trigger_backfill_oneshot();
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(pricing.backfill_pending.load(Ordering::SeqCst));

        drop(lock_guard);

        let drained = pricing
            .run_pending_backfill(&CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(drained, 1);
        assert!(!pricing.backfill_pending.load(Ordering::SeqCst));
        let call = store.llm_call("oneshot-busy-call").await.unwrap().unwrap();
        assert_eq!(call.cost_status.as_deref(), Some("priced"));
        assert_eq!(call.total_cost.as_deref(), Some("6"));
    }
}
