//! Canonical supplier-model identity decoupled from API keys, display names, and model_hash.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

use crate::{model::ProviderType, Error, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Builtin,
    Plugin,
}

impl SourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Builtin => "builtin",
            Self::Plugin => "plugin",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "builtin" => Ok(Self::Builtin),
            "plugin" => Ok(Self::Plugin),
            _ => Err(Error::Config(format!(
                "unsupported pricing source kind: {value}"
            ))),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SupplierIdentity {
    pub supplier_key: String,
    pub source_kind: SourceKind,
    pub endpoint_key: String,
    pub model_id: String,
}

pub fn canonical_supplier_identity(
    provider_type: ProviderType,
    request_url: &str,
    provider_url: &str,
    model_id: &str,
) -> SupplierIdentity {
    let model_id = model_id.trim().to_owned();
    let raw_endpoint = if !request_url.trim().is_empty() {
        request_url.trim()
    } else {
        provider_url.trim()
    };

    if source_kind_for(provider_type, raw_endpoint) == SourceKind::Plugin {
        let endpoint_key = normalize_plugin_endpoint_key(raw_endpoint);
        let supplier_key = plugin_supplier_key(&endpoint_key, &model_id)
            .unwrap_or_else(|| hashed_supplier_key(SourceKind::Plugin, &endpoint_key, &model_id));
        return SupplierIdentity {
            supplier_key,
            source_kind: SourceKind::Plugin,
            endpoint_key,
            model_id,
        };
    }

    let endpoint_key = normalize_endpoint_key(raw_endpoint)
        .unwrap_or_else(|_| raw_endpoint.trim_end_matches('/').to_owned());
    let supplier_key = hashed_supplier_key(SourceKind::Builtin, &endpoint_key, &model_id);
    SupplierIdentity {
        supplier_key,
        source_kind: SourceKind::Builtin,
        endpoint_key,
        model_id,
    }
}

pub fn source_kind_for(provider_type: ProviderType, endpoint: &str) -> SourceKind {
    if provider_type == ProviderType::Plugin || endpoint.trim().starts_with("plugin://") {
        SourceKind::Plugin
    } else {
        SourceKind::Builtin
    }
}

/// Canonical supplier identity decoupled from models (`source_kind + endpoint_key`).
pub fn canonical_supplier_id(source_kind: SourceKind, endpoint_key: &str) -> String {
    format!("{}::{}", source_kind.as_str(), endpoint_key)
}

pub fn build_supplier_identity(
    source_kind: SourceKind,
    endpoint_key: &str,
    model_id: &str,
) -> Result<SupplierIdentity> {
    let model_id = model_id.trim().to_owned();
    if model_id.is_empty() {
        return Err(Error::Config("model_id cannot be empty".into()));
    }
    let normalized_endpoint = match source_kind {
        SourceKind::Builtin => normalize_endpoint_key(endpoint_key)?,
        SourceKind::Plugin => normalize_plugin_endpoint_key(endpoint_key),
    };
    let supplier_key = match source_kind {
        SourceKind::Plugin => {
            plugin_supplier_key(&normalized_endpoint, &model_id).unwrap_or_else(|| {
                hashed_supplier_key(SourceKind::Plugin, &normalized_endpoint, &model_id)
            })
        }
        SourceKind::Builtin => {
            hashed_supplier_key(SourceKind::Builtin, &normalized_endpoint, &model_id)
        }
    };
    Ok(SupplierIdentity {
        supplier_key,
        source_kind,
        endpoint_key: normalized_endpoint,
        model_id,
    })
}

pub fn normalize_endpoint_key(raw: &str) -> Result<String> {
    let trimmed = raw.trim();
    if trimmed.starts_with("plugin://") {
        return Ok(normalize_plugin_endpoint_key(trimmed));
    }
    let mut url = Url::parse(trimmed)
        .map_err(|error| Error::Config(format!("invalid endpoint URL '{trimmed}': {error}")))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(Error::Config(format!(
            "endpoint URL must be http(s) with host: {trimmed}"
        )));
    }
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_fragment(None);
    let path = url.path().to_owned();
    let normalized_path = if path.is_empty() {
        "/"
    } else if path.len() > 1 {
        path.trim_end_matches('/')
    } else {
        &path
    };
    let normalized_path = if normalized_path.is_empty() {
        "/"
    } else {
        normalized_path
    };
    if normalized_path != path {
        url.set_path(normalized_path);
    }
    Ok(url.into())
}

pub fn endpoint_host(endpoint_key: &str) -> Option<String> {
    if let Some(rest) = endpoint_key.strip_prefix("plugin://") {
        let plugin_id = rest.split('/').next().filter(|value| !value.is_empty())?;
        return Some(plugin_id.to_owned());
    }
    Url::parse(endpoint_key)
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
}

fn normalize_plugin_endpoint_key(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Some(rest) = trimmed.strip_prefix("plugin://") {
        let without_fragment = rest.split(['?', '#']).next().unwrap_or(rest);
        let cleaned = without_fragment.trim_matches('/');
        return format!("plugin://{cleaned}");
    }
    trimmed.to_owned()
}

fn plugin_supplier_key(endpoint_key: &str, model_id: &str) -> Option<String> {
    let rest = endpoint_key.strip_prefix("plugin://")?;
    let (plugin_id, provider_id) = rest.split_once('/')?;
    if plugin_id.is_empty()
        || provider_id.is_empty()
        || provider_id.contains('/')
        || model_id.is_empty()
    {
        return None;
    }
    Some(crate::plugin::model_id(plugin_id, provider_id, model_id))
}

fn hashed_supplier_key(source_kind: SourceKind, endpoint_key: &str, model_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(source_kind.as_str().as_bytes());
    hasher.update([0_u8]);
    hasher.update(endpoint_key.as_bytes());
    hasher.update([0_u8]);
    hasher.update(model_id.as_bytes());
    let digest = hasher.finalize();
    format!("{}:{}", source_kind.as_str(), hex::encode(&digest[..16]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_urls_without_api_key_display_name_or_model_hash() {
        let a = canonical_supplier_identity(
            ProviderType::OpenAiResponses,
            "HTTPS://API.OpenAI.com:443/v1/responses/",
            "",
            "gpt-5",
        );
        let b = canonical_supplier_identity(
            ProviderType::OpenAiResponses,
            "https://api.openai.com/v1/responses",
            "",
            "gpt-5",
        );
        assert_eq!(a, b);
        assert_eq!(a.endpoint_key, "https://api.openai.com/v1/responses");
        assert!(a.supplier_key.starts_with("builtin:"));

        let different_model = canonical_supplier_identity(
            ProviderType::OpenAiResponses,
            "https://api.openai.com/v1/responses",
            "",
            "gpt-5-mini",
        );
        assert_ne!(a.supplier_key, different_model.supplier_key);
    }

    #[test]
    fn preserves_plugin_model_identity_shape() {
        let plugin = canonical_supplier_identity(
            ProviderType::Plugin,
            "plugin://dev.example/codex",
            "plugin://dev.example/codex",
            "org/gpt-5",
        );
        assert_eq!(plugin.source_kind, SourceKind::Plugin);
        assert_eq!(plugin.endpoint_key, "plugin://dev.example/codex");
        assert_eq!(plugin.supplier_key, "plugin:dev.example/codex/org/gpt-5");
    }
}
