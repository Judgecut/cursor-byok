//! Defines model and provider configuration.
use std::{fmt, str::FromStr};

use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{Error, Result};

pub const OPENAI_RESPONSES_ENDPOINT: &str = "/v1/responses";
pub const OPENAI_CHAT_ENDPOINT: &str = "/v1/chat/completions";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum ProviderType {
    #[serde(rename = "openai-chat")]
    OpenAiChat,
    #[serde(rename = "openai-responses")]
    OpenAiResponses,
    #[serde(rename = "anthropic")]
    Anthropic,
    #[serde(rename = "gemini")]
    Gemini,
    /// 插件执行的调用;协议细节在插件内部,核心只按统一事件流记录。
    #[serde(rename = "plugin")]
    Plugin,
}

impl ProviderType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenAiChat => "openai-chat",
            Self::OpenAiResponses => "openai-responses",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
            Self::Plugin => "plugin",
        }
    }
}

impl fmt::Display for ProviderType {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for ProviderType {
    type Err = Error;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "openai-chat" => Ok(Self::OpenAiChat),
            "openai-responses" => Ok(Self::OpenAiResponses),
            "anthropic" => Ok(Self::Anthropic),
            "gemini" => Ok(Self::Gemini),
            "plugin" => Ok(Self::Plugin),
            _ => Err(Error::Config(format!("unsupported provider type: {value}"))),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RequestFormat
{
    #[serde(rename = "openai-chat")]
    OpenAiChat,
    #[serde(rename = "openai-responses")]
    OpenAiResponses,
    Anthropic,
    #[serde(rename = "gemini")]
    Gemini,
}

impl RequestFormat
{
    pub fn provider_type(self) -> ProviderType
    {
        match self
        {
            Self::OpenAiChat => ProviderType::OpenAiChat,
            Self::OpenAiResponses => ProviderType::OpenAiResponses,
            Self::Anthropic => ProviderType::Anthropic,
            Self::Gemini => ProviderType::Gemini,
        }
    }

    pub fn as_str(self) -> &'static str
    {
        self.provider_type().as_str()
    }

    fn endpoint(self) -> Option<&'static str>
    {
        match self
        {
            Self::OpenAiChat => Some(OPENAI_CHAT_ENDPOINT),
            Self::OpenAiResponses => Some(OPENAI_RESPONSES_ENDPOINT),
            Self::Anthropic => Some("/v1/messages"),
            Self::Gemini => None,
        }
    }
}

impl FromStr for RequestFormat
{
    type Err = Error;

