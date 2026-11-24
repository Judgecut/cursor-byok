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
  calls: number;
  tokens: number;
  cost: string;
  timestamp: number;
};

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
      const calls = sample.metrics.llm_calls - last.metrics.llm_calls;
      const tokens = sample.metrics.token_usage - last.metrics.token_usage;
      const previousCost = last.metrics.total_cost;
      const negativePreviousCost = previousCost.startsWith("-") ? previousCost.slice(1) : `-${previousCost}`;
      const cost = currencyChanged ? "0" : addUsdStrings(sample.metrics.total_cost, negativePreviousCost);
      if (calls !== 0 || tokens !== 0 || cost !== "0")
      {
        setChanges({ calls, tokens, cost, timestamp: Date.now() });
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
