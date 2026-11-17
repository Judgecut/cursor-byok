//! Unified end-to-end and generation-speed rules plus first-output timing,
//! shared by call records, model tests, and model/provider aggregates.

use serde::Serialize;

/// A generation-speed sample needs at least this much generation time, which
/// also keeps a zero-length or sub-200ms measurement from producing noisy rates.
pub const MIN_SPEED_GENERATION_MS: i64 = 200;

const MILLIS_PER_SECOND: f64 = 1000.0;
const CALL_STATUS_COMPLETED: &str = "completed";

/// How much trust a displayed rate deserves. `Estimated` covers delivery timing
/// derived from streamed events, whose chunks can contain several tokens.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeedStatus {
    Measured,
    Estimated,
    #[default]
    Unavailable,
}

/// Why a call has no rate, so the interface can explain the gap instead of
/// showing a bare placeholder.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeedUnavailableReason {
    /// Failed, cancelled, or still running.
    NotCompleted,
    /// No streamed output, so generation cannot be separated from waiting.
    NotStreaming,
    /// The provider reported no output token count.
    MissingOutputTokens,
    /// No actual output was observed, so generation never started by our clock.
    MissingFirstOutput,
    /// The interval between the first and last visible outputs is unknown.
    MissingGeneration,
    /// Thinking is present but the upstream did not separate reasoning usage.
    MissingVisibleOutputTokens,
    /// Fewer than two visible output events were observed, or the count is unknown.
    InsufficientOutputEvents,
    /// The call has no positive wall-clock duration, so end-to-end throughput
    /// cannot be divided out.
    MissingDuration,
    /// No effective visible output tokens to measure generation speed.
    ShortOutput,
    /// Shorter generation time than the sample minimum.
    ShortGeneration,
}

/// The performance result attached to one call record or model test result.
///
/// `overall_tokens_per_second` divides output by the whole call duration,
/// while `tokens_per_second` estimates visible token delivery between the
/// first and last visible output events, excluding the first token.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct CallPerformance {
    pub overall_tokens_per_second: Option<f64>,
    pub overall_reason: Option<SpeedUnavailableReason>,
    pub speed_status: SpeedStatus,
    pub tokens_per_second: Option<f64>,
    pub reason: Option<SpeedUnavailableReason>,
    pub first_output_ms: Option<i64>,
    pub generation_ms: Option<i64>,
}

/// Inputs for one call's speed result, taken from the persisted call record.
#[derive(Clone, Copy, Debug)]
pub struct SpeedSample<'a> {
    pub status: &'a str,
    pub streaming: Option<bool>,
    pub output_tokens: Option<i64>,
    pub reasoning_tokens: Option<i64>,
    pub first_output_ms: Option<i64>,
    pub generation_ms: Option<i64>,
    /// Whole call duration, which is the end-to-end denominator.
    pub duration_ms: Option<i64>,
    pub generation_output_events: Option<i64>,
    /// Thinking may be a summary, so observing it never proves all reasoning was visible.
    pub observed_thinking: bool,
}

