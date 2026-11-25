import type { EChartsCoreOption } from "echarts/core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { init, Rect, type ElementEvent, type ZRenderType } from "zrender";
import { useI18n } from "../../../i18n/store";
import type { OverviewCalendarChartType } from "../../../shared/store/appStore";
import { Card } from "../../../shared/ui/Card";
import { useTooltip, type TooltipAnchor } from "../../../shared/ui/Tooltip";
import { compareUsdStrings, convertUsdToDisplayNumber, formatDisplayCost, formatDisplayCostExact, type DisplayCurrency, type DisplayExchangeRate } from "../../../shared/utils/costFormat";
import { formatCompactInteger, formatInteger } from "../../../shared/utils/numberFormat";
import { RollingNumber } from "../motion/RollingNumber";
import type { MotionTone } from "../motion/rollingDigits";
import { EChart } from "./EChart";
import {
  buildCalendarLayout,
  buildContributionSeries,
  CONTRIBUTION_LEVEL_COLORS,
  summarizeContribution,
  type CalendarCell,
  type CalendarLayout,
  type ContributionDay,
  type ContributionSeries,
  type ContributionWindow,
} from "./contributionCalendar";
import styles from "./ContributionCalendarChart.module.scss";

export type { ContributionDay };

type ContributionCalendarChartProps = {
  data: ContributionDay[];
  animate: boolean;
  filterKey: string;
  windowMode: ContributionWindow;
  onWindowModeChange: (value: ContributionWindow) => void;
  chartType: OverviewCalendarChartType;
  onChartTypeChange: (value: OverviewCalendarChartType) => void;
  currency: DisplayCurrency;
  exchangeRate: DisplayExchangeRate | null;
  quotaProgress?: ReactNode;
  loading?: boolean;
  error?: string | null;
};

type CellExtra = CalendarCell & {
  kind: "calendar-cell";
  x: number;
  y: number;
  width: number;
  height: number;
};

type AxisLabel = {
  key: string;
  text: string;
  left: number;
  width?: number;
};

type CalendarGeometry = {
  cellSize: number;
  cellGap: number;
  gridWidth: number;
  gridHeight: number;
  gridTemplateColumns: string | null;
  axisCentered: boolean;
  axisLabels: AxisLabel[];
};

type TooltipItem = {
  dataIndex: number;
};

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const REFERENCE_MONDAY_MS = Date.UTC(2024, 0, 1);
const WEEKDAY_ROWS = [0, 2, 4] as const;
const LINE_COLOR = "#40c463";
const AVERAGE_LINE_COLOR = "#E7B40B";

const CALENDAR_CONFIG = {
  resizeTransitionMs: 180,
  colorTransitionMs: 420,
  highlightDurationMs: 1_200,
  calendarPadX: 34,
  cardGap: 12,
  weekdayReserve: 40,
  wideLayoutMinWidth: 1340,
  summaryMinWidth: 360,
  summaryMaxWidth: 760,
  summaryRatio: 0.28,
} as const;

const WINDOW_GEOMETRY_CONFIG: Record<
  ContributionWindow,
  {
    minCellSize: number;
    singleMaxCellSize: number;
    wideMaxCellSize: number;
    cellGap: number;
    axisLabelWidth: number;
    axisLabelGap: number;
    cornerRadius: (cellSize: number) => number;
  }
> = {
  year: {
    minCellSize: 9,
    singleMaxCellSize: 20,
    wideMaxCellSize: 22,
    cellGap: 3,
    axisLabelWidth: 28,
    axisLabelGap: 8,
    cornerRadius: (cellSize) => Math.min(3, cellSize / 4),
  },
  month: {
    minCellSize: 16,
    singleMaxCellSize: 26,
    wideMaxCellSize: 28,
    cellGap: 4,
    axisLabelWidth: 36,
    axisLabelGap: 8,
    cornerRadius: (cellSize) => Math.min(3, cellSize / 4),
  },
  week: {
    minCellSize: 32,
    singleMaxCellSize: 60,
    wideMaxCellSize: 64,
    cellGap: 10,
    axisLabelWidth: 58,
    axisLabelGap: 4,
    cornerRadius: (cellSize) => Math.min(6, cellSize / 6),
  },
};

function cellOffset(index: number, cellSize: number, cellGap: number) {
  return index * (cellSize + cellGap);
}

