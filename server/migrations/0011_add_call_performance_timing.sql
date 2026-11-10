-- Records the first actual output, the generation window, and how a call was produced.
-- Rows written before this migration keep NULL timing, so their speed stays unknown.

ALTER TABLE llm_calls ADD COLUMN call_origin TEXT NOT NULL DEFAULT 'run'
    CHECK (call_origin IN ('run', 'model_test'));
ALTER TABLE llm_calls ADD COLUMN streaming INTEGER CHECK (streaming IN (0, 1));
ALTER TABLE llm_calls ADD COLUMN first_output_at_ms INTEGER;
ALTER TABLE llm_calls ADD COLUMN ttfo_ms INTEGER;
ALTER TABLE llm_calls ADD COLUMN generation_ms INTEGER;
ALTER TABLE llm_calls ADD COLUMN observed_thinking INTEGER NOT NULL DEFAULT 0
    CHECK (observed_thinking IN (0, 1));
