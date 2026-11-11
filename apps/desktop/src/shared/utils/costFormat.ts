export type DisplayCurrency = "USD" | "CNY";

type DecimalParts = {
  negative: boolean;
  intPart: string;
  fracPart: string;
};

function normalizeDecimalParts(raw: string): DecimalParts | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = /^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(trimmed);
  if (!match) return null;
  const negative = match[1] === "-";
  const intPart = (match[2] ?? "0").replace(/^0+(?=\d)/, "") || "0";
  const fracPart = match[3] ?? match[4] ?? "";
  return { negative, intPart, fracPart };
}

function toScaledBigInt(parts: DecimalParts): { scaled: bigint; scale: number } {
  const digits = `${parts.intPart}${parts.fracPart}`;
  const unsigned = BigInt(digits);
  return {
    scaled: parts.negative && unsigned > 0n ? -unsigned : unsigned,
    scale: parts.fracPart.length,
  };
}

function scaledToDecimalString(scaled: bigint, scale: number): string {
  if (scaled === 0n) return "0";
  const negative = scaled < 0n;
  const absStr = (negative ? -scaled : scaled).toString();
  if (scale <= 0) {
    return `${negative ? "-" : ""}${absStr}${"0".repeat(-scale)}`;
  }
  const padded = absStr.padStart(scale + 1, "0");
  const whole = padded.slice(0, padded.length - scale);
  const frac = padded.slice(padded.length - scale).replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return frac ? `${sign}${whole}.${frac}` : `${sign}${whole}`;
}

export function trimDecimalString(raw: string): string {
  const parts = normalizeDecimalParts(raw);
  if (!parts) return "0";
  const frac = parts.fracPart.replace(/0+$/, "");
  const sign = parts.negative && (parts.intPart !== "0" || frac.length > 0) ? "-" : "";
  return frac ? `${sign}${parts.intPart}.${frac}` : `${sign}${parts.intPart}`;
}

export function isValidExchangeRate(raw: string | null | undefined): raw is string {
  if (!raw) return false;
  const parts = normalizeDecimalParts(raw);
  if (!parts || parts.negative) return false;
  return BigInt(parts.intPart) > 0n || /[1-9]/.test(parts.fracPart);
}

export function normalizeExchangeRate(raw: string): string | null {
  if (!isValidExchangeRate(raw)) return null;
  return trimDecimalString(raw);
}

export function addUsdStrings(left: string | null | undefined, right: string | null | undefined): string {
  const aParts = left ? normalizeDecimalParts(left) : null;
  const bParts = right ? normalizeDecimalParts(right) : null;
  if (!aParts && !bParts) return "0";
  const a = aParts ? toScaledBigInt(aParts) : { scaled: 0n, scale: 0 };
  const b = bParts ? toScaledBigInt(bParts) : { scaled: 0n, scale: 0 };
  const scale = Math.max(a.scale, b.scale);
  const leftScaled = a.scaled * 10n ** BigInt(scale - a.scale);
  const rightScaled = b.scaled * 10n ** BigInt(scale - b.scale);
  return scaledToDecimalString(leftScaled + rightScaled, scale);
}

export function compareUsdStrings(left: string | null | undefined, right: string | null | undefined): number {
  const aParts = left ? normalizeDecimalParts(left) : null;
  const bParts = right ? normalizeDecimalParts(right) : null;
  const a = aParts ? toScaledBigInt(aParts) : { scaled: 0n, scale: 0 };
  const b = bParts ? toScaledBigInt(bParts) : { scaled: 0n, scale: 0 };
  const scale = Math.max(a.scale, b.scale);
  const leftScaled = a.scaled * 10n ** BigInt(scale - a.scale);
  const rightScaled = b.scaled * 10n ** BigInt(scale - b.scale);
  return leftScaled < rightScaled ? -1 : leftScaled > rightScaled ? 1 : 0;
}

export function multiplyDecimalStrings(
  left: string | null | undefined,
  right: string | null | undefined,
): string | null {
  if (!left || !right) return null;
  const aParts = normalizeDecimalParts(left);
  const bParts = normalizeDecimalParts(right);
  if (!aParts || !bParts) return null;
  const a = toScaledBigInt(aParts);
  const b = toScaledBigInt(bParts);
  return scaledToDecimalString(a.scaled * b.scaled, a.scale + b.scale);
}

export function convertUsdToDisplayDecimal(
  usdValue: string | null | undefined,
  currency: DisplayCurrency,
  cnyRate: string | null | undefined,
): { currency: DisplayCurrency; amount: string; rateUsed: string | null } {
  const normalizedUsd = usdValue ? trimDecimalString(usdValue) : "0";
  if (currency === "CNY" && isValidExchangeRate(cnyRate)) {
    const normalizedRate = trimDecimalString(cnyRate);
    const converted = multiplyDecimalStrings(normalizedUsd, normalizedRate);
    if (converted !== null) {
      return { currency: "CNY", amount: converted, rateUsed: normalizedRate };
    }
  }
  return { currency: "USD", amount: normalizedUsd, rateUsed: null };
}

