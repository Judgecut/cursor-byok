//! Four-component token pricing calculation following provider protocol rules.
use serde::{Deserialize, Serialize};

use crate::{
    model::{ProviderType, Usage},
    Result,
};

use super::decimal::DecimalPerMillion;

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
    pub billed_tokens: Option<BilledTokens>,
    pub input_cost_nano: Option<i64>,
    pub output_cost_nano: Option<i64>,
    pub cache_read_cost_nano: Option<i64>,
    pub cache_write_cost_nano: Option<i64>,
    pub total_cost_nano: Option<i64>,
}

pub fn billed_tokens(request_type: ProviderType, usage: &Usage) -> Option<BilledTokens> {
    let raw_input = usage.input_tokens?;
    let output = usage.output_tokens?;
    let cache_read = usage.cache_read_tokens.unwrap_or(0);
    let cache_write = usage.cache_write_tokens.unwrap_or(0);
    let non_cached_input = match request_type {
        ProviderType::Anthropic => raw_input,
        ProviderType::OpenAiChat | ProviderType::OpenAiResponses | ProviderType::Plugin => {
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

pub fn calculate_cost(
    request_type: ProviderType,
    usage: &Usage,
    snapshot: &PricingSnapshot,
) -> Result<CalculatedCost> {
    let Some(billed) = billed_tokens(request_type, usage) else {
        return Ok(CalculatedCost {
            status: CostStatus::IncompleteUsage,
            billed_tokens: None,
            input_cost_nano: None,
            output_cost_nano: None,
            cache_read_cost_nano: None,
            cache_write_cost_nano: None,
            total_cost_nano: None,
        });
    };

    if snapshot.source == PricingSource::Unpriced || !snapshot.rates.has_any() {
        return Ok(CalculatedCost {
            status: CostStatus::Unpriced,
            billed_tokens: Some(billed),
            input_cost_nano: None,
            output_cost_nano: None,
            cache_read_cost_nano: None,
            cache_write_cost_nano: None,
            total_cost_nano: None,
        });
    }

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
        return Ok(CalculatedCost {
            status: CostStatus::Unpriced,
            billed_tokens: Some(billed),
            input_cost_nano: None,
            output_cost_nano: None,
            cache_read_cost_nano: None,
            cache_write_cost_nano: None,
            total_cost_nano: None,
        });
    };

    let total = input_nano
        .checked_add(output_nano)
        .and_then(|value| value.checked_add(cache_read_nano))
        .and_then(|value| value.checked_add(cache_write_nano))
        .ok_or_else(|| crate::Error::Store("total call cost exceeded i64 range".into()))?;

    Ok(CalculatedCost {
        status: CostStatus::Priced,
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
            let cost = calculate_cost(protocol, &usage, &priced_snapshot()).unwrap();
            assert_eq!(cost.status, CostStatus::Priced);
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
        let cost = calculate_cost(ProviderType::Anthropic, &usage, &priced_snapshot()).unwrap();
        assert_eq!(cost.status, CostStatus::Priced);
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
            calculate_cost(ProviderType::OpenAiChat, &partial, &priced_snapshot())
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
        // Cache read not used -> priced cleanly
        let no_cache_usage = Usage {
            input_tokens: Some(1_000),
            output_tokens: Some(100),
            ..Usage::default()
        };
        assert_eq!(
            calculate_cost(
                ProviderType::OpenAiChat,
                &no_cache_usage,
                &missing_cache_price
            )
            .unwrap()
            .status,
            CostStatus::Priced
        );
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
                &cached_usage,
                &missing_cache_price
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
        let cost = calculate_cost(ProviderType::OpenAiChat, &usage, &free).unwrap();
        assert_eq!(cost.status, CostStatus::Priced);
        assert_eq!(cost.total_cost_nano, Some(0));
    }
}