function isCellExtra(value: unknown): value is CellExtra {
  return typeof value === "object" && value !== null && (value as CellExtra).kind === "calendar-cell";
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function computeWideSummaryWidth(bodyWidth: number): number | null {
  if (bodyWidth < CALENDAR_CONFIG.wideLayoutMinWidth) return null;
  return Math.min(
    CALENDAR_CONFIG.summaryMaxWidth,
    Math.max(CALENDAR_CONFIG.summaryMinWidth, Math.round(bodyWidth * CALENDAR_CONFIG.summaryRatio)),
  );
}

function computeCalendarGeometry(bodyWidth: number, layout: CalendarLayout): CalendarGeometry {
  const windowConfig = WINDOW_GEOMETRY_CONFIG[layout.window];
  const colCount = layout.columnCount;
  const rowCount = layout.rowCount;
  const showWeekday = rowCount > 1;
  const weekdayReserve = showWeekday ? CALENDAR_CONFIG.weekdayReserve : 0;
  const cellGap = windowConfig.cellGap;
  const gapsWidth = Math.max(0, colCount - 1) * cellGap;
  const summaryTarget = computeWideSummaryWidth(bodyWidth);
  const calendarBudget = summaryTarget !== null ? bodyWidth - summaryTarget - CALENDAR_CONFIG.cardGap : bodyWidth;

  const availableGridWidth = Math.max(
    0,
    calendarBudget - CALENDAR_CONFIG.calendarPadX - weekdayReserve,
  );
  const rawCellSize = colCount > 0
    ? (availableGridWidth - gapsWidth) / colCount
    : windowConfig.minCellSize;
  const maxCellSize = summaryTarget !== null
    ? windowConfig.wideMaxCellSize
    : windowConfig.singleMaxCellSize;
  const cellSize = Math.max(
    windowConfig.minCellSize,
    Math.min(maxCellSize, rawCellSize),
  );
  const gridWidth = Math.round(colCount * cellSize + gapsWidth);
  const gridHeight = Math.round(
    rowCount * cellSize + Math.max(0, rowCount - 1) * cellGap,
  );

  let gridTemplateColumns: string | null = null;
  if (summaryTarget !== null) {
    const calendarPaneWidth = gridWidth + weekdayReserve + CALENDAR_CONFIG.calendarPadX;
    const keepCompactCalendar = layout.window === "year"
      && calendarPaneWidth >= bodyWidth - CALENDAR_CONFIG.cardGap - CALENDAR_CONFIG.summaryMaxWidth;
    gridTemplateColumns = keepCompactCalendar
      ? `${calendarPaneWidth}px minmax(0, 1fr)`
      : `minmax(0, 1fr) ${summaryTarget}px`;
  }

  const axisCentered = layout.window === "week" && cellSize >= windowConfig.axisLabelWidth;
  let lastLabelEnd = -Infinity;
  const axisLabels: AxisLabel[] = axisCentered
    ? layout.axisTicks.map((tick) => ({
        ...tick,
        left: cellOffset(tick.column, cellSize, cellGap),
        width: cellSize,
      }))
    : layout.axisTicks.flatMap((tick) => {
        const left = Math.min(
          cellOffset(tick.column, cellSize, cellGap),
          Math.max(0, gridWidth - windowConfig.axisLabelWidth),
        );
        if (left < lastLabelEnd + windowConfig.axisLabelGap) return [];
        lastLabelEnd = left + windowConfig.axisLabelWidth;
        return [{ ...tick, left }];
      });

  return {
    cellSize,
    cellGap,
    gridWidth,
    gridHeight,
    gridTemplateColumns,
    axisCentered,
    axisLabels,
  };
}

function buildSeriesChartOption({
  series,
  chartType,
  windowMode,
  hovered,
  highlightedDates,
  tokenFormatter,
}: {
  series: ContributionSeries;
  chartType: Exclude<OverviewCalendarChartType, "heatmap">;
  windowMode: ContributionWindow;
  hovered: boolean;
  highlightedDates: ReadonlySet<string>;
  tokenFormatter: Intl.NumberFormat;
}): EChartsCoreOption {
  const axisMaximum = Math.max(1, series.maxTokens);
  const markLine = series.averageActiveTokens !== null && series.averageActiveTokens > 0
    ? {
        silent: true,
        symbol: "none",
        lineStyle: { color: AVERAGE_LINE_COLOR, opacity: hovered ? 1 : 0, type: "dashed" as const, width: 2 },
        label: {
          show: hovered,
          position: "insideStartTop" as const,
          formatter: t("平均"),
          color: AVERAGE_LINE_COLOR,
          distance: 8,
        },
        data: [{ yAxis: series.averageActiveTokens }],
      }
    : { data: [] };

  const barSeries: EChartsCoreOption[] = [
    {
      id: "tokens",
      name: t("Token 用量"),
      type: "bar",
      barWidth: "95%",
      universalTransition: true,
      data: series.points.map((point) => {
        const isHighlighted = highlightedDates.has(point.date);
        return {
          id: point.date,
          value: point.tokens,
          itemStyle: isHighlighted
            ? {
                color: CONTRIBUTION_LEVEL_COLORS[point.level],
                shadowBlur: 12,
                shadowColor: "rgba(64, 196, 99, 0.65)",
              }
            : {
                color: CONTRIBUTION_LEVEL_COLORS[point.level],
                shadowBlur: 0,
              },
        };
      }),
      markLine,
    },
  ];

  const defaultShowSymbol = windowMode !== "year" || series.points.length <= 31;
  const lineSeries: EChartsCoreOption[] = [
    {
      name: t("Token 用量"),
      id: "tokens",
      type: "line",
      universalTransition: true,
      data: series.points.map((point) => {
        const isHighlighted = highlightedDates.has(point.date);
        return {
          id: point.date,
          value: point.tokens,
          ...(defaultShowSymbol
            ? (isHighlighted ? { symbolSize: 9 } : {})
            : { symbolSize: isHighlighted ? 9 : 0 }),
          ...(isHighlighted
            ? { itemStyle: { color: LINE_COLOR, shadowBlur: 12, shadowColor: "rgba(64, 196, 99, 0.7)" } }
            : {}),
        };
      }),
      smooth: true,
      smoothMonotone: "x",
      clip: true,
      symbol: "circle",
      symbolSize: windowMode === "week" ? 7 : 5,
      showSymbol: defaultShowSymbol || highlightedDates.size > 0,
      lineStyle: { color: LINE_COLOR, width: 2 },
      itemStyle: { color: LINE_COLOR },
      areaStyle: {
        color: {
          type: "linear",
          x: 0,
          y: 0,
          x2: 0,
          y2: 1,
          colorStops: [
            { offset: 0, color: "rgba(64, 196, 99, 0.24)" },
            { offset: 1, color: "rgba(64, 196, 99, 0.02)" },
          ],
        },
      },
      markLine,
    },
  ];

  return {
    grid: { top: 12, right: 10, bottom: 24, left: 8, containLabel: true },
    tooltip: {
      trigger: "axis",
      className: styles.tooltip,
      backgroundColor: "var(--vscode-editorHoverWidget-background)",
      borderColor: "var(--vscode-editorHoverWidget-border)",
      textStyle: { color: "var(--vscode-foreground)", fontFamily: "PingFang-Medium" },
      extraCssText: "border-radius: 8px; box-shadow: 0 12px 32px rgb(0 0 0 / 30%); font-size: var(--contribution-tooltip-font-size); line-height: 1.5;",
      axisPointer: { type: "line", lineStyle: { color: "rgba(139, 148, 158, 0.35)", width: 1, type: "dashed" } },
      formatter: (params: unknown) => {
        const first = Array.isArray(params) ? (params[0] as TooltipItem | undefined) : undefined;
        const point = first ? series.points[first.dataIndex] : undefined;
        if (!point) return "";
        return [
          `<strong>${escapeHtml(point.tooltipLabel)}</strong>`,
          t("Token 用量：{tokens}", { tokens: tokenFormatter.format(point.tokens) }),
        ].join("<br/>");
      },
    },
    xAxis: {
      type: "category",
      boundaryGap: chartType === "bar" || series.points.length <= 1,
      data: series.points.map((point) => point.axisLabel),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: "rgba(139, 148, 158, 0.32)" } },
      axisLabel: {
        interval: windowMode === "week" ? 0 : "auto",
        hideOverlap: true,
        fontFamily: "HFKos",
        margin: 10,
      },
    },
    yAxis: {
      type: "value",
      show: true,
      min: 0,
      max: axisMaximum,
      splitNumber: 3,
      splitLine: { lineStyle: { color: "rgba(139, 148, 158, 0.14)" } },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        fontFamily: "HFKos",
        formatter: (value: number) => formatCompactInteger(value),
      },
    },
    series: chartType === "line" ? lineSeries : barSeries,
  };
}

