import { useLayoutEffect, useRef, useState } from "react";
import type { Overview } from "../../../shared/api";
import { addUsdStrings } from "../../../shared/utils/costFormat";

const CHANGE_DURATION_MS = 4_000;

type Sample =
{
  filterKey: string;
  day: string;
  metrics: Overview["metrics"];
};

export type MetricChanges =
{
  cacheHitRate: number | null;
  calls: number;
  failedCalls: number;
  speed: number | null;
  firstOutputMs: number | null;
  tokens: number;
  cost: string;
  timestamp: number;
};

function computeCacheHitRatePercent(metrics: Overview["metrics"]): number | null
{
  const denominator = metrics.cache_read_tokens + metrics.reported_cache_input_tokens;
  return denominator > 0 ? (metrics.cache_read_tokens / denominator) * 100 : null;
}

function roundSpeedDisplay(value: number): number
{
  return value >= 1 ? Math.round(value) : Number(value.toFixed(1));
}

export function useMetricChanges(sample: Sample | null, active: boolean, currencyKey: string, reset: boolean)
{
  const previous = useRef<Sample | null>(null);
  const previousCurrency = useRef(currencyKey);
  const [changes, setChanges] = useState<MetricChanges | null>(null);

  useLayoutEffect(() =>
  {
    const last = previous.current;
    const currencyChanged = previousCurrency.current !== currencyKey;
    previous.current = sample;
    previousCurrency.current = currencyKey;

    if (reset || !active || !sample || !last || last.filterKey !== sample.filterKey || last.day !== sample.day)
    {
      setChanges(null);
      return;
    }

    if (last !== sample)
    {
      const prevRate = computeCacheHitRatePercent(last.metrics);
      const nextRate = computeCacheHitRatePercent(sample.metrics);
      const cacheHitRate = prevRate != null && nextRate != null && Math.abs(nextRate - prevRate) >= 0.005
        ? nextRate - prevRate
        : null;

      const calls = sample.metrics.llm_calls - last.metrics.llm_calls;
      const failedCalls = sample.metrics.failed_calls - last.metrics.failed_calls;

      const prevSpeed = last.metrics.speed.average_tokens_per_second;
      const nextSpeed = sample.metrics.speed.average_tokens_per_second;
      const speed = prevSpeed != null && nextSpeed != null && roundSpeedDisplay(prevSpeed) !== roundSpeedDisplay(nextSpeed)
        ? nextSpeed - prevSpeed
        : null;

      const prevFirstOutput = last.metrics.speed.first_output_median_ms;
      const nextFirstOutput = sample.metrics.speed.first_output_median_ms;
      const prevTenths = prevFirstOutput != null ? Math.round(prevFirstOutput / 100) : null;
      const nextTenths = nextFirstOutput != null ? Math.round(nextFirstOutput / 100) : null;
      const firstOutputMs = prevTenths !== null && nextTenths !== null && prevTenths !== nextTenths
        ? (nextTenths - prevTenths) * 100
        : null;

      const tokens = sample.metrics.token_usage - last.metrics.token_usage;
      const previousCost = last.metrics.total_cost;
      const negativePreviousCost = previousCost.startsWith("-") ? previousCost.slice(1) : `-${previousCost}`;
      const cost = currencyChanged ? "0" : addUsdStrings(sample.metrics.total_cost, negativePreviousCost);

      if (
        cacheHitRate !== null
        || calls !== 0
        || failedCalls !== 0
        || speed !== null
        || firstOutputMs !== null
        || tokens !== 0
        || cost !== "0"
      )
      {
        setChanges({ cacheHitRate, calls, failedCalls, speed, firstOutputMs, tokens, cost, timestamp: Date.now() });
        return;
      }
    }

    if (currencyChanged)
    {
      setChanges((current) => current && { ...current, cost: "0" });
    }
  }, [active, currencyKey, reset, sample]);

  const timestamp = changes?.timestamp;
  useLayoutEffect(() =>
  {
    if (timestamp === undefined) return;
    const timer = window.setTimeout(() => setChanges(null), Math.max(0, timestamp + CHANGE_DURATION_MS - Date.now()));
    return () => window.clearTimeout(timer);
  }, [timestamp]);

  return changes;
}
