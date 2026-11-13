//! Encodes and decodes Cursor model variant legacy slugs.

use crate::{
    cursor::{
        protocol::proto::{agent::v1 as agent, inference as pb},
        transport::TransportRegistry,
    },
    model::{format_token_count, parse_token_count, ModelConfig, ModelLatency, ModelSpec},
    plugin::{parse_model_id, ADAPTER_ID_PREFIX},
    Result,
};

pub(crate) const CONTEXTS: [(&str, &str); 5] = [
    ("200k", "200K"),
    ("356k", "356K"),
    ("500k", "500K"),
    ("800k", "800K"),
    ("1m", "1M"),
];

pub(crate) const EFFORTS: [(&str, &str); 5] = [
    ("low", "Low"),
    ("medium", "Medium"),
    ("high", "High"),
    ("xhigh", "Extra High"),
    ("max", "Max"),
];

pub(crate) const DEFAULT_CONTEXT: &str = "200k";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct VariantParameters {
    pub context: String,
    pub effort: String,
    pub fast: bool,
}

pub(crate) struct ResolvedCursorModel {
    pub base_model_id: String,
    pub configured: Option<ModelConfig>,
    pub local: bool,
    pub variant: Option<VariantParameters>,
}

/// Lists the context options published for a model in `AvailableModels`.
pub(crate) fn context_options(context_window_tokens: Option<u64>) -> Vec<(String, String)> {
    let mut contexts = CONTEXTS
        .into_iter()
        .map(|(value, display_name)| (value.to_owned(), display_name.to_owned()))
        .collect::<Vec<_>>();
    if let Some(tokens) = context_window_tokens {
        let value = tokens.to_string();
        let duplicate = contexts
            .iter()
            .any(|(existing, _)| parse_token_count(existing) == Some(tokens));
        if !duplicate {
            contexts.push((value, format!("{} (Custom)", format_token_count(tokens))));
        }
    }
    contexts
}

/// Formats a Cursor `legacy_slug` matching `AvailableModels` variant entries.
pub(crate) fn legacy_slug(
    base_id: &str,
    context: &str,
    effort: Option<&str>,
    fast: bool,
) -> String {
    format!(
        "{base_id}-{context}{}{}",
        effort
            .map(|effort| format!("-{effort}"))
            .unwrap_or_default(),
        if fast { "-fast" } else { "" }
    )
}

/// Encodes an effective model selection as an `AvailableModels` legacy slug when an exact variant exists.
pub(crate) fn encode_legacy_slug(
    base_id: &str,
    configured_context_tokens: Option<u64>,
    model: &ModelSpec,
) -> Option<String> {
    if model.reasoning.enabled_override == Some(false) || !model.reasoning.enabled {
        return None;
    }
    let effort = model.reasoning.effort.as_deref()?;
    if !EFFORTS.iter().any(|(known, _)| *known == effort) {
        return None;
    }
    let contexts = context_options(configured_context_tokens);
    let context = match model.context_window_tokens.or(configured_context_tokens) {
        Some(tokens) => contexts
            .iter()
            .find(|(value, _)| parse_token_count(value) == Some(tokens))?
            .0
            .as_str(),
        None => DEFAULT_CONTEXT,
    };
    Some(legacy_slug(
        base_id,
        context,
        Some(effort),
        model.latency == ModelLatency::Fast,
    ))
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ParsedVariant<'a> {
    base_id: &'a str,
    context: &'a str,
    effort: &'a str,
    fast: bool,
}

fn parse_legacy_slug(value: &str) -> Option<ParsedVariant<'_>> {
    let (rest, fast) = match value.strip_suffix("-fast") {
        Some(rest) => (rest, true),
        None => (value, false),
    };
    let (rest, effort) = rest.rsplit_once('-')?;
    if !EFFORTS.iter().any(|(known, _)| *known == effort) {
        return None;
    }
    let (base_id, context) = rest.rsplit_once('-')?;
    if base_id.is_empty() || !is_context_token(context) {
        return None;
    }
    Some(ParsedVariant {
        base_id,
        context,
        effort,
        fast,
    })
}

fn is_context_token(value: &str) -> bool {
    CONTEXTS.iter().any(|(known, _)| *known == value)
        || (!value.is_empty()
            && value.bytes().all(|byte| byte.is_ascii_digit())
            && value.parse::<u64>().ok().is_some_and(|tokens| tokens > 0))
}

