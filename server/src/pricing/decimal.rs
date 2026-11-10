//! Exact base-10 pricing math in USD per million tokens and integer nanodollars.
use crate::{Error, Result};

pub const MAX_PRICE_SCALE: u32 = 15;
const MAX_CUSTOM_INPUT_SCALE: u32 = 12;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecimalPerMillion {
    pub mantissa: u128,
    pub scale: u32,
}

impl DecimalPerMillion {
    pub fn zero() -> Self {
        Self {
            mantissa: 0,
            scale: 0,
        }
    }

    pub fn parse(raw: &str) -> Result<Self> {
        parse_decimal_inner(raw, MAX_PRICE_SCALE)
    }

    pub fn parse_custom_input(raw: &str) -> Result<Self> {
        parse_decimal_inner(raw, MAX_CUSTOM_INPUT_SCALE)
    }

    pub fn canonical_string(&self) -> String {
        if self.mantissa == 0 {
            return "0".to_string();
        }
        if self.scale == 0 {
            return self.mantissa.to_string();
        }
        let digits = self.mantissa.to_string();
        let scale = self.scale as usize;
        if digits.len() <= scale {
            let zeros = "0".repeat(scale - digits.len());
            let formatted = format!("0.{zeros}{digits}");
            formatted.trim_end_matches('0').to_string()
        } else {
            let split = digits.len() - scale;
            let (whole, frac) = digits.split_at(split);
            let trimmed_frac = frac.trim_end_matches('0');
            if trimmed_frac.is_empty() {
                whole.to_string()
            } else {
                format!("{whole}.{trimmed_frac}")
            }
        }
    }

    /// Computes `(tokens * usd_per_million) / 1_000_000` in nanodollars (`10^-9` USD),
    /// rounded half-up.
    pub fn cost_nano(&self, tokens: u64) -> Result<i64> {
        if tokens == 0 || self.mantissa == 0 {
            return Ok(0);
        }
        let numerator = u128::from(tokens)
            .checked_mul(self.mantissa)
            .and_then(|value| value.checked_mul(1_000))
            .ok_or_else(|| Error::Store("token cost calculation overflowed u128".into()))?;
        let denominator = 10_u128
            .checked_pow(self.scale)
            .ok_or_else(|| Error::Store("price scale overflowed u128".into()))?;
        let rounded = numerator
            .checked_add(denominator / 2)
            .map(|value| value / denominator)
            .unwrap_or_else(|| {
                let quotient = numerator / denominator;
                let remainder = numerator % denominator;
                if remainder >= denominator.div_ceil(2) {
                    quotient.saturating_add(1)
                } else {
                    quotient
                }
            });
        i64::try_from(rounded)
            .map_err(|_| Error::Store("token cost exceeded maximum nanodollars".into()))
    }
}

pub fn parse_json_price(value: &serde_json::Value) -> Option<String> {
    let raw = match value {
        serde_json::Value::Number(number) => number.to_string(),
        serde_json::Value::String(text) => text.clone(),
        _ => return None,
    };
    DecimalPerMillion::parse(&raw)
        .ok()
        .map(|decimal| decimal.canonical_string())
}

pub fn canonicalize_custom_price(value: Option<&str>) -> Result<Option<String>> {
    let Some(raw) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let parsed = DecimalPerMillion::parse_custom_input(raw)?;
    Ok(Some(parsed.canonical_string()))
}

pub fn format_nano_usd(nano: i64) -> String {
    if nano == 0 {
        return "0".to_string();
    }
    let negative = nano < 0;
    let abs = nano.unsigned_abs();
    let whole = abs / 1_000_000_000;
    let frac = abs % 1_000_000_000;
    let body = if frac == 0 {
        whole.to_string()
    } else {
        let padded = format!("{frac:09}");
        let trimmed = padded.trim_end_matches('0');
        format!("{whole}.{trimmed}")
    };
    if negative {
        format!("-{body}")
    } else {
        body
    }
}

pub fn divide_nano_round_half_up(total_nano: i64, count: i64) -> Option<i64> {
    if count <= 0 {
        return None;
    }
    if total_nano == 0 {
        return Some(0);
    }
    let total = i128::from(total_nano);
    let divisor = i128::from(count);
    let adjusted = if total >= 0 {
        total * 2 + divisor
    } else {
        total * 2 - divisor
    };
    let result = adjusted / (divisor * 2);
    i64::try_from(result).ok()
}

