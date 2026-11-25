import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CostQuotaPeriod, type CostQuotas, type CostQuotaUsage } from "../../../shared/api";
import { COST_QUOTA_PERIODS, costQuotaWindows } from "../../../shared/utils/costQuota";

type Starts = Record<CostQuotaPeriod, number>;
type Sample = { starts: Starts; usage: CostQuotaUsage };
type Request = { starts: Starts; controller: AbortController; promise: Promise<void> };

export function useCostQuotaUsage(quotas: CostQuotas, active: boolean, refreshTick: number)
{
  const weekEnabled = quotas.week !== null;
  const monthEnabled = quotas.month !== null;
  const yearEnabled = quotas.year !== null;
  const enabled = weekEnabled || monthEnabled || yearEnabled;
  const [sample, setSample] = useState<Sample | null>(null);
  const [error, setError] = useState(false);
  const [queryStarts, setQueryStarts] = useState<Starts | null>(null);
  const inFlight = useRef<Request | null>(null);

  const refresh = useCallback((replace = false) =>
  {
    if (!enabled || !active) return Promise.resolve();
    const now = new Date();
    const { starts } = costQuotaWindows(now);
    const previous = inFlight.current;
    if (!replace && previous && COST_QUOTA_PERIODS.every((period) => previous.starts[period] === starts[period])) return previous.promise;
    previous?.controller.abort();
    setQueryStarts(starts);

    const controller = new AbortController();
    const promise = api.costQuotaUsage(starts, now.getTime(), controller.signal).then((usage) =>
    {
      if (controller.signal.aborted) return;
      setSample({ starts, usage });
      setError(false);
    }).catch(() =>
    {
      if (!controller.signal.aborted) setError(true);
    }).finally(() =>
    {
      if (inFlight.current?.controller === controller) inFlight.current = null;
    });
    inFlight.current = { starts, controller, promise };
    return promise;
  }, [active, enabled]);

  useEffect(() =>
  {
    if (!enabled)
    {
      setSample(null);
      setError(false);
    }
    void refresh(true);
    return () =>
    {
      inFlight.current?.controller.abort();
      inFlight.current = null;
    };
  }, [enabled, refresh, refreshTick]);

  useEffect(() =>
  {
    if (!enabled || !active) return;
    let timer: number;
    const schedule = () =>
    {
      const now = new Date();
      const { ends } = costQuotaWindows(now);
      const deadline = Math.min(weekEnabled ? ends.week : Infinity, monthEnabled ? ends.month : Infinity, yearEnabled ? ends.year : Infinity);
      timer = window.setTimeout(() =>
      {
        if (Date.now() >= deadline) void refresh();
        schedule();
      }, Math.min(deadline - now.getTime(), 2_000_000_000));
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [active, enabled, monthEnabled, refresh, weekEnabled, yearEnabled]);

  const usage = {
    week: sample && sample.starts.week === queryStarts?.week ? sample.usage.week : null,
    month: sample && sample.starts.month === queryStarts?.month ? sample.usage.month : null,
    year: sample && sample.starts.year === queryStarts?.year ? sample.usage.year : null,
  };
  return { usage, error, refresh };
}