/// Resolves a Cursor model ID (base ID or variant legacy slug) to its configured base model.
pub(crate) async fn resolve_cursor_model(
    registry: &TransportRegistry,
    model_id: &str,
) -> Result<ResolvedCursorModel> {
    if model_id.starts_with(ADAPTER_ID_PREFIX) {
        return resolve_plugin_model(registry, model_id).await;
    }
    if let Some(model) = registry.store().model(model_id).await? {
        return Ok(ResolvedCursorModel {
            base_model_id: model_id.into(),
            configured: Some(model),
            local: true,
            variant: None,
        });
    }
    if let Some(parsed) = parse_legacy_slug(model_id) {
        if let Some(model) = registry.store().model(parsed.base_id).await? {
            if context_options(model.context_window_tokens)
                .iter()
                .any(|(value, _)| value == parsed.context)
            {
                return Ok(ResolvedCursorModel {
                    base_model_id: parsed.base_id.into(),
                    configured: Some(model),
                    local: true,
                    variant: Some(VariantParameters {
                        context: parsed.context.into(),
                        effort: parsed.effort.into(),
                        fast: parsed.fast,
                    }),
                });
            }
        }
    }
    Ok(ResolvedCursorModel {
        base_model_id: model_id.into(),
        configured: None,
        local: false,
        variant: None,
    })
}

async fn resolve_plugin_model(
    registry: &TransportRegistry,
    model_id: &str,
) -> Result<ResolvedCursorModel> {
    if let Some(plugins) = registry.plugins() {
        if plugins.model_descriptor(model_id).await.is_ok() {
            return Ok(ResolvedCursorModel {
                base_model_id: model_id.into(),
                configured: None,
                local: true,
                variant: None,
            });
        }
        if let Some(parsed) = parse_legacy_slug(model_id) {
            if CONTEXTS.iter().any(|(known, _)| *known == parsed.context)
                && parse_model_id(parsed.base_id).is_some()
                && plugins.model_descriptor(parsed.base_id).await.is_ok()
            {
                return Ok(ResolvedCursorModel {
                    base_model_id: parsed.base_id.into(),
                    configured: None,
                    local: true,
                    variant: Some(VariantParameters {
                        context: parsed.context.into(),
                        effort: parsed.effort.into(),
                        fast: parsed.fast,
                    }),
                });
            }
        }
    }
    Ok(ResolvedCursorModel {
        base_model_id: model_id.into(),
        configured: None,
        local: true,
        variant: None,
    })
}

fn missing_variant_parameters(
    existing_ids: impl Iterator<Item = impl AsRef<str>>,
    variant: &VariantParameters,
) -> Vec<(&'static str, String)> {
    let mut has_context = false;
    let mut has_fast = false;
    let mut has_reasoning = false;
    for id in existing_ids {
        match id.as_ref() {
            "context" => has_context = true,
            "fast" => has_fast = true,
            "reasoning" | "effort" => has_reasoning = true,
            _ => {}
        }
    }
    let mut defaults = Vec::with_capacity(3);
    if !has_context {
        defaults.push(("context", variant.context.clone()));
    }
    if !has_reasoning {
        defaults.push(("reasoning", variant.effort.clone()));
    }
    if !has_fast {
        defaults.push(("fast", variant.fast.to_string()));
    }
    defaults
}

