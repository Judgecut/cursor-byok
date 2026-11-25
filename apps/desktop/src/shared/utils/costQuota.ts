import type { CostQuotaPeriod } from "../api";
import { presetRange } from "./timeRange";

export const COST_QUOTA_PERIODS = ["week", "month", "year"] as const;

export function costQuotaLabel(period: CostQuotaPeriod)
{
  switch (period)
  {
    case "week": return t("周额度");
    case "month": return t("月额度");
    case "year": return t("年额度");
  }
}

export function costQuotaWindows(now: Date)
{
  const week = presetRange("week", now).startMs;
  const month = presetRange("month", now).startMs;
  const year = new Date(now.getFullYear(), 0, 1).getTime();
  const nextWeek = new Date(week);
  // Construct local midnight again in case this week's start fell in a DST gap.
  nextWeek.setDate(nextWeek.getDate() + 7);
  nextWeek.setHours(0, 0, 0, 0);
  return {
    starts: { week, month, year },
    ends: { week: nextWeek.getTime(), month: new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime(), year: new Date(now.getFullYear() + 1, 0, 1).getTime() },
  };
}
