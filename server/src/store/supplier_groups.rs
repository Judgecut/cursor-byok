//! Resolves statistics-level supplier groups from provider and model configuration.
//!
//! The overview statistics and supplier filter group by configured provider ID,
//! so a provider stays one row across request protocols and a rename preserves
//! its identity. Pricing keeps its
//! endpoint-level identity in `pricing::identity`.

use std::collections::{BTreeSet, HashMap};

use crate::model::{ModelConfig, ProviderConfig};
use crate::Result;

use super::Store;

const PLUGIN_ENDPOINT_SCHEME: &str = "plugin://";

/// The call-context endpoint used by the statistics queries, matching the
/// coalesce previously inlined in `overview`.
const ENDPOINT_SQL: &str =
    "COALESCE(NULLIF(endpoint_key, ''), NULLIF(request_url, ''), provider_url)";

/// One configured provider and its models.
#[derive(Clone, Debug)]
pub(crate) struct SupplierGroup {
    pub id: String,
    /// The provider whose name and URL are shown for the group.
    pub provider_id: String,
    pub label: String,
    pub base_url: String,
    pub provider_type: Option<String>,
    pub model_ids: BTreeSet<String>,
    hashes: Vec<String>,
}

impl SupplierGroup {
    /// Whether the group still has at least one configured model.
    pub(crate) fn is_active(&self) -> bool {
        !self.model_ids.is_empty()
    }
}

struct ProviderHost {
    group: usize,
    path: String,
}

/// Resolves every call endpoint to a statistic supplier group and renders the
/// grouping as one SQL `CASE` expression.
pub(crate) struct SupplierGroups {
    expr: String,
    groups: Vec<SupplierGroup>,
    by_id: HashMap<String, usize>,
    /// Longest `authority/path` prefixes, used when one host serves several
    /// configured providers.
    prefix_rules: Vec<(String, String)>,
    /// Whole-host mappings, used when the host has exactly one provider (or a
    /// single root-path provider).
    host_rules: Vec<(String, String)>,
}

impl SupplierGroups {
    pub(crate) fn new(providers: &[ProviderConfig], models: &[ModelConfig]) -> Self {
        let mut groups: Vec<SupplierGroup> = Vec::new();
        let mut by_id: HashMap<String, usize> = HashMap::new();
        let mut provider_index: HashMap<&str, usize> = HashMap::new();

        for provider in providers {
            let id = provider_group_id(&provider.provider_id);
            let index = groups.len();
            by_id.insert(id.clone(), index);
            provider_index.insert(provider.provider_id.as_str(), index);
            groups.push(SupplierGroup {
                id,
                provider_id: provider.provider_id.clone(),
                label: provider.name.trim().to_owned(),
                base_url: provider.base_url.trim().to_owned(),
                provider_type: None,
                model_ids: BTreeSet::new(),
                hashes: Vec::new(),
            });
        }

        for model in models {
            let Some(&index) = provider_index.get(model.provider_id.as_str()) else {
                continue;
            };
            let group = &mut groups[index];
            if group.provider_type.is_none() {
                group.provider_type = Some(model.request_format.as_str().to_owned());
            }
            group.model_ids.insert(model.model_id.clone());
            group.hashes.push(model.model_hash.clone());
        }

        let mut hosts: HashMap<String, Vec<ProviderHost>> = HashMap::new();
        for provider in providers {
            let Some(&group) = provider_index.get(provider.provider_id.as_str()) else {
                continue;
            };
            let (authority, path) = split_authority_path(&provider.base_url);
            if authority.is_empty() {
                continue;
            }
            hosts
                .entry(authority)
                .or_default()
                .push(ProviderHost { group, path });
        }

        let mut prefix_rules: Vec<(String, String)> = Vec::new();
        let mut host_rules: Vec<(String, String)> = Vec::new();
        for (authority, entries) in hosts {
            if entries.len() == 1 {
                host_rules.push((authority, groups[entries[0].group].id.clone()));
                continue;
            }

            // Several providers share the authority: only a path prefix can
            // disambiguate them, and an ambiguous prefix must not be guessed.
            let mut prefix_groups: HashMap<String, Option<String>> = HashMap::new();
            for entry in &entries {
                if entry.path.is_empty() {
                    continue;
                }
                let key = format!("{authority}{}/", entry.path);
                let group_id = groups[entry.group].id.clone();
                match prefix_groups.get_mut(&key) {
                    Some(existing) => {
                        if existing.as_deref() != Some(group_id.as_str()) {
                            *existing = None;
                        }
                    }
                    None => {
                        prefix_groups.insert(key, Some(group_id));
                    }
                }
            }

            let mut ambiguous = false;
            for (key, group_id) in prefix_groups {
                match group_id {
                    Some(group_id) => prefix_rules.push((key, group_id)),
                    None => ambiguous = true,
                }
            }

            // A lone root-path provider also owns the endpoints outside every
            // explicit prefix of the same host, but only if no prefix is
            // ambiguous.
            let roots: Vec<&ProviderHost> = entries
                .iter()
                .filter(|entry| entry.path.is_empty())
                .collect();
            if !ambiguous && roots.len() == 1 {
                host_rules.push((authority, groups[roots[0].group].id.clone()));
            }
        }
        prefix_rules.sort_by(|left, right| {
            right
                .0
                .len()
                .cmp(&left.0.len())
                .then_with(|| left.0.cmp(&right.0))
        });

        let host_expr = sql_host_expr(ENDPOINT_SQL);
        let mut branches = String::new();
        for group in &groups {
            if group.hashes.is_empty() {
                continue;
            }
            let hashes = group
                .hashes
                .iter()
                .map(|hash| sql_literal(hash))
                .collect::<Vec<_>>()
                .join(", ");
            branches.push_str(&format!(
                " WHEN model_hash IN ({hashes}) THEN {}",
                sql_literal(&group.id)
            ));
        }
        for (prefix, group_id) in &prefix_rules {
            let prefix_chars = prefix.chars().count();
            branches.push_str(&format!(
                " WHEN substr({ENDPOINT_SQL}, instr({ENDPOINT_SQL}, '://') + 3, {prefix_chars}) = {} THEN {}",
                sql_literal(prefix),
                sql_literal(group_id)
            ));
        }
        for (host, group_id) in &host_rules {
            branches.push_str(&format!(
                " WHEN {host_expr} = {} THEN {}",
                sql_literal(host),
                sql_literal(group_id)
            ));
        }

        let expr = format!(
            "(CASE WHEN request_type = 'plugin' OR {ENDPOINT_SQL} LIKE 'plugin://%' \
             THEN 'plugin::' || {ENDPOINT_SQL}{branches} \
             ELSE 'builtin::host::' || COALESCE(NULLIF({host_expr}, ''), 'unknown') END)"
        );

        Self {
            expr,
            groups,
            by_id,
            prefix_rules,
            host_rules,
        }
    }

