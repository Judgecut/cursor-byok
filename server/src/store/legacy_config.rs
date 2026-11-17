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
        ModelConfigInput, ModelType, ProviderConfigInput, OPENAI_CHAT_ENDPOINT,
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
    pub model_type: ModelType,
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
        for provider in &existing_providers {
            let key = provider_match_key(
                provider.model_type,
                &provider.base_url,
                provider.use_full_url,
                &provider.api_key,
                &provider.openai_endpoint,
                provider.custom_headers_enabled,
                &provider.custom_headers,
                provider.extra_params_enabled,
                &provider.extra_params,
            )?;
            provider_ids_by_key
                .entry(key)
                .or_insert_with(|| provider.provider_id.clone());
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
                provider.model_type,
                &provider.base_url,
                provider.use_full_url,
                &provider.api_key,
                &provider.openai_endpoint,
                provider.custom_headers_enabled,
                &provider.custom_headers,
                provider.extra_params_enabled,
                &provider.extra_params,
            )?;
            let provider_id = if let Some(existing_id) = provider_ids_by_key.get(&key) {
                existing_id.clone()
            } else if let Some(planned_id) = planned_provider_ids.get(&key) {
                planned_id.clone()
            } else {
                let id = deterministic_provider_id(&key);
                planned_provider_ids.insert(key, id.clone());
                new_providers.push((id.clone(), provider.clone()));
                id
            };

            let model_input = normalize_model_input(
                &ModelConfigInput {
                    provider_id: provider_id.clone(),
                    sort_order: entry.sort_order,
                    display_name: entry.display_name,
                    tooltip_data: entry.tooltip_data,
                    model_id: entry.model_id,
                    reasoning_effort: entry.reasoning_effort,
                    context_window_tokens: entry.context_window_tokens,
                    max_output_tokens: entry.max_output_tokens,
                    anthropic_thinking_effort: entry.anthropic_thinking_effort,
                    thinking_budget_tokens: entry.thinking_budget_tokens,
                },
                provider.model_type,
            )?;

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
                    model_type: provider.model_type,
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
    let model_type = match model.model_type.trim().to_ascii_lowercase().as_str() {
        "openai" => ModelType::OpenAi,
        "anthropic" => ModelType::Anthropic,
        value => {
            return Err(Error::Config(format!(
                "unsupported v0.0.49 model type: {value}"
            )))
        }
    };
    let (base_url, openai_endpoint, use_full_url) =
        legacy_request_configuration(model_type, &model.base_url, &model.openai_endpoint)?;
    let (extra_params_enabled, extra_params) = match model_type {
        ModelType::OpenAi => (
            model.openai_extra_params_enabled,
            enabled_json_object(
                model.openai_extra_params_enabled,
                &model.openai_extra_params_json,
            )?,
        ),
        ModelType::Anthropic => (
            model.anthropic_extra_params_enabled,
            enabled_json_object(
                model.anthropic_extra_params_enabled,
                &model.anthropic_extra_params_json,
            )?,
        ),
    };
    let max_output_tokens = match model_type {
        ModelType::OpenAi => positive(model.max_completion_tokens),
        ModelType::Anthropic => {
            positive(model.anthropic_max_tokens).or_else(|| positive(model.max_completion_tokens))
        }
    };

    Ok(ParsedLegacyEntry {
        provider: ProviderConfigInput {
            sort_order: model.sort.max(0),
            name: host_label(&base_url),
            model_type,
            base_url,
            use_full_url,
            api_key: model.api_key,
            openai_endpoint,
            custom_headers_enabled: model.custom_headers_enabled,
            custom_headers: enabled_json_object(
                model.custom_headers_enabled,
                &model.custom_headers_json,
            )?,
            extra_params_enabled,
            extra_params,
        },
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
    model_type: ModelType,
    base_url: &str,
    use_full_url: bool,
    api_key: &str,
    openai_endpoint: &str,
    custom_headers_enabled: bool,
    custom_headers: &serde_json::Value,
    extra_params_enabled: bool,
    extra_params: &serde_json::Value,
) -> Result<ProviderMatchKey> {
    Ok(ProviderMatchKey {
        model_type: model_type.as_str(),
        base_url: base_url.to_owned(),
        use_full_url,
        api_key: api_key.to_owned(),
        openai_endpoint: openai_endpoint.to_owned(),
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
    model_type: ModelType,
    base_url: &str,
    openai_endpoint: &str,
) -> Result<(String, String, bool)> {
    let base_url = normalize_request_url(base_url)?;
    match model_type {
        ModelType::Anthropic => {
            let use_full_url = url_path_ends_with(&base_url, "/messages");
            Ok((base_url, String::new(), use_full_url))
        }
        ModelType::OpenAi => {
            let detected = openai_protocol_from_url(&base_url);
            let configured = match openai_endpoint.trim() {
                "" | OPENAI_RESPONSES_ENDPOINT => OPENAI_RESPONSES_ENDPOINT,
                OPENAI_CHAT_ENDPOINT => OPENAI_CHAT_ENDPOINT,
                "/custom" => OPENAI_CHAT_ENDPOINT,
                value => {
                    return Err(Error::Config(format!(
                        "unsupported v0.0.49 OpenAI endpoint: {value}"
                    )))
                }
            };
            let protocol = detected.unwrap_or(configured);
            let use_full_url = detected.is_some() || openai_endpoint.trim() == "/custom";
            Ok((base_url, protocol.into(), use_full_url))
        }
    }
}

fn openai_protocol_from_url(value: &str) -> Option<&'static str> {
    let url = reqwest::Url::parse(value).ok()?;
    let path = url.path().trim_end_matches('/');
    if path.to_ascii_lowercase().ends_with("/responses") {
        Some(OPENAI_RESPONSES_ENDPOINT)
    } else if path.to_ascii_lowercase().ends_with("/chat/completions") {
        Some(OPENAI_CHAT_ENDPOINT)
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
