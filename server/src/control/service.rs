//! Implements control API routing and shared state.
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
    time::Instant,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;
use reqwest::header::{HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use url::Url;

use super::ads::{
    AdDismissalInput, AdRuntime, ADS_ENDPOINT, APP_VERSION_HEADER, DEVICE_ID_HEADER,
    DISABLED_AD_IDS_HEADER, LANGUAGE_HEADER, OS_HEADER,
};

use crate::{
    exchange_rates::ExchangeRateService,
    local_app::CursorHarness,
    model::{
        evaluate as evaluate_performance, CallOrigin, ContentPart, CursorRunTraceArtifact,
        CursorRunTraceSummary, LlmCallRequest, LlmCallResponseChunk, LlmCallSummary, ModelConfig,
        ModelConfigInput, ModelInvocation, ModelRequest, ModelSpec, Overview, ProjectedContent,
        ProjectedMessage, PromptSpec, ProviderConfig, ProviderConfigInput, RequestFormat, Role,
        SpeedSample, SpeedStatus, SpeedUnavailableReason,
    },
    plugin::{PluginDescriptor, PluginRegistry, PluginRuntime, PluginRuntimeStatus},
    pricing::{PricingService, PricingSyncState},
    provider::{ModelEvent, Provider},
    store::{
        normalize_string_array_filter, pricing::PricingSettings, CallFinish, CatalogSearchResult,
        CommitSettings, DesktopSettings, ExternalApiSettings, InterfaceSettings,
        InterfaceSettingsPatch, LlmCallFilter, PortSettings, ProxySettings, ProxySettingsInput,
        SaveSupplierPricingInput, StatisticsStorage, Store, SupplierPricingView, TabSettings,
        TimelineCallRef,
    },
    Error, Result,
};

#[derive(Clone)]
pub struct ControlService {
    store: Store,
    cursor_harness: CursorHarness,
    provider: Arc<dyn Provider>,
    plugin_runtime: PluginRuntime,
    plugins: PluginRegistry,
    pricing: PricingService,
    exchange_rates: ExchangeRateService,
    clients: crate::network::NetworkClients,
    app_version: String,
    model_tests: Arc<Mutex<BTreeMap<String, CancellationToken>>>,
}

#[derive(Clone, Debug, Serialize)]
pub struct DiscoveredModels {
    pub models: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct LegacyModelImportResult {
    pub imported: usize,
    pub skipped: usize,
    pub total: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct LegacyModelImportPreview {
    pub source: String,
    pub total: usize,
    pub new_models: usize,
    pub existing_models: usize,
    pub models: Vec<LegacyModelImportPreviewItem>,
}

#[derive(Clone, Debug, Serialize)]
pub struct LegacyModelImportPreviewItem {
    pub model_hash: String,
    pub display_name: String,
    pub model_id: String,
    pub request_format: RequestFormat,
    pub existing: bool,
}

fn empty_json_object_ref() -> &'static serde_json::Value {
    static EMPTY: std::sync::OnceLock<serde_json::Value> = std::sync::OnceLock::new();
    EMPTY.get_or_init(|| serde_json::json!({}))
}

#[derive(Clone, Debug, Serialize)]
pub struct ModelConnectivityResult {
    pub duration_ms: u64,
    /// Time between the first and last visible output events.
    pub generation_ms: Option<u64>,
    pub first_output_ms: Option<u64>,
    pub output_tokens: Option<u64>,
    pub overall_tokens_per_second: Option<f64>,
    pub overall_reason: Option<SpeedUnavailableReason>,
    pub tokens_per_second: Option<f64>,
    pub speed_status: SpeedStatus,
    /// Why no rate is reported, when the test passed but produced no sample.
    pub speed_reason: Option<SpeedUnavailableReason>,
    pub output: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct CallDetail {
    pub call: CallSummary,
    pub request: Option<LlmCallRequest>,
    pub response_chunks: Vec<LlmCallResponseChunk>,
    pub cursor_trace: Option<CursorTraceDetail>,
}

#[derive(Clone, Debug, Serialize)]
pub struct CallListResult {
    pub items: Vec<CallSummary>,
    pub total: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct CallSummary {
    #[serde(flatten)]
    pub call: LlmCallSummary,
    pub call_kind: &'static str,
    pub route: &'static str,
}

#[derive(Clone, Debug, Serialize)]
pub struct CursorTraceDetail {
    pub trace: CursorRunTraceSummary,
    pub artifacts: Vec<CursorTraceArtifactDetail>,
}

#[derive(Clone, Debug, Serialize)]
pub struct CursorTraceArtifactDetail {
    pub seq: i64,
    pub artifact_type: String,
    pub source: String,
    pub metadata: serde_json::Value,
    pub created_at_ms: i64,
    pub byte_count: usize,
    pub encoding: &'static str,
    pub data: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct ObservabilitySettings {
    pub detailed: bool,
}

impl ControlService {
    pub fn new(
        store: Store,
        provider: Arc<dyn Provider>,
        plugin_runtime: PluginRuntime,
        plugins: PluginRegistry,
        clients: crate::network::NetworkClients,
        app_version: String,
    ) -> Result<Self> {
        let pricing = PricingService::new(store.clone(), clients.clone());
        let exchange_rates = ExchangeRateService::new(store.clone(), clients.clone());
        Ok(Self {
            cursor_harness: CursorHarness::new(store.clone())?,
            store,
            provider,
            plugin_runtime,
            plugins,
            pricing,
            exchange_rates,
            clients,
            app_version,
            model_tests: Arc::new(Mutex::new(BTreeMap::new())),
        })
    }

    pub fn with_pricing_service(mut self, pricing: PricingService) -> Self {
        self.pricing = pricing;
        self
    }

    pub fn pricing(&self) -> &PricingService {
        &self.pricing
    }

    pub fn exchange_rates(&self) -> &ExchangeRateService {
        &self.exchange_rates
    }

    pub fn cursor_harness(&self) -> &CursorHarness {
        &self.cursor_harness
    }

    pub async fn plugins(&self) -> Vec<PluginDescriptor> {
        self.plugins.plugins().await
    }

    pub async fn plugin_oauth_begin(
        &self,
        plugin_id: &str,
        resource_type: &str,
        method_id: &str,
    ) -> Result<crate::plugin::OAuthBeginResponse> {
        self.plugins
            .oauth_begin(plugin_id, resource_type, method_id)
            .await
    }

    pub async fn plugin_oauth_poll(
        &self,
        session_id: &str,
    ) -> Result<crate::plugin::OAuthPollResponse> {
        self.plugins.oauth_poll(session_id).await
    }

    pub async fn plugin_import(
        &self,
        plugin_id: &str,
        resource_type: &str,
        files: serde_json::Value,
    ) -> Result<crate::plugin::ImportResponse> {
        self.plugins
            .import_resources(plugin_id, resource_type, files)
            .await
    }

    pub async fn plugin_export_resources(
        &self,
        plugin_id: &str,
        resource_type: &str,
    ) -> Result<serde_json::Value> {
        self.plugins
            .export_resources(plugin_id, resource_type)
            .await
    }

    pub async fn plugin_refresh_resource(
        &self,
        plugin_id: &str,
        resource_type: &str,
        resource_id: &str,
    ) -> Result<()> {
        self.plugins
            .refresh_resource(plugin_id, resource_type, resource_id)
            .await
    }

    pub async fn plugin_resource_action(
        &self,
        plugin_id: &str,
        resource_type: &str,
        resource_id: &str,
        action_id: &str,
        input: serde_json::Value,
    ) -> Result<serde_json::Value> {
        self.plugins
            .resource_action(plugin_id, resource_type, resource_id, action_id, input)
            .await
    }

    pub async fn plugin_delete_resource(
        &self,
        plugin_id: &str,
        resource_type: &str,
        resource_id: &str,
    ) -> Result<()> {
        self.plugins
            .delete_resource(plugin_id, resource_type, resource_id)
            .await
    }

    pub async fn plugin_sync_models(&self, plugin_id: &str, provider_id: &str) -> Result<usize> {
        self.plugins.sync_models(plugin_id, provider_id).await
    }

    pub async fn plugin_set_model_enabled(
        &self,
        plugin_id: &str,
        provider_id: &str,
        model_id: &str,
        enabled: bool,
    ) -> Result<()> {
        self.plugins
            .set_model_enabled(plugin_id, provider_id, model_id, enabled)
            .await
    }

    pub async fn remove_plugin_configuration(&self, plugin_id: &str) -> Result<()> {
        self.plugins.remove(plugin_id).await
    }

    pub fn plugin_runtime_status(&self) -> PluginRuntimeStatus {
        self.plugin_runtime.status()
    }

    pub fn initialize_plugin_runtime(&self) -> PluginRuntimeStatus {
        self.plugin_runtime.initialize(self.store.clone())
    }

    pub fn cancel_plugin_runtime_initialization(&self) -> PluginRuntimeStatus {
        self.plugin_runtime.cancel_initialization()
    }

    pub(super) async fn ads(
        &self,
        disabled_ad_ids: Option<&str>,
        language: &str,
    ) -> Result<AdRuntime> {
        let client = self.clients.default_client().await?;
        let installation_id = self.store.installation_id().await?;
        let mut request = client
            .get(ADS_ENDPOINT)
            .header(DEVICE_ID_HEADER, installation_id)
            .header(OS_HEADER, std::env::consts::OS)
            .header(APP_VERSION_HEADER, &self.app_version)
            .header(LANGUAGE_HEADER, language)
            .timeout(std::time::Duration::from_secs(60));
        if let Some(disabled_ad_ids) = disabled_ad_ids.filter(|value| !value.is_empty()) {
            request = request.header(DISABLED_AD_IDS_HEADER, disabled_ad_ids);
        }
        let response = request.send().await?;
        let status = response.status();
        if !status.is_success() {
            let message = response.text().await.unwrap_or_default();
            return Err(Error::Provider(format!(
                "advertisement service failed ({status}): {}",
                message.chars().take(200).collect::<String>()
            )));
        }
        let mut runtime = response.json::<AdRuntime>().await?.into_menu_slots()?;
        runtime.cache_images(&client).await;
        Ok(runtime)
    }

    pub(super) async fn dismiss_ad(&self, ad_id: &str, input: &AdDismissalInput) -> Result<()> {
        let client = self.clients.default_client().await?;
        let installation_id = self.store.installation_id().await?;
        let mut endpoint = Url::parse(ADS_ENDPOINT).map_err(|error| {
            Error::Config(format!("advertisement endpoint is invalid: {error}"))
        })?;
        endpoint.set_query(None);
        endpoint
            .path_segments_mut()
            .map_err(|_| Error::Config("advertisement endpoint cannot contain an ad id".into()))?
            .push(ad_id)
            .push("dismissals");
        let response = client
            .post(endpoint)
            .header(DEVICE_ID_HEADER, installation_id)
            .header(OS_HEADER, std::env::consts::OS)
            .header(APP_VERSION_HEADER, &self.app_version)
            .json(input)
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            let message = response.text().await.unwrap_or_default();
            return Err(Error::Provider(format!(
                "advertisement dismissal failed ({status}): {}",
                message.chars().take(200).collect::<String>()
            )));
        }
        Ok(())
    }

    pub async fn providers(&self) -> Result<Vec<ProviderConfig>> {
        self.store.providers().await
    }

    pub async fn reorder_providers(&self, provider_ids: &[String]) -> Result<Vec<ProviderConfig>> {
        self.store.reorder_providers(provider_ids).await
    }

    pub async fn create_provider(&self, input: &ProviderConfigInput) -> Result<ProviderConfig> {
        self.store.create_provider(input).await
    }

    pub async fn update_provider(
        &self,
        provider_id: &str,
        input: &ProviderConfigInput,
    ) -> Result<ProviderConfig> {
        self.store.update_provider(provider_id, input).await
    }

    pub async fn delete_provider(&self, provider_id: &str) -> Result<()> {
        self.store.delete_provider(provider_id).await
    }

    pub async fn models(&self) -> Result<Vec<ModelConfig>> {
        self.store.models().await
    }

    pub async fn overview(
        &self,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
        supplier_keys: Option<&str>,
        suppliers: Option<&str>,
        bucket_ms: Option<i64>,
    ) -> Result<Overview> {
        let plugin_models = self.plugins.known_models().await;
        self.store
            .overview_with_plugins(
                start_ms,
                end_ms,
                supplier_keys,
                suppliers,
                bucket_ms,
                &plugin_models,
            )
            .await
    }

    pub async fn cost_quota_usage(&self, range: crate::store::CostQuotaRange) -> Result<crate::store::CostQuotaUsage>
    {
        self.store.cost_quota_usage(range).await
    }

    pub async fn create_models(&self, models: &[ModelConfigInput]) -> Result<Vec<ModelConfig>> {
        self.store.create_models(models).await
    }

    pub async fn reorder_models(
        &self,
        provider_id: &str,
        model_hashes: &[String],
    ) -> Result<Vec<ModelConfig>> {
        self.store.reorder_models(provider_id, model_hashes).await
    }

    pub async fn delete_model(&self, model_hash: &str) -> Result<()> {
        self.store.delete_model(model_hash).await
    }

    pub async fn update_model(
        &self,
        model_hash: &str,
        input: &ModelConfigInput,
    ) -> Result<ModelConfig> {
        self.store.update_model(model_hash, input).await
    }

    pub async fn test_model(
        &self,
        model_hash: &str,
        test_id: &str,
    ) -> Result<ModelConnectivityResult> {
        let cancellation = CancellationToken::new();
        let cancellation = {
            let mut tests = self
                .model_tests
                .lock()
                .expect("model test registry mutex poisoned");
            tests
                .entry(test_id.to_owned())
                .or_insert_with(|| cancellation.clone())
                .clone()
        };
        let result = self.run_model_test(model_hash, cancellation).await;
        self.model_tests
            .lock()
            .expect("model test registry mutex poisoned")
            .remove(test_id);
        result
    }

    pub fn cancel_model_test(&self, test_id: &str) {
        let cancellation = {
            let mut tests = self
                .model_tests
                .lock()
                .expect("model test registry mutex poisoned");
            tests.entry(test_id.to_owned()).or_default().clone()
        };
        cancellation.cancel();
    }

    async fn run_model_test(
        &self,
        model_hash: &str,
        cancellation: CancellationToken,
    ) -> Result<ModelConnectivityResult> {
        const TEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);
        const TEST_PROMPT: &str = "Output the numbers 1 through 120 separated by a single space. No commas, no newlines, no explanation.";

        let mut model = ModelSpec::new(model_hash);
        if model_hash.starts_with(crate::plugin::ADAPTER_ID_PREFIX) {
            let descriptor = self.plugins.model_descriptor(model_hash).await?;
            model.display_name = Some(descriptor.display_name);
            model.max_output_tokens = Some(descriptor.max_output_tokens.unwrap_or(65_536));
        } else {
            let configured = self
                .store
                .model(model_hash)
                .await?
                .ok_or_else(|| Error::RunNotFound(format!("model {model_hash}")))?;
            configured.configure(&mut model);
            model.max_output_tokens = Some(configured.max_output_tokens().unwrap_or(65_536));
        }
        let call_id = format!("model-test-{}", uuid::Uuid::new_v4());
        let invocation = ModelInvocation {
            call_id: call_id.clone(),
            run_id: call_id.clone(),
            conversation_id: call_id.clone(),
            provider_call_index: 0,
            origin: CallOrigin::ModelTest,
            request: ModelRequest {
                prompt: PromptSpec {
                    instructions: String::new(),
                    tools: Vec::new(),
                },
                model,
                history: vec![ProjectedMessage {
                    message_id: "connectivity-test".into(),
                    role: Role::User,
                    content: ProjectedContent::Parts(vec![ContentPart::Text {
                        text: TEST_PROMPT.into(),
                    }]),
                }],
            },
        };
        let started = Instant::now();
        let mut output = String::new();
        let stream = self.provider.stream(invocation, cancellation.clone());
        let completed = tokio::time::timeout(TEST_TIMEOUT, async {
            futures_util::pin_mut!(stream);
            let mut finished = false;
            while let Some(event) = stream.next().await {
                let event = event?;
                match event {
                    ModelEvent::TextDelta(delta) => {
                        output.push_str(&delta);
                    }
                    ModelEvent::Done(_) => finished = true,
                    _ => {}
                }
            }
            if cancellation.is_cancelled() {
                return Err(Error::Cancelled);
            }
            if !finished {
                return Err(Error::Protocol(
                    "provider stream ended without Done during connectivity test".into(),
                ));
            }
            Ok(())
        })
        .await;
        match completed {
            Ok(result) => result?,
            Err(_) => {
                cancellation.cancel();
                self.store
                    .finish_llm_call(
                        &call_id,
                        CallFinish {
                            status: "error",
                            finish_reason: None,
                            elapsed_ms: started.elapsed().as_millis().min(i64::MAX as u128) as i64,
                            generation_ms: None,
                            generation_output_events: None,
                            error_kind: Some("timeout"),
                            error_message: Some(
                                "model connectivity test timed out after 45 seconds",
                            ),
                        },
                    )
                    .await?;
                return Err(Error::Provider(
                    "model connectivity test timed out after 45 seconds".into(),
                ));
            }
        }
        let output = output.trim().to_string();
        // The stream recorder already timed this call, so the test reuses the
        // persisted record instead of maintaining a second measurement path.
        let record = self
            .store
            .llm_call(&call_id)
            .await?
            .ok_or_else(|| Error::Store("model connectivity test call is missing".into()))?;
        let Some(first_output_ms) = record.performance.first_output_ms else {
            return Err(Error::Provider(
                "model connectivity test received no valid response".into(),
            ));
        };
        let performance = &record.performance;
        Ok(ModelConnectivityResult {
            duration_ms: record.duration_ms.unwrap_or_default().max(0) as u64,
            generation_ms: performance.generation_ms.map(|value| value.max(0) as u64),
            first_output_ms: Some(first_output_ms.max(0) as u64),
            output_tokens: record.output_tokens.map(|tokens| tokens.max(0) as u64),
            overall_tokens_per_second: performance.overall_tokens_per_second,
            overall_reason: performance.overall_reason,
            tokens_per_second: performance.tokens_per_second,
            speed_status: performance.speed_status,
            speed_reason: performance.reason,
            output,
        })
    }

    pub async fn discover_provider_models(
        &self,
        provider_id: &str,
        request_format: RequestFormat,
        request_url_override: Option<&str>,
    ) -> Result<DiscoveredModels> {
        let provider = self
            .store
            .provider(provider_id)
            .await?
            .ok_or_else(|| Error::RunNotFound(format!("provider {provider_id}")))?;
        let client = self.clients.default_client().await?;
        let headers = if provider.custom_headers_enabled {
            &provider.custom_headers
        } else {
            empty_json_object_ref()
        };
        if request_format == RequestFormat::Gemini {
            let url = crate::model::gemini_models_url(&provider.base_url, request_url_override)?;
            return Ok(DiscoveredModels {
                models: gemini_models(&client, url, &provider.api_key, headers).await?,
            });
        }
        let request_url_override =
            crate::model::normalize_request_url_override(request_url_override)?;
        discover_models_from_endpoint(
            &client,
            request_format,
            request_url_override
                .as_deref()
                .unwrap_or(&provider.base_url),
            &provider.api_key,
            headers,
        )
        .await
    }

    pub async fn import_v0049_models(&self) -> Result<LegacyModelImportResult> {
        let path = crate::config::v0049_config_path()?;
        let outcome = self.store.import_v0049_model_config(&path).await?;
        Ok(LegacyModelImportResult {
            imported: outcome.imported,
            skipped: outcome.skipped,
            total: outcome.total,
        })
    }

    pub async fn preview_v0049_models(&self) -> Result<LegacyModelImportPreview> {
        let path = crate::config::v0049_config_path()?;
        let plan = self.store.preview_v0049_model_config(&path).await?;
        let total = plan.models.len();
        let existing_models = plan.models.iter().filter(|model| model.existing).count();
        Ok(LegacyModelImportPreview {
            source: path.display().to_string(),
            total,
            new_models: total - existing_models,
            existing_models,
            models: plan
                .models
                .into_iter()
                .map(|model| LegacyModelImportPreviewItem {
                    model_hash: model.model_hash,
                    display_name: model.input.display_name,
                    model_id: model.input.model_id,
                    request_format: model.input.request_format,
                    existing: model.existing,
                })
                .collect(),
        })
    }

    pub async fn calls(&self, filter: &LlmCallFilter<'_>) -> Result<CallListResult> {
        let supplier_keys_json =
            normalize_string_array_filter(filter.supplier_keys, "supplier_keys")?;
        let suppliers_json = normalize_string_array_filter(filter.suppliers, "suppliers")?;
        let has_supplier_filter = supplier_keys_json.is_some() || suppliers_json.is_some();

        if has_supplier_filter {
            let total = self.store.count_llm_calls(filter).await?;
            let items = self
                .store
                .llm_calls(filter)
                .await?
                .into_iter()
                .map(provider_call_summary)
                .collect();
            return Ok(CallListResult { items, total });
        }

        let llm_total = self.store.count_llm_calls(filter).await?;
        let official_total = self
            .store
            .count_official_cursor_traces(filter.start_ms, filter.end_ms)
            .await?;
        let total = llm_total.saturating_add(official_total);

        let refs = self
            .store
            .unfiltered_call_timeline_page(
                filter.start_ms,
                filter.end_ms,
                filter.limit,
                filter.offset,
            )
            .await?;

        let llm_ids: Vec<String> = refs
            .iter()
            .filter_map(|item| match item {
                TimelineCallRef::Llm(id) => Some(id.clone()),
                TimelineCallRef::Cursor(_) => None,
            })
            .collect();
        let cursor_ids: Vec<String> = refs
            .iter()
            .filter_map(|item| match item {
                TimelineCallRef::Cursor(id) => Some(id.clone()),
                TimelineCallRef::Llm(_) => None,
            })
            .collect();

        let mut llm_map = self.store.llm_calls_by_ids(&llm_ids).await?;
        let mut cursor_map = self
            .store
            .official_cursor_traces_by_ids(&cursor_ids)
            .await?;

        let mut items = Vec::with_capacity(refs.len());
        for entry in refs {
            match entry {
                TimelineCallRef::Llm(id) => {
                    if let Some(call) = llm_map.remove(&id) {
                        items.push(provider_call_summary(call));
                    }
                }
                TimelineCallRef::Cursor(id) => {
                    if let Some(trace) = cursor_map.remove(&id) {
                        items.push(official_call(trace));
                    }
                }
            }
        }
        Ok(CallListResult { items, total })
    }

    pub async fn call(&self, call_id: &str) -> Result<CallDetail> {
        if let Some(call) = self.store.llm_call(call_id).await? {
            let cursor_trace = self.cursor_trace_detail(&call.run_id).await?;
            let route = call_route(&call.run_id);
            return Ok(CallDetail {
                request: self.store.llm_call_request(call_id).await?,
                response_chunks: self.store.llm_call_chunks(call_id).await?,
                call: CallSummary {
                    call,
                    call_kind: "provider_llm",
                    route,
                },
                cursor_trace,
            });
        }
        let request_id = call_id.strip_prefix("cursor:").unwrap_or(call_id);
        let trace = self
            .store
            .cursor_trace(request_id)
            .await?
            .filter(|trace| trace.route == "cursor_official")
            .ok_or_else(|| Error::RunNotFound(format!("call {call_id}")))?;
        Ok(CallDetail {
            call: official_call(trace.clone()),
            request: None,
            response_chunks: Vec::new(),
            cursor_trace: Some(self.cursor_trace_detail_from(trace).await?),
        })
    }

    async fn cursor_trace_detail(&self, request_id: &str) -> Result<Option<CursorTraceDetail>> {
        let Some(trace) = self.store.cursor_trace(request_id).await? else {
            return Ok(None);
        };
        Ok(Some(self.cursor_trace_detail_from(trace).await?))
    }

    async fn cursor_trace_detail_from(
        &self,
        trace: CursorRunTraceSummary,
    ) -> Result<CursorTraceDetail> {
        let artifacts = self
            .store
            .cursor_trace_artifacts(&trace.request_id)
            .await?
            .into_iter()
            .map(cursor_artifact)
            .collect();
        Ok(CursorTraceDetail { trace, artifacts })
    }

    pub async fn observability(&self) -> Result<ObservabilitySettings> {
        Ok(ObservabilitySettings {
            detailed: self.store.detailed_logging().await?,
        })
    }

    pub async fn set_observability(
        &self,
        settings: ObservabilitySettings,
    ) -> Result<ObservabilitySettings> {
        self.store.set_detailed_logging(settings.detailed).await?;
        Ok(settings)
    }

    pub async fn ports(&self) -> Result<PortSettings> {
        self.store.port_settings().await
    }

    pub async fn external_api_settings(&self) -> Result<ExternalApiSettings> {
        self.store.external_api_settings().await
    }

    pub async fn set_external_api_settings(
        &self,
        settings: ExternalApiSettings,
    ) -> Result<ExternalApiSettings> {
        self.store.set_external_api_settings(settings).await
    }

    pub async fn set_ports(&self, settings: PortSettings) -> Result<PortSettings> {
        self.store.set_port_settings(settings).await?;
        Ok(settings)
    }

    pub async fn statistics_storage(&self) -> Result<StatisticsStorage> {
        self.store.statistics_storage().await
    }

    pub async fn clear_statistics_storage(&self) -> Result<StatisticsStorage> {
        self.store.clear_statistics_storage().await
    }

    pub async fn clear_all_statistics_storage(&self) -> Result<StatisticsStorage> {
        self.store.clear_all_statistics_storage().await
    }

    pub async fn proxy_settings(&self) -> Result<ProxySettings> {
        self.store.proxy_settings().await
    }

    pub async fn set_proxy_settings(&self, settings: ProxySettingsInput) -> Result<ProxySettings> {
        if settings.mode.is_custom() {
            let local_proxy_port = match self.cursor_harness.proxy_port().await {
                Some(port) => port,
                None => self.store.port_settings().await?.proxy_port,
            };
            crate::network::reject_self_proxy(&settings.address, local_proxy_port)?;
        }
        let settings = self.store.set_proxy_settings(settings).await?;
        self.clients.invalidate().await;
        Ok(settings)
    }

    pub async fn tab_settings(&self) -> Result<TabSettings> {
        self.store.tab_settings().await
    }

    pub async fn set_tab_settings(&self, settings: TabSettings) -> Result<TabSettings> {
        self.cursor_harness.set_tab_settings(settings).await
    }

    pub async fn desktop_settings(&self) -> Result<DesktopSettings> {
        self.store.desktop_settings().await
    }

    pub async fn set_desktop_settings(&self, settings: DesktopSettings) -> Result<()> {
        self.store.set_desktop_settings(settings).await
    }

    pub async fn commit_settings(&self) -> Result<CommitSettings> {
        self.store.commit_settings().await
    }

    pub async fn set_commit_settings(&self, settings: CommitSettings) -> Result<CommitSettings> {
        self.store.set_commit_settings(settings).await
    }

    pub async fn interface_settings(&self) -> Result<InterfaceSettings> {
        self.store.interface_settings().await
    }

    pub async fn update_interface_settings(
        &self,
        patch: InterfaceSettingsPatch,
    ) -> Result<InterfaceSettings> {
        self.store.update_interface_settings(patch).await
    }

    pub async fn pricing_catalog(
        &self,
        query: Option<&str>,
        provider_id: Option<&str>,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> Result<CatalogSearchResult> {
        self.store
            .search_pricing_catalog(query, provider_id, limit, offset)
            .await
    }

    pub async fn pricing_models(&self) -> Result<Vec<SupplierPricingView>> {
        let plugin_models = self.plugins.known_models().await;
        self.store.supplier_pricing_models(&plugin_models).await
    }

    pub async fn save_pricing_model(
        &self,
        input: &SaveSupplierPricingInput,
    ) -> Result<SupplierPricingView> {
        let plugin_models = self.plugins.known_models().await;
        let saved = self
            .store
            .save_supplier_pricing_config(input, &plugin_models)
            .await?;
        self.pricing.trigger_backfill_oneshot();
        Ok(saved)
    }

    pub async fn pricing_settings(&self) -> Result<PricingSettings> {
        self.store.pricing_settings().await
    }

    pub async fn set_pricing_settings(&self, settings: PricingSettings) -> Result<PricingSettings> {
        self.store.set_pricing_settings(settings).await
    }

    pub async fn pricing_sync_status(&self) -> Result<PricingSyncState> {
        self.pricing.status().await
    }

    pub async fn set_pricing_auto_sync(&self, enabled: bool) -> Result<PricingSyncState> {
        self.pricing.set_auto_sync(enabled).await
    }

    pub async fn sync_pricing_now(&self) -> Result<PricingSyncState> {
        self.pricing.sync_now().await
    }
}

fn provider_call_summary(call: LlmCallSummary) -> CallSummary {
    let route = call_route(&call.run_id);
    CallSummary {
        call,
        call_kind: "provider_llm",
        route,
    }
}

fn call_route(run_id: &str) -> &'static str {
    if run_id.starts_with("external-api:") {
        "external_api"
    } else {
        "local_byok"
    }
}

fn official_call(trace: CursorRunTraceSummary) -> CallSummary {
    let model_id = trace.model_id.clone().unwrap_or_else(|| "Cursor".into());
    let ttfb = trace
        .first_response_at_ms
        .map(|value| (value - trace.received_at_ms).max(0));
    let duration = trace
        .finished_at_ms
        .map(|value| (value - trace.received_at_ms).max(0));
    let error = trace.error_message.clone();
    let status = trace.status.clone();
    // Cursor passthrough traces carry no token usage or generation timing, so the
    // rate stays unavailable while the shared rules still describe why.
    let performance = evaluate_performance(SpeedSample {
        status: &status,
        streaming: Some(true),
        output_tokens: None,
        reasoning_tokens: None,
        first_output_ms: None,
        generation_ms: None,
        duration_ms: None,
        generation_output_events: None,
        observed_thinking: false,
    });
    CallSummary {
        call: LlmCallSummary {
            call_id: format!("cursor:{}", trace.request_id),
            run_id: trace.request_id.clone(),
            conversation_id: trace
                .conversation_id
                .clone()
                .unwrap_or_else(|| trace.request_id.clone()),
            provider_call_index: 0,
            model_hash: None,
            supplier_key: None,
            endpoint_key: None,
            provider_type: "cursor-official".into(),
            provider_url: "https://api2.cursor.sh".into(),
            request_type: "cursor-run-sse".into(),
            request_url: "https://api2.cursor.sh/agent.v1.AgentService/RunSSE".into(),
            model_id: model_id.clone(),
            display_name: model_id,
            reasoning_effort: None,
            fast: None,
            status,
            finish_reason: None,
            created_at_ms: trace.received_at_ms,
            request_started_at_ms: Some(trace.received_at_ms),
            response_headers_at_ms: trace.first_response_at_ms,
            first_event_at_ms: trace.first_response_at_ms,
            first_text_at_ms: None,
            first_valid_response_at_ms: None,
            first_output_at_ms: None,
            finished_at_ms: trace.finished_at_ms,
            queue_ms: None,
            ttfb_ms: ttfb,
            ttft_ms: None,
            ttfr_ms: None,
            ttfo_ms: None,
            duration_ms: duration,
            generation_ms: None,
            generation_output_events: None,
            streaming: Some(true),
            call_origin: CallOrigin::Run.as_str().into(),
            observed_thinking: false,
            performance,
            input_tokens: None,
            billed_input_tokens: None,
            output_tokens: None,
            total_tokens: None,
            cache_read_tokens: None,
            cache_write_tokens: None,
            reasoning_tokens: None,
            usage: None,
            pricing_source: None,
            pricing_provider_id: None,
            pricing_model_id: None,
            pricing_snapshot_at_ms: None,
            unit_input_per_million: None,
            unit_output_per_million: None,
            unit_cache_read_per_million: None,
            unit_cache_write_per_million: None,
            cost_status: Some("unknown".into()),
            cost_basis: None,
            assumed_cache_hit_rate_bps: None,
            estimated_cache_read_tokens: None,
            input_cost: None,
            output_cost: None,
            cache_read_cost: None,
            cache_write_cost: None,
            total_cost: None,
            cost_calculated_at_ms: None,
            cost_backfilled: false,
            message_count: 0,
            tool_count: 0,
            request_bytes: Some(trace.request_bytes),
            response_bytes: trace.response_bytes,
            stream_event_count: trace.response_event_count,
            http_status: trace.http_status,
            error_kind: error.as_ref().map(|_| "cursor_official".into()),
            error_message: error,
            detailed: true,
        },
        call_kind: "cursor_official",
        route: "cursor_official",
    }
}

fn cursor_artifact(artifact: CursorRunTraceArtifact) -> CursorTraceArtifactDetail {
    let byte_count = artifact.data.len();
    let (encoding, data) = match readable_utf8(&artifact.data) {
        Some(value) => ("utf8", value.into()),
        None => ("base64", STANDARD.encode(&artifact.data)),
    };
    CursorTraceArtifactDetail {
        seq: artifact.seq,
        artifact_type: artifact.artifact_type,
        source: artifact.source,
        metadata: artifact.metadata,
        created_at_ms: artifact.created_at_ms,
        byte_count,
        encoding,
        data,
    }
}

fn readable_utf8(data: &[u8]) -> Option<&str> {
    let value = std::str::from_utf8(data).ok()?;
    value
        .chars()
        .all(|character| !character.is_control() || matches!(character, '\n' | '\r' | '\t'))
        .then_some(value)
}

async fn discover_models_from_endpoint(
    client: &reqwest::Client,
    request_format: RequestFormat,
    base_url: &str,
    api_key: &str,
    custom_headers: &serde_json::Value,
) -> Result<DiscoveredModels> {
    let mut models = match request_format {
        RequestFormat::OpenAiChat | RequestFormat::OpenAiResponses => {
            openai_models(client, base_url, api_key, custom_headers).await?
        }
        RequestFormat::Anthropic => {
            anthropic_models(client, base_url, api_key, custom_headers).await?
        }
        RequestFormat::Gemini => unreachable!("Gemini uses its model collection URL"),
    };
    models.sort();
    models.dedup();
    Ok(DiscoveredModels { models })
}

async fn gemini_models(
    client: &reqwest::Client,
    url: Url,
    api_key: &str,
    custom_headers: &serde_json::Value,
) -> Result<Vec<String>> {
    let mut models = BTreeSet::new();
    let mut seen_pages = std::collections::HashSet::new();
    let mut page_token = None::<String>;
    loop {
        let mut request = client.get(url.clone()).header("x-goog-api-key", api_key);
        if let Some(token) = &page_token {
            request = request.query(&[("pageToken", token)]);
        }
        let response = apply_discovery_headers(request, custom_headers)?
            .send()
            .await?;
        let status = response.status();
        let body: serde_json::Value = response.json().await?;
        if !status.is_success() {
            return Err(Error::Provider(format!(
                "Gemini model discovery failed ({status}): {body}"
            )));
        }
        if let Some(entries) = body.get("models").and_then(serde_json::Value::as_array) {
            for model in entries {
                if !model
                    .get("supportedGenerationMethods")
                    .and_then(serde_json::Value::as_array)
                    .is_some_and(|methods| {
                        methods
                            .iter()
                            .any(|method| method.as_str() == Some("generateContent"))
                    })
                {
                    continue;
                }
                if let Some(name) = model
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .and_then(|name| name.strip_prefix("models/"))
                    .filter(|name| !name.is_empty())
                {
                    models.insert(name.to_owned());
                }
            }
        }
        let Some(token) = body
            .get("nextPageToken")
            .and_then(serde_json::Value::as_str)
            .filter(|token| !token.is_empty())
        else {
            break;
        };
        if !seen_pages.insert(token.to_owned()) {
            return Err(Error::Provider(
                "Gemini model discovery repeated a page token".into(),
            ));
        }
        page_token = Some(token.to_owned());
    }
    Ok(models.into_iter().collect())
}

fn model_discovery_url(base_url: &str) -> Result<Url> {
    let mut url = Url::parse(base_url)
        .map_err(|error| Error::Config(format!("invalid model request URL: {error}")))?;
    if url.host_str().is_none() {
        return Err(Error::Config(
            "model request URL must contain a host".into(),
        ));
    }
    // 在现有路径上追加，而不是整段替换：多数编程套餐的 API 挂在子路径下
    // （/api/anthropic、/coding、/api/paas/v4 等），直接 set_path("/v1/models")
    // 会把这些前缀吃掉，发现请求必然 404
    let path = url.path().trim_end_matches('/');
    let last = path.rsplit('/').next().unwrap_or("");
    let versioned = last.len() > 1
        && last.starts_with('v')
        && last[1..].bytes().all(|byte| byte.is_ascii_digit());
    let new_path = if let Some(parent) = path.strip_suffix("/chat/completions") {
        // 完整请求 URL：剥掉端点段（chat/completions 是两段），换成 models
        format!("{parent}/models")
    } else if let Some(parent) = path
        .strip_suffix("/responses")
        .or_else(|| path.strip_suffix("/messages"))
        .or_else(|| path.strip_suffix("/completions"))
    {
        format!("{parent}/models")
    } else if path.is_empty() {
        "/v1/models".to_string()
    } else if versioned {
        // 已带版本段（/v1、/api/v3、/api/paas/v4）：只补 models
        format!("{path}/models")
    } else {
        format!("{path}/v1/models")
    };
    url.set_path(&new_path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn model_discovery_urls(base_url: &str) -> Result<Vec<Url>> {
    let mut configured = Url::parse(base_url)
        .map_err(|error| Error::Config(format!("invalid model request URL: {error}")))?;
    let path = configured.path().trim_end_matches('/');
    let tail = path.rsplit('/').next().unwrap_or_default();
    if matches!(tail.to_ascii_lowercase().as_str(), "model" | "models") {
        configured.set_query(None);
        configured.set_fragment(None);
        return Ok(vec![configured]);
    }

    let primary = model_discovery_url(base_url)?;
    let versioned = tail.len() > 1
        && tail.starts_with('v')
        && tail[1..].bytes().all(|byte| byte.is_ascii_digit());
    let complete_request_url = [
        "/chat/completions",
        "/responses",
        "/messages",
        "/completions",
    ]
    .iter()
    .any(|suffix| path.to_ascii_lowercase().ends_with(suffix));
    if versioned || complete_request_url {
        return Ok(vec![primary]);
    }

    let Some(prefix) = primary.path().strip_suffix("/v1/models") else {
        return Ok(vec![primary]);
    };
    let mut fallback = primary.clone();
    fallback.set_path(&format!("{prefix}/models"));
    Ok(vec![primary, fallback])
}

async fn openai_models(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    custom_headers: &serde_json::Value,
) -> Result<Vec<String>> {
    let mut last_error = None;
    for url in model_discovery_urls(base_url)? {
        match openai_models_at(client, url, api_key, custom_headers).await {
            Ok(models) => return Ok(models),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| Error::Provider("no model discovery URL available".into())))
}

async fn openai_models_at(
    client: &reqwest::Client,
    url: Url,
    api_key: &str,
    custom_headers: &serde_json::Value,
) -> Result<Vec<String>> {
    let mut request = client.get(url);
    if !api_key.is_empty() {
        request = request.bearer_auth(api_key);
    }
    let response = apply_discovery_headers(request, custom_headers)?
        .send()
        .await?;
    let status = response.status();
    let body: serde_json::Value = response.json().await?;
    if !status.is_success() {
        return Err(Error::Provider(format!(
            "model discovery failed ({status}): {body}"
        )));
    }
    Ok(model_ids(body.get("data").unwrap_or(&body)))
}

async fn anthropic_models(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    custom_headers: &serde_json::Value,
) -> Result<Vec<String>> {
    let mut last_error = None;
    for url in model_discovery_urls(base_url)? {
        match anthropic_models_at(client, url, api_key, custom_headers).await {
            Ok(models) => return Ok(models),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| Error::Provider("no model discovery URL available".into())))
}

async fn anthropic_models_at(
    client: &reqwest::Client,
    url: Url,
    api_key: &str,
    custom_headers: &serde_json::Value,
) -> Result<Vec<String>> {
    let mut after_id = None::<String>;
    let mut found = BTreeSet::new();
    loop {
        let mut request = client
            .get(url.clone())
            .query(&[("limit", "100")])
            .header("anthropic-version", "2023-06-01");
        if !api_key.is_empty() {
            request = request.header("x-api-key", api_key);
        }
        if let Some(after_id) = &after_id {
            request = request.query(&[("after_id", after_id)]);
        }
        let response = apply_discovery_headers(request, custom_headers)?
            .send()
            .await?;
        let status = response.status();
        let body: serde_json::Value = response.json().await?;
        if !status.is_success() {
            return Err(Error::Provider(format!(
                "model discovery failed ({status}): {body}"
            )));
        }
        found.extend(model_ids(body.get("data").unwrap_or(&body)));
        if body.get("has_more").and_then(serde_json::Value::as_bool) != Some(true) {
            break;
        }
        after_id = body
            .get("last_id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);
        if after_id.is_none() {
            return Err(Error::Provider(
                "Anthropic model response has_more without last_id".into(),
            ));
        }
    }
    Ok(found.into_iter().collect())
}

fn model_ids(value: &serde_json::Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| match item {
            serde_json::Value::String(id) => Some(id.clone()),
            serde_json::Value::Object(object) => object
                .get("id")
                .or_else(|| object.get("name"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
            _ => None,
        })
        .collect()
}

fn apply_discovery_headers(
    mut request: reqwest::RequestBuilder,
    headers: &serde_json::Value,
) -> Result<reqwest::RequestBuilder> {
    let object = headers
        .as_object()
        .ok_or_else(|| Error::Config("custom headers must be an object".into()))?;
    for (name, value) in object {
        if name.eq_ignore_ascii_case("user-agent") {
            continue;
        }
        let value = value
            .as_str()
            .ok_or_else(|| Error::Config(format!("custom header {name} must be a string")))?;
        let name = HeaderName::try_from(name)
            .map_err(|error| Error::Config(format!("invalid header name: {error}")))?;
        let value = HeaderValue::try_from(value)
            .map_err(|error| Error::Config(format!("invalid header value: {error}")))?;
        request = request.header(name, value);
    }
    Ok(request)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_call_reports_missing_output_tokens_for_both_speeds() {
        let summary = official_call(CursorRunTraceSummary {
            request_id: "req-1".into(),
            conversation_id: Some("conv-1".into()),
            route: "cursor_official".into(),
            model_id: Some("claude-4.5-sonnet".into()),
            status: "completed".into(),
            request_bytes: 120,
            response_bytes: 480,
            response_event_count: 10,
            http_status: Some(200),
            received_at_ms: 1_000,
            first_response_at_ms: Some(1_250),
            finished_at_ms: Some(2_500),
            error_message: None,
        });
        assert_eq!(
            summary.call.performance.speed_status,
            SpeedStatus::Unavailable
        );
        assert_eq!(
            summary.call.performance.reason,
            Some(SpeedUnavailableReason::MissingOutputTokens)
        );
        assert_eq!(
            summary.call.performance.overall_reason,
            Some(SpeedUnavailableReason::MissingOutputTokens)
        );
    }
}