fn prepend_variant_parameters<T>(
    parameters: &mut Vec<T>,
    id_of: impl Fn(&T) -> &str,
    build: impl Fn(&'static str, String) -> T,
    variant: &VariantParameters,
) {
    // Prepend variant defaults so explicit overrides (including `thinking=false`) take precedence.
    let mut combined = missing_variant_parameters(parameters.iter().map(id_of), variant)
        .into_iter()
        .map(|(id, value)| build(id, value))
        .collect::<Vec<_>>();
    combined.append(parameters);
    *parameters = combined;
}

/// Canonicalizes `RunInference` requested model ID and fills missing variant parameters.
pub(crate) fn apply_to_inference_model(
    requested: &pb::InferenceRequestedModel,
    resolved: &ResolvedCursorModel,
) -> pb::InferenceRequestedModel {
    let mut normalized = requested.clone();
    normalized.model_id = resolved.base_model_id.clone();
    if let Some(variant) = &resolved.variant {
        prepend_variant_parameters(
            &mut normalized.parameters,
            |parameter| parameter.id.as_str(),
            |id, value| pb::InferenceModelParameterValue {
                id: id.into(),
                value,
            },
            variant,
        );
    }
    normalized
}

/// Canonicalizes `AgentService` run request model IDs and fills missing variant parameters.
pub(crate) fn apply_to_agent_run_request(
    request: &mut agent::AgentRunRequest,
    resolved: &ResolvedCursorModel,
) {
    if let Some(variant) = &resolved.variant {
        let requested = request
            .requested_model
            .get_or_insert_with(|| agent::RequestedModel {
                model_id: resolved.base_model_id.clone(),
                ..Default::default()
            });
        requested.model_id = resolved.base_model_id.clone();
        prepend_variant_parameters(
            &mut requested.parameters,
            |parameter| parameter.id.as_str(),
            |id, value| agent::requested_model::ModelParameterValue {
                id: id.into(),
                value,
            },
            variant,
        );
    } else if let Some(requested) = request.requested_model.as_mut() {
        if !requested.model_id.is_empty() {
            requested.model_id = resolved.base_model_id.clone();
        }
    }
    if let Some(details) = request.model_details.as_mut() {
        if !details.model_id.is_empty() {
            details.model_id = resolved.base_model_id.clone();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_and_parses_preset_custom_and_fast_legacy_slugs() {
        let mut spec = ModelSpec::new("hash-1");
        spec.reasoning.enabled = true;
        spec.reasoning.effort = Some("xhigh".into());
        spec.context_window_tokens = Some(1_000_000);
        let slug = encode_legacy_slug("hash-1", Some(258_000), &spec).unwrap();
        assert_eq!(slug, "hash-1-1m-xhigh");
        assert_eq!(
            parse_legacy_slug(&slug),
            Some(ParsedVariant {
                base_id: "hash-1",
                context: "1m",
                effort: "xhigh",
                fast: false,
            })
        );

        spec.context_window_tokens = Some(258_000);
        spec.latency = ModelLatency::Fast;
        spec.reasoning.effort = Some("low".into());
        let custom = encode_legacy_slug("plugin:p/prov/gpt-5", None, &spec);
        assert_eq!(custom, None);
        let custom_db = encode_legacy_slug("hash-1", Some(258_000), &spec).unwrap();
        assert_eq!(custom_db, "hash-1-258000-low-fast");
        assert_eq!(
            parse_legacy_slug(&custom_db),
            Some(ParsedVariant {
                base_id: "hash-1",
                context: "258000",
                effort: "low",
                fast: true,
            })
        );
    }

    #[test]
    fn encode_skips_disabled_thinking_or_unlisted_contexts() {
        let mut spec = ModelSpec::new("hash-1");
        assert_eq!(encode_legacy_slug("hash-1", None, &spec), None);

        spec.reasoning.enabled = true;
        spec.reasoning.effort = Some("high".into());
        spec.reasoning.enabled_override = Some(false);
        assert_eq!(encode_legacy_slug("hash-1", None, &spec), None);

        spec.reasoning.enabled_override = Some(true);
        spec.context_window_tokens = Some(128_000);
        assert_eq!(encode_legacy_slug("hash-1", Some(258_000), &spec), None);

        spec.context_window_tokens = None;
        assert_eq!(
            encode_legacy_slug("hash-1", Some(258_000), &spec).as_deref(),
            Some("hash-1-258000-high")
        );
        assert_eq!(
            encode_legacy_slug("plugin:p/prov/gpt-5", None, &spec).as_deref(),
            Some("plugin:p/prov/gpt-5-200k-high")
        );
    }

    #[test]
    fn thinking_override_preserves_variant_effort_or_disables_reasoning() {
        let resolved = ResolvedCursorModel {
            base_model_id: "hash-1".into(),
            configured: None,
            local: true,
            variant: Some(VariantParameters {
                context: "1m".into(),
                effort: "xhigh".into(),
                fast: false,
            }),
        };

        let with_thinking_true = pb::InferenceRequestedModel {
            model_id: "hash-1-1m-xhigh".into(),
            parameters: vec![pb::InferenceModelParameterValue {
                id: "thinking".into(),
                value: "true".into(),
            }],
            ..Default::default()
        };
        let applied_true = apply_to_inference_model(&with_thinking_true, &resolved);
        let mut spec_true = ModelSpec::new(&applied_true.model_id);
        crate::cursor::model_selection::apply(
            &mut spec_true,
            applied_true
                .parameters
                .iter()
                .map(|p| (p.id.as_str(), p.value.as_str())),
        )
        .unwrap();
        assert!(spec_true.reasoning.enabled);
        assert_eq!(spec_true.reasoning.effort.as_deref(), Some("xhigh"));
        assert_eq!(spec_true.context_window_tokens, Some(1_000_000));

        let with_thinking_false = pb::InferenceRequestedModel {
            model_id: "hash-1-1m-xhigh".into(),
            parameters: vec![pb::InferenceModelParameterValue {
                id: "thinking".into(),
                value: "false".into(),
            }],
            ..Default::default()
        };
        let applied_false = apply_to_inference_model(&with_thinking_false, &resolved);
        let mut spec_false = ModelSpec::new(&applied_false.model_id);
        crate::cursor::model_selection::apply(
            &mut spec_false,
            applied_false
                .parameters
                .iter()
                .map(|p| (p.id.as_str(), p.value.as_str())),
        )
        .unwrap();
        assert!(!spec_false.reasoning.enabled);
        assert_eq!(spec_false.reasoning.enabled_override, Some(false));
        assert_eq!(spec_false.reasoning.effort, None);
    }
}