export function parseUsdAmount(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function convertUsdToDisplayNumber(
  usdValue: string | null | undefined,
  currency: DisplayCurrency,
  cnyRate: string | null | undefined,
): number {
  const converted = convertUsdToDisplayDecimal(usdValue, currency, cnyRate);
  const parsed = Number(converted.amount);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function groupInt(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatDecimalWithSymbol(value: string | null | undefined, symbol: string): string {
  const parts = value ? normalizeDecimalParts(value) : null;
  if (!parts) return `${symbol}0.00`;
  const frac = parts.fracPart.replace(/0+$/, "");
  const isZero = parts.intPart === "0" && frac.length === 0;
  if (isZero) return `${symbol}0.00`;

  const sign = parts.negative ? "-" : "";
  if (parts.intPart !== "0") {
    const paddedFrac = `${frac}00`.slice(0, 2);
    return `${sign}${symbol}${groupInt(parts.intPart)}.${paddedFrac}`;
  }

  // Value is in (0, 1): preserve precision cleanly without collapsing micro amounts to 0.00.
  const firstNonZero = frac.search(/[1-9]/);
  if (firstNonZero < 0) return `${symbol}0.00`;
  if (firstNonZero <= 1) {
    const clipped = frac.slice(0, 4).replace(/0+$/, "");
    const padded = clipped.length < 2 ? clipped.padEnd(2, "0") : clipped;
    return `${sign}${symbol}0.${padded}`;
  }
  const sliceLen = Math.min(frac.length, firstNonZero + 3);
  const clipped = frac.slice(0, sliceLen).replace(/0+$/, "");
  return `${sign}${symbol}0.${clipped}`;
}

function formatDecimalExactWithSymbol(value: string | null | undefined, symbol: string): string {
  const parts = value ? normalizeDecimalParts(value) : null;
  if (!parts) return `${symbol}0.00`;
  const frac = parts.fracPart.replace(/0+$/, "");
  const isZero = parts.intPart === "0" && frac.length === 0;
  if (isZero) return `${symbol}0.00`;
  const sign = parts.negative ? "-" : "";
  const formattedInt = groupInt(parts.intPart);
  if (!frac) return `${sign}${symbol}${formattedInt}.00`;
  return frac.length === 1 ? `${sign}${symbol}${formattedInt}.${frac}0` : `${sign}${symbol}${formattedInt}.${frac}`;
}

export function currencySymbol(currency: DisplayCurrency, cnyRate?: string | null): string {
  return currency === "CNY" && isValidExchangeRate(cnyRate) ? "¥" : "$";
}

export function effectiveCurrency(currency: DisplayCurrency, cnyRate?: string | null): DisplayCurrency {
  return currency === "CNY" && isValidExchangeRate(cnyRate) ? "CNY" : "USD";
}

export function formatUsd(value: string | null | undefined): string {
  return formatDecimalWithSymbol(value, "$");
}

export function formatUsdExact(value: string | null | undefined): string {
  return formatDecimalExactWithSymbol(value, "$");
}

export function formatDisplayCost(
  usdValue: string | null | undefined,
  currency: DisplayCurrency,
  cnyRate: string | null | undefined,
): string {
  const resolved = convertUsdToDisplayDecimal(usdValue, currency, cnyRate);
  return formatDecimalWithSymbol(resolved.amount, resolved.currency === "CNY" ? "¥" : "$");
}

export function formatDisplayCostExact(
  usdValue: string | null | undefined,
  currency: DisplayCurrency,
  cnyRate: string | null | undefined,
): string {
  const resolved = convertUsdToDisplayDecimal(usdValue, currency, cnyRate);
  return formatDecimalExactWithSymbol(resolved.amount, resolved.currency === "CNY" ? "¥" : "$");
}

export function formatAxisCost(
  amount: number,
  currency: DisplayCurrency,
  cnyRate: string | null | undefined,
): string {
  const symbol = currencySymbol(currency, cnyRate);
  if (!Number.isFinite(amount) || amount === 0) return `${symbol}0`;
  const decimalText = Math.abs(amount) < 1e-4 ? amount.toFixed(10) : amount.toFixed(6);
  return formatDecimalWithSymbol(decimalText, symbol);
}

export function formatCostTooltipWithOrigin(
  usdValue: string | null | undefined,
  currency: DisplayCurrency,
  cnyRate: string | null | undefined,
): string {
  const resolved = convertUsdToDisplayDecimal(usdValue, currency, cnyRate);
  if (resolved.currency === "CNY" && resolved.rateUsed) {
    return [
      formatDecimalExactWithSymbol(resolved.amount, "¥"),
      t("原美元金额：{cost}", { cost: formatUsdExact(usdValue) }),
      t("按设置汇率折算（1 USD = {rate} CNY）", { rate: resolved.rateUsed }),
    ].join("\n");
  }
  return formatUsdExact(usdValue);
}

export function formatConversionNote(currency: DisplayCurrency, cnyRate: string | null | undefined): string | null {
  if (currency !== "CNY" || !isValidExchangeRate(cnyRate)) return null;
  return t("按设置汇率折算（1 USD = {rate} CNY）", { rate: trimDecimalString(cnyRate) });
}

export function formatRatePerMillion(value: string | null | undefined): string {
  if (value == null) return "—";
  const parts = normalizeDecimalParts(value);
  if (!parts) return "—";
  const frac = parts.fracPart.replace(/0+$/, "");
  const clean = frac ? `${parts.intPart}.${frac}` : parts.intPart;
  return `$${clean}/1M`;
}

export function isValidCustomPriceInput(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  return /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmed);
}
