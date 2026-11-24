//! Imports provider and model definitions from the v0.0.49 YAML configuration.
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::{
    model::{
        model_hash, normalize_model_input, normalize_provider_input, normalize_request_url,
        ModelConfigInput, ProviderConfigInput, RequestFormat, OPENAI_CHAT_ENDPOINT,
        OPENAI_RESPONSES_ENDPOINT,
    },
    Error, Result,
};

use super::{
    models::{insert_model_with_conflict, insert_provider_with_conflict},
    now_ms, Store,
};

pub struct LegacyModelImportPlan {
    pub providers: Vec<(String, ProviderConfigInput)>,
    pub models: Vec<LegacyModelImportEntry>,
}

pub struct LegacyModelImportEntry {
    pub model_hash: String,
    pub input: ModelConfigInput,
    pub existing: bool,
}

pub struct LegacyModelImportOutcome {
    pub imported: usize,
    pub skipped: usize,
    pub total: usize,
}

#[derive(Default, Deserialize)]
struct LegacyConfig {
    #[serde(rename = "modelAdapters", default)]
    model_adapters: Vec<LegacyModel>,
}

#[derive(Default, Deserialize)]
struct LegacyModel {
    #[serde(default)]
    sort: i64,
    #[serde(rename = "displayName", default)]
    display_name: String,
    #[serde(rename = "type", default)]
    model_type: String,
    #[serde(rename = "baseURL", default)]
    base_url: String,
    #[serde(rename = "apiKey", default)]
    api_key: String,
    #[serde(rename = "tooltipData", default)]
    tooltip_data: String,
    #[serde(rename = "modelID", default)]
    model_id: String,
    #[serde(rename = "reasoningEffort", default)]
    reasoning_effort: String,
    #[serde(rename = "openAIEndpoint", default)]
    openai_endpoint: String,
    #[serde(rename = "openAIExtraParamsEnabled", default)]
    openai_extra_params_enabled: bool,
    #[serde(rename = "openAIExtraParamsJSON", default)]
    openai_extra_params_json: String,
    #[serde(rename = "customHeadersEnabled", default)]
    custom_headers_enabled: bool,
    #[serde(rename = "customHeadersJSON", default)]
    custom_headers_json: String,
    #[serde(rename = "anthropicExtraParamsEnabled", default)]
    anthropic_extra_params_enabled: bool,
    #[serde(rename = "anthropicExtraParamsJSON", default)]
    anthropic_extra_params_json: String,
    #[serde(rename = "contextWindowTokens", default)]
    context_window_tokens: u64,
    #[serde(rename = "maxCompletionTokens", default)]
    max_completion_tokens: u64,
    #[serde(rename = "anthropicMaxTokens", default)]
    anthropic_max_tokens: u64,
    #[serde(rename = "anthropicThinkingEffort", default)]
    anthropic_thinking_effort: String,
    #[serde(rename = "thinkingBudgetTokens", default)]
    thinking_budget_tokens: u64,
}

struct ParsedLegacyEntry {
    provider: ProviderConfigInput,
    request_format: RequestFormat,
    request_url_override: Option<String>,
    extra_params_enabled: bool,
    extra_params: serde_json::Value,
    sort_order: i64,
    display_name: String,
    tooltip_data: String,
    model_id: String,
    reasoning_effort: Option<String>,
    context_window_tokens: Option<u64>,
    max_output_tokens: Option<u64>,
    anthropic_thinking_effort: Option<String>,
    thinking_budget_tokens: Option<u64>,
}

#[derive(Clone, Hash, PartialEq, Eq)]
struct ProviderMatchKey {
    model_type: &'static str,
    base_url: String,
    use_full_url: bool,
    api_key: String,
    openai_endpoint: String,
    custom_headers_enabled: bool,
    custom_headers_json: String,
    extra_params_enabled: bool,
    extra_params_json: String,
}

