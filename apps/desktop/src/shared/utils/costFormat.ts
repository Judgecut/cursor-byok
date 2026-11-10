const NANO_SCALE = 1_000_000_000n;

function normalizeDecimalParts(raw: string): { negative: boolean; intPart: string; fracPart: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = /^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(trimmed);
  if (!match) return null;
  const negative = match[1] === "-";
  const intPart = (match[2] ?? "0").replace(/^0+(?=\d)/, "") || "0";
  const fracPart = match[3] ?? match[4] ?? "";
  return { negative, intPart, fracPart };
}

function decimalToNano(raw: string | null | undefined): bigint | null {
  if (!raw) return null;
  const parts = normalizeDecimalParts(raw);
  if (!parts) return null;
  const padded = `${parts.fracPart}000000000`.slice(0, 9);
  const abs = BigInt(parts.intPart) * NANO_SCALE + BigInt(padded);
  return parts.negative && abs > 0n ? -abs : abs;
}

function nanoToDecimalString(nano: bigint): string {
  const negative = nano < 0n;
  const abs = negative ? -nano : nano;
  const whole = abs / NANO_SCALE;
  const frac = abs % NANO_SCALE;
  if (frac === 0n) return `${negative ? "-" : ""}${whole.toString()}`;
  const fracStr = frac.toString().padStart(9, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}.${fracStr}`;
}

export function trimDecimalString(raw: string): string {
  const parts = normalizeDecimalParts(raw);
  if (!parts) return "0";
  const frac = parts.fracPart.replace(/0+$/, "");
  const sign = parts.negative && (parts.intPart !== "0" || frac.length > 0) ? "-" : "";
  return frac ? `${sign}${parts.intPart}.${frac}` : `${sign}${parts.intPart}`;
}

export function addUsdStrings(left: string | null | undefined, right: string | null | undefined): string {
  const a = decimalToNano(left) ?? 0n;
  const b = decimalToNano(right) ?? 0n;
  return nanoToDecimalString(a + b);
}

export function parseUsdAmount(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function groupInt(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatUsd(value: string | null | undefined): string {
  const parts = value ? normalizeDecimalParts(value) : null;
  if (!parts) return "$0.00";
  const frac = parts.fracPart.replace(/0+$/, "");
  const isZero = parts.intPart === "0" && frac.length === 0;
  if (isZero) return "$0.00";

  const sign = parts.negative ? "-" : "";
  if (parts.intPart !== "0") {
    const paddedFrac = `${frac}00`.slice(0, 2);
    return `${sign}$${groupInt(parts.intPart)}.${paddedFrac}`;
  }

  // Value is in (0, 1): preserve precision cleanly without collapsing micro-USD to $0.00.
  const firstNonZero = frac.search(/[1-9]/);
  if (firstNonZero < 0) return "$0.00";
  if (firstNonZero <= 1) {
    // >= $0.01: keep at least 2 decimals, up to 4 significant decimals when needed.
    const clipped = frac.slice(0, 4).replace(/0+$/, "");
    const padded = clipped.length < 2 ? clipped.padEnd(2, "0") : clipped;
    return `${sign}$0.${padded}`;
  }
  // < $0.01: keep leading zeros up to firstNonZero + 3 significant digits.
  const sliceLen = Math.min(frac.length, firstNonZero + 3);
  const clipped = frac.slice(0, sliceLen).replace(/0+$/, "");
  return `${sign}$0.${clipped}`;
}

export function formatUsdExact(value: string | null | undefined): string {
  const parts = value ? normalizeDecimalParts(value) : null;
  if (!parts) return "$0.00";
  const frac = parts.fracPart.replace(/0+$/, "");
  const isZero = parts.intPart === "0" && frac.length === 0;
  if (isZero) return "$0.00";
  const sign = parts.negative ? "-" : "";
  const formattedInt = groupInt(parts.intPart);
  if (!frac) return `${sign}$${formattedInt}.00`;
  return frac.length === 1 ? `${sign}$${formattedInt}.${frac}0` : `${sign}$${formattedInt}.${frac}`;
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