    /// SQL expression that maps a call row to its supplier group id.
    pub(crate) fn expr(&self) -> &str {
        &self.expr
    }

    /// Resolves the group id of a recorded endpoint without a model hash.
    pub(crate) fn group_for_endpoint(&self, endpoint: &str) -> String {
        let endpoint = endpoint.trim();
        if endpoint.is_empty() {
            return host_group_id("");
        }
        if endpoint.starts_with(PLUGIN_ENDPOINT_SCHEME) {
            return plugin_group_id(endpoint);
        }
        let scheme_less = strip_scheme(endpoint);
        for (prefix, group_id) in &self.prefix_rules {
            if scheme_less.starts_with(prefix.as_str()) {
                return group_id.clone();
            }
        }
        let authority = raw_authority(endpoint);
        for (host, group_id) in &self.host_rules {
            if authority == *host {
                return group_id.clone();
            }
        }
        host_group_id(&authority)
    }

    pub(crate) fn group(&self, group_id: &str) -> Option<&SupplierGroup> {
        self.by_id.get(group_id).map(|index| &self.groups[*index])
    }

    pub(crate) fn groups(&self) -> &[SupplierGroup] {
        &self.groups
    }
}

impl Store {
    /// Builds the current statistics grouping from the persisted configuration.
    pub(crate) async fn supplier_groups(&self) -> Result<SupplierGroups> {
        let providers = self.providers().await?;
        let models = self.models().await?;
        Ok(SupplierGroups::new(&providers, &models))
    }
}

fn provider_group_id(provider_id: &str) -> String {
    format!("builtin::provider::{provider_id}")
}

/// Group id for an endpoint that no configured provider owns.
pub(crate) fn host_group_id(authority: &str) -> String {
    if authority.is_empty() {
        "builtin::host::unknown".to_owned()
    } else {
        format!("builtin::host::{authority}")
    }
}

/// Group id for a plugin transport endpoint; plugins stay endpoint-scoped.
pub(crate) fn plugin_group_id(endpoint: &str) -> String {
    format!("plugin::{endpoint}")
}