/// Applies the shared speed rules to one call.
///
/// The first-output wait is reported whenever it was measured, even for calls
/// whose speed is unavailable, because it does not depend on the sample minimum.
pub fn evaluate(sample: SpeedSample<'_>) -> CallPerformance {
    let mut performance = CallPerformance {
        first_output_ms: sample.first_output_ms,
        generation_ms: sample.generation_ms,
        ..CallPerformance::default()
    };

    performance.overall_reason = overall_unavailable(&sample);
    if performance.overall_reason.is_none() {
        let output_tokens = sample.output_tokens.unwrap_or_default().max(0);
        let duration_ms = sample.duration_ms.unwrap_or_default().max(0);
        performance.overall_tokens_per_second = Some(rate(output_tokens, duration_ms));
    }

    let reason = if sample.status != CALL_STATUS_COMPLETED {
        Some(SpeedUnavailableReason::NotCompleted)
    } else if sample.streaming != Some(true) {
        Some(SpeedUnavailableReason::NotStreaming)
    } else if sample.output_tokens.is_none() {
        Some(SpeedUnavailableReason::MissingOutputTokens)
    } else if sample.first_output_ms.is_none() {
        Some(SpeedUnavailableReason::MissingFirstOutput)
    } else if sample.generation_output_events.unwrap_or(0) < 2 {
        Some(SpeedUnavailableReason::InsufficientOutputEvents)
    } else if sample.generation_ms.is_none() {
        Some(SpeedUnavailableReason::MissingGeneration)
    } else {
        None
    };
    if let Some(reason) = reason {
        performance.reason = Some(reason);
        return performance;
    }

    let output_tokens = sample.output_tokens.unwrap_or_default().max(0);
    let generation_ms = sample.generation_ms.unwrap_or_default().max(0);
    if generation_ms < MIN_SPEED_GENERATION_MS {
        performance.reason = Some(SpeedUnavailableReason::ShortGeneration);
        return performance;
    }

    if sample.observed_thinking && sample.reasoning_tokens.is_none() {
        performance.reason = Some(SpeedUnavailableReason::MissingVisibleOutputTokens);
        return performance;
    }
    let reasoning_tokens = sample.reasoning_tokens.unwrap_or(0).max(0);
    // The first output token has already arrived when the generation interval starts.
    let effective_tokens = output_tokens
        .saturating_sub(reasoning_tokens)
        .saturating_sub(1)
        .max(0);
    // SSE events may contain several tokens; their per-token generation times are unknown.
    let speed_status = SpeedStatus::Estimated;

    if effective_tokens <= 0 {
        performance.reason = Some(SpeedUnavailableReason::ShortOutput);
        return performance;
    }

    performance.tokens_per_second = Some(rate(effective_tokens, generation_ms));
    performance.speed_status = speed_status;
    performance
}

/// An end-to-end rate needs a completed call, a reported output count, and a
/// positive duration. Streaming and first-output timing are not required because
/// the whole call is inside the denominator.
fn overall_unavailable(sample: &SpeedSample<'_>) -> Option<SpeedUnavailableReason> {
    if sample.status != CALL_STATUS_COMPLETED {
        return Some(SpeedUnavailableReason::NotCompleted);
    }
    if sample.output_tokens.is_none() {
        return Some(SpeedUnavailableReason::MissingOutputTokens);
    }
    match sample.duration_ms {
        Some(duration) if duration > 0 => None,
        _ => Some(SpeedUnavailableReason::MissingDuration),
    }
}

/// Accumulates effective output and generation time so long and short calls
/// contribute in proportion to their real output rather than equally.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SpeedTotals {
    pub output_tokens: i64,
    pub generation_ms: i64,
    pub samples: i64,
}

impl SpeedTotals {
    /// Adds one call that already passed the aggregate eligibility rules.
    pub fn add(&mut self, output_tokens: i64, generation_ms: i64) {
        self.output_tokens = self.output_tokens.saturating_add(output_tokens);
        self.generation_ms = self.generation_ms.saturating_add(generation_ms);
        self.samples += 1;
    }

    /// Folds another group's totals in, used to roll supplier samples up to a model.
    pub fn merge(&mut self, other: Self) {
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.generation_ms = self.generation_ms.saturating_add(other.generation_ms);
        self.samples += other.samples;
    }

    /// Divides accumulated output by accumulated generation time.
    pub fn average(&self) -> Option<f64> {
        (self.generation_ms > 0).then(|| rate(self.output_tokens, self.generation_ms))
    }
}

/// Arithmetic mean of the middle values, matching SQLite's row-window median.
pub fn median(values: &mut [i64]) -> Option<i64> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    let middle = values.len() / 2;
    if values.len().is_multiple_of(2) {
        let sum = values[middle - 1].saturating_add(values[middle]);
        Some(sum / 2)
    } else {
        Some(values[middle])
    }
}

