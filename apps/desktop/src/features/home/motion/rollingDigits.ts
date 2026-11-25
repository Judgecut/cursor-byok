export type RollDirection = 1 | -1 | 0;

export type MotionTone = "none" | "positive" | "attention" | "active" | "negative";

export type MotionPolarity = "higher-better" | "lower-better" | "cost" | "activity" | "neutral";

export type RollToken =
  | { kind: "static"; text: string; key: string }
  | {
      kind: "digit";
      target: string;
      steps: string[];
      direction: 1 | -1;
      delayMs: number;
      key: string;
      entering?: boolean;
    };

export type RollPlan = {
  shouldRoll: boolean;
  direction: RollDirection;
  tokens: RollToken[];
  maxDelayMs: number;
};

export type ParsedFormattedNumber = {
  prefix: string;
  sign: string;
  leadingText: string;
  intDigits: string;
  fracDigits: string;
  rawCore: string;
  suffix: string;
};

const MAX_STAGGER_DELAY_MS = 90;
const STAGGER_STEP_MS = 20;
const NUMBER_PATTERN = /^([^0-9-]*)(-?)([^0-9]*?)(\d[\d,]*(?:\.\d+)?)(.*)$/;

/** Maps a change direction and metric polarity to a semantic motion color tone. */
export function resolveMotionTone(direction: RollDirection, polarity: MotionPolarity): MotionTone {
  if (direction === 0 || polarity === "neutral") return "none";
  switch (polarity) {
    case "higher-better":
      return direction > 0 ? "positive" : "attention";
    case "lower-better":
      return direction < 0 ? "positive" : "attention";
    case "cost":
      return direction > 0 ? "attention" : "positive";
    case "activity":
      return direction > 0 ? "active" : "attention";
  }
}

/** Extracts prefix, sign, integer/fractional digits, and suffix from a formatted display value. */
export function parseFormattedNumber(text: string): ParsedFormattedNumber | null {
  const match = NUMBER_PATTERN.exec(text);
  if (!match) return null;
  const [, preMinus, minus, postMinus, rawCore, suffix] = match;
  const dotIndex = rawCore.indexOf(".");
  const intPart = dotIndex === -1 ? rawCore : rawCore.slice(0, dotIndex);
  const fracPart = dotIndex === -1 ? "" : rawCore.slice(dotIndex + 1);
  return {
    prefix: `${preMinus}${postMinus}`,
    sign: minus,
    leadingText: `${preMinus}${minus}${postMinus}`,
    intDigits: intPart.replace(/,/g, ""),
    fracDigits: fracPart,
    rawCore,
    suffix,
  };
}

/**
 * Builds the vertical digit sequence ordered top-to-bottom as rendered in the DOM:
 * - direction === 1 (increasing): [from, ..., to] so upward translation reveals `to`.
 * - direction === -1 (decreasing): [to, ..., from] so downward translation reveals `to`.
 */
export function buildCyclicSteps(fromDigit: string, toDigit: string, direction: 1 | -1): string[] {
  const from = Number(fromDigit);
  const to = Number(toDigit);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > 9 || to < 0 || to > 9) {
    return [toDigit];
  }
  if (from === to) return [toDigit];

  const sequence: string[] = [String(from)];
  let current = from;
  for (let step = 0; step < 10; step += 1) {
    current = (current + direction + 10) % 10;
    sequence.push(String(current));
    if (current === to) break;
  }
  return direction === 1 ? sequence : sequence.reverse();
}

function parseCoreNumeric(parsed: ParsedFormattedNumber): number {
  const raw = `${parsed.sign}${parsed.intDigits}${parsed.fracDigits ? `.${parsed.fracDigits}` : ""}`;
  return Number(raw);
}

function inferNumericDirection(prevNumeric?: number | null, nextNumeric?: number | null): RollDirection {
  if (
    prevNumeric != null
    && nextNumeric != null
    && Number.isFinite(prevNumeric)
    && Number.isFinite(nextNumeric)
    && prevNumeric !== nextNumeric
  ) {
    return nextNumeric > prevNumeric ? 1 : -1;
  }
  return 0;
}

function buildForcedSpinSteps(toDigit: string, direction: 1 | -1, spinSteps: number): string[] {
  const to = Number(toDigit);
  const clampedSteps = Math.max(1, Math.min(9, spinSteps));
  const from = (to - direction * clampedSteps + 20) % 10;
  return buildCyclicSteps(String(from), toDigit, direction);
}

function buildEnteringSteps(toDigit: string, direction: 1 | -1): string[] {
  if (direction === 1) {
    const fromDigit = toDigit === "0" ? "9" : "0";
    return buildCyclicSteps(fromDigit, toDigit, 1);
  }
  const fromDigit = String((Number(toDigit) + 2) % 10);
  return buildCyclicSteps(fromDigit, toDigit, -1);
}