impl Store {
    pub async fn preview_v0049_model_config(&self, path: &Path) -> Result<LegacyModelImportPlan> {
        let entries = load_v0049_model_config(path)?;
        let existing_providers = self.providers().await?;
        let existing_models = self.models().await?;

        let mut provider_ids_by_key = HashMap::new();
        let providers_by_id: HashMap<_, _> = existing_providers
            .iter()
            .map(|provider| (provider.provider_id.as_str(), provider))
            .collect();
        for model in existing_models
            .iter()
            .filter(|model| model.request_format != RequestFormat::Gemini)
        {
            let key = provider_match_key(
                model.request_format,
                model
                    .request_url_override
                    .as_deref()
                    .unwrap_or(&model.base_url),
                model.request_url_override.is_some(),
                &model.api_key,
                model.custom_headers_enabled,
                &model.custom_headers,
                model.extra_params_enabled,
                &model.extra_params,
            )?;
            provider_ids_by_key
                .entry(key)
                .or_insert_with(|| model.provider_id.clone());
        }

        let mut existing_by_identity = HashMap::new();
        let mut existing_hashes = HashSet::with_capacity(existing_models.len());
        for model in &existing_models {
            existing_hashes.insert(model.model_hash.clone());
            existing_by_identity.insert(
                (
                    model.provider_id.clone(),
                    model.model_id.clone(),
                    model.display_name.clone(),
                ),
                model.model_hash.clone(),
            );
        }

        let mut new_providers = Vec::new();
        let mut planned_provider_ids: HashMap<ProviderMatchKey, String> = HashMap::new();
        let mut seen_models = HashSet::with_capacity(entries.len());
        let mut models = Vec::with_capacity(entries.len());

        for entry in entries {
            let provider = normalize_provider_input(&entry.provider)?;
            let key = provider_match_key(
                entry.request_format,
                entry
                    .request_url_override
                    .as_deref()
                    .unwrap_or(&provider.base_url),
                entry.request_url_override.is_some(),
                &provider.api_key,
                provider.custom_headers_enabled,
                &provider.custom_headers,
                entry.extra_params_enabled,
                &entry.extra_params,
            )?;
            let provider_id = if let Some(existing_id) = provider_ids_by_key.get(&key) {
                existing_id.clone()
            } else if let Some(planned_id) = planned_provider_ids.get(&key) {
                planned_id.clone()
            } else {
                let id = deterministic_provider_id(&key);
                planned_provider_ids.insert(key, id.clone());
                if let Some(existing) = providers_by_id.get(id.as_str()) {
                    if existing.base_url != provider.base_url
                        || existing.api_key != provider.api_key
                        || existing.custom_headers_enabled != provider.custom_headers_enabled
                        || existing.custom_headers != provider.custom_headers
                    {
                        return Err(Error::Config(format!(
                            "legacy import conflicts with provider {id}"
                        )));
                    }
                } else {
                    new_providers.push((id.clone(), provider));
                }
                id
            };

            let model_input = normalize_model_input(&ModelConfigInput {
                provider_id: provider_id.clone(),
                request_format: entry.request_format,
                request_url_override: entry.request_url_override,
                extra_params_enabled: entry.extra_params_enabled,
                extra_params: entry.extra_params,
                sort_order: entry.sort_order,
                display_name: entry.display_name,
                tooltip_data: entry.tooltip_data,
                model_id: entry.model_id,
                reasoning_effort: entry.reasoning_effort,
                context_window_tokens: entry.context_window_tokens,
                max_output_tokens: entry.max_output_tokens,
                anthropic_thinking_effort: entry.anthropic_thinking_effort,
                thinking_budget_tokens: entry.thinking_budget_tokens,
            })?;

            let identity = (
                model_input.provider_id.clone(),
                model_input.model_id.clone(),
                model_input.display_name.clone(),
            );
            let existing_hash = existing_by_identity.get(&identity).cloned();
            let hash = match &existing_hash {
                Some(hash) => hash.clone(),
                None => model_hash(&model_input)?,
            };
            let existing = existing_hash.is_some() || existing_hashes.contains(&hash);

            if seen_models.insert(hash.clone()) {
                models.push(LegacyModelImportEntry {
                    model_hash: hash,
                    input: model_input,
                    existing,
                });
            }
        }

        Ok(LegacyModelImportPlan {
            providers: new_providers,
            models,
        })
    }