fn rate(output_tokens: i64, elapsed_ms: i64) -> f64 {
    output_tokens as f64 * MILLIS_PER_SECOND / elapsed_ms as f64
}

impl std::ops::AddAssign for SpeedTotals {
    fn add_assign(&mut self, other: Self) {
        self.merge(other);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasoning_summaries_do_not_make_billed_reasoning_visible() {
        let performance = evaluate(SpeedSample {
            observed_thinking: true,
            reasoning_tokens: Some(800),
            ..sample(Some(1_000), Some(2_000), Some(1_000))
        });
        assert_eq!(performance.tokens_per_second, Some(199.0));
        assert_eq!(performance.speed_status, SpeedStatus::Estimated);
    }

    #[test]
    fn the_first_output_token_is_outside_the_generation_interval() {
        let performance = evaluate(sample(Some(101), Some(500), Some(1_000)));
        assert_eq!(performance.tokens_per_second, Some(100.0));
    }

    fn sample(
        output_tokens: Option<i64>,
        first_output_ms: Option<i64>,
        generation_ms: Option<i64>,
    ) -> SpeedSample<'static> {
        SpeedSample {
            status: CALL_STATUS_COMPLETED,
            streaming: Some(true),
            output_tokens,
            reasoning_tokens: None,
            first_output_ms,
            generation_ms,
            duration_ms: Some(
                first_output_ms.unwrap_or_default() + generation_ms.unwrap_or_default(),
            ),
            generation_output_events: Some(2),
            observed_thinking: false,
        }
    }

    #[test]
    fn generation_time_excludes_the_first_output_wait() {
        // 1,000 tokens over 12 s of generation; the 2 s wait is not part of the rate.
        let performance = evaluate(sample(Some(1_000), Some(2_000), Some(12_000)));
        assert_eq!(performance.speed_status, SpeedStatus::Estimated);
        assert_eq!(performance.first_output_ms, Some(2_000));
        assert_eq!(performance.reason, None);
        assert!((performance.tokens_per_second.unwrap() - 83.25).abs() < 0.001);

        let performance = evaluate(sample(Some(1_000), Some(0), Some(10_000)));
        assert!((performance.tokens_per_second.unwrap() - 99.9).abs() < f64::EPSILON);
    }

    #[test]
    fn end_to_end_rate_includes_the_first_output_wait() {
        // The same call end to end: 1,000 tokens over 2 s of waiting plus 12 s of output.
        let performance = evaluate(sample(Some(1_000), Some(2_000), Some(12_000)));
        assert!((performance.overall_tokens_per_second.unwrap() - 71.428).abs() < 0.001);
        assert_eq!(performance.overall_reason, None);
        // The JSON contract the desktop reads; a rename here must update the client type.
        let json = serde_json::to_value(&performance).unwrap();
        assert!(json.get("overall_tokens_per_second").is_some());
        assert!(json.get("overall_reason").is_some());
        assert!(json.get("tokens_per_second").is_some());
    }

