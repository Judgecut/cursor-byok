//! Synchronizes complete USD exchange-rate snapshots for display.
use std::{collections::BTreeMap, sync::{Arc, atomic::{AtomicU64, Ordering}}, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{Mutex, Notify};
use tokio_util::sync::CancellationToken;

use crate::{network::NetworkClients, store::{normalize_exchange_rate, now_ms, Store}, Error, Result};

const CURRENCIES: [&str; 6] = ["CNY", "EUR", "JPY", "TWD", "TRY", "KRW"];
const EXCHANGE_RATE_API: &str = "https://open.er-api.com/v6/latest/USD";
const FLOAT_RATES_API: &str = "https://www.floatrates.com/daily/usd.json";
const SYNC_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_RESPONSE_BYTES: usize = 128 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExchangeRateSource
{
    ExchangeRateApi,
    FloatRates,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ExchangeRateSnapshot
{
    pub source: ExchangeRateSource,
    pub published_at_ms: i64,
    pub rates: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct ExchangeRateSyncMeta
{
    pub auto_sync_enabled: bool,
    pub snapshot: Option<ExchangeRateSnapshot>,
    pub last_attempted_at_ms: Option<i64>,
    pub last_synced_at_ms: Option<i64>,
    pub last_error: Option<String>,
}

impl Default for ExchangeRateSyncMeta
{
    fn default() -> Self
    {
        Self {
            auto_sync_enabled: true,
            snapshot: None,
            last_attempted_at_ms: None,
            last_synced_at_ms: None,
            last_error: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct ExchangeRateSyncState
{
    #[serde(flatten)]
    meta: ExchangeRateSyncMeta,
    syncing: bool,
}

#[derive(Clone)]
pub struct ExchangeRateService
{
    inner: Arc<ExchangeRateServiceInner>,
}

struct ExchangeRateServiceInner
{
    store: Store,
    clients: NetworkClients,
    sources: [(ExchangeRateSource, String); 2],
    gate: Mutex<()>,
    completed: AtomicU64,
    changed: Notify,
    shutdown: CancellationToken,
}

impl ExchangeRateService
{
    pub fn new(store: Store, clients: NetworkClients) -> Self
    {
        Self::with_sources(store, clients, EXCHANGE_RATE_API, FLOAT_RATES_API)
    }

    fn with_sources(store: Store, clients: NetworkClients, primary: &str, secondary: &str) -> Self
    {
        Self { inner: Arc::new(ExchangeRateServiceInner {
            store, clients,
            sources: [(ExchangeRateSource::ExchangeRateApi, primary.into()), (ExchangeRateSource::FloatRates, secondary.into())],
            gate: Mutex::new(()),
            completed: AtomicU64::new(0),
            changed: Notify::new(),
            shutdown: CancellationToken::new(),
        }) }
    }

    pub fn start(&self, shutdown: CancellationToken)
    {
        let service = self.clone();
        tokio::spawn(async move
        {
            tokio::select! {
                () = shutdown.cancelled() => service.inner.shutdown.cancel(),
                () = service.run_background() => {}
            }
        });
    }

    pub async fn status(&self) -> Result<ExchangeRateSyncState>
    {
        let meta = self.inner.store.exchange_rate_sync_meta().await?;
        Ok(ExchangeRateSyncState { meta, syncing: self.inner.gate.try_lock().is_err() })
    }

    pub async fn set_auto_sync(&self, enabled: bool) -> Result<ExchangeRateSyncState>
    {
        self.inner.store.update_exchange_rate_sync_meta(|meta| meta.auto_sync_enabled = enabled).await?;
        self.inner.changed.notify_one();
        self.status().await
    }

    pub async fn sync_now(&self) -> Result<ExchangeRateSyncState>
    {
        self.sync(false).await?;
        self.status().await
    }

    async fn run_background(&self)
    {
        loop
        {
            let wait = match self.inner.store.exchange_rate_sync_meta().await
            {
                Ok(meta) => next_sync_delay(&meta, now_ms()),
                Err(error) =>
                {
                    tracing::warn!(%error, "could not read exchange rate sync settings");
                    Some(SYNC_INTERVAL)
                }
            };
            if let Some(wait) = wait
            {
                tokio::select! {
                    () = self.inner.changed.notified() => continue,
                    () = tokio::time::sleep(wait) => {}
                }
                if let Err(error) = self.sync(true).await
                {
                    tracing::warn!(%error, "could not update the exchange rate cache");
                    tokio::select! {
                        () = self.inner.changed.notified() => {}
                        () = tokio::time::sleep(SYNC_INTERVAL) => {}
                    }
                }
            }
            else
            {
                self.inner.changed.notified().await;
            }
        }
    }

    async fn sync(&self, automatic: bool) -> Result<()>
    {
        let observed = self.inner.completed.load(Ordering::Acquire);
        let guard = tokio::select! {
            () = self.inner.shutdown.cancelled() => return Err(Error::Cancelled),
            guard = self.inner.gate.lock() => guard,
        };
        if self.inner.completed.load(Ordering::Acquire) != observed
        {
            return Ok(());
        }
        let meta = self.inner.store.exchange_rate_sync_meta().await?;
        let attempted_at = now_ms();
        if automatic && next_sync_delay(&meta, attempted_at) != Some(Duration::ZERO)
        {
            return Ok(());
        }

        let minimum_date = meta.snapshot.as_ref().map_or(0, |snapshot| snapshot.published_at_ms);
        let result = tokio::select! {
            () = self.inner.shutdown.cancelled() => return Err(Error::Cancelled),
            result = self.fetch(minimum_date) => result,
        };
        self.inner.store.update_exchange_rate_sync_meta(|meta|
        {
            meta.last_attempted_at_ms = Some(attempted_at);
            match result
            {
                Ok(snapshot) if meta.snapshot.as_ref().is_none_or(|cached| snapshot.published_at_ms >= cached.published_at_ms) =>
                {
                    meta.snapshot = Some(snapshot);
                    meta.last_synced_at_ms = Some(now_ms());
                    meta.last_error = None;
                }
                Ok(_) => meta.last_error = Some("Response is older than the cached rates".into()),
                Err(error) => meta.last_error = Some(error),
            }
        }).await?;
        self.inner.completed.fetch_add(1, Ordering::Release);
        drop(guard);
        self.inner.changed.notify_one();
        Ok(())
    }

    async fn fetch(&self, minimum_date: i64) -> std::result::Result<ExchangeRateSnapshot, String>
    {
        let client = self.inner.clients.default_client().await.map_err(|_| "Could not initialize the network client".to_owned())?;
        let mut failures = Vec::new();
        for (source, url) in &self.inner.sources
        {
            match fetch_source(&client, *source, url).await
            {
                Ok(snapshot) if snapshot.published_at_ms >= minimum_date => return Ok(snapshot),
                Ok(_) => failures.push(format!("{source:?}: older than the cached rates")),
                Err(reason) => failures.push(format!("{source:?}: {reason}")),
            }
        }
        Err(failures.join(" · "))
    }
}

fn next_sync_delay(meta: &ExchangeRateSyncMeta, now: i64) -> Option<Duration>
{
    if !meta.auto_sync_enabled
    {
        return None;
    }
    let elapsed = meta.last_attempted_at_ms.map_or(SYNC_INTERVAL, |last| Duration::from_millis(now.saturating_sub(last).max(0) as u64));
    Some(SYNC_INTERVAL.saturating_sub(elapsed))
}

async fn fetch_source(client: &reqwest::Client, source: ExchangeRateSource, url: &str) -> std::result::Result<ExchangeRateSnapshot, String>
{
    let mut response = client.get(url).timeout(REQUEST_TIMEOUT).send().await.map_err(|_| "request failed".to_owned())?;
    if !response.status().is_success()
    {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "could not read the response".to_owned())?
    {
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES
        {
            return Err("response is too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    parse_snapshot(source, &body, now_ms()).ok_or_else(|| "incomplete or invalid USD rate snapshot".into())
}

fn parse_snapshot(source: ExchangeRateSource, body: &[u8], now: i64) -> Option<ExchangeRateSnapshot>
{
    let payload: Value = serde_json::from_slice(body).ok()?;
    let published_at_ms = match source
    {
        ExchangeRateSource::ExchangeRateApi =>
        {
            if payload["result"].as_str()? != "success" || payload["base_code"].as_str()? != "USD"
            {
                return None;
            }
            payload["time_last_update_unix"].as_i64()?.checked_mul(1000)?
        }
        ExchangeRateSource::FloatRates => CURRENCIES.iter().map(|currency|
        {
            let row = &payload[currency.to_ascii_lowercase()];
            let date = chrono::DateTime::parse_from_rfc2822(row["date"].as_str()?).ok()?.timestamp_millis();
            valid_timestamp(date, now).then_some(date)
        }).collect::<Option<Vec<_>>>()?.into_iter().min()?,
    };
    if !valid_timestamp(published_at_ms, now)
    {
        return None;
    }
    let mut rates = BTreeMap::new();
    for currency in CURRENCIES
    {
        let rate = match source
        {
            ExchangeRateSource::ExchangeRateApi => &payload["rates"][currency],
            ExchangeRateSource::FloatRates => &payload[currency.to_ascii_lowercase()]["rate"],
        };
        let rate = match rate
        {
            Value::Number(number) => normalize_exchange_rate(&number.to_string()).ok()??,
            Value::String(text) => normalize_exchange_rate(text).ok()??,
            _ => return None,
        };
        rates.insert(currency.into(), rate);
    }
    Some(ExchangeRateSnapshot { source, published_at_ms, rates })
}

fn valid_timestamp(timestamp: i64, now: i64) -> bool
{
    timestamp > 0 && timestamp <= now.saturating_add(5 * 60 * 1000)
}

#[cfg(test)]
mod tests
{
    use super::*;
    use axum::{extract::State, routing::get, Json, Router};
    use serde_json::json;
    use std::sync::atomic::AtomicBool;

    #[derive(Default)]
    struct Feeds
    {
        primary: Mutex<Value>,
        fallback: Mutex<Value>,
        primary_count: AtomicU64,
        fallback_count: AtomicU64,
        hold_primary: AtomicBool,
        requested: Notify,
        release: Notify,
    }

    async fn primary(State(feeds): State<Arc<Feeds>>) -> Json<Value>
    {
        feeds.primary_count.fetch_add(1, Ordering::Relaxed);
        feeds.requested.notify_one();
        if feeds.hold_primary.load(Ordering::Acquire)
        {
            feeds.release.notified().await;
        }
        Json(feeds.primary.lock().await.clone())
    }

    async fn fallback(State(feeds): State<Arc<Feeds>>) -> Json<Value>
    {
        feeds.fallback_count.fetch_add(1, Ordering::Relaxed);
        Json(feeds.fallback.lock().await.clone())
    }

    async fn mock_feeds(store: Store) -> (ExchangeRateService, Arc<Feeds>, tokio::task::JoinHandle<()>)
    {
        let feeds = Arc::new(Feeds::default());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = Router::new().route("/primary", get(primary)).route("/fallback", get(fallback)).with_state(feeds.clone());
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let service = ExchangeRateService::with_sources(store.clone(), NetworkClients::new(store), &format!("http://{address}/primary"), &format!("http://{address}/fallback"));
        (service, feeds, task)
    }

    fn main_batch(published: i64) -> Value
    {
        json!({ "result": "success", "base_code": "USD", "time_last_update_unix": published / 1000, "rates": { "CNY": 6.67, "EUR": 0.91, "JPY": 158, "TWD": 32.9, "TRY": 50.5, "KRW": 1339.44 } })
    }

    fn backup_batch(published: i64) -> Value
    {
        let date = chrono::DateTime::from_timestamp_millis(published).unwrap().to_rfc2822();
        Value::Object(CURRENCIES.iter().map(|currency| (currency.to_ascii_lowercase(), json!({ "rate": "7.0500", "date": date }))).collect())
    }

    #[tokio::test]
    async fn keeps_complete_snapshots_across_fallback_failure_and_reopen()
    {
        let directory = tempfile::tempdir().unwrap();
        let url = format!("sqlite://{}", directory.path().join("rates.db").display());
        let store = Store::connect(&url).await.unwrap();
        let (service, feeds, server) = mock_feeds(store).await;
        let now = now_ms();
        *feeds.primary.lock().await = main_batch(now - 90_000);

        assert!(service.status().await.unwrap().meta.auto_sync_enabled);
        let first = service.sync_now().await.unwrap().meta;
        assert_eq!(first.snapshot.unwrap().source, ExchangeRateSource::ExchangeRateApi);
        assert_eq!(feeds.fallback_count.load(Ordering::Relaxed), 0);

        feeds.primary.lock().await["rates"].as_object_mut().unwrap().remove("TWD");
        *feeds.fallback.lock().await = backup_batch(now - 45_000);
        let second = service.sync_now().await.unwrap().meta;
        let cached = second.snapshot.unwrap();
        assert_eq!(cached.source, ExchangeRateSource::FloatRates);
        assert_eq!(cached.rates.len(), 6);
        assert_eq!(cached.rates["TWD"], "7.05");

        *feeds.primary.lock().await = main_batch(now - 120_000);
        feeds.fallback.lock().await["jpy"]["rate"] = json!("0");
        let failure = service.sync_now().await.unwrap().meta;
        assert_eq!(failure.last_synced_at_ms, second.last_synced_at_ms);
        assert!(failure.last_error.unwrap().contains("older"));
        assert_eq!(failure.snapshot.unwrap().rates, cached.rates);

        service.set_auto_sync(false).await.unwrap();
        drop(service);
        let reopened = Store::connect(&url).await.unwrap().exchange_rate_sync_meta().await.unwrap();
        assert!(!reopened.auto_sync_enabled);
        assert_eq!(reopened.snapshot.unwrap().published_at_ms, cached.published_at_ms);
        assert_eq!(reopened.last_synced_at_ms, second.last_synced_at_ms);
        assert!(reopened.last_error.is_some());
        server.abort();
    }

    #[tokio::test]
    async fn shares_startup_sync_with_manual_request_and_stops_scheduling_when_disabled()
    {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        let (service, feeds, server) = mock_feeds(store).await;
        *feeds.primary.lock().await = main_batch(now_ms());
        feeds.hold_primary.store(true, Ordering::Release);
        let shutdown = CancellationToken::new();
        service.start(shutdown.clone());
        tokio::time::timeout(Duration::from_secs(4), feeds.requested.notified()).await.unwrap();
        assert!(service.status().await.unwrap().syncing);

        assert!(!service.set_auto_sync(false).await.unwrap().meta.auto_sync_enabled);
        let request = service.sync_now();
        tokio::pin!(request);
        assert!(futures_util::poll!(&mut request).is_pending());
        feeds.hold_primary.store(false, Ordering::Release);
        feeds.release.notify_one();
        let finished = request.await.unwrap();
        assert!(finished.meta.snapshot.is_some());
        assert_eq!(feeds.primary_count.load(Ordering::Relaxed), 1);
        assert!(!finished.meta.auto_sync_enabled);
        assert_eq!(next_sync_delay(&finished.meta, now_ms()), None);

        assert!(service.sync_now().await.unwrap().meta.snapshot.is_some());
        assert_eq!(feeds.primary_count.load(Ordering::Relaxed), 2);
        shutdown.cancel();
        server.abort();
    }

    #[test]
    fn honors_the_daily_interval_and_rejects_invalid_publication_times()
    {
        let now = now_ms();
        let meta = ExchangeRateSyncMeta { last_attempted_at_ms: Some(now - 60_000), ..Default::default() };
        assert_eq!(next_sync_delay(&meta, now), Some(SYNC_INTERVAL - Duration::from_secs(60)));
        assert_eq!(next_sync_delay(&meta, now + 24 * 60 * 60 * 1000), Some(Duration::ZERO));
        let future = main_batch(now + 24 * 60 * 60 * 1000);
        assert!(parse_snapshot(ExchangeRateSource::ExchangeRateApi, future.to_string().as_bytes(), now).is_none());
        let mut float_rates = backup_batch(now);
        float_rates["cny"]["date"] = json!("Fri, 20 Nov 2026 23:59:00 GMT");
        assert!(chrono::DateTime::parse_from_rfc2822(float_rates["cny"]["date"].as_str().unwrap()).is_ok());
    }
}
