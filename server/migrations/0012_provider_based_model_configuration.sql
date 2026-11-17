PRAGMA defer_foreign_keys = ON;

CREATE TABLE provider_configs (
    provider_id TEXT PRIMARY KEY,
    sort_order INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    model_type TEXT NOT NULL CHECK(model_type IN ('openai', 'anthropic')),
    base_url TEXT NOT NULL,
    use_full_url INTEGER NOT NULL DEFAULT 0 CHECK(use_full_url IN (0, 1)),
    api_key TEXT NOT NULL,
    openai_endpoint TEXT NOT NULL DEFAULT '',
    custom_headers_enabled INTEGER NOT NULL DEFAULT 0 CHECK(custom_headers_enabled IN (0, 1)),
    custom_headers_json TEXT NOT NULL DEFAULT '{}',
    extra_params_enabled INTEGER NOT NULL DEFAULT 0 CHECK(extra_params_enabled IN (0, 1)),
    extra_params_json TEXT NOT NULL DEFAULT '{}',
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

INSERT INTO provider_configs (
    provider_id,
    sort_order,
    name,
    model_type,
    base_url,
    use_full_url,
    api_key,
    openai_endpoint,
    custom_headers_enabled,
    custom_headers_json,
    extra_params_enabled,
    extra_params_json,
    created_at_ms,
    updated_at_ms
)
SELECT
    provider_id,
    sort_order,
    COALESCE(
        configured_name,
        NULLIF(
            CASE
                WHEN hostport LIKE '[%' AND instr(hostport, ']') > 0
                    THEN lower(substr(hostport, 1, instr(hostport, ']')))
                WHEN instr(hostport, ':') > 0
                    THEN lower(substr(hostport, 1, instr(hostport, ':') - 1))
                ELSE lower(hostport)
            END,
            ''
        ),
        trim(base_url)
    ) AS name,
    model_type,
    base_url,
    use_full_url,
    api_key,
    openai_endpoint,
    custom_headers_enabled,
    custom_headers_json,
    extra_params_enabled,
    extra_params_json,
    created_at_ms,
    updated_at_ms
FROM (
    SELECT
        *,
        CASE
            WHEN instr(authority, '@') > 0 THEN substr(authority, instr(authority, '@') + 1)
            ELSE authority
        END AS hostport
    FROM (
        SELECT
            *,
            CASE
                WHEN instr(after_scheme, '/') > 0 THEN substr(after_scheme, 1, instr(after_scheme, '/') - 1)
                ELSE after_scheme
            END AS authority
        FROM (
            SELECT
                *,
                CASE
                    WHEN instr(trim(base_url), '://') > 0
                        THEN substr(trim(base_url), instr(trim(base_url), '://') + 3)
                    ELSE trim(base_url)
                END AS after_scheme
            FROM (
                SELECT
                    MIN(model_hash) AS provider_id,
                    MIN(sort_order) AS sort_order,
                    MAX(NULLIF(trim(group_name), '')) AS configured_name,
                    model_type,
                    base_url,
                    use_full_url,
                    api_key,
                    openai_endpoint,
                    custom_headers_enabled,
                    custom_headers_json,
                    CASE
                        WHEN model_type = 'anthropic' THEN anthropic_extra_params_enabled
                        ELSE openai_extra_params_enabled
                    END AS extra_params_enabled,
                    CASE
                        WHEN model_type = 'anthropic' THEN anthropic_extra_params_json
                        ELSE openai_extra_params_json
                    END AS extra_params_json,
                    MIN(created_at_ms) AS created_at_ms,
                    MAX(updated_at_ms) AS updated_at_ms
                FROM model_configs
                GROUP BY
                    model_type,
                    base_url,
                    use_full_url,
                    api_key,
                    openai_endpoint,
                    custom_headers_enabled,
                    custom_headers_json,
                    CASE
                        WHEN model_type = 'anthropic' THEN anthropic_extra_params_enabled
                        ELSE openai_extra_params_enabled
                    END,
                    CASE
                        WHEN model_type = 'anthropic' THEN anthropic_extra_params_json
                        ELSE openai_extra_params_json
                    END
            )
        )
    )
);

CREATE TABLE model_configs_new (
    model_hash TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
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
    FOREIGN KEY(provider_id) REFERENCES provider_configs(provider_id) ON DELETE CASCADE
);

INSERT INTO model_configs_new (
    model_hash,
    provider_id,
    sort_order,
    display_name,
    tooltip_data,
    model_id,
    reasoning_effort,
    context_window_tokens,
    max_output_tokens,
    anthropic_thinking_effort,
    thinking_budget_tokens,
    created_at_ms,
    updated_at_ms
)
SELECT
    m.model_hash,
    p.provider_id,
    m.sort_order,
    m.display_name,
    m.tooltip_data,
    m.model_id,
    m.reasoning_effort,
    m.context_window_tokens,
    CASE
        WHEN m.model_type = 'anthropic' THEN COALESCE(m.anthropic_max_tokens, m.max_completion_tokens)
        ELSE m.max_completion_tokens
    END,
    m.anthropic_thinking_effort,
    m.thinking_budget_tokens,
    m.created_at_ms,
    m.updated_at_ms
FROM model_configs AS m
JOIN provider_configs AS p ON
    p.model_type = m.model_type
    AND p.base_url = m.base_url
    AND p.use_full_url = m.use_full_url
    AND p.api_key = m.api_key
    AND p.openai_endpoint = m.openai_endpoint
    AND p.custom_headers_enabled = m.custom_headers_enabled
    AND p.custom_headers_json = m.custom_headers_json
    AND p.extra_params_enabled = CASE
        WHEN m.model_type = 'anthropic' THEN m.anthropic_extra_params_enabled
        ELSE m.openai_extra_params_enabled
    END
    AND p.extra_params_json = CASE
        WHEN m.model_type = 'anthropic' THEN m.anthropic_extra_params_json
        ELSE m.openai_extra_params_json
    END;

CREATE TEMP TABLE preserved_call_models (
    call_id TEXT PRIMARY KEY,
    model_hash TEXT NOT NULL
);

INSERT INTO preserved_call_models (call_id, model_hash)
SELECT call_id, model_hash FROM llm_calls WHERE model_hash IS NOT NULL;

UPDATE llm_calls SET model_hash = NULL WHERE model_hash IS NOT NULL;

DROP TABLE model_configs;
ALTER TABLE model_configs_new RENAME TO model_configs;

UPDATE llm_calls
SET model_hash = (SELECT model_hash FROM preserved_call_models WHERE preserved_call_models.call_id = llm_calls.call_id)
WHERE call_id IN (SELECT call_id FROM preserved_call_models);

DROP TABLE preserved_call_models;

CREATE INDEX provider_configs_sort ON provider_configs(sort_order, name);
CREATE INDEX model_configs_sort ON model_configs(sort_order, display_name);
CREATE INDEX model_configs_provider ON model_configs(provider_id, sort_order, display_name);