    #[test]
    fn sample_minimums_accept_short_outputs_with_enough_generation_time_and_reject_zero() {
        let boundary = evaluate(sample(Some(2), Some(0), Some(MIN_SPEED_GENERATION_MS)));
        assert_eq!(boundary.speed_status, SpeedStatus::Estimated);
        assert_eq!(boundary.tokens_per_second, Some(5.0));

        // Short tool-call output (30-99 tokens) is measured as long as generation_ms >= 200.
        let short_tool_call = evaluate(sample(Some(40), Some(300), Some(500)));
        assert_eq!(short_tool_call.speed_status, SpeedStatus::Estimated);
        assert_eq!(short_tool_call.reason, None);
        assert_eq!(short_tool_call.tokens_per_second, Some(78.0));
        assert_eq!(short_tool_call.overall_tokens_per_second, Some(50.0));

        let zero_output = evaluate(sample(Some(0), Some(100), Some(MIN_SPEED_GENERATION_MS)));
        assert_eq!(
            zero_output.reason,
            Some(SpeedUnavailableReason::ShortOutput)
        );
        assert_eq!(zero_output.tokens_per_second, None);
        assert_eq!(zero_output.speed_status, SpeedStatus::Unavailable);
        assert_eq!(zero_output.overall_tokens_per_second, Some(0.0));
        assert_eq!(zero_output.overall_reason, None);

        let short_generation = evaluate(sample(
            Some(100),
            Some(0),
            Some(MIN_SPEED_GENERATION_MS - 1),
        ));
        assert_eq!(
            short_generation.reason,
            Some(SpeedUnavailableReason::ShortGeneration)
        );
        assert_eq!(short_generation.tokens_per_second, None);
    }

    #[test]
    fn hidden_reasoning_deducts_reasoning_tokens_and_rejects_zero_visible_output() {
        let hidden = evaluate(SpeedSample {
            observed_thinking: true,
            reasoning_tokens: Some(200),
            ..sample(Some(500), Some(2_000), Some(5_000))
        });
        assert_eq!(hidden.speed_status, SpeedStatus::Estimated);
        assert_eq!(hidden.reason, None);
        assert_eq!(hidden.tokens_per_second, Some(59.8));

        let only_hidden_reasoning = evaluate(SpeedSample {
            observed_thinking: true,
            reasoning_tokens: Some(200),
            ..sample(Some(200), Some(2_000), Some(5_000))
        });
        assert_eq!(only_hidden_reasoning.speed_status, SpeedStatus::Unavailable);
        assert_eq!(
            only_hidden_reasoning.reason,
            Some(SpeedUnavailableReason::ShortOutput)
        );
        assert_eq!(only_hidden_reasoning.tokens_per_second, None);

        let clamped_hidden_reasoning = evaluate(SpeedSample {
            observed_thinking: true,
            reasoning_tokens: Some(250),
            ..sample(Some(200), Some(2_000), Some(5_000))
        });
        assert_eq!(
            clamped_hidden_reasoning.reason,
            Some(SpeedUnavailableReason::ShortOutput)
        );
        assert_eq!(clamped_hidden_reasoning.tokens_per_second, None);

        // A thinking summary does not expose the billed reasoning tokens.
        let observed = evaluate(SpeedSample {
            observed_thinking: true,
            reasoning_tokens: Some(200),
            ..sample(Some(500), Some(2_000), Some(5_000))
        });
        assert_eq!(observed.speed_status, SpeedStatus::Estimated);
        assert_eq!(observed.tokens_per_second, Some(59.8));
    }

    #[test]
    fn zero_time_and_missing_values_never_produce_an_unbounded_rate() {
        let zero = evaluate(sample(Some(5_000), Some(0), Some(0)));
        assert_eq!(zero.reason, Some(SpeedUnavailableReason::ShortGeneration));
        assert_eq!(zero.tokens_per_second, None);
        assert_eq!(
            zero.overall_reason,
            Some(SpeedUnavailableReason::MissingDuration)
        );
        assert_eq!(zero.overall_tokens_per_second, None);

        let no_tokens = evaluate(sample(None, Some(120), Some(900)));
        assert_eq!(
            no_tokens.reason,
            Some(SpeedUnavailableReason::MissingOutputTokens)
        );

        let no_first_output = evaluate(sample(Some(500), None, Some(900)));
        assert_eq!(
            no_first_output.reason,
            Some(SpeedUnavailableReason::MissingFirstOutput)
        );

        let no_generation = evaluate(sample(Some(500), Some(120), None));
        assert_eq!(
            no_generation.reason,
            Some(SpeedUnavailableReason::MissingGeneration)
        );
    }

