-- Only calls with observed visible output events have a measurable generation window.
-- Historical calls retain their usage and timing but have no verified generation sample.
ALTER TABLE llm_calls ADD COLUMN generation_output_events INTEGER CHECK (generation_output_events >= 0);