    pub async fn import_v0049_model_config(&self, path: &Path) -> Result<LegacyModelImportOutcome> {
        let plan = self.preview_v0049_model_config(path).await?;
        let total = plan.models.len();
        let now = now_ms();
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin().await?;
        for (provider_id, provider) in &plan.providers {
            insert_provider_with_conflict(&mut transaction, provider_id, provider, now, true)
                .await?;
        }
        let mut imported = 0usize;
        for entry in &plan.models {
            if entry.existing {
                continue;
            }
            if insert_model_with_conflict(
                &mut transaction,
                &entry.model_hash,
                &entry.input,
                now,
                true,
            )
            .await?
            {
                imported += 1;
            }
        }
        transaction.commit().await?;
        Ok(LegacyModelImportOutcome {
            imported,
            skipped: total - imported,
            total,
        })
    }
}

fn load_v0049_model_config(path: &Path) -> Result<Vec<ParsedLegacyEntry>> {
    let raw = match std::fs::read(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(Error::Config(format!(
                "v0.0.49 config not found at {}",
                path.display()
            )))
        }
        Err(error) => return Err(error.into()),
    };
    let legacy: LegacyConfig = serde_yaml::from_slice(&raw)
        .map_err(|error| Error::Config(format!("invalid v0.0.49 config: {error}")))?;
    if legacy.model_adapters.is_empty() {
        return Err(Error::Config(
            "v0.0.49 config contains no model adapters".into(),
        ));
    }
    legacy
        .model_adapters
        .into_iter()
        .map(parse_legacy_entry)
        .collect()
}

fn parse_legacy_entry(model: LegacyModel) -> Result<ParsedLegacyEntry> {
    let (request_format, request_url_override) =
        legacy_request_configuration(&model.model_type, &model.base_url, &model.openai_endpoint)?;
    let base_url = match &request_url_override {
        Some(url) => legacy_base_url(url)?,
        None => normalize_request_url(&model.base_url)?,
    };
    let (extra_params_enabled, extra_params) = match request_format {
        RequestFormat::Gemini => unreachable!("legacy formats predate Gemini"),
        RequestFormat::OpenAiChat | RequestFormat::OpenAiResponses => (
            model.openai_extra_params_enabled,
            enabled_json_object(
                model.openai_extra_params_enabled,
                &model.openai_extra_params_json,
            )?,
        ),
        RequestFormat::Anthropic => (
            model.anthropic_extra_params_enabled,
            enabled_json_object(
                model.anthropic_extra_params_enabled,
                &model.anthropic_extra_params_json,
            )?,
        ),
    };
    let max_output_tokens = match request_format {
        RequestFormat::Gemini => unreachable!("legacy formats predate Gemini"),
        RequestFormat::OpenAiChat | RequestFormat::OpenAiResponses => {
            positive(model.max_completion_tokens)
        }
        RequestFormat::Anthropic => {
            positive(model.anthropic_max_tokens).or_else(|| positive(model.max_completion_tokens))
        }
    };

    Ok(ParsedLegacyEntry {
        provider: ProviderConfigInput {
            icon: None,
            sort_order: model.sort.max(0),
            name: host_label(&base_url),
            base_url,
            api_key: model.api_key,
            custom_headers_enabled: model.custom_headers_enabled,
            custom_headers: enabled_json_object(
                model.custom_headers_enabled,
                &model.custom_headers_json,
            )?,
        },
        request_format,
        request_url_override,
        extra_params_enabled,
        extra_params,
        sort_order: model.sort,
        display_name: model.display_name.clone(),
        tooltip_data: if model.tooltip_data.trim().is_empty() {
            model.display_name
        } else {
            model.tooltip_data
        },
        model_id: model.model_id,
        reasoning_effort: optional_string(model.reasoning_effort),
        context_window_tokens: positive(model.context_window_tokens),
        max_output_tokens,
        anthropic_thinking_effort: optional_string(model.anthropic_thinking_effort),
        thinking_budget_tokens: positive(model.thinking_budget_tokens),
    })
}

