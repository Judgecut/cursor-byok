import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import {
  buildRollPlan,
  resolveMotionTone,
  type MotionPolarity,
  type MotionTone,
  type RollPlan,
} from "./rollingDigits";
import styles from "./RollingNumber.module.scss";

const ROLL_DURATION_MS = 520;
const FLASH_DURATION_MS = 1150;

export type RollingNumberProps = {
  value: string;
  numericValue?: number | null;
  animate: boolean;
  resetKey?: string;
  polarity?: MotionPolarity;
  flashTone?: MotionTone;
  suppressFlash?: boolean;
  rollOnMount?: boolean;
  mountDelayMs?: number;
  className?: string;
};

type RollState = {
  id: number;
  plan: RollPlan;
  baseDelayMs: number;
};

type FlashState = {
  id: number;
  tone: Exclude<MotionTone, "none">;
};

/** Renders formatted numbers with a smooth vertical digit reel and optional semantic update flash. */
export function RollingNumber({
  value,
  numericValue,
  animate,
  resetKey,
  polarity = "neutral",
  flashTone,
  suppressFlash = false,
  rollOnMount = false,
  mountDelayMs = 0,
  className,
}: RollingNumberProps) {
  const prevRef = useRef({ value, numericValue, resetKey });
  const seqRef = useRef(0);
  const flashSeqRef = useRef(0);

  const [rollState, setRollState] = useState<RollState | null>(() => {
    if (!rollOnMount || !animate) return null;
    const plan = buildRollPlan(null, value, { nextNumeric: numericValue, mountSpinSteps: 2 });
    return plan.shouldRoll ? { id: ++seqRef.current, plan, baseDelayMs: mountDelayMs } : null;
  });
  const [flashState, setFlashState] = useState<FlashState | null>(null);

  useLayoutEffect(() => {
    const prev = prevRef.current;
    prevRef.current = { value, numericValue, resetKey };

    if (!animate) {
      setRollState(null);
      setFlashState(null);
      return;
    }

    const textChanged = prev.value !== value;
    const numericChanged = prev.numericValue != null
      && numericValue != null
      && Number.isFinite(prev.numericValue)
      && Number.isFinite(numericValue)
      && prev.numericValue !== numericValue;
    const contextChanged = prev.resetKey !== resetKey;

    if (!textChanged && !numericChanged) return;

    const plan = textChanged
      ? buildRollPlan(prev.value, value, {
          prevNumeric: contextChanged ? null : prev.numericValue,
          nextNumeric: contextChanged ? null : numericValue,
        })
      : null;

    if (plan) {
      if (plan.shouldRoll) {
        setRollState({ id: ++seqRef.current, plan, baseDelayMs: 0 });
      } else {
        setRollState(null);
      }
    }

    if (!contextChanged && !suppressFlash) {
      const direction = numericChanged
        ? (numericValue! > prev.numericValue! ? 1 : -1)
        : (plan?.direction ?? 0);
      const tone = flashTone ?? resolveMotionTone(direction, polarity);
      if (tone !== "none") {
        setFlashState({ id: ++flashSeqRef.current, tone });
      }
    }
  }, [animate, flashTone, numericValue, polarity, resetKey, suppressFlash, value]);

  useEffect(() => {
    if (!rollState) return;
    const totalMs = ROLL_DURATION_MS + rollState.plan.maxDelayMs + rollState.baseDelayMs + 40;
    const id = rollState.id;
    const timer = window.setTimeout(() => {
      setRollState((current) => (current?.id === id ? null : current));
    }, totalMs);
    return () => window.clearTimeout(timer);
  }, [rollState]);

  useEffect(() => {
    if (!flashState) return;
    const id = flashState.id;
    const timer = window.setTimeout(() => {
      setFlashState((current) => (current?.id === id ? null : current));
    }, FLASH_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [flashState]);

  const directionAttr = rollState?.plan.direction === 1
    ? "up"
    : rollState?.plan.direction === -1
      ? "down"
      : undefined;

  return (
    <span
      className={[styles.root, className].filter(Boolean).join(" ")}
      data-rolling={rollState ? "true" : undefined}
      data-direction={directionAttr}
      data-flash={flashState?.tone}
      data-flash-parity={flashState ? String(flashState.id % 2) : undefined}
    >
      {rollState
        ? rollState.plan.tokens.map((token) => {
            if (token.kind === "static") {
              return <span key={token.key} className={styles.staticToken}>{token.text}</span>;
            }
            const shift = `${((token.steps.length - 1) / token.steps.length) * 100}%`;
            return (
              <span
                key={`${rollState.id}-${token.key}`}
                className={styles.digitSlot}
                data-entering={token.entering ? "true" : undefined}
              >
                <span className={styles.digitMeasure} aria-hidden="true">{token.target}</span>
                <span
                  className={styles.digitTrack}
                  data-direction={token.direction > 0 ? "up" : "down"}
                  style={{
                    "--roll-shift": shift,
                    animationDelay: `${rollState.baseDelayMs + token.delayMs}ms`,
                  } as CSSProperties}
                >
                  {token.steps.map((digit, index) => (
                    <span key={index} className={styles.digitCell}>{digit}</span>
                  ))}
                </span>
              </span>
            );
          })
        : value}
    </span>
  );
}
