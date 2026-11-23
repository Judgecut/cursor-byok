CREATE TABLE model_configs_new (
    model_hash TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES provider_configs(provider_id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    display_name TEXT NOT NULL,
    tooltip_data TEXT NOT NULL,
    model_id TEXT NOT NULL,
    reasoning_effort TEXT,
    context_window_tokens INTEGER,
    max_output_tokens INTEGER,
    anthropic_thinking_effort TEXT,
    thinking_budget_tokens INTEGER,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    request_format TEXT NOT NULL CHECK(request_format IN ('openai-chat', 'openai-responses', 'anthropic', 'gemini')),
    request_url_override TEXT,
    extra_params_enabled INTEGER NOT NULL DEFAULT 0 CHECK(extra_params_enabled IN (0, 1)),
    extra_params_json TEXT NOT NULL DEFAULT '{}'
);


INSERT INTO model_configs_new (
    model_hash, provider_id, sort_order, display_name, tooltip_data, model_id,
    reasoning_effort, context_window_tokens, max_output_tokens, anthropic_thinking_effort,
    thinking_budget_tokens, created_at_ms, updated_at_ms, request_format,
    request_url_override, extra_params_enabled, extra_params_json
)
SELECT
    model_hash, provider_id, sort_order, display_name, tooltip_data, model_id,
    reasoning_effort, context_window_tokens, max_output_tokens, anthropic_thinking_effort,
    thinking_budget_tokens, created_at_ms, updated_at_ms, request_format,
    request_url_override, extra_params_enabled, extra_params_json
FROM model_configs;

DROP TABLE model_configs;
ALTER TABLE model_configs_new RENAME TO model_configs;
CREATE INDEX model_configs_sort ON model_configs(sort_order, display_name);
CREATE INDEX model_configs_provider ON model_configs(provider_id, sort_order, display_name);
