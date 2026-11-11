import type { EChartsCoreOption } from "echarts/core";
import { useMemo, useState } from "react";
import type { TokenUsageGranularity } from "../../../shared/api";
import type { OverviewChartMode, OverviewChartType } from "../../../shared/store/appStore";
import {
  convertUsdToDisplayNumber,
  effectiveCurrency,
  formatAxisCost,
  formatConversionNote,
  formatDisplayCost,
  formatUsdExact,
  type DisplayCurrency,
} from "../../../shared/utils/costFormat";
import { formatCompactInteger } from "../../../shared/utils/numberFormat";
import { EChart } from "./EChart";
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
  granularity,
  mode,
  chartType,
  currency,
  cnyRate,
  loading = false,
  error = null,
}: {
  data: DailyTokenUsage[];
  granularity: TokenUsageGranularity;
  mode: OverviewChartMode;
  chartType: OverviewChartType;
  currency: DisplayCurrency;
  cnyRate: string | null;
  loading?: boolean;
  error?: string | null;
}) {
  const [hovered, setHovered] = useState(false);
  const resolvedCurrency = effectiveCurrency(currency, cnyRate);
  const conversionNote = mode === "cost" ? formatConversionNote(currency, cnyRate) : null;

  const totals = useMemo(
    () => data.map((day) => (mode === "tokens"
      ? totalTokens(day)
      : convertUsdToDisplayNumber(day.totalCost, currency, cnyRate))),
    [cnyRate, currency, data, mode],
  );
  const maximumTotal = totals.reduce((maximum, total) => Math.max(maximum, total), 0);
  const axisMaximum = mode === "tokens"
    ? Math.max(1, maximumTotal)
    : maximumTotal > 0 ? maximumTotal : 1;
  const nonZeroTotals = totals.filter((total) => total > 0);
  const averageLevel = nonZeroTotals.length === 0
    ? 0
    : nonZeroTotals.reduce((sum, total) => sum + total, 0) / nonZeroTotals.length;

  const unitLabel = mode === "tokens"
    ? t("单位：Token")
    : resolvedCurrency === "CNY"
      ? t("单位：CNY (¥)")
      : t("单位：USD ($)");

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

    const barSeries: EChartsCoreOption[] = [
      {
        name: mode === "tokens" ? t("无用量") : t("无费用"),
        type: "bar",
        stack: "empty-placeholder",
        data: totals.map((total) => total === 0 ? axisMaximum : 0),
        barMaxWidth: 18,
        silent: true,
        z: 0,
        itemStyle: { color: emptyBarColor, borderRadius: [2, 2, 0, 0] },
        emphasis: { disabled: true },
      },
      {
        name: t("输入（非缓存）"),
        type: "bar",
        stack: "usage",
        data: data.map((day) => mode === "tokens"
          ? day.inputTokens
          : convertUsdToDisplayNumber(day.inputCost, currency, cnyRate)),
        barMaxWidth: 18,
        itemStyle: { color: seriesColors.input },
        ...seriesFocus,
      },
      {
        name: t("缓存输入"),
        type: "bar",
        stack: "usage",
        data: data.map((day) => mode === "tokens"
          ? day.cacheReadTokens
          : convertUsdToDisplayNumber(day.cacheReadCost, currency, cnyRate)),
        barMaxWidth: 18,
        itemStyle: { color: seriesColors.cacheRead },
        ...seriesFocus,
      },
      {
        name: t("缓存写入"),
        type: "bar",
        stack: "usage",
        data: data.map((day) => mode === "tokens"
          ? day.cacheWriteTokens
          : convertUsdToDisplayNumber(day.cacheWriteCost, currency, cnyRate)),
        barMaxWidth: 18,
        itemStyle: { color: seriesColors.cacheWrite },
        ...seriesFocus,
      },
      {
        name: t("模型输出"),
        type: "bar",
        stack: "usage",
        data: data.map((day) => mode === "tokens"
          ? day.outputTokens
          : convertUsdToDisplayNumber(day.outputCost, currency, cnyRate)),
        barMaxWidth: 18,
        barGap: "-100%",
        itemStyle: { color: seriesColors.output, borderRadius: [2, 2, 0, 0] },
        markLine,
        ...seriesFocus,
      },
    ];

    const lineSeries: EChartsCoreOption[] = [
      {
        name: mode === "tokens" ? t("总 Token") : t("总费用"),
        type: "line",
        data: totals,
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
      animationDuration: 450,
      animationEasing: "cubicOut",
      grid: { top: 10, right: 8, bottom: 26, left: 8, containLabel: true },
      tooltip: {
        trigger: "axis",
        confine: true,
        backgroundColor: "var(--vscode-editorHoverWidget-background)",
        borderColor: "var(--vscode-editorHoverWidget-border)",
        textStyle: { color: "var(--vscode-foreground)", fontFamily: "PingFang-Medium" },
        extraCssText: "border-radius: 8px; box-shadow: 0 12px 32px rgb(0 0 0 / 30%); font-size: var(--daily-token-tooltip-font-size); line-height: 1.5;",
        axisPointer: commonAxisPointer,
        formatter: (params: unknown) => {
          const first = (params as TooltipItem[])[0];
          const day = first ? data[first.dataIndex] : undefined;
          if (!day) return "";
          if (mode === "tokens") {
            return [
              formatTooltipTime(day.bucketStartMs, granularity),
              `${t("总请求")}：${formatCompactInteger(totalTokens(day))}`,
              `${colorMark(seriesColors.input)}${t("输入（非缓存）")}：${formatCompactInteger(day.inputTokens)}`,
              `${colorMark(seriesColors.cacheRead)}${t("缓存输入")}：${formatCompactInteger(day.cacheReadTokens)}`,
              `${colorMark(seriesColors.cacheWrite)}${t("缓存写入")}：${formatCompactInteger(day.cacheWriteTokens)}`,
              `${colorMark(seriesColors.output)}${t("模型输出")}：${formatCompactInteger(day.outputTokens)}`,
            ].join("<br/>");
          }
          const lines = [
            formatTooltipTime(day.bucketStartMs, granularity),
            `${t("总费用")}：${formatDisplayCost(day.totalCost, currency, cnyRate)}`,
            `${colorMark(seriesColors.input)}${t("输入（非缓存）")}：${formatDisplayCost(day.inputCost, currency, cnyRate)}`,
            `${colorMark(seriesColors.cacheRead)}${t("缓存输入")}：${formatDisplayCost(day.cacheReadCost, currency, cnyRate)}`,
            `${colorMark(seriesColors.cacheWrite)}${t("缓存写入")}：${formatDisplayCost(day.cacheWriteCost, currency, cnyRate)}`,
            `${colorMark(seriesColors.output)}${t("模型输出")}：${formatDisplayCost(day.outputCost, currency, cnyRate)}`,
          ];
          if (conversionNote) {
            lines.push(
              `${t("原美元金额：{cost}", { cost: formatUsdExact(day.totalCost) })}`,
              conversionNote,
            );
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
            : formatAxisCost(value, currency, cnyRate),
        },
      },
      series: chartType === "line" ? lineSeries : barSeries,
    };
  }, [averageLevel, axisMaximum, chartType, cnyRate, conversionNote, currency, data, granularity, hovered, mode, totals]);

  return <div className={styles.container}>
    <div className={styles.metaBar}>
      <span className={styles.unit}>{unitLabel}</span>
      {conversionNote && <span className={styles.conversion}>{conversionNote}</span>}
    </div>
    {error
      ? <div className={styles.state}>{t("趋势数据加载失败：{error}", { error })}</div>
      : data.length === 0
        ? <div className={styles.state}>{loading ? t("正在加载趋势数据…") : t("当前筛选范围内暂无趋势数据")}</div>
        : <EChart
            option={option}
            className={styles.root}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
          />}
  </div>;
}
