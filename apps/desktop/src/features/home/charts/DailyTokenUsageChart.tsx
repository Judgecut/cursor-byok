import type { EChartsCoreOption } from "echarts/core";
import { useMemo, useState } from "react";
import type { TokenUsageGranularity } from "../../../shared/api";
import { formatUsd, parseUsdAmount } from "../../../shared/utils/costFormat";
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

type ChartMode = "tokens" | "cost";

type TooltipItem = {
  dataIndex: number;
};

const seriesColors = {
  input: "#0091ff",
  cacheRead: "#40c463",
  cacheWrite: "#3A62BA",
  output: "#E7B40B",
} as const;
const levelLineColor = "#E7B40B";
const emptyBarColor = "rgba(139, 148, 158, 0.20)";
const EMPTY_BAR_RATIO = 1;
const DATA_HEIGHT_RATIO = 1;

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

function totalCostNumber(day: DailyTokenUsage) {
  return parseUsdAmount(day.totalCost);
}

export function DailyTokenUsageChart({
  data,
  granularity,
}: {
  data: DailyTokenUsage[];
  granularity: TokenUsageGranularity;
}) {
  const [mode, setMode] = useState<ChartMode>("tokens");
  const [hovered, setHovered] = useState(false);

  const totals = useMemo(
    () => data.map((day) => (mode === "tokens" ? totalTokens(day) : totalCostNumber(day))),
    [data, mode],
  );
  const maximumTotal = totals.reduce((maximum, total) => Math.max(maximum, total), 0);
  const axisMaximum = mode === "tokens"
    ? Math.max(1, maximumTotal / DATA_HEIGHT_RATIO)
    : maximumTotal > 0 ? maximumTotal / DATA_HEIGHT_RATIO : 1;
  const emptyBarHeight = axisMaximum * EMPTY_BAR_RATIO;
  const nonZeroTotals = totals.filter((total) => total > 0);
  const averageLevel = nonZeroTotals.length === 0
    ? 0
    : nonZeroTotals.reduce((sum, total) => sum + total, 0) / nonZeroTotals.length;

  const option = useMemo<EChartsCoreOption>(() => ({
    animationDuration: 450,
    animationEasing: "cubicOut",
    grid: { top: 8, right: 0, bottom: 0, left: 0 },
    tooltip: {
      trigger: "axis",
      confine: true,
      backgroundColor: "var(--vscode-editorHoverWidget-background)",
      borderColor: "var(--vscode-editorHoverWidget-border)",
      textStyle: { color: "var(--vscode-foreground)", fontFamily: "PingFang-Medium" },
      extraCssText: "border-radius: 8px; box-shadow: 0 12px 32px rgb(0 0 0 / 30%); font-size: var(--daily-token-tooltip-font-size); line-height: 1.5;",
      axisPointer: {
        type: "shadow",
        shadowStyle: { color: "rgba(139, 148, 158, 0.14)" },
      },
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
          `${t("总费用")}：${formatUsd(day.totalCost)}`,
          `${colorMark(seriesColors.input)}${t("输入（非缓存）")}：${formatUsd(day.inputCost)}`,
          `${colorMark(seriesColors.cacheRead)}${t("缓存输入")}：${formatUsd(day.cacheReadCost)}`,
          `${colorMark(seriesColors.cacheWrite)}${t("缓存写入")}：${formatUsd(day.cacheWriteCost)}`,
          `${colorMark(seriesColors.output)}${t("模型输出")}：${formatUsd(day.outputCost)}`,
        ];
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
        margin: 14,
      },
    },
    yAxis: {
      type: "value",
      show: false,
      min: 0,
      max: axisMaximum,
    },
    series: [
      {
        name: mode === "tokens" ? t("无用量") : t("无费用"),
        type: "bar",
        stack: "empty-placeholder",
        data: totals.map((total) => total === 0 ? emptyBarHeight : 0),
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
        data: data.map((day) => mode === "tokens" ? day.inputTokens : parseUsdAmount(day.inputCost)),
        barMaxWidth: 18,
        itemStyle: { color: seriesColors.input },
        ...seriesFocus,
      },
      {
        name: t("缓存输入"),
        type: "bar",
        stack: "usage",
        data: data.map((day) => mode === "tokens" ? day.cacheReadTokens : parseUsdAmount(day.cacheReadCost)),
        barMaxWidth: 18,
        itemStyle: { color: seriesColors.cacheRead },
        ...seriesFocus,
      },
      {
        name: t("缓存写入"),
        type: "bar",
        stack: "usage",
        data: data.map((day) => mode === "tokens" ? day.cacheWriteTokens : parseUsdAmount(day.cacheWriteCost)),
        barMaxWidth: 18,
        itemStyle: { color: seriesColors.cacheWrite },
        ...seriesFocus,
      },
      {
        name: t("模型输出"),
        type: "bar",
        stack: "usage",
        data: data.map((day) => mode === "tokens" ? day.outputTokens : parseUsdAmount(day.outputCost)),
        barMaxWidth: 18,
        barGap: "-100%",
        itemStyle: { color: seriesColors.output, borderRadius: [2, 2, 0, 0] },
        markLine: {
          silent: true,
          symbol: "none",
          lineStyle: { color: levelLineColor, opacity: hovered ? 1 : 0, type: "dashed", width: 2 },
          label: {
            show: hovered,
            position: "insideStartTop",
            formatter: t("平均"),
            color: levelLineColor,
            distance: 8,
          },
          data: [{ yAxis: averageLevel }],
        },
        ...seriesFocus,
      },
    ],
  }), [averageLevel, axisMaximum, data, emptyBarHeight, granularity, hovered, mode, totals]);

  return <div className={styles.container}>
    <div className={styles.toolbar}>
      <div className={styles.modeSwitch} role="group" aria-label={t("趋势统计维度")}>
        <button type="button" aria-pressed={mode === "tokens"} onClick={() => setMode("tokens")}>Token</button>
        <button type="button" aria-pressed={mode === "cost"} onClick={() => setMode("cost")}>{t("费用")}</button>
      </div>
    </div>
    <EChart
      option={option}
      className={styles.root}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    />
  </div>;
}