function resolveHeaderLabels(chartType: OverviewCalendarChartType, windowMode: ContributionWindow) {
  const sectionAriaLabel = windowMode === "year"
    ? t("过去一年的 Token 用量")
    : windowMode === "month"
      ? t("本月的 Token 用量")
      : t("本周的 Token 用量");

  if (chartType === "bar") {
    return {
      title: windowMode === "year"
        ? t("年度活动柱状图（近 365 天，按当前供应商筛选）")
        : windowMode === "month"
          ? t("月度活动柱状图（本月，按当前供应商筛选）")
          : t("周度活动柱状图（本周，按当前供应商筛选）"),
      sectionAriaLabel,
      chartAriaLabel: windowMode === "year"
        ? t("过去一年的 Token 用量柱状图")
        : windowMode === "month"
          ? t("本月的 Token 用量柱状图")
          : t("本周的 Token 用量柱状图"),
    };
  }

  if (chartType === "line") {
    return {
      title: windowMode === "year"
        ? t("年度活动曲线图（近 365 天，按当前供应商筛选）")
        : windowMode === "month"
          ? t("月度活动曲线图（本月，按当前供应商筛选）")
          : t("周度活动曲线图（本周，按当前供应商筛选）"),
      sectionAriaLabel,
      chartAriaLabel: windowMode === "year"
        ? t("过去一年的 Token 用量曲线图")
        : windowMode === "month"
          ? t("本月的 Token 用量曲线图")
          : t("本周的 Token 用量曲线图"),
    };
  }

  return {
    title: windowMode === "year"
      ? t("年度活动日历（近 365 天，按当前供应商筛选）")
      : windowMode === "month"
        ? t("月度活动日历（本月，按当前供应商筛选）")
        : t("周度活动日历（本周，按当前供应商筛选）"),
    sectionAriaLabel,
    chartAriaLabel: windowMode === "year"
      ? t("过去一年的 Token 用量日历")
      : windowMode === "month"
        ? t("本月的 Token 用量日历")
        : t("本周的 Token 用量日历"),
  };
}

