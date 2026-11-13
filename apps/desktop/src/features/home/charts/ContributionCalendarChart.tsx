import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { init, Rect, type ElementEvent } from "zrender";
import { useI18n } from "../../../i18n/store";
import { useTooltip, type TooltipAnchor } from "../../../shared/ui/Tooltip";
import { formatCompactInteger, formatInteger } from "../../../shared/utils/numberFormat";
import {
  buildCalendarLayout,
  summarizeContribution,
  type CalendarCell,
  type CalendarLayout,
  type ContributionDay,
  type ContributionWindow,
} from "./contributionCalendar";
import styles from "./ContributionCalendarChart.module.scss";

export type { ContributionDay };

type ContributionCalendarChartProps = {
  data: ContributionDay[];
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
  isWide: boolean;
  cellSize: number;
  cellGap: number;
  gridWidth: number;
  gridHeight: number;
  gridTemplateColumns: string | null;
  axisCentered: boolean;
  axisLabels: AxisLabel[];
};

const levelColors = [
  "rgba(139, 148, 158, 0.20)",
  "#9be9a8",
  "#40c463",
  "#30a14e",
  "#216e39",
];

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const REFERENCE_MONDAY_MS = Date.UTC(2024, 0, 1);
const WEEKDAY_ROWS = [0, 2, 4] as const;

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