fn host_label(base_url: &str) -> String {
    reqwest::Url::parse(base_url.trim())
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .filter(|host| !host.is_empty())
        .unwrap_or_else(|| base_url.trim().to_owned())
}

#[allow(clippy::too_many_arguments)]
fn provider_match_key(
    request_format: RequestFormat,
    base_url: &str,
    use_full_url: bool,
    api_key: &str,
    custom_headers_enabled: bool,
    custom_headers: &serde_json::Value,
    extra_params_enabled: bool,
    extra_params: &serde_json::Value,
) -> Result<ProviderMatchKey> {
    Ok(ProviderMatchKey {
        model_type: if request_format == RequestFormat::Anthropic {
            "anthropic"
        } else {
            "openai"
        },
        base_url: base_url.to_owned(),
        use_full_url,
        api_key: api_key.to_owned(),
        openai_endpoint: match request_format {
            RequestFormat::OpenAiChat => OPENAI_CHAT_ENDPOINT,
            RequestFormat::OpenAiResponses => OPENAI_RESPONSES_ENDPOINT,
            RequestFormat::Anthropic => "",
            RequestFormat::Gemini => unreachable!("legacy formats predate Gemini"),
        }
        .to_owned(),
        custom_headers_enabled,
        custom_headers_json: serde_json::to_string(custom_headers)?,
        extra_params_enabled,
        extra_params_json: serde_json::to_string(extra_params)?,
    })
}

fn deterministic_provider_id(key: &ProviderMatchKey) -> String {
    let mut hasher = Sha256::new();
    for field in [
        key.model_type,
        &key.base_url,
        if key.use_full_url { "1" } else { "0" },
        &key.api_key,
        &key.openai_endpoint,
        if key.custom_headers_enabled { "1" } else { "0" },
        &key.custom_headers_json,
        if key.extra_params_enabled { "1" } else { "0" },
        &key.extra_params_json,
    ] {
        hasher.update(field.as_bytes());
        hasher.update([0_u8]);
    }
    let digest = hasher.finalize();
    hex::encode(&digest[..8])
}

fn legacy_request_configuration(
    model_type: &str,
    base_url: &str,
    openai_endpoint: &str,
) -> Result<(RequestFormat, Option<String>)> {
    let base_url = normalize_request_url(base_url)?;
    match model_type.trim().to_ascii_lowercase().as_str() {
        "anthropic" => Ok((
            RequestFormat::Anthropic,
            url_path_ends_with(&base_url, "/messages").then_some(base_url),
        )),
        "openai" => {
            let detected = openai_protocol_from_url(&base_url);
            let configured = match openai_endpoint.trim() {
                "" | OPENAI_RESPONSES_ENDPOINT => RequestFormat::OpenAiResponses,
                OPENAI_CHAT_ENDPOINT | "/custom" => RequestFormat::OpenAiChat,
                value => {
                    return Err(Error::Config(format!(
                        "unsupported v0.0.49 OpenAI endpoint: {value}"
                    )))
                }
            };
            let use_full_url = detected.is_some() || openai_endpoint.trim() == "/custom";
            Ok((
                detected.unwrap_or(configured),
                use_full_url.then_some(base_url),
            ))
        }
        value => Err(Error::Config(format!(
            "unsupported v0.0.49 model type: {value}"
        ))),
    }
}

