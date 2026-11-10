//! Unified generation-speed and first-output timing rules shared by call records,
//! model tests, and model/provider aggregates.

use serde::Serialize;

/// A speed sample needs at least this many output tokens. Shorter calls cannot
/// separate generation from start-up and rounding noise.
pub const MIN_SPEED_OUTPUT_TOKENS: i64 = 100;
/// A speed sample needs at least this much generation time, which also keeps a
/// zero-length or clock-less measurement from producing an unbounded rate.
pub const MIN_SPEED_GENERATION_MS: i64 = 100;

const MILLIS_PER_SECOND: f64 = 1000.0;
const CALL_STATUS_COMPLETED: &str = "completed";

/// How much trust a displayed rate deserves. `Estimated` covers token counts
/// derived from text and generation windows that hide reasoning time.
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
    /// A first output was recorded but the call has no end time.
    MissingGeneration,
    /// Fewer output tokens than the sample minimum.
    ShortOutput,
    /// Shorter generation time than the sample minimum.
    ShortGeneration,
}

/// The performance result attached to one call record or model test result.
/// `tokens_per_second` is absent whenever no reliable rate can be derived.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct CallPerformance {
    pub speed_status: SpeedStatus,
    pub tokens_per_second: Option<f64>,
    pub reason: Option<SpeedUnavailableReason>,
    pub first_output_ms: Option<i64>,
    pub generation_ms: Option<i64>,
}

impl SpeedStatus {
    /// Aggregates prefer measured samples and only fall back to estimated ones.
    pub fn from_sample_counts(measured_samples: i64, estimated_samples: i64) -> Self {
        if measured_samples > 0 {
            Self::Measured
        } else if estimated_samples > 0 {
            Self::Estimated
        } else {
            Self::Unavailable
        }
    }
}

/// Inputs for one call's speed result, taken from the persisted call record.
#[derive(Clone, Copy, Debug)]
pub struct SpeedSample<'a> {
    pub status: &'a str,
    pub streaming: Option<bool>,
    pub output_tokens: Option<i64>,
    pub first_output_ms: Option<i64>,
    pub generation_ms: Option<i64>,
    /// Output tokens came from text estimation rather than provider usage.
    pub tokens_estimated: bool,
    /// The provider billed reasoning tokens that no output event ever showed.
    pub hidden_reasoning: bool,
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

    let reason = if sample.status != CALL_STATUS_COMPLETED {
        Some(SpeedUnavailableReason::NotCompleted)
    } else if sample.streaming != Some(true) {
        Some(SpeedUnavailableReason::NotStreaming)
    } else if sample.output_tokens.is_none() {
        Some(SpeedUnavailableReason::MissingOutputTokens)
    } else if sample.first_output_ms.is_none() {
        Some(SpeedUnavailableReason::MissingFirstOutput)
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
    if output_tokens < MIN_SPEED_OUTPUT_TOKENS {
        performance.reason = Some(SpeedUnavailableReason::ShortOutput);
        return performance;
    }

    performance.tokens_per_second = Some(rate(output_tokens, generation_ms));
    performance.speed_status = if sample.tokens_estimated || sample.hidden_reasoning {
        SpeedStatus::Estimated
    } else {
        SpeedStatus::Measured
    };
    performance
}

/// Accumulates speed samples by numerator and denominator so long and short
/// calls contribute in proportion to their real output rather than equally.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SpeedSampleTotals {
    pub measured_output_tokens: i64,
    pub measured_generation_ms: i64,
    pub measured_samples: i64,
    pub estimated_output_tokens: i64,
    pub estimated_generation_ms: i64,
    pub estimated_samples: i64,
}

impl SpeedSampleTotals {
    /// Adds one sample that already passed the per-call eligibility rules.
    pub fn add(&mut self, output_tokens: i64, generation_ms: i64, estimated: bool) {
        if estimated {
            self.estimated_output_tokens =
                self.estimated_output_tokens.saturating_add(output_tokens);
            self.estimated_generation_ms =
                self.estimated_generation_ms.saturating_add(generation_ms);
            self.estimated_samples += 1;
        } else {
            self.measured_output_tokens = self.measured_output_tokens.saturating_add(output_tokens);
            self.measured_generation_ms = self.measured_generation_ms.saturating_add(generation_ms);
            self.measured_samples += 1;
        }
    }

    /// Folds another group's totals in, used to roll supplier samples up to a model.
    pub fn merge(&mut self, other: Self) {
        self.measured_output_tokens = self
            .measured_output_tokens
            .saturating_add(other.measured_output_tokens);
        self.measured_generation_ms = self
            .measured_generation_ms
            .saturating_add(other.measured_generation_ms);
        self.measured_samples += other.measured_samples;
        self.estimated_output_tokens = self
            .estimated_output_tokens
            .saturating_add(other.estimated_output_tokens);
        self.estimated_generation_ms = self
            .estimated_generation_ms
            .saturating_add(other.estimated_generation_ms);
        self.estimated_samples += other.estimated_samples;
    }

    pub fn status(&self) -> SpeedStatus {
        SpeedStatus::from_sample_counts(self.measured_samples, self.estimated_samples)
    }