/// Display origin (`scheme://authority`) of a recorded endpoint.
pub(crate) fn endpoint_origin(endpoint: &str) -> String {
    match endpoint.find("://") {
        Some(index) => format!(
            "{}://{}",
            endpoint[..index].to_lowercase(),
            raw_authority(endpoint)
        ),
        None => raw_authority(endpoint),
    }
}

fn sql_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn strip_scheme(endpoint: &str) -> &str {
    match endpoint.find("://") {
        Some(index) => &endpoint[index + 3..],
        None => endpoint,
    }
}

/// Mirrors the SQL `host_expr`: lowercased authority, with the whole string
/// lowercased when no `://` is present.
fn raw_authority(endpoint: &str) -> String {
    if endpoint.find("://").is_none() {
        return endpoint.to_lowercase();
    }
    let scheme_less = strip_scheme(endpoint);
    let host = scheme_less.split('/').next().unwrap_or("");
    let host = host.split('?').next().unwrap_or(host);
    let host = host.split('#').next().unwrap_or(host);
    host.to_lowercase()
}

fn split_authority_path(base_url: &str) -> (String, String) {
    let scheme_less = strip_scheme(base_url);
    let (authority, path) = match scheme_less.find('/') {
        Some(index) => (&scheme_less[..index], &scheme_less[index..]),
        None => (scheme_less, ""),
    };
    (
        authority.to_lowercase(),
        path.trim_end_matches('/').to_owned(),
    )
}