/** Plans per-character static and rolling digit tokens between two formatted numeric strings. */
export function buildRollPlan(
  prevText: string | null,
  nextText: string,
  options?: {
    prevNumeric?: number | null;
    nextNumeric?: number | null;
    mountSpinSteps?: number;
  },
): RollPlan {
  if (prevText === nextText) {
    return {
      shouldRoll: false,
      direction: inferNumericDirection(options?.prevNumeric, options?.nextNumeric),
      tokens: [{ kind: "static", text: nextText, key: "static" }],
      maxDelayMs: 0,
    };
  }

  const nextParsed = parseFormattedNumber(nextText);
  if (!nextParsed) {
    return {
      shouldRoll: false,
      direction: 0,
      tokens: [{ kind: "static", text: nextText, key: "static" }],
      maxDelayMs: 0,
    };
  }

  const prevParsed = prevText !== null ? parseFormattedNumber(prevText) : null;
  let direction = inferNumericDirection(options?.prevNumeric, options?.nextNumeric);
  if (direction === 0 && prevParsed && prevParsed.prefix === nextParsed.prefix && prevParsed.suffix === nextParsed.suffix) {
    const prevVal = parseCoreNumeric(prevParsed);
    const nextVal = parseCoreNumeric(nextParsed);
    if (Number.isFinite(prevVal) && Number.isFinite(nextVal) && prevVal !== nextVal) {
      direction = nextVal > prevVal ? 1 : -1;
    }
  }
  const rollDir: 1 | -1 = direction === -1 ? -1 : 1;

  const canPlaceAlign = prevParsed !== null
    && prevParsed.prefix === nextParsed.prefix
    && prevParsed.suffix === nextParsed.suffix
    && prevParsed.sign === nextParsed.sign;

  const tokens: RollToken[] = [];
  if (nextParsed.leadingText) {
    tokens.push({ kind: "static", text: nextParsed.leadingText, key: "prefix" });
  }

  const dotIndex = nextParsed.rawCore.indexOf(".");
  const intLen = nextParsed.intDigits.length;
  const spinSteps = options?.mountSpinSteps ?? 2;
  let intIndex = 0;
  let fracIndex = 0;

  for (let i = 0; i < nextParsed.rawCore.length; i += 1) {
    const ch = nextParsed.rawCore[i];
    if (ch < "0" || ch > "9") {
      tokens.push({ kind: "static", text: ch, key: `sep-${i}` });
      continue;
    }

    const inFrac = dotIndex !== -1 && i > dotIndex;
    if (!canPlaceAlign || !prevParsed) {
      tokens.push({
        kind: "digit",
        target: ch,
        steps: buildForcedSpinSteps(ch, rollDir, spinSteps),
        direction: rollDir,
        delayMs: 0,
        key: inFrac ? `frac-${fracIndex}` : `int-${intLen - 1 - intIndex}`,
      });
    } else if (!inFrac) {
      const placeFromRight = intLen - 1 - intIndex;
      const prevIdx = prevParsed.intDigits.length - 1 - placeFromRight;
      const prevDigit = prevIdx >= 0 ? prevParsed.intDigits[prevIdx] : undefined;
      if (prevDigit === ch) {
        tokens.push({ kind: "static", text: ch, key: `int-static-${placeFromRight}` });
      } else if (prevDigit !== undefined) {
        tokens.push({
          kind: "digit",
          target: ch,
          steps: buildCyclicSteps(prevDigit, ch, rollDir),
          direction: rollDir,
          delayMs: 0,
          key: `int-${placeFromRight}`,
        });
      } else {
        tokens.push({
          kind: "digit",
          target: ch,
          steps: buildEnteringSteps(ch, rollDir),
          direction: rollDir,
          delayMs: 0,
          key: `int-${placeFromRight}`,
          entering: true,
        });
      }
    } else {
      const prevDigit = fracIndex < prevParsed.fracDigits.length ? prevParsed.fracDigits[fracIndex] : undefined;
      if (prevDigit === ch) {
        tokens.push({ kind: "static", text: ch, key: `frac-static-${fracIndex}` });
      } else if (prevDigit !== undefined) {
        tokens.push({
          kind: "digit",
          target: ch,
          steps: buildCyclicSteps(prevDigit, ch, rollDir),
          direction: rollDir,
          delayMs: 0,
          key: `frac-${fracIndex}`,
        });
      } else {
        tokens.push({
          kind: "digit",
          target: ch,
          steps: buildEnteringSteps(ch, rollDir),
          direction: rollDir,
          delayMs: 0,
          key: `frac-${fracIndex}`,
          entering: true,
        });
      }
    }

    if (inFrac) {
      fracIndex += 1;
    } else {
      intIndex += 1;
    }
  }

  if (nextParsed.suffix) {
    tokens.push({ kind: "static", text: nextParsed.suffix, key: "suffix" });
  }

  let digitOrder = 0;
  let maxDelayMs = 0;
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = tokens[i];
    if (token.kind !== "digit") continue;
    const delayMs = Math.min(MAX_STAGGER_DELAY_MS, digitOrder * STAGGER_STEP_MS);
    token.delayMs = delayMs;
    maxDelayMs = Math.max(maxDelayMs, delayMs);
    digitOrder += 1;
  }

  return {
    shouldRoll: digitOrder > 0,
    direction,
    tokens,
    maxDelayMs,
  };
}