export function ContributionCalendarChart({
  data,
  animate,
  filterKey,
  windowMode,
  onWindowModeChange,
  chartType,
  onChartTypeChange,
  currency,
  exchangeRate,
  quotaProgress,
  loading = false,
  error = null,
}: ContributionCalendarChartProps) {
  const { locale } = useI18n();
  const bodyRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const zrenderRef = useRef<ZRenderType | null>(null);
  const cellRectsRef = useRef<Map<string, Rect>>(new Map());
  const lastGridSizeRef = useRef({ width: -1, height: -1 });
  const lastWindowRef = useRef<ContributionWindow | null>(null);
  const { show: showTooltip, hide: hideTooltip } = useTooltip();
  const [bodyWidth, setBodyWidth] = useState(0);
  const [seriesHovered, setSeriesHovered] = useState(false);
  const [highlightedDates, setHighlightedDates] = useState<ReadonlySet<string>>(() => new Set());
  const prevSeriesRef = useRef<{ key: string; tokensByDate: Map<string, number>; data: ContributionDay[] } | null>(null);
  const [summaryPulses, setSummaryPulses] = useState<{
    id: number;
    total?: MotionTone;
    activeDays?: MotionTone;
    totalCost?: MotionTone;
    peak?: MotionTone;
  } | null>(null);
  const summaryPulseSeqRef = useRef(0);
  const prevSummaryRef = useRef<{
    key: string;
    currencyKey: string;
    totalTokens: number;
    activeDays: number;
    totalCost: string;
    peakTokens: number | null;
  } | null>(null);

  const layout = useMemo(
    () => (chartType === "heatmap" ? buildCalendarLayout(data, windowMode, locale) : null),
    [chartType, data, locale, windowMode],
  );
  const series = useMemo(
    () => (chartType !== "heatmap" ? buildContributionSeries(data, windowMode, locale) : null),
    [chartType, data, locale, windowMode],
  );
  const summary = useMemo(() => summarizeContribution(data, windowMode), [data, windowMode]);
  const hasData = Boolean(summary && (chartType === "heatmap" ? layout : series) && !error);
  const isHeatmap = hasData && chartType === "heatmap";

  useLayoutEffect(() => {
    const key = `${filterKey}|${windowMode}`;
    const tokensByDate = new Map<string, number>();
    for (const point of series?.points ?? []) {
      tokensByDate.set(point.date, point.tokens);
    }
    const prev = prevSeriesRef.current;
    prevSeriesRef.current = { key, tokensByDate, data };

    if (!animate || chartType === "heatmap" || !prev || prev.key !== key) {
      setHighlightedDates((current) => (current.size > 0 ? new Set() : current));
      return;
    }

    if (prev.data === data) return;
    const increased = new Set<string>();
    for (const [date, tokens] of tokensByDate) {
      if (tokens > (prev.tokensByDate.get(date) ?? 0)) {
        increased.add(date);
      }
    }
    if (increased.size > 0) {
      setHighlightedDates(increased);
    }
  }, [animate, chartType, data, filterKey, series, windowMode]);

  useEffect(() => {
    if (highlightedDates.size === 0) return;
    const timer = window.setTimeout(() => setHighlightedDates(new Set()), CALENDAR_CONFIG.highlightDurationMs);
    return () => window.clearTimeout(timer);
  }, [highlightedDates]);

  useLayoutEffect(() => {
    const key = `${filterKey}|${windowMode}`;
    const currencyKey = `${currency}:${exchangeRate?.rate ?? ""}`;
    if (!summary) {
      prevSummaryRef.current = null;
      setSummaryPulses(null);
      return;
    }
    const peakTokens = summary.peakDay?.tokens ?? null;
    const prev = prevSummaryRef.current;
    prevSummaryRef.current = {
      key,
      currencyKey,
      totalTokens: summary.totalTokens,
      activeDays: summary.activeDays,
      totalCost: summary.totalCost,
      peakTokens,
    };

    if (!animate || !prev || prev.key !== key) {
      setSummaryPulses(null);
      return;
    }

    const sameCurrency = prev.currencyKey === currencyKey;
    const total: MotionTone | undefined = summary.totalTokens !== prev.totalTokens
      ? (summary.totalTokens > prev.totalTokens ? "active" : "attention")
      : undefined;
    const activeDays: MotionTone | undefined = summary.activeDays !== prev.activeDays
      ? (summary.activeDays > prev.activeDays ? "active" : "attention")
      : undefined;
    const totalCost: MotionTone | undefined = sameCurrency && summary.totalCost !== prev.totalCost
      ? (compareUsdStrings(summary.totalCost, prev.totalCost) < 0 ? "positive" : "attention")
      : undefined;
    const peak: MotionTone | undefined = peakTokens !== prev.peakTokens
      ? ((peakTokens ?? 0) > (prev.peakTokens ?? 0) ? "active" : "attention")
      : undefined;

    if (total || activeDays || totalCost || peak) {
      setSummaryPulses({ id: ++summaryPulseSeqRef.current, total, activeDays, totalCost, peak });
    }
  }, [animate, currency, exchangeRate?.rate, filterKey, summary, windowMode]);

  useEffect(() => {
    if (!summaryPulses) return;
    const id = summaryPulses.id;
    const timer = window.setTimeout(() => {
      setSummaryPulses((current) => (current?.id === id ? null : current));
    }, CALENDAR_CONFIG.highlightDurationMs);
    return () => window.clearTimeout(timer);
  }, [summaryPulses]);

  const tokenFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const tokenFormatterRef = useRef(tokenFormatter);
  tokenFormatterRef.current = tokenFormatter;

  const weekdayTicks = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
    return WEEKDAY_ROWS.map((row) => ({
      row,
      label: formatter.format(new Date(REFERENCE_MONDAY_MS + row * DAY_IN_MS)),
    }));
  }, [locale]);

  const geometry = useMemo(
    () => (isHeatmap && layout && bodyWidth > 0 ? computeCalendarGeometry(bodyWidth, layout) : null),
    [bodyWidth, isHeatmap, layout],
  );

  const seriesOption = useMemo<EChartsCoreOption | null>(() => {
    if (!hasData || chartType === "heatmap" || !series) return null;
    return buildSeriesChartOption({
      series,
      chartType,
      windowMode,
      hovered: seriesHovered,
      highlightedDates,
      tokenFormatter,
    });
  }, [chartType, hasData, highlightedDates, series, seriesHovered, tokenFormatter, windowMode]);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || !hasData) {
      setBodyWidth(0);
      return;
    }

    let frame = 0;
    const measure = () => {
      const nextWidth = Math.floor(body.clientWidth);
      if (nextWidth > 0) {
        setBodyWidth((current) => (current === nextWidth ? current : nextWidth));
      }
    };
    const scheduleMeasure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };

    measure();
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(body);

    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [hasData]);

  useLayoutEffect(() => {
    const node = canvasRef.current;
    if (!isHeatmap || !node) return;

    const chart = init(node, {
      renderer: "canvas",
      width: 1,
      height: 1,
      useDirtyRect: false,
    });
    zrenderRef.current = chart;

    const handleMouseOver = (event: ElementEvent) => {
      const extra = event.target?.extra;
      if (!isCellExtra(extra)) return;
      const anchor: TooltipAnchor = {
        contextElement: node,
        getBoundingClientRect: () => {
          const bounds = node.getBoundingClientRect();
          return new DOMRect(bounds.left + extra.x, bounds.top + extra.y, extra.width, extra.height);
        },
      };
      showTooltip(anchor, undefined, <div className={styles.tooltipContent}>
        <strong>{extra.date}</strong>
        <span>{t("Token 用量：{tokens}", { tokens: tokenFormatterRef.current.format(extra.tokens) })}</span>
      </div>);
    };
    const handleMouseOut = (event: ElementEvent) => {
      if (isCellExtra(event.target?.extra)) hideTooltip();
    };

    chart.on("mouseover", handleMouseOver);
    chart.on("mouseout", handleMouseOut);

    return () => {
      hideTooltip();
      cellRectsRef.current.clear();
      lastGridSizeRef.current = { width: -1, height: -1 };
      lastWindowRef.current = null;
      zrenderRef.current = null;
      chart.dispose();
    };
  }, [hideTooltip, isHeatmap, showTooltip]);

  useLayoutEffect(() => {
    const chart = zrenderRef.current;
    const node = canvasRef.current;
    if (!isHeatmap || !chart || !node || !layout || !geometry) return;

    if (
      geometry.gridWidth !== lastGridSizeRef.current.width
      || geometry.gridHeight !== lastGridSizeRef.current.height
    ) {
      node.style.width = `${geometry.gridWidth}px`;
      node.style.height = `${geometry.gridHeight}px`;
      chart.resize({ width: geometry.gridWidth, height: geometry.gridHeight });
      lastGridSizeRef.current = { width: geometry.gridWidth, height: geometry.gridHeight };
    }

    const cellRects = cellRectsRef.current;
    if (lastWindowRef.current && lastWindowRef.current !== layout.window) {
      for (const rect of cellRects.values()) {
        rect.stopAnimation();
        chart.remove(rect);
      }
      cellRects.clear();
    }
    lastWindowRef.current = layout.window;

    const currentDates = new Set(layout.cells.map((cell) => cell.date));
    for (const [date, rect] of cellRects) {
      if (currentDates.has(date)) continue;
      rect.stopAnimation();
      chart.remove(rect);
      cellRects.delete(date);
    }

    const cornerRadius = WINDOW_GEOMETRY_CONFIG[layout.window].cornerRadius(geometry.cellSize);
    const maxColumn = Math.max(1, layout.columnCount - 1);
    for (const cell of layout.cells) {
      const x = cellOffset(cell.column, geometry.cellSize, geometry.cellGap);
      const y = cellOffset(cell.row, geometry.cellSize, geometry.cellGap);
      const originX = x + geometry.cellSize / 2;
      const originY = y + geometry.cellSize / 2;
      const shape = {
        x,
        y,
        width: geometry.cellSize,
        height: geometry.cellSize,
        r: cornerRadius,
      };
      const extra = {
        ...cell,
        kind: "calendar-cell" as const,
        x,
        y,
        width: geometry.cellSize,
        height: geometry.cellSize,
      } satisfies CellExtra;
      const current = cellRects.get(cell.date);
      const fill = CONTRIBUTION_LEVEL_COLORS[cell.level];

      if (current) {
        const prevExtra = current.extra as CellExtra;
        const levelChanged = prevExtra.level !== cell.level;
        const tokensIncreased = cell.tokens > prevExtra.tokens;
        current.extra = extra;
        if (
          current.shape.width !== shape.width
          || current.shape.height !== shape.height
          || current.shape.x !== shape.x
          || current.shape.y !== shape.y
          || current.shape.r !== shape.r
        ) {
          current.stopAnimation();
          current.attr({
            originX,
            originY,
            scaleX: 1,
            scaleY: 1,
            z2: 0,
            shape,
            style: { fill, opacity: 1, shadowBlur: 0 },
          });
        } else if (!animate) {
          current.stopAnimation();
          current.attr({
            originX,
            originY,
            scaleX: 1,
            scaleY: 1,
            z2: 0,
            style: { fill, opacity: 1, shadowBlur: 0 },
          });
        } else if (tokensIncreased) {
          current.stopAnimation();
          current.attr({ originX, originY, z2: 2 });
          current.animateTo(
            {
              scaleX: 1.15,
              scaleY: 1.15,
              style: { fill, shadowBlur: 10, shadowColor: "rgba(64, 196, 99, 0.55)" },
            },
            {
              duration: 200,
              easing: "cubicOut",
              done: () => {
                current.animateTo(
                  { scaleX: 1, scaleY: 1, style: { shadowBlur: 0 } },
                  {
                    duration: 380,
                    easing: "cubicInOut",
                    done: () => {
                      current.attr({ z2: 0 });
                    },
                  },
                );
              },
            },
          );
        } else if (levelChanged) {
          current.stopAnimation();
          current.animateTo(
            { style: { fill } },
            { duration: CALENDAR_CONFIG.colorTransitionMs, easing: "cubicOut" },
          );
        }
        continue;
      }

      const rect = new Rect({
        originX,
        originY,
        scaleX: animate ? 0.72 : 1,
        scaleY: animate ? 0.72 : 1,
        shape,
        style: {
          fill,
          stroke: "rgba(139, 148, 158, 0.10)",
          lineWidth: 1,
          opacity: animate ? 0 : 1,
        },
        cursor: "default",
        extra,
      });
      cellRects.set(cell.date, rect);
      chart.add(rect);
      if (animate) {
        const delay = Math.round((cell.column / maxColumn) * 200 + cell.row * 10);
        rect.animateTo(
          { scaleX: 1, scaleY: 1, style: { opacity: 1 } },
          { duration: 280, delay, easing: "cubicOut" },
        );
      }
    }
    hideTooltip();
  }, [animate, geometry, hideTooltip, isHeatmap, layout]);

  const { title: windowTitle, sectionAriaLabel, chartAriaLabel } = resolveHeaderLabels(chartType, windowMode);

  const renderChartTypeSwitcher = () => (
    <div className={styles.switcher} role="group" aria-label={t("活动图表样式")}>
      <button
        type="button"
        aria-pressed={chartType === "heatmap"}
        onClick={() => onChartTypeChange("heatmap")}
      >{t("热力")}</button>
      <button
        type="button"
        aria-pressed={chartType === "bar"}
        onClick={() => onChartTypeChange("bar")}
      >{t("柱状")}</button>
      <button
        type="button"
        aria-pressed={chartType === "line"}
        onClick={() => onChartTypeChange("line")}
      >{t("曲线")}</button>
    </div>
  );

  const renderWindowSwitcher = () => (
    <div
      className={styles.switcher}
      role="group"
      aria-label={chartType === "heatmap" ? t("活动日历时间维度") : t("活动图表时间维度")}
    >
      <button
        type="button"
        aria-pressed={windowMode === "year"}
        onClick={() => onWindowModeChange("year")}
      >{t("年")}</button>
      <button
        type="button"
        aria-pressed={windowMode === "month"}
        onClick={() => onWindowModeChange("month")}
      >{t("月")}</button>
      <button
        type="button"
        aria-pressed={windowMode === "week"}
        onClick={() => onWindowModeChange("week")}
      >{t("周")}</button>
    </div>
  );

  const quotaCard = quotaProgress && <Card className={styles.summaryQuota}>{quotaProgress}</Card>;

  const renderChartCard = (content: ReactNode, inlineStats?: string) => (
    <Card as="article" className={styles.chartCard}>
      <header className={styles.header}>
        <h2 className={styles.title}>{windowTitle}</h2>
        <div className={styles.headerMeta}>
          {inlineStats && <span className={styles.inlineStats}>{inlineStats}</span>}
          {renderChartTypeSwitcher()}
          {renderWindowSwitcher()}
          {isHeatmap && (
            <div className={styles.legend} aria-hidden="true">
              <span>{t("少")}</span>
              <div className={styles.legendSwatches}>
                {CONTRIBUTION_LEVEL_COLORS.map((color, index) => (
                  <span key={index} className={styles.legendSwatch} style={{ backgroundColor: color }} />
                ))}
              </div>
              <span>{t("多")}</span>
            </div>
          )}
        </div>
      </header>
      {content}
    </Card>
  );

  if (error || !summary || (chartType === "heatmap" ? !layout : !series))
  {
    const message = error
      ? (chartType === "heatmap" ? t("日历数据加载失败：{error}", { error }) : t("活动数据加载失败：{error}", { error }))
      : loading
        ? (chartType === "heatmap" ? t("正在加载日历数据…") : t("正在加载活动数据…"))
        : t("暂无活动数据");
    return <section className={styles.root} aria-label={sectionAriaLabel}>
      {renderChartCard(<div className={styles.state}>{message}</div>)}
      {quotaCard}
    </section>;
  }

  const summaryTarget = computeWideSummaryWidth(bodyWidth);
  const isWide = summaryTarget !== null;
  const showWeekdayAxis = Boolean(layout && layout.rowCount > 1);
  const gridTemplateColumns = chartType === "heatmap"
    ? geometry?.gridTemplateColumns
    : summaryTarget !== null
      ? `minmax(0, 1fr) ${summaryTarget}px`
      : null;
  const bodyStyle = gridTemplateColumns ? { gridTemplateColumns } : undefined;

  const summaryTotalLabel = windowMode === "year"
    ? t("近 {days} 天累计", { days: summary.windowDays })
    : windowMode === "month"
      ? t("本月累计")
      : t("本周累计");
  const inlineStatsLabel = windowMode === "year"
    ? t("近 {days} 天累计 {total} · 活跃 {active} 天", {
        days: summary.windowDays,
        total: formatCompactInteger(summary.totalTokens),
        active: formatInteger(summary.activeDays),
      })
    : windowMode === "month"
      ? t("本月累计 {total} · 活跃 {active} 天", {
          total: formatCompactInteger(summary.totalTokens),
          active: formatInteger(summary.activeDays),
        })
      : t("本周累计 {total} · 活跃 {active} 天", {
          total: formatCompactInteger(summary.totalTokens),
          active: formatInteger(summary.activeDays),
        });

  return (
    <section ref={bodyRef} className={styles.root} aria-label={sectionAriaLabel} style={bodyStyle}>
      {renderChartCard(
        <div className={styles.calendarPane}>
          {chartType === "heatmap" ? (
            <div className={styles.scroller}>
              <div className={styles.canvasFrame}>
                <div className={styles.heatmapRow}>
                  {showWeekdayAxis && (
                    <div
                      className={styles.weekdayAxis}
                      style={{ height: geometry?.gridHeight ?? 0 }}
                      aria-hidden="true"
                    >
                      {geometry && weekdayTicks.map((tick) => (
                        <span
                          key={tick.row}
                          style={{
                            top: cellOffset(tick.row, geometry.cellSize, geometry.cellGap),
                            height: geometry.cellSize,
                          }}
                        >
                          {tick.label}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className={styles.gridColumn}>
                    <div
                      ref={canvasRef}
                      className={styles.canvas}
                      role="img"
                      aria-label={chartAriaLabel}
                    />
                    <div
                      className={[styles.axis, geometry?.axisCentered ? styles.axisCentered : ""].filter(Boolean).join(" ")}
                      style={{ width: geometry?.gridWidth ?? 0 }}
                      aria-hidden="true"
                    >
                      {geometry?.axisLabels.map((label) => (
                        <span
                          key={label.key}
                          style={label.width !== undefined ? { left: label.left, width: label.width } : { left: label.left }}
                        >
                          {label.text}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            seriesOption && (
              <div className={styles.seriesFrame} role="img" aria-label={chartAriaLabel}>
                <EChart
                  option={seriesOption}
                  transition={{ viewKey: JSON.stringify([filterKey, windowMode]), morphKey: chartType, data, enabled: animate }}
                  className={styles.echart}
                  onMouseEnter={() => setSeriesHovered(true)}
                  onMouseLeave={() => setSeriesHovered(false)}
                />
              </div>
            )
          )}
        </div>,
        isWide ? undefined : inlineStatsLabel,
      )}
      {isWide && (
        <div className={styles.summaryPane}>
          <Card as="article" className={styles.summaryCell}>
            {animate && summaryPulses?.total && <span key={summaryPulses.id} className={styles.summaryPulse} data-tone={summaryPulses.total} aria-hidden="true" />}
            <h3 className={styles.summaryLabel}>{summaryTotalLabel}</h3>
            <div className={styles.summaryBody}>
              <div className={styles.summaryValue} title={formatInteger(summary.totalTokens)}>
                <RollingNumber
                  value={formatCompactInteger(summary.totalTokens)}
                  numericValue={summary.totalTokens}
                  animate={animate}
                  resetKey={`${filterKey}|${windowMode}`}
                  polarity="activity"
                  rollOnMount
                  mountDelayMs={40}
                />
              </div>
              <div className={styles.summarySub} title={summary.dateRangeLabel}>
                {summary.dateRangeLabel}
              </div>
            </div>
          </Card>

          <Card as="article" className={styles.summaryCell}>
            {animate && summaryPulses?.activeDays && <span key={summaryPulses.id} className={styles.summaryPulse} data-tone={summaryPulses.activeDays} aria-hidden="true" />}
            <h3 className={styles.summaryLabel}>{t("活跃天数")}</h3>
            <div className={styles.summaryBody}>
              <div className={styles.summaryValue}>
                <RollingNumber
                  value={t("{count} 天", { count: formatInteger(summary.activeDays) })}
                  numericValue={summary.activeDays}
                  animate={animate}
                  resetKey={`${filterKey}|${windowMode}`}
                  polarity="activity"
                  rollOnMount
                  mountDelayMs={70}
                />
              </div>
              <div className={styles.summarySub}>
                {summary.activeDays > 0
                  ? t("活跃占比 {rate}", { rate: summary.activeRateLabel })
                  : t("暂无活跃记录")}
              </div>
            </div>
          </Card>

          <Card as="article" className={styles.summaryCell}>
            {animate && summaryPulses?.totalCost && <span key={summaryPulses.id} className={styles.summaryPulse} data-tone={summaryPulses.totalCost} aria-hidden="true" />}
            <h3 className={styles.summaryLabel}>{t("总费用")}</h3>
            <div className={styles.summaryBody}>
              <div
                className={styles.summaryValue}
                title={formatDisplayCostExact(summary.totalCost, currency, exchangeRate)}
              >
                <RollingNumber
                  value={formatDisplayCost(summary.totalCost, currency, exchangeRate)}
                  numericValue={convertUsdToDisplayNumber(summary.totalCost, currency, exchangeRate)}
                  animate={animate}
                  resetKey={`${filterKey}|${windowMode}|${currency}|${exchangeRate?.rate ?? ""}`}
                  polarity="cost"
                  rollOnMount
                  mountDelayMs={100}
                />
              </div>
              <div className={styles.summarySub}>
                {summary.longestStreak > 0
                  ? t("最长连续 {days} 天", { days: formatInteger(summary.longestStreak) })
                  : t("暂无连续活跃")}
              </div>
            </div>
          </Card>

          <Card as="article" className={styles.summaryCell}>
            {animate && summaryPulses?.peak && <span key={summaryPulses.id} className={styles.summaryPulse} data-tone={summaryPulses.peak} aria-hidden="true" />}
            <h3 className={styles.summaryLabel}>{t("单日峰值")}</h3>
            <div className={styles.summaryBody}>
              <div
                className={styles.summaryValue}
                title={summary.peakDay ? formatInteger(summary.peakDay.tokens) : undefined}
              >
                <RollingNumber
                  value={summary.peakDay ? formatCompactInteger(summary.peakDay.tokens) : "—"}
                  numericValue={summary.peakDay?.tokens ?? null}
                  animate={animate}
                  resetKey={`${filterKey}|${windowMode}`}
                  polarity="activity"
                  rollOnMount
                  mountDelayMs={130}
                />
              </div>
              <div className={styles.summarySub}>
                {summary.peakDay ? summary.peakDay.date : t("暂无用量记录")}
              </div>
            </div>
          </Card>
          {quotaCard}
        </div>
      )}
      {!isWide && quotaCard}
    </section>
  );
}
