-- Separate explicitly reported cache usage (including zero) from omitted cache fields
-- and record when cost calculation fell back to an assumed cache hit rate.
ALTER TABLE llm_calls ADD COLUMN cost_basis TEXT CHECK(cost_basis IN ('reported', 'assumed_cache'));
ALTER TABLE llm_calls ADD COLUMN assumed_cache_hit_rate_bps INTEGER CHECK(assumed_cache_hit_rate_bps >= 0 AND assumed_cache_hit_rate_bps <= 10000);
ALTER TABLE llm_calls ADD COLUMN estimated_cache_read_tokens INTEGER CHECK(estimated_cache_read_tokens >= 0);

UPDATE llm_calls
SET cost_basis = 'reported'
WHERE cost_status = 'priced'
  AND (cache_read_tokens IS NOT NULL OR cache_write_tokens IS NOT NULL);
