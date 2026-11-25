import type { BarSeriesOption, LineSeriesOption } from "echarts/charts";
import type { OverviewChartMode, OverviewChartType, OverviewTrendSeries } from "../../../shared/api";
import { convertUsdToDisplayNumber, type DisplayCurrency, type DisplayExchangeRate } from "../../../shared/utils/costFormat";

const GROUP_COLORS = ["#268cff", "#34aa68", "#a874ed", "#e9a226", "#e46d80", "#16a5af", "#bd7350"];

export function buildUsageTrendBreakdown(
  breakdown: OverviewTrendSeries[],
  buckets: { bucketStartMs: number }[],
  mode: OverviewChartMode,
  chartType: OverviewChartType,
  currency: DisplayCurrency,
  exchangeRate: DisplayExchangeRate | null,
)
{
  const rankKey = mode === "tokens" ? "token_rank" : "cost_rank";
  const groups = breakdown.flatMap((group) =>
  {
    const rank = group[rankKey];
    return rank === null ? [] : [{ group, rank }];
  }).sort((left, right) => left.rank - right.rank).slice(0, GROUP_COLORS.length).map(({ group }, index) =>
  {
    const byStart = new Map(group.buckets.map((bucket) => [bucket.bucket_start_ms, bucket]));
    const points = buckets.map(({ bucketStartMs }) => byStart.get(bucketStartMs));
    const values = points.map((point) => mode === "tokens" ? point?.token_usage ?? 0 : convertUsdToDisplayNumber(point?.total_cost, currency, exchangeRate));
    return { id: group.id, label: group.label, color: GROUP_COLORS[index], points, values };
  });

  const maximum = chartType === "bar"
    ? Math.max(0, ...buckets.map((_, index) => groups.reduce((sum, group) => sum + group.values[index], 0)))
    : Math.max(0, ...groups.flatMap((group) => group.values));
  const series = groups.map((group): BarSeriesOption | LineSeriesOption =>
  {
    const data = buckets.map(({ bucketStartMs }, index) => ({ id: String(bucketStartMs), value: group.values[index] }));
    const common = { id: group.id, name: group.label, data, itemStyle: { color: group.color }, emphasis: { focus: "series" as const }, universalTransition: true };
    return chartType === "bar"
      ? { ...common, type: "bar", stack: "usage", barWidth: "95%" }
      : { ...common, type: "line", smooth: 0.35, smoothMonotone: "x", showSymbol: buckets.length <= 1, symbolSize: 6, lineStyle: { color: group.color, width: 2 } };
  });

  return { groups, maximum, series };
}
