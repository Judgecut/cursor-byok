//! Parses public catalog data and enforces strict endpoint + exact model matching.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use url::Url;

use crate::{Error, Result};

use super::{
    calculator::{PricingRates, PricingSnapshot, PricingSource},
    decimal::parse_json_price,
    identity::{SourceKind, SupplierIdentity},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogModel {
    pub provider_id: String,
    pub provider_name: String,
    pub provider_api: Option<String>,
    pub model_id: String,
    pub model_name: String,
    pub rates: PricingRates,
    pub synced_at_ms: i64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BindingMode {
    #[default]
    Auto,
    Manual,
}

impl BindingMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Manual => "manual",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "auto" => Ok(Self::Auto),
            "manual" => Ok(Self::Manual),
            _ => Err(Error::Config(format!(
                "unsupported pricing binding mode: {value}"
            ))),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelPricingConfig {
    pub supplier_key: String,
    pub source_kind: SourceKind,
    pub endpoint_key: String,
    pub model_id: String,
    pub binding_mode: BindingMode,
    pub catalog_provider_id: Option<String>,
    pub catalog_model_id: Option<String>,
    pub custom_rates: PricingRates,
    pub updated_at_ms: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CatalogMatchKind {
    Manual,
    ManualMissing,
    AutoExact,
    AutoUnique,
    AutoDefault,
    None,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedPricing {
    pub snapshot: PricingSnapshot,
    pub binding_mode: BindingMode,
    pub catalog_match_kind: CatalogMatchKind,
    pub catalog_entry: Option<CatalogModel>,
    pub configured_catalog_ref: Option<(String, String)>,
    pub custom_rates: PricingRates,
}

pub fn parse_models_dev_catalog(bytes: &[u8], synced_at_ms: i64) -> Result<Vec<CatalogModel>> {
    let root: BTreeMap<String, serde_json::Value> = serde_json::from_slice(bytes)
        .map_err(|error| Error::Provider(format!("invalid models.dev catalog JSON: {error}")))?;
    let mut entries = Vec::new();
    for (provider_key, provider_value) in root {
        let Some(provider_obj) = provider_value.as_object() else {
            continue;
        };
        let provider_id = provider_obj
            .get("id")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .unwrap_or(provider_key.trim());
        if provider_id.is_empty() {
            continue;
        }
        let provider_name = provider_obj
            .get("name")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or(provider_id);
        let provider_api = provider_obj
            .get("api")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|api| !api.is_empty())
            .map(normalize_api_url);
        let Some(models_obj) = provider_obj
            .get("models")
            .and_then(serde_json::Value::as_object)
        else {
            continue;
        };

        for (model_key, model_value) in models_obj {
            let Some(model_obj) = model_value.as_object() else {
                continue;
            };
            let model_id = model_obj
                .get("id")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .unwrap_or(model_key.trim());
            if model_id.is_empty() {
                continue;
            }
            let model_name = model_obj
                .get("name")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .unwrap_or(model_id);
            let Some(cost_obj) = model_obj.get("cost").and_then(serde_json::Value::as_object)
            else {
                continue;
            };
            let rates = PricingRates {
                input_per_million: cost_obj.get("input").and_then(parse_json_price),
                output_per_million: cost_obj.get("output").and_then(parse_json_price),
                cache_read_per_million: cost_obj.get("cache_read").and_then(parse_json_price),
                cache_write_per_million: cost_obj.get("cache_write").and_then(parse_json_price),
            };
            if !rates.has_any() {
                continue;
            }
            entries.push(CatalogModel {
                provider_id: provider_id.to_owned(),
                provider_name: provider_name.to_owned(),
                provider_api: provider_api.clone(),
                model_id: model_id.to_owned(),
                model_name: model_name.to_owned(),
                rates,
                synced_at_ms,
            });
        }
    }

    if entries.is_empty() {
        return Err(Error::Provider(
            "models.dev catalog returned no priced models".into(),
        ));
    }
    Ok(entries)
}

pub fn resolve_supplier_pricing(
    identity: &SupplierIdentity,
    config: Option<&ModelPricingConfig>,
    exact_model_candidates: &[CatalogModel],
    manual_catalog_entry: Option<CatalogModel>,
    now_ms: i64,
) -> ResolvedPricing {
    let binding_mode = config.map_or(BindingMode::Auto, |item| item.binding_mode);
    let custom_rates = config
        .map(|item| item.custom_rates.clone())
        .unwrap_or_default();
    let configured_catalog_ref = config.and_then(|item| {
        item.catalog_provider_id
            .clone()
            .zip(item.catalog_model_id.clone())
    });

    let (catalog_match_kind, catalog_entry) = match binding_mode {
        BindingMode::Manual => match manual_catalog_entry {
            Some(entry) => (CatalogMatchKind::Manual, Some(entry)),
            None => (CatalogMatchKind::ManualMissing, None),
        },
        BindingMode::Auto => auto_match(identity, exact_model_candidates),
    };

    let snapshot = if custom_rates.has_any() {
        PricingSnapshot {
            source: PricingSource::Custom,
            provider_id: catalog_entry
                .as_ref()
                .map(|entry| entry.provider_id.clone()),
            model_id: catalog_entry.as_ref().map(|entry| entry.model_id.clone()),
            snapshot_at_ms: now_ms,
            rates: catalog_entry.as_ref().map_or_else(
                || custom_rates.clone(),
                |entry| custom_rates.with_fallback(&entry.rates),
            ),
        }
    } else if let Some(entry) = &catalog_entry {
        PricingSnapshot {
            source: PricingSource::Catalog,
            provider_id: Some(entry.provider_id.clone()),
            model_id: Some(entry.model_id.clone()),
            snapshot_at_ms: now_ms,
            rates: entry.rates.clone(),
        }
    } else {
        PricingSnapshot::unpriced(now_ms)
    };

    ResolvedPricing {
        snapshot,
        binding_mode,
        catalog_match_kind,
        catalog_entry,
        configured_catalog_ref,
        custom_rates,
    }
}

fn auto_match(
    identity: &SupplierIdentity,
    candidates: &[CatalogModel],
) -> (CatalogMatchKind, Option<CatalogModel>) {
    if candidates.is_empty() {
        return (CatalogMatchKind::None, None);
    }

    if identity.source_kind == SourceKind::Builtin {
        let endpoint_matches: Vec<&CatalogModel> = candidates
            .iter()
            .filter(|candidate| endpoint_matches_catalog(&identity.endpoint_key, candidate))
            .collect();
        if endpoint_matches.len() == 1 {
            return (
                CatalogMatchKind::AutoExact,
                Some(endpoint_matches[0].clone()),
            );
        }
        if endpoint_matches.len() > 1 {
            if let Some(best) = select_preferred_candidate(endpoint_matches.iter().copied()) {
                return (CatalogMatchKind::AutoExact, Some(best.clone()));
            }
        }
    }

    // Source endpoint did not uniquely identify the vendor (for example a relay URL or plugin).
    // Bind automatically using exact `model_id`: `AutoUnique` when a single entry exists, or
    // `AutoDefault` choosing the canonical public reference provider when multiple exist.
    if candidates.len() == 1 {
        return (CatalogMatchKind::AutoUnique, Some(candidates[0].clone()));
    }

    if let Some(best) = select_preferred_candidate(candidates.iter()) {
        return (CatalogMatchKind::AutoDefault, Some(best.clone()));
    }

    (CatalogMatchKind::None, None)
}

const REFERENCE_PROVIDER_PRIORITY: &[&str] = &[
    // Reference hubs are tie-breakers only when the model creator is unavailable.
    "openrouter",
    "google-vertex",
    "google-vertex-anthropic",
    "azure",
    "azure-cognitive-services",
    "amazon-bedrock",
];

fn select_preferred_candidate<'a, I>(candidates: I) -> Option<&'a CatalogModel>
where
    I: IntoIterator<Item = &'a CatalogModel>,
{
    candidates.into_iter().min_by_key(|candidate| {
        (
            is_subscription_plan_provider(&candidate.provider_id),
            !(candidate.rates.input_per_million.is_some()
                && candidate.rates.output_per_million.is_some()),
            model_creator_rank(&candidate.model_id, &candidate.provider_id),
            reference_provider_rank(&candidate.provider_id),
            std::cmp::Reverse(populated_rate_count(&candidate.rates)),
            candidate.provider_id.as_str(),
        )
    })
}

fn model_creator_rank(model_id: &str, provider_id: &str) -> usize {
    let normalized = model_id.to_ascii_lowercase();
    let model = normalized.rsplit('/').next().unwrap_or(&normalized);
    // A provider can also resell another creator's models. Recognize the model family
    // before preferring a first-party provider; a global vendor order cannot do that.
    let creators: &[&str] = if model.starts_with("gpt-")
        || model.starts_with("chatgpt-")
        || ["o1", "o3", "o4"]
            .iter()
            .any(|prefix| model == *prefix || model.starts_with(&format!("{prefix}-")))
    {
        &["openai"]
    } else if model.starts_with("claude-") {
        &["anthropic"]
    } else if model.starts_with("gemini-") || model.starts_with("gemma-") {
        &["google"]
    } else if model.starts_with("deepseek-") {
        &["deepseek"]
    } else if model.starts_with("grok-") {
        &["xai"]
    } else if model.starts_with("glm-") {
        &["zai", "zhipuai"]
    } else if model.starts_with("kimi-") || model.starts_with("moonshot-") {
        &["moonshotai", "moonshotai-cn"]
    } else if model.starts_with("qwen") || model.starts_with("qwq-") || model.starts_with("qvq-") {
        &["alibaba", "alibaba-cn"]
    } else if model.starts_with("minimax-") {
        &["minimax", "minimax-cn"]
    } else if [
        "mistral-",
        "mixtral-",
        "magistral-",
        "ministral-",
        "codestral-",
        "devstral-",
        "pixtral-",
        "voxtral-",
    ]
    .iter()
    .any(|prefix| model.starts_with(prefix))
    {
        &["mistral"]
    } else if model.starts_with("command-") {
        &["cohere"]
    } else {
        &[]
    };
    creators
        .iter()
        .position(|creator| *creator == provider_id)
        .unwrap_or(usize::MAX)
}

fn is_subscription_plan_provider(provider_id: &str) -> bool {
    provider_id.contains("-coding-plan")
        || provider_id.contains("-token-plan")
        || provider_id.contains("-code-plan")
}

fn reference_provider_rank(provider_id: &str) -> usize {
    REFERENCE_PROVIDER_PRIORITY
        .iter()
        .position(|candidate| *candidate == provider_id)
        .unwrap_or(usize::MAX)
}

fn populated_rate_count(rates: &PricingRates) -> usize {
    [
        rates.input_per_million.is_some(),
        rates.output_per_million.is_some(),
        rates.cache_read_per_million.is_some(),
        rates.cache_write_per_million.is_some(),
    ]
    .into_iter()
    .filter(|present| *present)
    .count()
}

fn endpoint_matches_catalog(endpoint_key: &str, candidate: &CatalogModel) -> bool {
    let Ok(endpoint_url) = Url::parse(endpoint_key) else {
        return false;
    };
    let Some(endpoint_host) = endpoint_url.host_str().map(str::to_ascii_lowercase) else {
        return false;
    };

    if let Some(provider_api) = candidate.provider_api.as_deref() {
        let Ok(api_url) = Url::parse(provider_api) else {
            return false;
        };
        let Some(api_host) = api_url.host_str().map(str::to_ascii_lowercase) else {
            return false;
        };
        if endpoint_host != api_host {
            return false;
        }
        let endpoint_path = endpoint_url.path().trim_end_matches('/');
        let api_path = api_url.path().trim_end_matches('/');
        return api_path.is_empty()
            || endpoint_path == api_path
            || endpoint_path.starts_with(&format!("{api_path}/"));
    }

    matches!(
        (endpoint_host.as_str(), candidate.provider_id.as_str()),
        ("api.openai.com", "openai")
            | ("api.anthropic.com", "anthropic")
            | ("generativelanguage.googleapis.com", "google")
            | ("api.x.ai", "xai")
            | ("api.deepseek.com", "deepseek")
            | ("api.mistral.ai", "mistral")
            | ("api.groq.com", "groq")
            | ("openrouter.ai", "openrouter")
    )
}

fn normalize_api_url(raw: &str) -> String {
    match Url::parse(raw) {
        Ok(mut url) => {
            url.set_fragment(None);
            let path = url.path().trim_end_matches('/').to_owned();
            if path.is_empty() {
                url.set_path("/");
            } else {
                url.set_path(&path);
            }
            url.into()
        }
        Err(_) => raw.trim().to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ProviderType;
    use crate::pricing::identity::canonical_supplier_identity;

    fn catalog_entry(
        provider_id: &str,
        provider_api: Option<&str>,
        model_id: &str,
        input: &str,
    ) -> CatalogModel {
        CatalogModel {
            provider_id: provider_id.into(),
            provider_name: provider_id.into(),
            provider_api: provider_api.map(String::from),
            model_id: model_id.into(),
            model_name: model_id.into(),
            rates: PricingRates {
                input_per_million: Some(input.into()),
                output_per_million: Some("10".into()),
                cache_read_per_million: None,
                cache_write_per_million: None,
            },
            synced_at_ms: 100,
        }
    }

    #[test]
    fn matches_by_endpoint_and_exact_model_id_only() {
        let identity = canonical_supplier_identity(
            ProviderType::OpenAiChat,
            "https://openrouter.ai/api/v1/chat/completions",
            "",
            "gpt-4o",
        );
        let candidates = vec![
            catalog_entry("openai", Some("https://api.openai.com/v1"), "gpt-4o", "2.5"),
            catalog_entry(
                "openrouter",
                Some("https://openrouter.ai/api/v1"),
                "gpt-4o",
                "2.8",
            ),
        ];
        let resolved = resolve_supplier_pricing(&identity, None, &candidates, None, 200);
        assert_eq!(resolved.catalog_match_kind, CatalogMatchKind::AutoExact);
        assert_eq!(resolved.snapshot.provider_id.as_deref(), Some("openrouter"));
        assert_eq!(
            resolved.snapshot.rates.input_per_million.as_deref(),
            Some("2.8")
        );
    }

    #[test]
    fn relay_model_uses_default_public_catalog_over_zero_plans_and_resellers() {
        let relay = canonical_supplier_identity(
            ProviderType::OpenAiChat,
            "https://relay.example.com/v1/chat/completions",
            "",
            "gpt-4o",
        );
        let mut free_plan = catalog_entry("openai-coding-plan", None, "gpt-4o", "0");
        free_plan.rates.output_per_million = Some("0".into());
        let candidates = vec![
            free_plan,
            catalog_entry("azure", None, "gpt-4o", "3.0"),
            catalog_entry("openai", Some("https://api.openai.com/v1"), "gpt-4o", "2.5"),
        ];
        let default_matched = resolve_supplier_pricing(&relay, None, &candidates, None, 200);
        assert_eq!(
            default_matched.catalog_match_kind,
            CatalogMatchKind::AutoDefault
        );
        assert_eq!(default_matched.snapshot.source, PricingSource::Catalog);
        assert_eq!(
            default_matched.snapshot.provider_id.as_deref(),
            Some("openai")
        );
        assert_eq!(
            default_matched.snapshot.rates.input_per_million.as_deref(),
            Some("2.5")
        );

        let unique = canonical_supplier_identity(
            ProviderType::Plugin,
            "plugin://dev.example/provider",
            "",
            "unique-model-v1",
        );
        let resolved_unique = resolve_supplier_pricing(
            &unique,
            None,
            &[catalog_entry("vendor", None, "unique-model-v1", "1.2")],
            None,
            200,
        );
        assert_eq!(
            resolved_unique.catalog_match_kind,
            CatalogMatchKind::AutoUnique
        );
        assert_eq!(
            resolved_unique.snapshot.provider_id.as_deref(),
            Some("vendor")
        );

        let unknown = canonical_supplier_identity(
            ProviderType::OpenAiChat,
            "https://relay.example.com/v1/chat/completions",
            "",
            "non-existent-model",
        );
        let resolved_unknown = resolve_supplier_pricing(&unknown, None, &[], None, 200);
        assert_eq!(resolved_unknown.catalog_match_kind, CatalogMatchKind::None);
        assert_eq!(resolved_unknown.snapshot.source, PricingSource::Unpriced);
    }

    #[test]
    fn custom_override_takes_priority_and_clearing_restores_public_price() {
        let identity = canonical_supplier_identity(
            ProviderType::OpenAiResponses,
            "https://api.openai.com/v1/responses",
            "",
            "gpt-4o",
        );
        let candidates = vec![catalog_entry(
            "openai",
            Some("https://api.openai.com/v1"),
            "gpt-4o",
            "2.5",
        )];
        let custom_cfg = ModelPricingConfig {
            supplier_key: identity.supplier_key.clone(),
            source_kind: SourceKind::Builtin,
            endpoint_key: identity.endpoint_key.clone(),
            model_id: "gpt-4o".into(),
            binding_mode: BindingMode::Auto,
            catalog_provider_id: None,
            catalog_model_id: None,
            custom_rates: PricingRates {
                input_per_million: Some("0".into()),
                output_per_million: Some("0".into()),
                cache_read_per_million: None,
                cache_write_per_million: None,
            },
            updated_at_ms: 150,
        };
        let overridden =
            resolve_supplier_pricing(&identity, Some(&custom_cfg), &candidates, None, 200);
        assert_eq!(overridden.snapshot.source, PricingSource::Custom);
        assert_eq!(
            overridden.snapshot.rates.input_per_million.as_deref(),
            Some("0")
        );
        assert_eq!(overridden.catalog_match_kind, CatalogMatchKind::AutoExact);
    }

    #[test]
    fn default_public_price_belongs_to_the_model_creator_even_when_another_creator_resells_it() {
        for (model_id, creator_id, reseller_id) in [
            ("MiniMax-M2.5", "minimax", "alibaba-cn"),
            ("qwen3.5-plus", "alibaba", "minimax"),
            ("deepseek-chat", "deepseek", "openai"),
        ] {
            let identity = canonical_supplier_identity(
                ProviderType::Plugin,
                "plugin://test/provider",
                "",
                model_id,
            );
            let reseller = catalog_entry(reseller_id, None, model_id, "3");
            let mut creator = catalog_entry(creator_id, None, model_id, "1");
            creator.rates.cache_read_per_million = Some("0.1".into());
            for candidates in [
                vec![reseller.clone(), creator.clone()],
                vec![creator.clone(), reseller.clone()],
            ] {
                let resolved = resolve_supplier_pricing(&identity, None, &candidates, None, 200);
                assert_eq!(resolved.catalog_match_kind, CatalogMatchKind::AutoDefault);
                assert_eq!(resolved.snapshot.provider_id.as_deref(), Some(creator_id));
                assert_eq!(
                    resolved.snapshot.rates.cache_read_per_million.as_deref(),
                    Some("0.1")
                );
            }
        }
    }

    #[test]
    fn official_free_public_price_is_valid_and_exact_reseller_endpoints_still_win() {
        let mut official = catalog_entry(
            "zai",
            Some("https://api.z.ai/api/paas/v4"),
            "glm-4.7-flash",
            "0",
        );
        official.rates = PricingRates {
            input_per_million: Some("0".into()),
            output_per_million: Some("0".into()),
            cache_read_per_million: Some("0".into()),
            cache_write_per_million: Some("0".into()),
        };
        let reseller = catalog_entry(
            "cortecs",
            Some("https://api.cortecs.ai/v1"),
            "glm-4.7-flash",
            "0.08",
        );
        let plan = catalog_entry("zai-coding-plan", None, "glm-4.7-flash", "0");
        let candidates = vec![reseller, plan, official];
        let relay = canonical_supplier_identity(
            ProviderType::OpenAiChat,
            "https://relay.example.com/v1/chat/completions",
            "",
            "glm-4.7-flash",
        );
        let resolved = resolve_supplier_pricing(&relay, None, &candidates, None, 200);
        assert_eq!(resolved.snapshot.provider_id.as_deref(), Some("zai"));
        let usage = crate::model::Usage {
            input_tokens: Some(1000),
            output_tokens: Some(100),
            cache_read_tokens: Some(500),
            ..Default::default()
        };
        let cost =
            crate::pricing::calculate_cost(ProviderType::OpenAiChat, &usage, &resolved.snapshot)
                .unwrap();
        assert_eq!(cost.status, crate::pricing::CostStatus::Priced);
        assert_eq!(cost.total_cost_nano, Some(0));

        let direct = canonical_supplier_identity(
            ProviderType::OpenAiChat,
            "https://api.cortecs.ai/v1/chat/completions",
            "",
            "glm-4.7-flash",
        );
        let resolved = resolve_supplier_pricing(&direct, None, &candidates, None, 200);
        assert_eq!(resolved.catalog_match_kind, CatalogMatchKind::AutoExact);
        assert_eq!(resolved.snapshot.provider_id.as_deref(), Some("cortecs"));
    }

    #[test]
    fn partial_custom_rates_fallback_field_by_field_to_catalog() {
        let identity = canonical_supplier_identity(
            ProviderType::OpenAiResponses,
            "https://api.openai.com/v1/responses",
            "",
            "gpt-4o",
        );
        let mut catalog =
            catalog_entry("openai", Some("https://api.openai.com/v1"), "gpt-4o", "2.5");
        catalog.rates.cache_read_per_million = Some("1.25".into());
        catalog.rates.cache_write_per_million = Some("3.75".into());

        let partial_cfg = ModelPricingConfig {
            supplier_key: identity.supplier_key.clone(),
            source_kind: SourceKind::Builtin,
            endpoint_key: identity.endpoint_key.clone(),
            model_id: "gpt-4o".into(),
            binding_mode: BindingMode::Auto,
            catalog_provider_id: None,
            catalog_model_id: None,
            custom_rates: PricingRates {
                input_per_million: Some("9.99".into()),
                output_per_million: None,
                cache_read_per_million: Some("0".into()),
                cache_write_per_million: None,
            },
            updated_at_ms: 150,
        };

        let resolved =
            resolve_supplier_pricing(&identity, Some(&partial_cfg), &[catalog.clone()], None, 200);
        assert_eq!(resolved.snapshot.source, PricingSource::Custom);
        assert_eq!(resolved.snapshot.provider_id.as_deref(), Some("openai"));
        assert_eq!(resolved.snapshot.model_id.as_deref(), Some("gpt-4o"));
        assert_eq!(
            resolved.snapshot.rates,
            PricingRates {
                input_per_million: Some("9.99".into()),
                output_per_million: Some("10".into()),
                cache_read_per_million: Some("0".into()),
                cache_write_per_million: Some("3.75".into()),
            }
        );

        let mut manual_cfg = partial_cfg.clone();
        manual_cfg.binding_mode = BindingMode::Manual;
        manual_cfg.catalog_provider_id = Some("openai".into());
        manual_cfg.catalog_model_id = Some("gpt-4o".into());
        manual_cfg.custom_rates.output_per_million = Some("12".into());
        manual_cfg.custom_rates.input_per_million = None;
        let manual_resolved =
            resolve_supplier_pricing(&identity, Some(&manual_cfg), &[], Some(catalog), 210);
        assert_eq!(manual_resolved.catalog_match_kind, CatalogMatchKind::Manual);
        assert_eq!(
            manual_resolved.snapshot.rates,
            PricingRates {
                input_per_million: Some("2.5".into()),
                output_per_million: Some("12".into()),
                cache_read_per_million: Some("0".into()),
                cache_write_per_million: Some("3.75".into()),
            }
        );
    }

    #[test]
    fn parses_models_dev_json_rejecting_empty_or_malformed_costs() {
        let json = br#"{
          "openai": {
            "id": "openai",
            "name": "OpenAI",
            "api": "https://api.openai.com/v1",
            "models": {
              "gpt-5": {
                "id": "gpt-5",
                "name": "GPT-5",
                "cost": { "input": 1.25, "output": 10, "cache_read": 0.125 }
              },
              "unpriced": { "id": "unpriced", "name": "Unpriced" },
              "broken": { "id": "broken", "cost": { "input": -1 } }
            }
          }
        }"#;
        let parsed = parse_models_dev_catalog(json, 1_000).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].provider_id, "openai");
        assert_eq!(parsed[0].model_id, "gpt-5");
        assert_eq!(
            parsed[0].rates.cache_read_per_million.as_deref(),
            Some("0.125")
        );
    }
}
