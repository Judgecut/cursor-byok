CREATE TABLE pricing_catalog_models (
    provider_id TEXT NOT NULL,
    provider_name TEXT NOT NULL,
    provider_api TEXT,
    model_id TEXT NOT NULL,
    model_name TEXT NOT NULL,
    input_per_million TEXT,
    output_per_million TEXT,
    cache_read_per_million TEXT,
    cache_write_per_million TEXT,
    synced_at_ms INTEGER NOT NULL,
    PRIMARY KEY (provider_id, model_id)
);

CREATE INDEX idx_pricing_catalog_model_id
    ON pricing_catalog_models(model_id);
CREATE INDEX idx_pricing_catalog_provider_api
    ON pricing_catalog_models(provider_api, model_id);

CREATE TABLE model_pricing_configs (
    supplier_key TEXT PRIMARY KEY,
    source_kind TEXT NOT NULL CHECK(source_kind IN ('builtin', 'plugin')),
    endpoint_key TEXT NOT NULL,
    model_id TEXT NOT NULL,
    binding_mode TEXT NOT NULL DEFAULT 'auto' CHECK(binding_mode IN ('auto', 'manual')),
    catalog_provider_id TEXT,
    catalog_model_id TEXT,
    custom_input_per_million TEXT,
    custom_output_per_million TEXT,
    custom_cache_read_per_million TEXT,
    custom_cache_write_per_million TEXT,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE(endpoint_key, model_id)
);

ALTER TABLE llm_calls ADD COLUMN supplier_key TEXT;
ALTER TABLE llm_calls ADD COLUMN endpoint_key TEXT;
ALTER TABLE llm_calls ADD COLUMN pricing_source TEXT;
ALTER TABLE llm_calls ADD COLUMN pricing_provider_id TEXT;
ALTER TABLE llm_calls ADD COLUMN pricing_model_id TEXT;
ALTER TABLE llm_calls ADD COLUMN pricing_snapshot_at_ms INTEGER;
ALTER TABLE llm_calls ADD COLUMN unit_input_per_million TEXT;
ALTER TABLE llm_calls ADD COLUMN unit_output_per_million TEXT;
ALTER TABLE llm_calls ADD COLUMN unit_cache_read_per_million TEXT;
ALTER TABLE llm_calls ADD COLUMN unit_cache_write_per_million TEXT;
ALTER TABLE llm_calls ADD COLUMN cost_status TEXT;
ALTER TABLE llm_calls ADD COLUMN input_cost_nano INTEGER;
ALTER TABLE llm_calls ADD COLUMN output_cost_nano INTEGER;
ALTER TABLE llm_calls ADD COLUMN cache_read_cost_nano INTEGER;
ALTER TABLE llm_calls ADD COLUMN cache_write_cost_nano INTEGER;
ALTER TABLE llm_calls ADD COLUMN total_cost_nano INTEGER;
ALTER TABLE llm_calls ADD COLUMN cost_calculated_at_ms INTEGER;
ALTER TABLE llm_calls ADD COLUMN cost_backfilled INTEGER NOT NULL DEFAULT 0 CHECK(cost_backfilled IN (0, 1));

CREATE INDEX idx_llm_calls_supplier_created_at
    ON llm_calls(supplier_key, created_at_ms DESC);
CREATE INDEX idx_llm_calls_model_created_at
    ON llm_calls(model_id, created_at_ms DESC);
CREATE INDEX idx_llm_calls_cost_status
    ON llm_calls(cost_status, status, created_at_ms DESC);

DELETE FROM service_settings WHERE setting_key = 'token_pricing';
