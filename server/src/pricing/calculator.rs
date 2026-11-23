//! Four-component token pricing calculation following provider protocol rules.
use serde::{Deserialize, Serialize};

use crate::{
    model::{CallOrigin, ProviderType, Usage},
    Result,
};

use super::decimal::DecimalPerMillion;

pub const DEFAULT_ASSUMED_CACHE_HIT_RATE_BPS: i64 = 9_000;
pub const ASSUMED_CACHE_MIN_INPUT_TOKENS: u64 = 1_024;
const BPS_DENOMINATOR: u128 = 10_000;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PricingRates {
    pub input_per_million: Option<String>,
    pub output_per_million: Option<String>,
    pub cache_read_per_million: Option<String>,
    pub cache_write_per_million: Option<String>,
}

impl PricingRates {
    pub fn has_any(&self) -> bool {
        self.input_per_million.is_some()
            || self.output_per_million.is_some()
            || self.cache_read_per_million.is_some()
            || self.cache_write_per_million.is_some()
    }

    pub fn with_fallback(&self, fallback: &Self) -> Self {
        Self {
            input_per_million: self
                .input_per_million
                .clone()
                .or_else(|| fallback.input_per_million.clone()),
            output_per_million: self
                .output_per_million
                .clone()
                .or_else(|| fallback.output_per_million.clone()),
            cache_read_per_million: self
                .cache_read_per_million
                .clone()
                .or_else(|| fallback.cache_read_per_million.clone()),
            cache_write_per_million: self
                .cache_write_per_million
                .clone()
                .or_else(|| fallback.cache_write_per_million.clone()),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PricingSource {
    Custom,
    Catalog,
    Unpriced,
}

impl PricingSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Custom => "custom",
            Self::Catalog => "catalog",
            Self::Unpriced => "unpriced",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "custom" => Self::Custom,
            "catalog" => Self::Catalog,
            _ => Self::Unpriced,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PricingSnapshot {
    pub source: PricingSource,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub snapshot_at_ms: i64,
    pub rates: PricingRates,
}

impl PricingSnapshot {
    pub fn unpriced(now_ms: i64) -> Self {
        Self {
            source: PricingSource::Unpriced,
            provider_id: None,
            model_id: None,
            snapshot_at_ms: now_ms,
            rates: PricingRates::default(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CostStatus {
    Priced,
    Unpriced,
    IncompleteUsage,
}

impl CostStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Priced => "priced",
            Self::Unpriced => "unpriced",
            Self::IncompleteUsage => "incomplete_usage",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CostBasis {
    Reported,
    AssumedCache,
}

impl CostBasis {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Reported => "reported",
            Self::AssumedCache => "assumed_cache",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BilledTokens {
    pub non_cached_input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CalculatedCost {
    pub status: CostStatus,
    pub cost_basis: Option<CostBasis>,
    pub assumed_cache_hit_rate_bps: Option<i64>,
    pub estimated_cache_read_tokens: Option<u64>,
    pub billed_tokens: Option<BilledTokens>,
    pub input_cost_nano: Option<i64>,
    pub output_cost_nano: Option<i64>,
    pub cache_read_cost_nano: Option<i64>,
    pub cache_write_cost_nano: Option<i64>,
    pub total_cost_nano: Option<i64>,
}

impl CalculatedCost {
    fn without_amounts(status: CostStatus, billed_tokens: Option<BilledTokens>) -> Self {
        Self {
            status,
            cost_basis: None,
            assumed_cache_hit_rate_bps: None,
            estimated_cache_read_tokens: None,
            billed_tokens,
            input_cost_nano: None,
            output_cost_nano: None,
            cache_read_cost_nano: None,
            cache_write_cost_nano: None,
            total_cost_nano: None,
        }
    }
}

pub fn billed_tokens(request_type: ProviderType, usage: &Usage) -> Option<BilledTokens> {
    let raw_input = usage.input_tokens?;
    let output = usage.output_tokens?;
    let cache_read = usage.cache_read_tokens.unwrap_or(0);
    let cache_write = usage.cache_write_tokens.unwrap_or(0);
    let non_cached_input = match request_type {
        ProviderType::Anthropic => raw_input,
        ProviderType::OpenAiChat | ProviderType::OpenAiResponses | ProviderType::Gemini | ProviderType::Plugin => {
            raw_input
                .saturating_sub(cache_read)
                .saturating_sub(cache_write)
        }
    };
    Some(BilledTokens {
        non_cached_input,
        output,
        cache_read,
        cache_write,
    })
}

fn should_assume_cache(
    call_origin: CallOrigin,
    raw_input: u64,
    usage: &Usage,
    snapshot: &PricingSnapshot,
) -> Result<bool> {
    if call_origin != CallOrigin::Run
        || usage.cache_read_tokens.is_some()
        || usage.cache_write_tokens.is_some()
        || raw_input < ASSUMED_CACHE_MIN_INPUT_TOKENS
    {
        return Ok(false);
    }
    let (Some(input_price), Some(cache_read_price)) = (
        snapshot.rates.input_per_million.as_deref(),
        snapshot.rates.cache_read_per_million.as_deref(),
    ) else {
        return Ok(false);
    };
    Ok(DecimalPerMillion::parse(cache_read_price)? < DecimalPerMillion::parse(input_price)?)
}

fn assumed_cache_split(raw_input: u64, hit_rate_bps: i64) -> u64 {
    let scaled = u128::from(raw_input) * (hit_rate_bps as u128);
    ((scaled + (BPS_DENOMINATOR / 2)) / BPS_DENOMINATOR) as u64
}

pub fn calculate_cost(
    request_type: ProviderType,
    call_origin: CallOrigin,
    usage: &Usage,
    snapshot: &PricingSnapshot,
    hit_rate_bps: i64,
) -> Result<CalculatedCost> {
    let Some(raw_input) = usage.input_tokens else {
        return Ok(CalculatedCost::without_amounts(
            CostStatus::IncompleteUsage,
            None,
        ));
    };
    let Some(output) = usage.output_tokens else {
        return Ok(CalculatedCost::without_amounts(
            CostStatus::IncompleteUsage,
            None,
        ));
    };
    let Some(reported_billed) = billed_tokens(request_type, usage) else {
        return Ok(CalculatedCost::without_amounts(
            CostStatus::IncompleteUsage,
            None,
        ));
    };

    if snapshot.source == PricingSource::Unpriced || !snapshot.rates.has_any() {
        return Ok(CalculatedCost::without_amounts(
            CostStatus::Unpriced,
            Some(reported_billed),
        ));
    }

    let (cost_basis, assumed_cache_hit_rate_bps, estimated_cache_read_tokens, billed) =
        if should_assume_cache(call_origin, raw_input, usage, snapshot)? {
            let estimated_cache_read = assumed_cache_split(raw_input, hit_rate_bps);
            let non_cached_input = raw_input.saturating_sub(estimated_cache_read);
            (
                CostBasis::AssumedCache,
                Some(hit_rate_bps),
                Some(estimated_cache_read),
                BilledTokens {
                    non_cached_input,
                    output,
                    cache_read: estimated_cache_read,
                    cache_write: 0,
                },
            )
        } else {
            (CostBasis::Reported, None, None, reported_billed)
        };

    let input_cost =
        component_cost_nano(billed.non_cached_input, &snapshot.rates.input_per_million)?;
    let output_cost = component_cost_nano(billed.output, &snapshot.rates.output_per_million)?;
    let cache_read_cost =
        component_cost_nano(billed.cache_read, &snapshot.rates.cache_read_per_million)?;
    let cache_write_cost =
        component_cost_nano(billed.cache_write, &snapshot.rates.cache_write_per_million)?;

    let (Some(input_nano), Some(output_nano), Some(cache_read_nano), Some(cache_write_nano)) =
        (input_cost, output_cost, cache_read_cost, cache_write_cost)
    else {
        return Ok(CalculatedCost::without_amounts(
            CostStatus::Unpriced,
            Some(reported_billed),
        ));
    };

    let total = input_nano
        .checked_add(output_nano)
        .and_then(|value| value.checked_add(cache_read_nano))
        .and_then(|value| value.checked_add(cache_write_nano))
        .ok_or_else(|| crate::Error::Store("total call cost exceeded i64 range".into()))?;

    Ok(CalculatedCost {
        status: CostStatus::Priced,
        cost_basis: Some(cost_basis),
        assumed_cache_hit_rate_bps,
        estimated_cache_read_tokens,
        billed_tokens: Some(billed),
        input_cost_nano: Some(input_nano),
        output_cost_nano: Some(output_nano),
        cache_read_cost_nano: Some(cache_read_nano),
        cache_write_cost_nano: Some(cache_write_nano),
        total_cost_nano: Some(total),
    })
}

fn component_cost_nano(tokens: u64, unit_price: &Option<String>) -> Result<Option<i64>> {
    if tokens == 0 {
        return Ok(Some(0));
    }
    let Some(unit_price) = unit_price.as_deref() else {
        return Ok(None);
    };
    let decimal = DecimalPerMillion::parse(unit_price)?;
    decimal.cost_nano(tokens).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn priced_snapshot() -> PricingSnapshot {
        PricingSnapshot {
            source: PricingSource::Catalog,
            provider_id: Some("test".into()),
            model_id: Some("model".into()),
            snapshot_at_ms: 1,
            rates: PricingRates {
                input_per_million: Some("2".into()),
                output_per_million: Some("10".into()),
                cache_read_per_million: Some("0.5".into()),
                cache_write_per_million: Some("2.5".into()),
            },
        }
    }

    #[test]
    fn openai_and_plugin_deduct_cached_tokens_and_ignore_extra_reasoning_charge() {
        let usage = Usage {
            input_tokens: Some(1_000_000),
            output_tokens: Some(100_000),
            cache_read_tokens: Some(800_000),
            cache_write_tokens: Some(0),
            reasoning_tokens: Some(50_000),
            ..Usage::default()
        };
        for protocol in [
            ProviderType::OpenAiChat,
            ProviderType::OpenAiResponses,
            ProviderType::Plugin,
        ] {
            let cost =
                calculate_cost(protocol, CallOrigin::Run, &usage, &priced_snapshot(), DEFAULT_ASSUMED_CACHE_HIT_RATE_BPS).unwrap();
            assert_eq!(cost.status, CostStatus::Priced);
            assert_eq!(cost.cost_basis, Some(CostBasis::Reported));
            assert_eq!(cost.assumed_cache_hit_rate_bps, None);
            assert_eq!(cost.estimated_cache_read_tokens, None);
            // non-cached input = 200k @ $2/M = $0.4 = 400_000_000 nano
            // output = 100k @ $10/M = $1.0 = 1_000_000_000 nano (reasoning NOT double billed)
            // cache read = 800k @ $0.5/M = $0.4 = 400_000_000 nano
            assert_eq!(cost.input_cost_nano, Some(400_000_000));
            assert_eq!(cost.output_cost_nano, Some(1_000_000_000));
            assert_eq!(cost.cache_read_cost_nano, Some(400_000_000));
            assert_eq!(cost.cache_write_cost_nano, Some(0));
            assert_eq!(cost.total_cost_nano, Some(1_800_000_000));
        }
    }

    #[test]
    fn anthropic_treats_input_tokens_as_non_cached_input() {
        let usage = Usage {
            input_tokens: Some(100_000),
            output_tokens: Some(50_000),
            cache_read_tokens: Some(400_000),
            cache_write_tokens: Some(200_000),
            ..Usage::default()
        };
        let cost = calculate_cost(
            ProviderType::Anthropic,
            CallOrigin::Run,
            &usage,
            &priced_snapshot(),
            DEFAULT_ASSUMED_CACHE_HIT_RATE_BPS,
        )
        .unwrap();
        assert_eq!(cost.status, CostStatus::Priced);
        assert_eq!(cost.cost_basis, Some(CostBasis::Reported));
        // 100k * $2 + 50k * $10 + 400k * $0.5 + 200k * $2.5 = 0.2 + 0.5 + 0.2 + 0.5 = 1.4 USD
        assert_eq!(cost.input_cost_nano, Some(200_000_000));
        assert_eq!(cost.output_cost_nano, Some(500_000_000));
        assert_eq!(cost.cache_read_cost_nano, Some(200_000_000));
        assert_eq!(cost.cache_write_cost_nano, Some(500_000_000));
        assert_eq!(cost.total_cost_nano, Some(1_400_000_000));
    }

    #[test]
    fn missing_required_usage_or_missing_used_price_keeps_cost_unknown() {
        let partial = Usage {
            input_tokens: Some(100),
            output_tokens: None,
            ..Usage::default()
        };
        assert_eq!(
            calculate_cost(
                ProviderType::OpenAiChat,
                CallOrigin::Run,
                &partial,
                &priced_snapshot(),
                DEFAULT_ASSUMED_CACHE_HIT_RATE_BPS,
            )
            .unwrap()
            .status,
            CostStatus::IncompleteUsage
        );

        let missing_cache_price = PricingSnapshot {
            source: PricingSource::Catalog,
            provider_id: Some("openai".into()),
            model_id: Some("gpt-4o".into()),
            snapshot_at_ms: 1,
            rates: PricingRates {
                input_per_million: Some("2.5".into()),
                output_per_million: Some("10".into()),
                cache_read_per_million: None,
                cache_write_per_million: None,
            },
        };
        // Cache read not used -> priced cleanly without assuming cache
        let no_cache_usage = Usage {
            input_tokens: Some(10_000),
            output_tokens: Some(100),
            ..Usage::default()
        };
        let no_cache_cost = calculate_cost(
            ProviderType::OpenAiChat,
            CallOrigin::Run,
            &no_cache_usage,
            &missing_cache_price,
            DEFAULT_ASSUMED_CACHE_HIT_RATE_BPS,
        )
        .unwrap();
        assert_eq!(no_cache_cost.status, CostStatus::Priced);
        assert_eq!(no_cache_cost.cost_basis, Some(CostBasis::Reported));
        // Cache read used without cache_read price -> unpriced
        let cached_usage = Usage {
            input_tokens: Some(1_000),
            output_tokens: Some(100),
            cache_read_tokens: Some(500),
            ..Usage::default()
        };
        assert_eq!(
            calculate_cost(
                ProviderType::OpenAiChat,
                CallOrigin::Run,
                &cached_usage,
                &missing_cache_price,
                DEFAULT_ASSUMED_CACHE_HIT_RATE_BPS,
            )
            .unwrap()
            .status,
            CostStatus::Unpriced
        );
    }

    #[test]
    fn zero_price_is_explicitly_priced_as_zero() {
        let free = PricingSnapshot {
            source: PricingSource::Custom,
            provider_id: None,
            model_id: None,
            snapshot_at_ms: 1,
            rates: PricingRates {
                input_per_million: Some("0".into()),
                output_per_million: Some("0".into()),
                cache_read_per_million: Some("0".into()),
                cache_write_per_million: Some("0".into()),
            },
        };
        let usage = Usage {
            input_tokens: Some(10_000),
            output_tokens: Some(500),
            cache_read_tokens: Some(2_000),
            ..Usage::default()
        };
        let cost =
            calculate_cost(ProviderType::OpenAiChat, CallOrigin::Run, &usage, &free, DEFAULT_ASSUMED_CACHE_HIT_RATE_BPS).unwrap();
        assert_eq!(cost.status, CostStatus::Priced);
        assert_eq!(cost.total_cost_nano, Some(0));
    }

    #[test]
    fn unreported_cache_on_long_run_assumes_ninety_percent_hit_rate_while_explicit_zero_does_not() {
        let gemini = PricingSnapshot {
            source: PricingSource::Catalog,
            provider_id: Some("google".into()),
            model_id: Some("gemini-2.5-pro".into()),
            snapshot_at_ms: 1,
            rates: PricingRates {
                input_per_million: Some("1.5".into()),
                output_per_million: Some("7.5".into()),
                cache_read_per_million: Some("0.075".into()),
                cache_write_per_million: None,
            },
        };

        // Omitted cache_read & cache_write on a >=1024 Run call -> 90% assumed cache hit
        let unreported = Usage {
            input_tokens: Some(179_726),
            output_tokens: Some(798),
            ..Usage::default()
        };
        for protocol in [
            ProviderType::Anthropic,
            ProviderType::OpenAiChat,
            ProviderType::OpenAiResponses,
        ] {
            let estimated =
                calculate_cost(protocol, CallOrigin::Run, &unreported, &gemini, DEFAULT_ASSUMED_CACHE_HIT_RATE_BPS).unwrap();
            assert_eq!(estimated.status, CostStatus::Priced);
            assert_eq!(estimated.cost_basis, Some(CostBasis::AssumedCache));
            assert_eq!(estimated.assumed_cache_hit_rate_bps, Some(9_000));
            assert_eq!(estimated.estimated_cache_read_tokens, Some(161_753));
            assert_eq!(
                estimated.billed_tokens,
                Some(BilledTokens {
                    non_cached_input: 17_973,
                    output: 798,
                    cache_read: 161_753,
                    cache_write: 0,
                })
            );
            assert_eq!(estimated.input_cost_nano, Some(26_959_500));
            assert_eq!(estimated.cache_read_cost_nano, Some(12_131_475));
            assert_eq!(estimated.output_cost_nano, Some(5_985_000));
            assert_eq!(estimated.total_cost_nano, Some(45_075_975));
        }

        // Explicit zero cache_read stays strictly uncached ("reported")
        let explicit_zero = Usage {
            input_tokens: Some(179_726),
            output_tokens: Some(798),
            cache_read_tokens: Some(0),
            ..Usage::default()
        };
        let exact_zero = calculate_cost(
            ProviderType::Anthropic,
            CallOrigin::Run,
            &explicit_zero,
            &gemini,
            DEFAULT_ASSUMED_CACHE_HIT_RATE_BPS,
        )
        .unwrap();
        assert_eq!(exact_zero.cost_basis, Some(CostBasis::Reported));
        assert_eq!(exact_zero.estimated_cache_read_tokens, None);
        assert_eq!(exact_zero.total_cost_nano, Some(275_574_000));

        // Cache creation present without cache_read -> cache usage reported (e.g. turn 0)
        let cache_create_only = Usage {
            input_tokens: Some(2_067),
            output_tokens: Some(323),
            cache_write_tokens: Some(64_247),
            ..Usage::default()
        };
        let turn0 = calculate_cost(
            ProviderType::Anthropic,
            CallOrigin::Run,
            &cache_create_only,
            &priced_snapshot(),
            DEFAULT_ASSUMED_CACHE_HIT_RATE_BPS,
        )
        .unwrap();
        assert_eq!(turn0.cost_basis, Some(CostBasis::Reported));
        assert_eq!(turn0.estimated_cache_read_tokens, None);

        // ModelTest or short (<1024) input never assumes cache
        let test_cost = calculate_cost(
            ProviderType::Anthropic,
            CallOrigin::ModelTest,
            &unreported,
            &gemini,
            DEFAULT_ASSUMED_CACHE_HIT_RATE_BPS,
        )
        .unwrap();
        assert_eq!(test_cost.cost_basis, Some(CostBasis::Reported));
        let short_usage = Usage {
            input_tokens: Some(1_023),
            output_tokens: Some(100),
            ..Usage::default()
        };
        let short_cost = calculate_cost(
            ProviderType::Anthropic,
            CallOrigin::Run,
            &short_usage,
            &gemini,
            DEFAULT_ASSUMED_CACHE_HIT_RATE_BPS,
        )
        .unwrap();
        assert_eq!(short_cost.cost_basis, Some(CostBasis::Reported));
    }
}