    /// Divides the accumulated totals; measured samples win over estimated ones.
    pub fn average(&self) -> Option<f64> {
        let (output_tokens, generation_ms) = match self.status() {
            SpeedStatus::Measured => (self.measured_output_tokens, self.measured_generation_ms),
            SpeedStatus::Estimated => (self.estimated_output_tokens, self.estimated_generation_ms),
            SpeedStatus::Unavailable => return None,
        };
        (generation_ms > 0).then(|| rate(output_tokens, generation_ms))
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

fn rate(output_tokens: i64, generation_ms: i64) -> f64 {
    output_tokens as f64 * MILLIS_PER_SECOND / generation_ms as f64
}

impl std::ops::AddAssign for SpeedSampleTotals {
    fn add_assign(&mut self, other: Self) {
        self.merge(other);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(
        output_tokens: Option<i64>,
        first_output_ms: Option<i64>,
        generation_ms: Option<i64>,
    ) -> SpeedSample<'static> {
        SpeedSample {
            status: CALL_STATUS_COMPLETED,
            streaming: Some(true),
            output_tokens,
            first_output_ms,
            generation_ms,
            tokens_estimated: false,
            hidden_reasoning: false,
        }
    }

    #[test]
    fn generation_time_excludes_the_first_output_wait() {
        // 1,000 tokens over 12 s of generation; the 2 s wait is not part of the rate.
        let performance = evaluate(sample(Some(1_000), Some(2_000), Some(12_000)));
        assert_eq!(performance.speed_status, SpeedStatus::Measured);
        assert_eq!(performance.first_output_ms, Some(2_000));
        assert_eq!(performance.reason, None);
        assert!((performance.tokens_per_second.unwrap() - 83.333).abs() < 0.001);

        let performance = evaluate(sample(Some(1_000), Some(0), Some(10_000)));
        assert!((performance.tokens_per_second.unwrap() - 100.0).abs() < f64::EPSILON);
    }

    #[test]
    fn sample_minimums_accept_the_boundary_and_reject_shorter_values() {
        let boundary = evaluate(sample(
            Some(MIN_SPEED_OUTPUT_TOKENS),
            Some(0),
            Some(MIN_SPEED_GENERATION_MS),
        ));
        assert_eq!(boundary.speed_status, SpeedStatus::Measured);
        assert_eq!(boundary.tokens_per_second, Some(1_000.0));

        let short_output = evaluate(sample(
            Some(MIN_SPEED_OUTPUT_TOKENS - 1),
            Some(0),
            Some(MIN_SPEED_GENERATION_MS),
        ));
        assert_eq!(
            short_output.reason,
            Some(SpeedUnavailableReason::ShortOutput)
        );
        assert_eq!(short_output.tokens_per_second, None);

        let short_generation = evaluate(sample(
            Some(MIN_SPEED_OUTPUT_TOKENS),
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
    fn zero_time_and_missing_values_never_produce_an_unbounded_rate() {
        let zero = evaluate(sample(Some(5_000), Some(0), Some(0)));
        assert_eq!(zero.reason, Some(SpeedUnavailableReason::ShortGeneration));
        assert_eq!(zero.tokens_per_second, None);

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
    }

    #[test]
    fn estimated_inputs_are_marked_instead_of_reported_as_measured() {
        let hidden = evaluate(SpeedSample {
            hidden_reasoning: true,
            ..sample(Some(1_000), Some(2_000), Some(5_000))
        });
        assert_eq!(hidden.speed_status, SpeedStatus::Estimated);
        assert!(hidden.tokens_per_second.is_some());

        let estimated_tokens = evaluate(SpeedSample {
            tokens_estimated: true,
            ..sample(Some(1_000), Some(2_000), Some(5_000))
        });
        assert_eq!(estimated_tokens.speed_status, SpeedStatus::Estimated);
    }

    #[test]
    fn totals_divide_accumulated_output_by_accumulated_generation_time() {
        let mut totals = SpeedSampleTotals::default();
        totals.add(1_000, 10_000, false);
        totals.add(100, 100_000, false);
        // Pooled: 1,100 tokens over 110 s, not the mean of 100 and 1 tok/s.
        assert!((totals.average().unwrap() - 10.0).abs() < 0.001);
        assert_eq!(totals.status(), SpeedStatus::Measured);
        assert_eq!(totals.measured_samples, 2);
    }

    #[test]
    fn totals_prefer_measured_samples_over_estimated_ones() {
        let mut totals = SpeedSampleTotals::default();
        totals.add(1_000, 10_000, true);
        assert_eq!(totals.status(), SpeedStatus::Estimated);
        assert!((totals.average().unwrap() - 100.0).abs() < 0.001);

        totals.add(1_000, 20_000, false);
        assert_eq!(totals.status(), SpeedStatus::Measured);
        assert!((totals.average().unwrap() - 50.0).abs() < 0.001);

        assert_eq!(
            SpeedSampleTotals::default().status(),
            SpeedStatus::Unavailable
        );
        assert_eq!(SpeedSampleTotals::default().average(), None);
    }

    #[test]
    fn a_totals_with_zero_generation_time_has_no_rate() {
        let mut totals = SpeedSampleTotals::default();
        totals.add(500, 0, false);
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
