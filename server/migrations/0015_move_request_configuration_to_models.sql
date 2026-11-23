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
    request_format TEXT NOT NULL CHECK(request_format IN ('openai-chat', 'openai-responses', 'anthropic')),
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
    m.model_hash, m.provider_id, m.sort_order, m.display_name, m.tooltip_data, m.model_id,
    m.reasoning_effort, m.context_window_tokens, m.max_output_tokens, m.anthropic_thinking_effort,
    m.thinking_budget_tokens, m.created_at_ms, m.updated_at_ms,
    CASE
        WHEN p.model_type = 'anthropic' THEN 'anthropic'
        WHEN p.openai_endpoint = '/v1/responses' THEN 'openai-responses'
        ELSE 'openai-chat'
    END,
    CASE WHEN p.use_full_url = 1 THEN p.base_url END,
    p.extra_params_enabled, p.extra_params_json
FROM model_configs AS m
JOIN provider_configs AS p ON p.provider_id = m.provider_id;

DROP TABLE model_configs;
ALTER TABLE model_configs_new RENAME TO model_configs;
CREATE INDEX model_configs_sort ON model_configs(sort_order, display_name);
CREATE INDEX model_configs_provider ON model_configs(provider_id, sort_order, display_name);

-- The complete URL, including its query, has already moved to the models.
WITH addresses AS (
    SELECT provider_id, rtrim(substr(base_url, 1, instr(base_url || '?', '?') - 1), '/') AS address
    FROM provider_configs
    WHERE use_full_url = 1
), parts AS (
    SELECT provider_id, address, instr(address, '://') + 3 AS authority_start
    FROM addresses
), origins AS (
    SELECT provider_id, address,
        substr(address, 1, authority_start + instr(substr(address, authority_start) || '/', '/') - 2) AS origin
    FROM parts
)
UPDATE provider_configs
SET base_url = (
    SELECT CASE
        WHEN lower(substr(address, -17)) = '/chat/completions' AND length(address) >= length(origin) + 17
            THEN substr(address, 1, length(address) - 17)
        WHEN lower(substr(address, -10)) = '/responses' AND length(address) >= length(origin) + 10
            THEN substr(address, 1, length(address) - 10)
        WHEN lower(substr(address, -9)) = '/messages' AND length(address) >= length(origin) + 9
            THEN substr(address, 1, length(address) - 9)
        ELSE origin
    END
    FROM origins
    WHERE origins.provider_id = provider_configs.provider_id
)
WHERE use_full_url = 1;

ALTER TABLE provider_configs DROP COLUMN model_type;
ALTER TABLE provider_configs DROP COLUMN use_full_url;
ALTER TABLE provider_configs DROP COLUMN openai_endpoint;
ALTER TABLE provider_configs DROP COLUMN extra_params_enabled;
ALTER TABLE provider_configs DROP COLUMN extra_params_json;