    fn from_str(value: &str) -> Result<Self>
    {
        match value
        {
            "openai-chat" => Ok(Self::OpenAiChat),
            "openai-responses" => Ok(Self::OpenAiResponses),
            "anthropic" => Ok(Self::Anthropic),
            "gemini" => Ok(Self::Gemini),
            _ => Err(Error::Config(format!("unsupported request format: {value}"))),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ProviderConfigInput {
    #[serde(default)]
    pub sort_order: i64,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    #[serde(default)]
    pub custom_headers_enabled: bool,
    #[serde(default = "empty_object")]
    pub custom_headers: serde_json::Value,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProviderConfig {
    pub provider_id: String,
    pub sort_order: i64,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub custom_headers_enabled: bool,
    pub custom_headers: serde_json::Value,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ModelConfigInput {
    pub provider_id: String,
    pub request_format: RequestFormat,
    #[serde(default)]
    pub request_url_override: Option<String>,
    #[serde(default)]
    pub extra_params_enabled: bool,
    #[serde(default = "empty_object")]
    pub extra_params: serde_json::Value,
    #[serde(default)]
    pub sort_order: i64,
    pub display_name: String,
    pub tooltip_data: String,
    pub model_id: String,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    pub context_window_tokens: Option<u64>,
    pub max_output_tokens: Option<u64>,
    #[serde(default)]
    pub anthropic_thinking_effort: Option<String>,
    pub thinking_budget_tokens: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ModelConfig {
    pub model_hash: String,
    pub provider_id: String,
    pub provider_name: String,
    pub sort_order: i64,
    pub display_name: String,
    pub request_format: RequestFormat,
    pub request_url_override: Option<String>,
    pub base_url: String,
    pub api_key: String,
    pub custom_headers_enabled: bool,
    pub custom_headers: serde_json::Value,
    pub extra_params_enabled: bool,
    pub extra_params: serde_json::Value,
    pub tooltip_data: String,
    pub model_id: String,
    pub reasoning_effort: Option<String>,
    pub context_window_tokens: Option<u64>,
    pub max_output_tokens: Option<u64>,
    pub anthropic_thinking_effort: Option<String>,
    pub thinking_budget_tokens: Option<u64>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

impl ModelConfig {
    pub fn provider_type(&self) -> ProviderType {
        self.request_format.provider_type()
    }

    pub fn request_url(&self) -> Result<String> {
        resolve_request_url(self.request_format, &self.base_url, self.request_url_override.as_deref(), &self.model_id)
    }

    pub fn max_output_tokens(&self) -> Option<u64> {
        self.max_output_tokens
    }

    pub fn extra_params(&self) -> &serde_json::Value {
        if self.extra_params_enabled {
            &self.extra_params
        } else {
            empty_object_ref()
        }
    }

    pub fn configure(&self, model: &mut super::ModelSpec) {
        model.display_name = Some(self.display_name.clone());
        // A request-selected context is authoritative.  Use the saved model
        // value only when Cursor did not send a context parameter.
        if model.context_window_tokens.is_none() {
            model.context_window_tokens = self.context_window_tokens;
        }
        if model.reasoning.effort.is_none() && model.reasoning.enabled_override != Some(false) {
            model.reasoning.effort = match self.request_format {
                RequestFormat::OpenAiChat | RequestFormat::OpenAiResponses => self.reasoning_effort.clone(),
                RequestFormat::Gemini => None,
                RequestFormat::Anthropic => self
                    .anthropic_thinking_effort
                    .clone()
                    .or_else(|| Some("xhigh".into())),
            };
        }
        model.reasoning.enabled |= model.reasoning.effort.is_some();
    }
}

pub fn generate_provider_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..16].to_owned()
}

pub fn normalize_provider_input(input: &ProviderConfigInput) -> Result<ProviderConfigInput> {
    let name = required(&input.name, "provider name")?;
    let base_url = normalize_request_url(&input.base_url)?;
    let api_key = required(&input.api_key, "provider API key")?;
    validate_headers(&input.custom_headers)?;
    Ok(ProviderConfigInput {
        sort_order: input.sort_order.max(0),
        name,
        base_url,
        api_key,
        custom_headers_enabled: input.custom_headers_enabled,
        custom_headers: input.custom_headers.clone(),
    })
}

pub fn normalize_model_input(input: &ModelConfigInput) -> Result<ModelConfigInput>
{
    let provider_id = required(&input.provider_id, "provider id")?;
    let display_name = required(&input.display_name, "model display name")?;
    let tooltip_data = required(&input.tooltip_data, "model tooltip")?;
    let model_id = required(&input.model_id, "model id")?;
    let model_id = if input.request_format == RequestFormat::Gemini
    {
        required(model_id.strip_prefix("models/").unwrap_or(&model_id), "model id")?
    }
    else
    {
        model_id
    };
    let request_url_override = normalize_request_url_override(input.request_url_override.as_deref())?;
    validate_object(&input.extra_params, "model extra params")?;
    let reasoning_effort = match input.request_format {
        RequestFormat::OpenAiChat | RequestFormat::OpenAiResponses => normalize_effort(input.reasoning_effort.as_deref(), true)?,
        RequestFormat::Anthropic | RequestFormat::Gemini => None,
    };
    let anthropic_thinking_effort = match input.request_format {
        RequestFormat::Anthropic => Some(
            normalize_effort(
                input.anthropic_thinking_effort.as_deref().or(Some("xhigh")),
                false,
            )?
            .expect("Anthropic effort has a default"),
        ),
        RequestFormat::OpenAiChat | RequestFormat::OpenAiResponses | RequestFormat::Gemini => None,
    };
    let thinking_budget_tokens = positive(input.thinking_budget_tokens, "thinking budget")?;

    Ok(ModelConfigInput {
        provider_id,
        request_format: input.request_format,
        request_url_override,
        extra_params_enabled: input.extra_params_enabled,
        extra_params: input.extra_params.clone(),
        sort_order: input.sort_order.max(0),
        display_name,
        tooltip_data,
        model_id,
        reasoning_effort,
        context_window_tokens: positive(input.context_window_tokens, "context window")?,
        max_output_tokens: positive(input.max_output_tokens, "max output tokens")?,
        anthropic_thinking_effort,
        thinking_budget_tokens: match input.request_format {
            RequestFormat::Anthropic => thinking_budget_tokens,
            RequestFormat::OpenAiChat | RequestFormat::OpenAiResponses | RequestFormat::Gemini => None,
        },
    })
}

pub fn model_hash(input: &ModelConfigInput) -> Result<String> {
    let provider_id = required(&input.provider_id, "provider id")?;
    let model_id = required(&input.model_id, "model id")?;
    let display_name = required(&input.display_name, "model display name")?;
    let digest = Sha256::digest([provider_id, model_id, display_name].join("\n").as_bytes());
    Ok(hex::encode(&digest[..8]))
}

pub fn normalize_request_url(value: &str) -> Result<String> {
    let value = value.trim();
    let url = Url::parse(value)
        .map_err(|error| Error::Config(format!("invalid model request URL: {error}")))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(Error::Config(
            "model request URL must be an HTTP(S) URL with a host".into(),
        ));
    }
    if url.fragment().is_some() {
        return Err(Error::Config(
            "model request URL cannot contain a fragment".into(),
        ));
    }
    Ok(value.into())
}

pub(crate) fn normalize_request_url_override(value: Option<&str>) -> Result<Option<String>>
{
    value.map(str::trim).filter(|value| !value.is_empty()).map(normalize_request_url).transpose()
}

pub fn resolve_request_url(format: RequestFormat, base_url: &str, request_url_override: Option<&str>, model_id: &str) -> Result<String>
{
    let override_url = normalize_request_url_override(request_url_override)?;
    if let Some(endpoint) = format.endpoint()
    {
        return match override_url
        {
            Some(url) => Ok(url),
            None => append_standard_endpoint(&normalize_request_url(base_url)?, endpoint),
        };
    }

    let mut url = match override_url
    {
        Some(url) => Url::parse(&url).map_err(|error| Error::Config(format!("invalid Gemini endpoint: {error}")))?,
        None =>
        {
            let mut url = gemini_models_url(base_url, None)?;
            let model_id = model_id.strip_prefix("models/").unwrap_or(model_id);
            if model_id.is_empty() || !model_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
            {
                return Err(Error::Config("invalid Gemini model ID".into()));
            }
            url.path_segments_mut().expect("HTTP URL").push(&format!("{model_id}:streamGenerateContent"));
            url
        }
    };
    let query: Vec<_> = url.query_pairs().filter(|(key, _)| key != "alt").map(|(key, value)| (key.into_owned(), value.into_owned())).collect();
    url.query_pairs_mut().clear().extend_pairs(query).append_pair("alt", "sse");
    Ok(url.into())
}

pub(crate) fn gemini_models_url(base_url: &str, request_url_override: Option<&str>) -> Result<Url>
{
    if let Some(value) = normalize_request_url_override(request_url_override)?
    {
        let mut url = Url::parse(&value).map_err(|error| Error::Config(format!("invalid Gemini endpoint: {error}")))?;
        if let Some(collection) = gemini_model_collection(url.path())
        {
            let collection = collection.to_owned();
            url.set_path(&collection);
            url.set_query(None);
            return Ok(url);
        }
    }
    let mut url = Url::parse(&normalize_request_url(base_url)?).map_err(|error| Error::Config(format!("invalid Gemini base URL: {error}")))?;
    let path = url.path().trim_end_matches('/');
    let has_version = has_trailing_version(path) || path.ends_with("/v1beta") || path.ends_with("/v1alpha");
    let mut segments = url.path_segments_mut().expect("HTTP URL");
    segments.pop_if_empty();
    if !has_version
    {
        segments.push("v1beta");
    }
    segments.push("models");
    drop(segments);
    Ok(url)
}

pub(crate) fn gemini_model_collection(path: &str) -> Option<&str>
{
    let (collection, resource) = path.trim_end_matches('/').rsplit_once('/')?;
    (collection.ends_with("/models") && resource.ends_with(":streamGenerateContent")).then_some(collection)
}

fn append_standard_endpoint(base_url: &str, endpoint: &str) -> Result<String> {
    let mut url = Url::parse(base_url)
        .map_err(|error| Error::Config(format!("invalid model server URL: {error}")))?;
    let base_path = url.path().trim_end_matches('/').to_string();
    let endpoint = if has_trailing_version(&base_path) {
        endpoint.strip_prefix("/v1").unwrap_or(endpoint)
    } else {
        endpoint
    };
    url.set_path(&format!("{base_path}{endpoint}"));
    normalize_request_url(url.as_str())
}

fn has_trailing_version(path: &str) -> bool {
    let Some(segment) = path.rsplit('/').next() else {
        return false;
    };
    segment.strip_prefix('v').is_some_and(|digits| {
        !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
    })
}

pub fn is_sensitive_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "authorization" | "proxy-authorization" | "x-api-key" | "x-goog-api-key" | "api-key" | "cookie" | "set-cookie"
    )
}

fn normalize_effort(value: Option<&str>, allow_empty: bool) -> Result<Option<String>> {
    let value = value.unwrap_or_default().trim().to_ascii_lowercase();
    if value.is_empty() && allow_empty {
        return Ok(None);
    }
    if matches!(value.as_str(), "low" | "medium" | "high" | "xhigh" | "max") {
        Ok(Some(value))
    } else {
        Err(Error::Config(format!(
            "unsupported reasoning effort: {value}"
        )))
    }
}

fn positive(value: Option<u64>, label: &str) -> Result<Option<u64>> {
    match value {
        Some(0) => Err(Error::Config(format!("{label} must be greater than zero"))),
        value => Ok(value),
    }
}

fn required(value: &str, label: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() {
        Err(Error::Config(format!("{label} cannot be empty")))
    } else {
        Ok(value.into())
    }
}

fn validate_object(value: &serde_json::Value, label: &str) -> Result<()> {
    if value.is_object() {
        Ok(())
    } else {
        Err(Error::Config(format!("{label} must be a JSON object")))
    }
}

fn validate_headers(value: &serde_json::Value) -> Result<()> {
    validate_object(value, "custom headers")?;
    for (name, value) in value.as_object().expect("validated object") {
        if name.trim().is_empty() || !value.is_string() {
            return Err(Error::Config(
                "custom headers must have non-empty names and string values".into(),
            ));
        }
    }
    Ok(())
}

fn empty_object() -> serde_json::Value {
    serde_json::json!({})
}

fn empty_object_ref() -> &'static serde_json::Value {
    static EMPTY: std::sync::OnceLock<serde_json::Value> = std::sync::OnceLock::new();
    EMPTY.get_or_init(empty_object)
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReasoningSpec {
    pub enabled: bool,
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled_override: Option<bool>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelLatency {
    #[default]
    Standard,
    Fast,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ModelSpec {
    pub model_id: String,
    pub display_name: Option<String>,
    pub reasoning: ReasoningSpec,
    pub latency: ModelLatency,
    pub max_output_tokens: Option<u64>,
    pub context_window_tokens: Option<u64>,
    #[serde(default)]
    pub supports_image_generation: bool,
    #[serde(default)]
    pub extra_params: serde_json::Value,
}

impl ModelSpec {
    pub fn new(model_id: impl Into<String>) -> Self {
        Self {
            model_id: model_id.into(),
            display_name: None,
            reasoning: ReasoningSpec::default(),
            latency: ModelLatency::Standard,
            max_output_tokens: None,
            context_window_tokens: None,
            supports_image_generation: false,
            extra_params: serde_json::json!({}),
        }
    }
}