    #[test]
    fn failures_keep_the_first_output_wait_but_report_no_speed() {
        let failed = evaluate(SpeedSample {
            status: "error",
            ..sample(Some(1_000), Some(500), Some(3_000))
        });
        assert_eq!(failed.reason, Some(SpeedUnavailableReason::NotCompleted));
        assert_eq!(failed.speed_status, SpeedStatus::Unavailable);
        assert_eq!(failed.first_output_ms, Some(500));
        assert_eq!(failed.tokens_per_second, None);
        assert_eq!(failed.overall_tokens_per_second, None);
        assert_eq!(
            failed.overall_reason,
            Some(SpeedUnavailableReason::NotCompleted)
        );
    }

    #[test]
    fn non_streamed_calls_have_no_measurable_generation_window() {
        let non_streamed = evaluate(SpeedSample {
            streaming: Some(false),
            ..sample(Some(1_000), Some(120), Some(3_000))
        });
        assert_eq!(
            non_streamed.reason,
            Some(SpeedUnavailableReason::NotStreaming)
        );

        let unknown_stream = evaluate(SpeedSample {
            streaming: None,
            ..sample(Some(1_000), Some(120), Some(3_000))
        });
        assert_eq!(
            unknown_stream.reason,
            Some(SpeedUnavailableReason::NotStreaming)
        );
        // The end-to-end rate does not need a streamed response.
        assert!(non_streamed.overall_tokens_per_second.is_some());
        assert!(unknown_stream.overall_tokens_per_second.is_some());
    }

    #[test]
    fn unknown_reasoning_usage_and_unverified_streams_have_no_generation_rate() {
        let unknown_reasoning = evaluate(SpeedSample {
            observed_thinking: true,
            ..sample(Some(1_000), Some(500), Some(1_000))
        });
        assert_eq!(
            unknown_reasoning.reason,
            Some(SpeedUnavailableReason::MissingVisibleOutputTokens)
        );
        for events in [None, Some(0), Some(1)] {
            let buffered = evaluate(SpeedSample {
                generation_output_events: events,
                ..sample(Some(1_000), Some(500), Some(1_000))
            });
            assert_eq!(buffered.tokens_per_second, None);
            assert_eq!(
                buffered.reason,
                Some(SpeedUnavailableReason::InsufficientOutputEvents)
            );
            assert!(buffered.overall_tokens_per_second.is_some());
        }
    }

    #[test]
    fn totals_divide_accumulated_output_by_accumulated_call_time() {
        let mut totals = SpeedTotals::default();
        totals.add(1_000, 10_000);
        totals.add(50, 5_300);
        // Pooled: 1,050 tokens over 15.3 s, not the mean of 2 call rates.
        assert!((totals.average().unwrap() - 68.627).abs() < 0.001);
        assert_eq!(totals.samples, 2);
    }

    #[test]
    fn merged_totals_keep_the_pooled_numerator_and_denominator() {
        let mut supplier_a = SpeedTotals::default();
        supplier_a.add(500, 5_000);
        let mut supplier_b = SpeedTotals::default();
        supplier_b.add(1_000, 15_000);
        let mut model = supplier_a;
        model.merge(supplier_b);
        assert!((model.average().unwrap() - 75.0).abs() < 0.001);
        assert_eq!(model.samples, 2);
        assert_eq!(SpeedTotals::default().average(), None);
    }

    #[test]
    fn a_totals_with_zero_call_time_has_no_rate() {
        let mut totals = SpeedTotals::default();
        totals.add(500, 0);
        assert_eq!(totals.average(), None);
    }

    #[test]
    fn median_matches_the_middle_value_and_averages_two_middles() {
        assert_eq!(median(&mut []), None);
        assert_eq!(median(&mut [1_300]), Some(1_300));
        assert_eq!(median(&mut [1_300, 900, 2_100]), Some(1_300));
        assert_eq!(median(&mut [2_100, 900, 1_000, 1_500]), Some(1_250));
    }
}