fn legacy_base_url(full_url: &str) -> Result<String> {
    let url = reqwest::Url::parse(full_url)
        .map_err(|error| Error::Config(format!("invalid legacy URL: {error}")))?;
    let path = url.path().trim_end_matches('/');
    let lower_path = path.to_ascii_lowercase();
    let prefix = ["/chat/completions", "/responses", "/messages"]
        .iter()
        .find_map(|suffix| {
            lower_path
                .strip_suffix(suffix)
                .map(|prefix| &path[..prefix.len()])
        })
        .unwrap_or_default();
    Ok(format!("{}{prefix}", &url[..url::Position::BeforePath]))
}

fn openai_protocol_from_url(value: &str) -> Option<RequestFormat> {
    let url = reqwest::Url::parse(value).ok()?;
    let path = url.path().trim_end_matches('/');
    if path.to_ascii_lowercase().ends_with("/responses") {
        Some(RequestFormat::OpenAiResponses)
    } else if path.to_ascii_lowercase().ends_with("/chat/completions") {
        Some(RequestFormat::OpenAiChat)
    } else {
        None
    }
}

fn url_path_ends_with(value: &str, suffix: &str) -> bool {
    reqwest::Url::parse(value).is_ok_and(|url| {
        url.path()
            .trim_end_matches('/')
            .to_ascii_lowercase()
            .ends_with(suffix)
    })
}

fn enabled_json_object(enabled: bool, value: &str) -> Result<serde_json::Value> {
    if enabled {
        json_object(value)
    } else {
        Ok(serde_json::json!({}))
    }
}

fn json_object(value: &str) -> Result<serde_json::Value> {
    if value.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }
    let value: serde_json::Value = serde_json::from_str(value)?;
    if value.is_object() {
        Ok(value)
    } else {
        Err(Error::Config(
            "v0.0.49 model JSON fields must be objects".into(),
        ))
    }
}

fn positive(value: u64) -> Option<u64> {
    (value > 0).then_some(value)
}

fn optional_string(value: String) -> Option<String> {
    (!value.trim().is_empty()).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn imported_models_keep_their_connection_groups_and_are_deduplicated() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("import.db").display()
        ))
        .await
        .unwrap();
        let config_path = directory.path().join("config.yaml");
        std::fs::write(
            &config_path,
            r#"
modelAdapters:
  - displayName: Shared name
    type: openai
    baseURL: https://example.com/v1
    apiKey: test-key
    modelID: model-1
    openAIEndpoint: /v1/responses
    openAIExtraParamsEnabled: true
    openAIExtraParamsJSON: '{"temperature":0.25}'
  - displayName: Shared name
    type: anthropic
    baseURL: https://example.com/v1/messages?route=2
    apiKey: test-key
    modelID: model-1
"#,
        )
        .unwrap();

        let result = store.import_v0049_model_config(&config_path).await.unwrap();
        assert_eq!((result.imported, result.skipped), (2, 0));
        let models = store.models().await.unwrap();
        assert_ne!(models[0].provider_id, models[1].provider_id);
        let responses = models
            .iter()
            .find(|model| model.request_format == RequestFormat::OpenAiResponses)
            .unwrap();
        assert_eq!(
            responses.request_url().unwrap(),
            "https://example.com/v1/responses"
        );
        assert_eq!(responses.extra_params()["temperature"], 0.25);
        let anthropic = models
            .iter()
            .find(|model| model.request_format == RequestFormat::Anthropic)
            .unwrap();
        assert_eq!(anthropic.base_url, "https://example.com/v1");
        assert_eq!(
            anthropic.request_url().unwrap(),
            "https://example.com/v1/messages?route=2"
        );

        let result = store.import_v0049_model_config(&config_path).await.unwrap();
        assert_eq!((result.imported, result.skipped), (0, 2));
        assert_eq!(store.providers().await.unwrap().len(), 2);
    }
}
