import { format, type EChartsCoreOption } from "echarts/core";
import { useMemo, useState } from "react";
import type { OverviewTrendSeries, TokenUsageGranularity } from "../../../shared/api";
import type { OverviewChartMode, OverviewChartType } from "../../../shared/store/appStore";
import {
  CURRENCY_SYMBOLS,
  convertUsdToDisplayNumber,
  formatAxisCost,
  formatConversionNote,
  formatDisplayCost,
  formatUsdExact,
  type DisplayCurrency,
  type DisplayExchangeRate,
} from "../../../shared/utils/costFormat";
import { formatCompactInteger } from "../../../shared/utils/numberFormat";
import { EChart } from "./EChart";
import { buildUsageTrendBreakdown } from "./usageTrendBreakdown";
import styles from "./DailyTokenUsageChart.module.scss";

export type DailyTokenUsage = {
  bucketStartMs: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  inputCost: string;
  outputCost: string;
  cacheReadCost: string;
  cacheWriteCost: string;
  totalCost: string;
  pricedCalls: number;
  unpricedCalls: number;
  incompleteUsageCalls: number;
  unreportedCacheCalls: number;
  assumedCacheCalls: number;
  assumedCacheCost: string;
  estimatedCacheReadTokens: number;
};

type TooltipItem = {
  dataIndex: number;
};

const seriesColors = {
  input: "#0091ff",
  cacheRead: "#40c463",
  cacheWrite: "#3A62BA",
  output: "#E7B40B",
  line: "#49b0ff",
} as const;
const levelLineColor = "#E7B40B";
const emptyBarColor = "rgba(139, 148, 158, 0.20)";

const seriesFocus = {
  emphasis: { focus: "series" },
  blur: { itemStyle: { opacity: 0.2 } },
} as const;

function colorMark(color: string): string {
  return `<span style="display:inline-block;width:8px;height:8px;margin-right:6px;border-radius:50%;background-color:${color};vertical-align:middle"></span>`;
}