fn sql_host_expr(endpoint_sql: &str) -> String {
    let rest = format!("substr({endpoint_sql}, instr({endpoint_sql}, '://') + 3)");
    let no_path = format!(
        "(CASE WHEN instr({rest}, '/') > 0 THEN substr({rest}, 1, instr({rest}, '/') - 1) ELSE {rest} END)"
    );
    let no_query = format!(
        "(CASE WHEN instr({no_path}, '?') > 0 THEN substr({no_path}, 1, instr({no_path}, '?') - 1) ELSE {no_path} END)"
    );
    let no_fragment = format!(
        "(CASE WHEN instr({no_query}, '#') > 0 THEN substr({no_query}, 1, instr({no_query}, '#') - 1) ELSE {no_query} END)"
    );
    format!(
        "(CASE WHEN instr({endpoint_sql}, '://') = 0 THEN lower({endpoint_sql}) ELSE lower({no_fragment}) END)"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ModelConfig, ProviderConfig, RequestFormat};

    fn provider(id: &str, name: &str, base_url: &str) -> ProviderConfig {
        ProviderConfig {
            provider_id: id.into(),
            sort_order: 0,
            name: name.into(),
            icon: None,
            base_url: base_url.into(),
            api_key: "key".into(),
            custom_headers_enabled: false,
            custom_headers: serde_json::json!({}),
            created_at_ms: 0,
            updated_at_ms: 0,
        }
    }

    fn model(
        hash: &str,
        provider: &ProviderConfig,
        request_format: RequestFormat,
        model_id: &str,
    ) -> ModelConfig {
        ModelConfig {
            model_hash: hash.into(),
            provider_id: provider.provider_id.clone(),
            provider_name: provider.name.clone(),
            sort_order: 0,
            display_name: model_id.into(),
            request_format,
            request_url_override: None,
            base_url: provider.base_url.clone(),
            api_key: provider.api_key.clone(),
            custom_headers_enabled: false,
            custom_headers: serde_json::json!({}),
            extra_params_enabled: false,
            extra_params: serde_json::json!({}),
            tooltip_data: String::new(),
            model_id: model_id.into(),
            reasoning_effort: None,
            context_window_tokens: None,
            max_output_tokens: None,
            anthropic_thinking_effort: None,
            thinking_budget_tokens: None,
            created_at_ms: 0,
            updated_at_ms: 0,
        }
    }

    #[test]
    fn protocol_endpoints_share_a_configuration_but_same_name_configurations_stay_separate() {
        let relay = provider("p-relay", "Relay", "https://relay.example.com");
        let mirror = provider("p-mirror", " Relay ", "https://mirror.example.com");
        let models = vec![
            model(
                "h-anthropic",
                &relay,
                RequestFormat::Anthropic,
                "claude-opus-5.5",
            ),
            model("h-gemini", &relay, RequestFormat::Gemini, "gemini-example"),
        ];
        let groups = SupplierGroups::new(&[relay, mirror], &models);

        let id = "builtin::provider::p-relay";
        assert_eq!(
            groups.group_for_endpoint("https://relay.example.com/v1/messages"),
            id
        );
        assert_eq!(
            groups.group_for_endpoint("https://relay.example.com/v1beta/models"),
            id
        );
        // A historical endpoint without a model hash still belongs to the relay.
        assert_eq!(
            groups.group_for_endpoint("https://relay.example.com/v1/responses"),
            id
        );
        assert_eq!(
            groups.group_for_endpoint("https://mirror.example.com/v1/messages"),
            "builtin::provider::p-mirror"
        );
        assert!(groups
            .expr()
            .contains("model_hash IN ('h-anthropic', 'h-gemini')"));
        assert_eq!(groups.group(id).unwrap().model_ids.len(), 2);
        assert_eq!(groups.group(id).unwrap().label, "Relay");
    }

    #[test]
    fn shared_host_is_disambiguated_by_the_longest_base_path() {
        let plan = provider(
            "p-plan",
            "火山方舟",
            "https://ark.cn-beijing.volces.com/api/plan",
        );
        let coding = provider(
            "p-coding",
            "火山方舟 Coding",
            "https://ark.cn-beijing.volces.com/api/coding",
        );
        let models = vec![model(
            "h-plan",
            &plan,
            RequestFormat::Anthropic,
            "deepseek-v4.1-flash",
        )];
        let groups = SupplierGroups::new(&[plan, coding], &models);

        assert_eq!(
            groups.group_for_endpoint("https://ark.cn-beijing.volces.com/api/plan/v1/messages"),
            "builtin::provider::p-plan"
        );
        assert_eq!(
            groups.group_for_endpoint("https://ark.cn-beijing.volces.com/api/coding/v1/messages"),
            "builtin::provider::p-coding"
        );
        // Not under any configured base path -> domain group.
        assert_eq!(
            groups.group_for_endpoint("https://ark.cn-beijing.volces.com/api/other/v1/messages"),
            "builtin::host::ark.cn-beijing.volces.com"
        );
        // Prefix matching respects path segments.
        assert_eq!(
            groups.group_for_endpoint("https://ark.cn-beijing.volces.com/api/planning/v1/messages"),
            "builtin::host::ark.cn-beijing.volces.com"
        );
    }

    #[test]
    fn unknown_hosts_merge_by_authority() {
        let groups = SupplierGroups::new(&[], &[]);
        let expected = "builtin::host::api.minimaxi.com";
        assert_eq!(
            groups.group_for_endpoint("https://api.minimaxi.com/anthropic/v1/messages"),
            expected
        );
        assert_eq!(
            groups.group_for_endpoint("https://API.minimaxi.com/v1/messages"),
            expected
        );
    }

    #[test]
    fn plugin_endpoints_stay_endpoint_scoped() {
        let groups = SupplierGroups::new(&[], &[]);
        let endpoint = "plugin://dev.example/codex";
        assert_eq!(
            groups.group_for_endpoint(endpoint),
            "plugin::plugin://dev.example/codex"
        );
    }

    #[test]
    fn provider_ids_with_quotes_are_escaped_in_sql() {
        let quirky = provider("p-o'brien", "O'Brien", "https://example.com");
        let groups = SupplierGroups::new(&[quirky], &[]);
        assert_eq!(
            groups.group_for_endpoint("https://example.com/v1/messages"),
            "builtin::provider::p-o'brien"
        );
        assert!(groups.expr().contains("'builtin::provider::p-o''brien'"));
        assert!(!groups.expr().contains("'builtin::provider::p-o'brien'"));
    }

    #[test]
    fn duplicate_base_urls_do_not_guess_between_different_names() {
        let first = provider("p-a", "Gateway A", "https://gateway.example.com/v1");
        let second = provider("p-b", "Gateway B", "https://gateway.example.com/v1");
        let models = vec![
            model("h-a", &first, RequestFormat::OpenAiChat, "model-a"),
            model("h-b", &second, RequestFormat::OpenAiChat, "model-b"),
        ];
        let groups = SupplierGroups::new(&[first, second], &models);

        // Live calls still attribute through their model hash.
        assert!(groups.expr().contains("model_hash IN ('h-a')"));
        assert!(groups.expr().contains("model_hash IN ('h-b')"));
        // Endpoint-only history cannot pick a winner and falls back to the host.
        assert_eq!(
            groups.group_for_endpoint("https://gateway.example.com/v1/chat/completions"),
            "builtin::host::gateway.example.com"
        );
    }
}