fn parse_decimal_inner(raw: &str, max_scale: u32) -> Result<DecimalPerMillion> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(Error::Config("price cannot be empty".into()));
    }
    if trimmed.starts_with('-') {
        return Err(Error::Config("price cannot be negative".into()));
    }
    let unsigned = trimmed.strip_prefix('+').unwrap_or(trimmed);
    if unsigned.eq_ignore_ascii_case("nan")
        || unsigned.eq_ignore_ascii_case("inf")
        || unsigned.eq_ignore_ascii_case("infinity")
    {
        return Err(Error::Config(format!("invalid price: {raw}")));
    }

    let (mantissa_part, exponent) = match unsigned.find(['e', 'E']) {
        Some(index) => {
            let exp_str = &unsigned[index + 1..];
            let exp = exp_str
                .parse::<i32>()
                .map_err(|_| Error::Config(format!("invalid price exponent: {raw}")))?;
            (&unsigned[..index], exp)
        }
        None => (unsigned, 0),
    };

    let (int_part, frac_part) = match mantissa_part.split_once('.') {
        Some((int_part, frac_part)) => {
            if frac_part.contains('.') {
                return Err(Error::Config(format!("invalid price decimal: {raw}")));
            }
            (int_part, frac_part)
        }
        None => (mantissa_part, ""),
    };

    if (int_part.is_empty() && frac_part.is_empty())
        || !int_part.bytes().all(|byte| byte.is_ascii_digit())
        || !frac_part.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(Error::Config(format!("invalid price digits: {raw}")));
    }

    let mut digits = format!("{int_part}{frac_part}");
    let stripped = digits.trim_start_matches('0');
    if stripped.is_empty() {
        return Ok(DecimalPerMillion::zero());
    }
    digits = stripped.to_owned();

    let raw_scale = i64::try_from(frac_part.len())
        .map_err(|_| Error::Config(format!("price too long: {raw}")))?
        - i64::from(exponent);

    // Strip trailing zeros first cleanly by adjusting raw_scale downward.
    while digits.ends_with('0') && raw_scale > 0 {
        digits.pop();
        return normalize_mantissa_and_scale(digits, raw_scale - 1, raw, max_scale);
    }

    normalize_mantissa_and_scale(digits, raw_scale, raw, max_scale)
}

fn normalize_mantissa_and_scale(
    mut digits: String,
    mut raw_scale: i64,
    original: &str,
    max_scale: u32,
) -> Result<DecimalPerMillion> {
    while raw_scale > 0 && digits.ends_with('0') {
        digits.pop();
        raw_scale -= 1;
    }
    if raw_scale < 0 {
        let extra_zeros = usize::try_from(-raw_scale)
            .map_err(|_| Error::Config(format!("price exponent overflow: {original}")))?;
        if digits.len() + extra_zeros > 38 {
            return Err(Error::Config(format!("price is too large: {original}")));
        }
        digits.push_str(&"0".repeat(extra_zeros));
        raw_scale = 0;
    }
    let scale = u32::try_from(raw_scale)
        .map_err(|_| Error::Config(format!("price scale invalid: {original}")))?;
    if scale > max_scale {
        return Err(Error::Config(format!(
            "price exceeds {max_scale} decimal places: {original}"
        )));
    }
    let mantissa = digits
        .parse::<u128>()
        .map_err(|_| Error::Config(format!("price is too large: {original}")))?;
    Ok(DecimalPerMillion { mantissa, scale })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_scientific_trailing_zeros_and_exact_nanodollars() {
        let p = DecimalPerMillion::parse("5e-5").unwrap();
        assert_eq!(p.canonical_string(), "0.00005");
        assert_eq!(p.cost_nano(1_000_000).unwrap(), 50_000);

        let zero = DecimalPerMillion::parse("0.000").unwrap();
        assert_eq!(zero.canonical_string(), "0");
        assert_eq!(zero.cost_nano(1_234_567).unwrap(), 0);

        let opus = DecimalPerMillion::parse("15.00").unwrap();
        assert_eq!(opus.canonical_string(), "15");
        // 1,000 tokens @ $15 / 1M = $0.015 = 15_000_000 nano
        assert_eq!(opus.cost_nano(1_000).unwrap(), 15_000_000);

        let small = DecimalPerMillion::parse("0.0750").unwrap();
        assert_eq!(small.canonical_string(), "0.075");
        // 2,000 tokens @ $0.075 / 1M = $0.00015 = 150_000 nano
        assert_eq!(small.cost_nano(2_000).unwrap(), 150_000);
    }

    #[test]
    fn rounds_half_up_at_nanodollar_boundary() {
        // $0.0005 / 1M = 0.5 nano per 1 token -> half-up = 1 nano
        let p = DecimalPerMillion::parse("0.0005").unwrap();
        assert_eq!(p.cost_nano(1).unwrap(), 1);
        assert_eq!(p.cost_nano(2).unwrap(), 1_000 * 5 * 2 / 10_000);
    }

    #[test]
    fn rejects_negative_and_invalid_prices() {
        assert!(DecimalPerMillion::parse("-1.5").is_err());
        assert!(DecimalPerMillion::parse("NaN").is_err());
        assert!(DecimalPerMillion::parse("").is_err());
        assert!(DecimalPerMillion::parse("1.2.3").is_err());
    }

    #[test]
    fn formats_nanodollars_without_trailing_zeros() {
        assert_eq!(format_nano_usd(0), "0");
        assert_eq!(format_nano_usd(1_500_000_000), "1.5");
        assert_eq!(format_nano_usd(124_000), "0.000124");
        assert_eq!(format_nano_usd(1), "0.000000001");
    }

    #[test]
    fn averages_round_half_up() {
        assert_eq!(divide_nano_round_half_up(100, 0), None);
        assert_eq!(divide_nano_round_half_up(3, 2), Some(2));
        assert_eq!(divide_nano_round_half_up(5, 2), Some(3));
        assert_eq!(divide_nano_round_half_up(0, 4), Some(0));
    }
}