function formatDay(value: Date) {
  return `${value.getUTCMonth() + 1}/${value.getUTCDate()}`;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function formatAxisLabel(bucketStartMs: number, granularity: TokenUsageGranularity) {
  const value = new Date(bucketStartMs);
  if (granularity === "minute") return `${pad(value.getHours())}:${pad(value.getMinutes())}`;
  if (granularity === "hour") return `${pad(value.getHours())}:00`;
  const day = value.getUTCDay();
  if (day === 6) return t("周六");
  if (day === 0) return t("周日");
  return formatDay(value);
}

function formatTooltipTime(bucketStartMs: number, granularity: TokenUsageGranularity) {
  const value = new Date(bucketStartMs);
  if (granularity === "day") return formatDay(value);
  const time = `${pad(value.getHours())}:${pad(value.getMinutes())}`;
  return `${value.getMonth() + 1}/${value.getDate()} ${time}`;
}

function totalTokens(day: DailyTokenUsage) {
  return day.inputTokens + day.cacheReadTokens + day.cacheWriteTokens + day.outputTokens;
}

export function DailyTokenUsageChart({
  data,
  breakdown,
  animate,
  filterKey,
  granularity,
  mode,
  chartType,
  currency,
  exchangeRate,
  loading = false,
  error = null,
}: {
  data: DailyTokenUsage[];
  breakdown: OverviewTrendSeries[] | null;
  animate: boolean;
  filterKey: string;
  granularity: TokenUsageGranularity;
  mode: OverviewChartMode;
  chartType: OverviewChartType;
  currency: DisplayCurrency;
  exchangeRate: DisplayExchangeRate | null;
  loading?: boolean;
  error?: string | null;
}) {
  const [hovered, setHovered] = useState(false);
  const conversionNote = mode === "cost" ? formatConversionNote(currency, exchangeRate) : null;
  const grouped = useMemo(() => breakdown === null ? null : buildUsageTrendBreakdown(breakdown, data, mode, chartType, currency, exchangeRate), [breakdown, data, mode, chartType, currency, exchangeRate]);

  const totals = useMemo(
    () => data.map((day) => (mode === "tokens"
      ? totalTokens(day)
      : convertUsdToDisplayNumber(day.totalCost, currency, exchangeRate))),
    [exchangeRate, currency, data, mode],
  );
  const maximumTotal = grouped?.maximum ?? totals.reduce((maximum, total) => Math.max(maximum, total), 0);
  const axisMaximum = mode === "tokens"
    ? Math.max(1, maximumTotal)
    : maximumTotal > 0 ? maximumTotal : 1;
  const nonZeroTotals = totals.filter((total) => total > 0);
  const averageLevel = nonZeroTotals.length === 0
    ? 0
    : nonZeroTotals.reduce((sum, total) => sum + total, 0) / nonZeroTotals.length;

  const unitLabel = mode === "tokens"
    ? t("单位：Token")
    : t("单位：{currency} ({symbol})", { currency, symbol: CURRENCY_SYMBOLS[currency] });

  const option = useMemo<EChartsCoreOption>(() => {
    const commonAxisPointer = chartType === "line"
      ? {
          type: "line" as const,
          lineStyle: { color: "rgba(139, 148, 158, 0.35)", width: 1, type: "dashed" as const },
        }
      : {
          type: "shadow" as const,
          shadowStyle: { color: "rgba(139, 148, 158, 0.14)" },
        };

    const markLine = {
      silent: true,
      symbol: "none",
      lineStyle: { color: levelLineColor, opacity: hovered ? 1 : 0, type: "dashed" as const, width: 2 },
      label: {
        show: hovered,
        position: "insideStartTop" as const,
        formatter: t("平均"),
        color: levelLineColor,
        distance: 8,
      },
      data: [{ yAxis: averageLevel }],
    };

    const byBucket = (values: number[]) => data.map((bucket, index) => ({ id: String(bucket.bucketStartMs), value: values[index] }));
    const barSeries: EChartsCoreOption[] = [
      {
        id: "empty",
        name: mode === "tokens" ? t("无用量") : t("无费用"),
        type: "bar",
        stack: "empty-placeholder",
        data: byBucket(totals.map((total) => total === 0 ? axisMaximum : 0)),
        barMaxWidth: 18,
        silent: true,
        z: 0,
        itemStyle: { color: emptyBarColor, borderRadius: [2, 2, 0, 0] },
        emphasis: { disabled: true },
      },
      {
        id: "input",
        name: t("输入（非缓存）"),
        type: "bar",
        stack: "usage",
        data: byBucket(data.map((day) => mode === "tokens"
          ? day.inputTokens
          : convertUsdToDisplayNumber(day.inputCost, currency, exchangeRate))),
        barMaxWidth: 18,
        itemStyle: { color: seriesColors.input },
        ...seriesFocus,
      },
      {
        id: "cache-read",
        name: t("缓存输入"),
        type: "bar",
        stack: "usage",
        data: byBucket(data.map((day) => mode === "tokens"
          ? day.cacheReadTokens
          : convertUsdToDisplayNumber(day.cacheReadCost, currency, exchangeRate))),
        barMaxWidth: 18,
        itemStyle: { color: seriesColors.cacheRead },
        ...seriesFocus,
      },
      {
        id: "cache-write",
        name: t("缓存写入"),
        type: "bar",
        stack: "usage",
        data: byBucket(data.map((day) => mode === "tokens"
          ? day.cacheWriteTokens
          : convertUsdToDisplayNumber(day.cacheWriteCost, currency, exchangeRate))),
        barMaxWidth: 18,
        itemStyle: { color: seriesColors.cacheWrite },
        ...seriesFocus,
      },
      {
        id: "output",
        name: t("模型输出"),
        type: "bar",
        stack: "usage",
        data: byBucket(data.map((day) => mode === "tokens"
          ? day.outputTokens
          : convertUsdToDisplayNumber(day.outputCost, currency, exchangeRate))),
        barMaxWidth: 18,
        barGap: "-100%",
        itemStyle: { color: seriesColors.output, borderRadius: [2, 2, 0, 0] },
        markLine,
        ...seriesFocus,
      },
    ];

    const lineSeries: EChartsCoreOption[] = [
      {
        id: "total",
        name: mode === "tokens" ? t("总 Token") : t("总费用"),
        type: "line",
        data: byBucket(totals),
        smooth: 0.35,
        smoothMonotone: "x",
        clip: true,
        symbol: "circle",
        symbolSize: 6,
        showSymbol: totals.length <= 1,
        lineStyle: { color: seriesColors.line, width: 2 },
        itemStyle: { color: seriesColors.line },
        areaStyle: {
          color: {
            type: "linear",
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: "rgba(73, 176, 255, 0.24)" },
              { offset: 1, color: "rgba(73, 176, 255, 0.02)" },
            ],
          },
        },
        markLine,
      },
    ];

    return {
      grid: { top: 10, right: 8, bottom: 26, left: 8, containLabel: true },
      tooltip: {
        trigger: "axis",
        className: styles.tooltip,
        backgroundColor: "var(--vscode-editorHoverWidget-background)",
        borderColor: "var(--vscode-editorHoverWidget-border)",
        textStyle: { color: "var(--vscode-foreground)", fontFamily: "PingFang-Medium" },
        extraCssText: "border-radius: 8px; box-shadow: 0 12px 32px rgb(0 0 0 / 30%); font-size: var(--daily-token-tooltip-font-size); line-height: 1.5;",
        axisPointer: commonAxisPointer,
        formatter: (params: unknown) => {
          const first = (params as TooltipItem[])[0];
          const day = first ? data[first.dataIndex] : undefined;
          if (!day) return "";
          if (grouped)
          {
            const lines = grouped.groups.map((group) =>
            {
              const point = group.points[first.dataIndex];
              const value = mode === "tokens" ? formatCompactInteger(point?.token_usage ?? 0) : formatDisplayCost(point?.total_cost, currency, exchangeRate);
              return `${colorMark(group.color)}${format.encodeHTML(group.label)}：${value}`;
            });
            return [formatTooltipTime(day.bucketStartMs, granularity), ...lines].join("<br/>");
          }
          if (mode === "tokens") {
            const lines = [
              formatTooltipTime(day.bucketStartMs, granularity),
              `${t("总请求")}：${formatCompactInteger(totalTokens(day))}`,
              `${colorMark(seriesColors.input)}${t("输入（非缓存）")}：${formatCompactInteger(day.inputTokens)}`,
              `${colorMark(seriesColors.cacheRead)}${t("缓存输入（已上报）")}：${formatCompactInteger(day.cacheReadTokens)}`,
              `${colorMark(seriesColors.cacheWrite)}${t("缓存写入（已上报）")}：${formatCompactInteger(day.cacheWriteTokens)}`,
              `${colorMark(seriesColors.output)}${t("模型输出")}：${formatCompactInteger(day.outputTokens)}`,
            ];
            if (day.unreportedCacheCalls > 0) {
              lines.push(`${t("未上报缓存调用")}：${formatCompactInteger(day.unreportedCacheCalls)}`);
            }
            if (day.estimatedCacheReadTokens > 0) {
              lines.push(`${t("按估算拆分缓存读取")}：~${formatCompactInteger(day.estimatedCacheReadTokens)}`);
            }
            return lines.join("<br/>");
          }
          const lines = [
            formatTooltipTime(day.bucketStartMs, granularity),
            `${t("总费用")}：${formatDisplayCost(day.totalCost, currency, exchangeRate)}`,
            `${colorMark(seriesColors.input)}${t("输入（非缓存）")}：${formatDisplayCost(day.inputCost, currency, exchangeRate)}`,
            `${colorMark(seriesColors.cacheRead)}${t("缓存输入")}：${formatDisplayCost(day.cacheReadCost, currency, exchangeRate)}`,
            `${colorMark(seriesColors.cacheWrite)}${t("缓存写入")}：${formatDisplayCost(day.cacheWriteCost, currency, exchangeRate)}`,
            `${colorMark(seriesColors.output)}${t("模型输出")}：${formatDisplayCost(day.outputCost, currency, exchangeRate)}`,
          ];
          if (conversionNote) {
            lines.push(
              `${t("原美元金额：{cost}", { cost: formatUsdExact(day.totalCost) })}`,
              conversionNote,
            );
          }
          if (day.assumedCacheCalls > 0) {
            lines.push(`${t("按缓存估算调用")}：${formatCompactInteger(day.assumedCacheCalls)}（${formatDisplayCost(day.assumedCacheCost, currency, exchangeRate)}）`);
          }
          if (day.unpricedCalls > 0) {
            lines.push(`${t("未定价调用")}：${formatCompactInteger(day.unpricedCalls)}`);
          }
          if (day.incompleteUsageCalls > 0) {
            lines.push(`${t("用量不完整调用")}：${formatCompactInteger(day.incompleteUsageCalls)}`);
          }
          return lines.join("<br/>");
        },
      },
      xAxis: {
        type: "category",
        boundaryGap: chartType === "bar",
        data: data.map(({ bucketStartMs }) => bucketStartMs),
        axisTick: { show: false },
        axisLine: { lineStyle: { color: "rgba(139, 148, 158, 0.32)" } },
        axisLabel: {
          interval: "auto",
          hideOverlap: true,
          formatter: (_value: string, index: number) => {
            const bucket = data[index];
            return bucket ? formatAxisLabel(bucket.bucketStartMs, granularity) : "";
          },
          color: "#8c8c8c",
          fontFamily: "HFKos",
          margin: 12,
        },
      },
      yAxis: {
        type: "value",
        show: true,
        min: 0,
        max: axisMaximum,
        splitNumber: 4,
        splitLine: { lineStyle: { color: "rgba(139, 148, 158, 0.14)" } },
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: "#8c8c8c",
          fontFamily: "HFKos",
          formatter: (value: number) => mode === "tokens"
            ? formatCompactInteger(value)
            : formatAxisCost(value, currency),
        },
      },
      series: grouped?.series ?? (chartType === "line" ? lineSeries : barSeries),
    };
  }, [averageLevel, axisMaximum, chartType, exchangeRate, conversionNote, currency, data, granularity, grouped, hovered, mode, totals]);

  return <div className={styles.container}>
    <div className={styles.metaBar}>
      <span className={styles.unit}>{unitLabel}</span>
      {conversionNote && <span className={styles.conversion}>{conversionNote}</span>}
    </div>
    {!!grouped?.groups.length && <ul className={styles.legend}>
      {grouped.groups.map(({ id, label, color }) => <li key={id} title={label}>
        <span className={styles.legendSwatch} style={{ backgroundColor: color }} aria-hidden="true" />
        <span className={styles.legendLabel}>{label}</span>
      </li>)}
    </ul>}
    {error
      ? <div className={styles.state}>{t("趋势数据加载失败：{error}", { error })}</div>
      : data.length === 0 || grouped?.groups.length === 0
        ? <div className={styles.state}>{loading ? t("正在加载趋势数据…") : t("当前筛选范围内暂无趋势数据")}</div>
        : <EChart
            option={option}
            transition={{ viewKey: JSON.stringify([filterKey, chartType, mode, granularity, mode === "cost" && currency, mode === "cost" && exchangeRate?.rate]), data: breakdown ?? data, enabled: animate }}
            className={styles.root}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
          />}
  </div>;
}
