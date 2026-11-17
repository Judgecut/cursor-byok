import type { EChartsCoreOption } from "echarts/core";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { init, Rect, type ElementEvent, type ZRenderType } from "zrender";
import { useI18n } from "../../../i18n/store";
import type { OverviewCalendarChartType } from "../../../shared/store/appStore";
import { useTooltip, type TooltipAnchor } from "../../../shared/ui/Tooltip";
import { formatCompactInteger, formatInteger } from "../../../shared/utils/numberFormat";
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
  windowMode: ContributionWindow;
  onWindowModeChange: (value: ContributionWindow) => void;
  chartType: OverviewCalendarChartType;
  onChartTypeChange: (value: OverviewCalendarChartType) => void;
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
  calendarPadX: 32,
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
  const calendarBudget = summaryTarget !== null ? Math.max(0, bodyWidth - summaryTarget) : bodyWidth;

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
      && calendarPaneWidth >= bodyWidth - CALENDAR_CONFIG.summaryMaxWidth;
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
  tokenFormatter,
}: {
  series: ContributionSeries;
  chartType: Exclude<OverviewCalendarChartType, "heatmap">;
  windowMode: ContributionWindow;
  hovered: boolean;
  tokenFormatter: Intl.NumberFormat;
}): EChartsCoreOption {
  const axisMaximum = Math.max(1, series.maxTokens);
  const commonAxisPointer = chartType === "line"
    ? {
        type: "line" as const,
        lineStyle: { color: "rgba(139, 148, 158, 0.35)", width: 1, type: "dashed" as const },
      }
    : {
        type: "shadow" as const,
        shadowStyle: { color: "rgba(139, 148, 158, 0.14)" },
      };

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
    : undefined;

  const barSeries: EChartsCoreOption[] = [
    ...(series.maxTokens > 0
      ? [{
          name: t("无用量"),
          type: "bar",
          stack: "empty-placeholder",
          data: series.points.map((point) => (point.tokens === 0 ? axisMaximum : 0)),
          barMaxWidth: 18,
          silent: true,
          z: 0,
          itemStyle: { color: CONTRIBUTION_LEVEL_COLORS[0], borderRadius: [2, 2, 0, 0] },
          emphasis: { disabled: true },
        }]
      : []),
    {
      name: t("Token 用量"),
      type: "bar",
      barMaxWidth: 18,
      barGap: "-100%",
      data: series.points.map((point) => ({
        value: point.tokens,
        itemStyle: {
          color: CONTRIBUTION_LEVEL_COLORS[point.level],
          borderRadius: [3, 3, 0, 0],
        },
      })),
      markLine,
    },
  ];

  const lineSeries: EChartsCoreOption[] = [
    {
      name: t("Token 用量"),
      type: "line",
      data: series.points.map((point) => point.tokens),
      smooth: true,
      smoothMonotone: "x",
      clip: true,
      symbol: "circle",
      symbolSize: windowMode === "week" ? 7 : 5,
      showSymbol: windowMode !== "year" || series.points.length <= 31,
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
    animationDuration: 450,
    animationEasing: "cubicOut",
    grid: { top: 12, right: 10, bottom: 24, left: 8, containLabel: true },
    tooltip: {
      trigger: "axis",
      className: styles.tooltip,
      backgroundColor: "var(--vscode-editorHoverWidget-background)",
      borderColor: "var(--vscode-editorHoverWidget-border)",
      textStyle: { color: "var(--vscode-foreground)", fontFamily: "PingFang-Medium" },
      extraCssText: "border-radius: 8px; box-shadow: 0 12px 32px rgb(0 0 0 / 30%); font-size: var(--contribution-tooltip-font-size); line-height: 1.5;",
      axisPointer: commonAxisPointer,
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
        color: "#8c8c8c",
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
        color: "#8c8c8c",
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
  windowMode,
  onWindowModeChange,
  chartType,
  onChartTypeChange,
  loading = false,
  error = null,
}: ContributionCalendarChartProps) {
  const { locale } = useI18n();
  const bodyRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const zrenderRef = useRef<ZRenderType | null>(null);
  const cellRectsRef = useRef<Map<string, Rect>>(new Map());
  const lastGridSizeRef = useRef({ width: -1, height: -1 });
  const lastWindowRef = useRef<ContributionWindow | null>(null);
  const { show: showTooltip, hide: hideTooltip } = useTooltip();
  const [bodyWidth, setBodyWidth] = useState(0);
  const [seriesHovered, setSeriesHovered] = useState(false);

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
      tokenFormatter,
    });
  }, [chartType, hasData, series, seriesHovered, tokenFormatter, windowMode]);

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
    for (const cell of layout.cells) {
      const x = cellOffset(cell.column, geometry.cellSize, geometry.cellGap);
      const y = cellOffset(cell.row, geometry.cellSize, geometry.cellGap);
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

      if (current) {
        current.extra = extra;
        current.stopAnimation();
        if (
          current.shape.width !== shape.width
          || current.shape.height !== shape.height
          || current.shape.x !== shape.x
          || current.shape.y !== shape.y
          || current.shape.r !== shape.r
        ) {
          current.attr({ shape, style: { fill: CONTRIBUTION_LEVEL_COLORS[cell.level] } });
        } else {
          current.animateTo(
            { style: { fill: CONTRIBUTION_LEVEL_COLORS[cell.level] } },
            { duration: CALENDAR_CONFIG.resizeTransitionMs, easing: "cubicOut" },
          );
        }
        continue;
      }

      const rect = new Rect({
        shape,
        style: {
          fill: CONTRIBUTION_LEVEL_COLORS[cell.level],
          stroke: "rgba(139, 148, 158, 0.10)",
          lineWidth: 1,
        },
        cursor: "default",
        extra,
      });
      cellRects.set(cell.date, rect);
      chart.add(rect);
    }
    hideTooltip();
  }, [geometry, hideTooltip, isHeatmap, layout]);

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

  if (error) {
    return (
      <section className={styles.root} aria-label={sectionAriaLabel}>
        <div className={styles.header}>
          <span className={styles.title}>{windowTitle}</span>
          <div className={styles.headerMeta}>
            {renderChartTypeSwitcher()}
            {renderWindowSwitcher()}
          </div>
        </div>
        <div className={styles.state}>
          {chartType === "heatmap"
            ? t("日历数据加载失败：{error}", { error })
            : t("活动数据加载失败：{error}", { error })}
        </div>
      </section>
    );
  }

  if (!summary || (chartType === "heatmap" ? !layout : !series)) {
    return (
      <section className={styles.root} aria-label={sectionAriaLabel}>
        <div className={styles.header}>
          <span className={styles.title}>{windowTitle}</span>
          <div className={styles.headerMeta}>
            {renderChartTypeSwitcher()}
            {renderWindowSwitcher()}
          </div>
        </div>
        <div className={styles.state}>
          {loading
            ? (chartType === "heatmap" ? t("正在加载日历数据…") : t("正在加载活动数据…"))
            : t("暂无活动数据")}
        </div>
      </section>
    );
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
    <section className={styles.root} aria-label={sectionAriaLabel}>
      <div className={styles.header}>
        <span className={styles.title}>{windowTitle}</span>
        <div className={styles.headerMeta}>
          {!isWide && (
            <span className={styles.inlineStats}>
              {inlineStatsLabel}
            </span>
          )}
          {renderChartTypeSwitcher()}
          {renderWindowSwitcher()}
          {chartType === "heatmap" && (
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
      </div>

      <div
        ref={bodyRef}
        className={[styles.body, isWide ? styles.bodyWide : ""].filter(Boolean).join(" ")}
        style={bodyStyle}
      >
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
                  className={styles.echart}
                  onMouseEnter={() => setSeriesHovered(true)}
                  onMouseLeave={() => setSeriesHovered(false)}
                />
              </div>
            )
          )}
        </div>

        {isWide && (
          <div className={styles.summaryPane}>
            <div className={styles.summaryCell}>
              <div className={styles.summaryLabel}>{summaryTotalLabel}</div>
              <div className={styles.summaryBody}>
                <div className={styles.summaryValue} title={formatInteger(summary.totalTokens)}>
                  {formatCompactInteger(summary.totalTokens)}
                </div>
                <div className={styles.summarySub} title={summary.dateRangeLabel}>
                  {summary.dateRangeLabel}
                </div>
              </div>
            </div>

            <div className={styles.summaryCell}>
              <div className={styles.summaryLabel}>{t("活跃天数")}</div>
              <div className={styles.summaryBody}>
                <div className={styles.summaryValue}>
                  {t("{count} 天", { count: formatInteger(summary.activeDays) })}
                </div>
                <div className={styles.summarySub}>
                  {summary.activeDays > 0
                    ? t("活跃占比 {rate}", { rate: summary.activeRateLabel })
                    : t("暂无活跃记录")}
                </div>
              </div>
            </div>

            <div className={styles.summaryCell}>
              <div className={styles.summaryLabel}>{t("活跃日均")}</div>
              <div className={styles.summaryBody}>
                <div
                  className={styles.summaryValue}
                  title={summary.averageActiveTokens !== null ? formatInteger(summary.averageActiveTokens) : undefined}
                >
                  {summary.averageActiveTokens !== null ? formatCompactInteger(summary.averageActiveTokens) : "—"}
                </div>
                <div className={styles.summarySub}>
                  {summary.longestStreak > 0
                    ? t("最长连续 {days} 天", { days: formatInteger(summary.longestStreak) })
                    : t("暂无连续活跃")}
                </div>
              </div>
            </div>

            <div className={styles.summaryCell}>
              <div className={styles.summaryLabel}>{t("单日峰值")}</div>
              <div className={styles.summaryBody}>
                <div
                  className={styles.summaryValue}
                  title={summary.peakDay ? formatInteger(summary.peakDay.tokens) : undefined}
                >
                  {summary.peakDay ? formatCompactInteger(summary.peakDay.tokens) : "—"}
                </div>
                <div className={styles.summarySub}>
                  {summary.peakDay ? summary.peakDay.date : t("暂无用量记录")}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