export function ContributionCalendarChart({ data, loading = false, error = null }: ContributionCalendarChartProps) {
  const { locale } = useI18n();
  const [windowMode, setWindowMode] = useState<ContributionWindow>("year");
  const bodyRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<CalendarLayout | null>(null);
  const drawNowRef = useRef<() => void>(() => undefined);
  const { show: showTooltip, hide: hideTooltip } = useTooltip();
  const [geometry, setGeometry] = useState<CalendarGeometry | null>(null);

  const layout = useMemo(() => buildCalendarLayout(data, windowMode, locale), [data, locale, windowMode]);
  const summary = useMemo(() => summarizeContribution(data, windowMode), [data, windowMode]);
  const hasChart = Boolean(layout && summary && !error);
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

  layoutRef.current = layout;

  useLayoutEffect(() => {
    const body = bodyRef.current;
    const node = canvasRef.current;
    if (!body || !node) return;

    const chart = init(node, {
      renderer: "canvas",
      width: 1,
      height: 1,
      useDirtyRect: false,
    });

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

    const cellRects = new Map<string, Rect>();
    let drawFrame = 0;
    let lastBodyWidth = -1;
    let lastGridWidth = -1;
    let lastGridHeight = -1;
    let lastLayout: CalendarLayout | null = null;

    const draw = () => {
      const currentLayout = layoutRef.current;
      if (!currentLayout) return;
      const bodyWidth = Math.floor(body.clientWidth);
      if (bodyWidth <= 0 || (bodyWidth === lastBodyWidth && currentLayout === lastLayout)) return;

      const windowConfig = WINDOW_GEOMETRY_CONFIG[currentLayout.window];
      const colCount = currentLayout.columnCount;
      const rowCount = currentLayout.rowCount;
      const showWeekday = rowCount > 1;
      const weekdayReserve = showWeekday ? CALENDAR_CONFIG.weekdayReserve : 0;
      const cellGap = windowConfig.cellGap;
      const gapsWidth = Math.max(0, colCount - 1) * cellGap;
      const isWide = bodyWidth >= CALENDAR_CONFIG.wideLayoutMinWidth;

      let calendarBudget = bodyWidth;
      let summaryTarget = 0;
      if (isWide) {
        summaryTarget = Math.min(
          CALENDAR_CONFIG.summaryMaxWidth,
          Math.max(CALENDAR_CONFIG.summaryMinWidth, Math.round(bodyWidth * CALENDAR_CONFIG.summaryRatio)),
        );
        calendarBudget = Math.max(0, bodyWidth - summaryTarget);
      }

      const availableGridWidth = Math.max(
        0,
        calendarBudget - CALENDAR_CONFIG.calendarPadX - weekdayReserve,
      );
      const rawCellSize = colCount > 0
        ? (availableGridWidth - gapsWidth) / colCount
        : windowConfig.minCellSize;
      const maxCellSize = isWide
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
      if (isWide) {
        const calendarPaneWidth = gridWidth + weekdayReserve + CALENDAR_CONFIG.calendarPadX;
        const keepCompactCalendar = currentLayout.window === "year"
          && calendarPaneWidth >= bodyWidth - CALENDAR_CONFIG.summaryMaxWidth;
        gridTemplateColumns = keepCompactCalendar
          ? `${calendarPaneWidth}px minmax(0, 1fr)`
          : `minmax(0, 1fr) ${summaryTarget}px`;
      }

      const axisCentered = currentLayout.window === "week" && cellSize >= windowConfig.axisLabelWidth;
      let lastLabelEnd = -Infinity;
      const axisLabels: AxisLabel[] = axisCentered
        ? currentLayout.axisTicks.map((tick) => ({
            ...tick,
            left: cellOffset(tick.column, cellSize, cellGap),
            width: cellSize,
          }))
        : currentLayout.axisTicks.flatMap((tick) => {
            const left = Math.min(
              cellOffset(tick.column, cellSize, cellGap),
              Math.max(0, gridWidth - windowConfig.axisLabelWidth),
            );
            if (left < lastLabelEnd + windowConfig.axisLabelGap) return [];
            lastLabelEnd = left + windowConfig.axisLabelWidth;
            return [{ ...tick, left }];
          });

      setGeometry({
        isWide,
        cellSize,
        cellGap,
        gridWidth,
        gridHeight,
        gridTemplateColumns,
        axisCentered,
        axisLabels,
      });

      if (gridWidth !== lastGridWidth || gridHeight !== lastGridHeight) {
        node.style.width = `${gridWidth}px`;
        node.style.height = `${gridHeight}px`;
        chart.resize({ width: gridWidth, height: gridHeight });
        lastGridWidth = gridWidth;
        lastGridHeight = gridHeight;
      }

      if (lastLayout && lastLayout.window !== currentLayout.window) {
        for (const rect of cellRects.values()) {
          rect.stopAnimation();
          chart.remove(rect);
        }
        cellRects.clear();
      }

      lastBodyWidth = bodyWidth;
      lastLayout = currentLayout;

      const currentDates = new Set(currentLayout.cells.map((cell) => cell.date));
      for (const [date, rect] of cellRects) {
        if (currentDates.has(date)) continue;
        rect.stopAnimation();
        chart.remove(rect);
        cellRects.delete(date);
      }

      const cornerRadius = windowConfig.cornerRadius(cellSize);
      for (const cell of currentLayout.cells) {
        const x = cellOffset(cell.column, cellSize, cellGap);
        const y = cellOffset(cell.row, cellSize, cellGap);
        const shape = {
          x,
          y,
          width: cellSize,
          height: cellSize,
          r: cornerRadius,
        };
        const extra = {
          ...cell,
          kind: "calendar-cell" as const,
          x,
          y,
          width: cellSize,
          height: cellSize,
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
            current.attr({ shape, style: { fill: levelColors[cell.level] } });
          } else {
            current.animateTo(
              { style: { fill: levelColors[cell.level] } },
              { duration: CALENDAR_CONFIG.resizeTransitionMs, easing: "cubicOut" },
            );
          }
          continue;
        }

        const rect = new Rect({
          shape,
          style: {
            fill: levelColors[cell.level],
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
    };

    const drawNow = () => {
      window.cancelAnimationFrame(drawFrame);
      drawFrame = 0;
      draw();
    };
    const scheduleDraw = () => {
      window.cancelAnimationFrame(drawFrame);
      drawFrame = window.requestAnimationFrame(draw);
    };
    drawNowRef.current = drawNow;
    const observer = new ResizeObserver(scheduleDraw);
    observer.observe(body);
    draw();

    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(drawFrame);
      drawNowRef.current = () => undefined;
      chart.dispose();
    };
  }, [hasChart]);

  useLayoutEffect(() => {
    drawNowRef.current();
  }, [layout, windowMode]);

  const windowTitle = windowMode === "year"
    ? t("年度活动日历（近 365 天，按当前供应商筛选）")
    : windowMode === "month"
      ? t("月度活动日历（近 30 天，按当前供应商筛选）")
      : t("周度活动日历（近 7 天，按当前供应商筛选）");

  const sectionAriaLabel = windowMode === "year"
    ? t("过去一年的 Token 用量")
    : windowMode === "month"
      ? t("过去一个月的 Token 用量")
      : t("过去一周的 Token 用量");

  const canvasAriaLabel = windowMode === "year"
    ? t("过去一年的 Token 用量日历")
    : windowMode === "month"
      ? t("过去一个月的 Token 用量日历")
      : t("过去一周的 Token 用量日历");

  const renderWindowSwitcher = () => (
    <div className={styles.windowSwitcher} role="group" aria-label={t("活动日历时间维度")}>
      <button
        type="button"
        aria-pressed={windowMode === "year"}
        onClick={() => setWindowMode("year")}
      >{t("年")}</button>
      <button
        type="button"
        aria-pressed={windowMode === "month"}
        onClick={() => setWindowMode("month")}
      >{t("月")}</button>
      <button
        type="button"
        aria-pressed={windowMode === "week"}
        onClick={() => setWindowMode("week")}
      >{t("周")}</button>
    </div>
  );

  if (error) {
    return (
      <section className={styles.root} aria-label={sectionAriaLabel}>
        <div className={styles.header}>
          <span className={styles.title}>{windowTitle}</span>
          <div className={styles.headerMeta}>{renderWindowSwitcher()}</div>
        </div>
        <div className={styles.state}>{t("日历数据加载失败：{error}", { error })}</div>
      </section>
    );
  }

  if (!layout || !summary) {
    return (
      <section className={styles.root} aria-label={sectionAriaLabel}>
        <div className={styles.header}>
          <span className={styles.title}>{windowTitle}</span>
          <div className={styles.headerMeta}>{renderWindowSwitcher()}</div>
        </div>
        <div className={styles.state}>{loading ? t("正在加载日历数据…") : t("暂无活动数据")}</div>
      </section>
    );
  }

  const isWide = geometry?.isWide ?? false;
  const showWeekdayAxis = layout.rowCount > 1;
  const bodyStyle = geometry?.gridTemplateColumns
    ? { gridTemplateColumns: geometry.gridTemplateColumns }
    : undefined;

  return (
    <section className={styles.root} aria-label={sectionAriaLabel}>
      <div className={styles.header}>
        <span className={styles.title}>{windowTitle}</span>
        <div className={styles.headerMeta}>
          {!isWide && (
            <span className={styles.inlineStats}>
              {t("近 {days} 天累计 {total} · 活跃 {active} 天", {
                days: summary.windowDays,
                total: formatCompactInteger(summary.totalTokens),
                active: formatInteger(summary.activeDays),
              })}
            </span>
          )}
          {renderWindowSwitcher()}
          <div className={styles.legend} aria-hidden="true">
            <span>{t("少")}</span>
            <div className={styles.legendSwatches}>
              {levelColors.map((color, index) => (
                <span key={index} className={styles.legendSwatch} style={{ backgroundColor: color }} />
              ))}
            </div>
            <span>{t("多")}</span>
          </div>
        </div>
      </div>

      <div
        ref={bodyRef}
        className={[styles.body, isWide ? styles.bodyWide : ""].filter(Boolean).join(" ")}
        style={bodyStyle}
      >
        <div className={styles.calendarPane}>
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
                    aria-label={canvasAriaLabel}
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
        </div>

        {isWide && (
          <div className={styles.summaryPane}>
            <div className={styles.summaryCell}>
              <div className={styles.summaryLabel}>{t("近 {days} 天累计", { days: summary.windowDays })}</div>
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
