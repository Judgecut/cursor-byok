import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { init, Rect, type ElementEvent } from "zrender";
import type { Locale } from "../../../i18n/runtime";
import { useI18n } from "../../../i18n/store";
import { useTooltip, type TooltipAnchor } from "../../../shared/ui/Tooltip";
import { formatCompactInteger, formatInteger } from "../../../shared/utils/numberFormat";
import styles from "./ContributionCalendarChart.module.scss";

export type ContributionDay = {
  date: string;
  tokens: number;
};

type ContributionCalendarChartProps = {
  data: ContributionDay[];
  loading?: boolean;
  error?: string | null;
};

type CalendarCell = ContributionDay & {
  column: number;
  row: number;
  level: number;
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
};

type CalendarGeometry = {
  isWide: boolean;
  cellSize: number;
  cellGap: number;
  gridWidth: number;
  gridHeight: number;
  calendarPaneWidth: number | null;
  axisLabels: AxisLabel[];
};

type ContributionSummary = {
  windowDays: number;
  totalTokens: number;
  activeDays: number;
  activeRateLabel: string;
  averageActiveTokens: number | null;
  longestStreak: number;
  peakDay: ContributionDay | null;
  dateRangeLabel: string;
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
  minCellSize: 9,
  singleMaxCellSize: 20,
  wideMaxCellSize: 22,
  cellGap: 3,
  resizeTransitionMs: 180,
  rowCount: 7,
  axisLabelGap: 8,
  axisLabelWidth: 28,
  calendarPadX: 32,
  weekdayReserve: 40,
  wideLayoutMinWidth: 1340,
  summaryMinWidth: 360,
  summaryMaxWidth: 760,
  summaryRatio: 0.28,
} as const;

function parseDate(date: string) {
  return new Date(`${date}T00:00:00Z`);
}

function mondayIndex(date: Date) {
  return (date.getUTCDay() + 6) % 7;
}

function cellOffset(index: number, cellSize: number, cellGap: number) {
  return index * (cellSize + cellGap);
}

function isCellExtra(value: unknown): value is CellExtra {
  return typeof value === "object" && value !== null && (value as CellExtra).kind === "calendar-cell";
}

function buildCalendarLayout(data: ContributionDay[], locale: Locale) {
  if (data.length === 0) return null;

  const sorted = [...data].sort((left, right) => left.date.localeCompare(right.date));
  const monthFormatter = new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" });
  const maximum = Math.max(1, ...sorted.map(({ tokens }) => tokens));
  const firstDate = parseDate(sorted[0].date);
  const calendarStart = new Date(firstDate.getTime() - mondayIndex(firstDate) * DAY_IN_MS);

  const cells: CalendarCell[] = sorted.map((day) => {
    const tokens = Number.isFinite(day.tokens) ? Math.max(0, day.tokens) : 0;
    const date = parseDate(day.date);
    const daysFromStart = Math.round((date.getTime() - calendarStart.getTime()) / DAY_IN_MS);
    const level = tokens === 0 ? 0 : Math.max(1, Math.ceil((tokens / maximum) * 4));
    return { date: day.date, tokens, column: Math.floor(daysFromStart / 7), row: mondayIndex(date), level };
  });

  const columnCount = cells.at(-1)!.column + 1;
  const monthTicks = cells.reduce<Array<{ key: string; text: string; column: number }>>((ticks, cell) => {
    const date = parseDate(cell.date);
    const key = `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
    if (ticks.at(-1)?.key !== key) ticks.push({ key, text: monthFormatter.format(date), column: cell.column });
    return ticks;
  }, []);

  return { cells, columnCount, monthTicks };
}

function summarizeContribution(data: ContributionDay[]): ContributionSummary | null {
  if (data.length === 0) return null;

  const sorted = [...data].sort((left, right) => left.date.localeCompare(right.date));
  let totalTokens = 0;
  let activeDays = 0;
  let longestStreak = 0;
  let currentStreak = 0;
  let previousActiveMs: number | null = null;
  let peakDay: ContributionDay | null = null;

  for (const day of sorted) {
    const tokens = Number.isFinite(day.tokens) ? Math.max(0, day.tokens) : 0;
    totalTokens += tokens;
    if (tokens > 0) {
      activeDays += 1;
      const dayMs = parseDate(day.date).getTime();
      if (previousActiveMs !== null && dayMs - previousActiveMs === DAY_IN_MS) {
        currentStreak += 1;
      } else {
        currentStreak = 1;
      }
      previousActiveMs = dayMs;
      longestStreak = Math.max(longestStreak, currentStreak);

      if (!peakDay || tokens > peakDay.tokens) {
        peakDay = { date: day.date, tokens };
      }
    }
  }

  const windowDays = sorted.length;
  const activeRate = windowDays > 0 ? (activeDays / windowDays) * 100 : 0;
  const activeRateLabel = `${activeRate.toFixed(1).replace(/\.0$/, "")}%`;
  const firstDate = sorted[0].date;
  const lastDate = sorted.at(-1)!.date;

  return {
    windowDays,
    totalTokens,
    activeDays,
    activeRateLabel,
    averageActiveTokens: activeDays > 0 ? Math.round(totalTokens / activeDays) : null,
    longestStreak,
    peakDay,
    dateRangeLabel: firstDate === lastDate ? firstDate : `${firstDate} ~ ${lastDate}`,
  };
}

export function ContributionCalendarChart({ data, loading = false, error = null }: ContributionCalendarChartProps) {
  const { locale } = useI18n();
  const bodyRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<ReturnType<typeof buildCalendarLayout>>(null);
  const scheduleDrawRef = useRef<() => void>(() => undefined);
  const { show: showTooltip, hide: hideTooltip } = useTooltip();
  const [geometry, setGeometry] = useState<CalendarGeometry | null>(null);

  const layout = useMemo(() => buildCalendarLayout(data, locale), [data, locale]);
  const summary = useMemo(() => summarizeContribution(data), [data]);
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
    let lastLayout: typeof layout = null;

    const draw = () => {
      const currentLayout = layoutRef.current;
      if (!currentLayout) return;
      const bodyWidth = Math.floor(body.clientWidth);
      if (bodyWidth <= 0 || (bodyWidth === lastBodyWidth && currentLayout === lastLayout)) return;

      const colCount = currentLayout.columnCount;
      const cellGap = CALENDAR_CONFIG.cellGap;
      const gapsWidth = Math.max(0, colCount - 1) * cellGap;
      const isWide = bodyWidth >= CALENDAR_CONFIG.wideLayoutMinWidth;

      let calendarBudget = bodyWidth;
      if (isWide) {
        const summaryTarget = Math.min(
          CALENDAR_CONFIG.summaryMaxWidth,
          Math.max(CALENDAR_CONFIG.summaryMinWidth, Math.round(bodyWidth * CALENDAR_CONFIG.summaryRatio)),
        );
        calendarBudget = Math.max(0, bodyWidth - summaryTarget);
      }

      const availableGridWidth = Math.max(
        0,
        calendarBudget - CALENDAR_CONFIG.calendarPadX - CALENDAR_CONFIG.weekdayReserve,
      );
      const rawCellSize = colCount > 0
        ? (availableGridWidth - gapsWidth) / colCount
        : CALENDAR_CONFIG.minCellSize;
      const maxCellSize = isWide
        ? CALENDAR_CONFIG.wideMaxCellSize
        : CALENDAR_CONFIG.singleMaxCellSize;
      const cellSize = Math.max(
        CALENDAR_CONFIG.minCellSize,
        Math.min(maxCellSize, rawCellSize),
      );
      const gridWidth = Math.round(colCount * cellSize + gapsWidth);
      const gridHeight = Math.round(
        CALENDAR_CONFIG.rowCount * cellSize + Math.max(0, CALENDAR_CONFIG.rowCount - 1) * cellGap,
      );
      const calendarPaneWidth = isWide
        ? gridWidth + CALENDAR_CONFIG.weekdayReserve + CALENDAR_CONFIG.calendarPadX
        : null;

      let lastLabelEnd = -Infinity;
      const axisLabels = currentLayout.monthTicks.flatMap((tick) => {
        const left = Math.min(
          cellOffset(tick.column, cellSize, cellGap),
          Math.max(0, gridWidth - CALENDAR_CONFIG.axisLabelWidth),
        );
        if (left < lastLabelEnd + CALENDAR_CONFIG.axisLabelGap) return [];
        lastLabelEnd = left + CALENDAR_CONFIG.axisLabelWidth;
        return [{ ...tick, left }];
      });

      setGeometry({
        isWide,
        cellSize,
        cellGap,
        gridWidth,
        gridHeight,
        calendarPaneWidth,
        axisLabels,
      });

      if (gridWidth !== lastGridWidth || gridHeight !== lastGridHeight) {
        node.style.width = `${gridWidth}px`;
        node.style.height = `${gridHeight}px`;
        chart.resize({ width: gridWidth, height: gridHeight });
        lastGridWidth = gridWidth;
        lastGridHeight = gridHeight;
      }
      lastBodyWidth = bodyWidth;
      lastLayout = currentLayout;

      const currentDates = new Set(currentLayout.cells.map((cell) => cell.date));
      for (const [date, rect] of cellRects) {
        if (currentDates.has(date)) continue;
        chart.remove(rect);
        cellRects.delete(date);
      }

      for (const cell of currentLayout.cells) {
        const x = cellOffset(cell.column, cellSize, cellGap);
        const y = cellOffset(cell.row, cellSize, cellGap);
        const shape = {
          x,
          y,
          width: cellSize,
          height: cellSize,
          r: Math.min(3, cellSize / 4),
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
          if (current.shape.width !== shape.width || current.shape.x !== shape.x || current.shape.y !== shape.y) {
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

    const scheduleDraw = () => {
      window.cancelAnimationFrame(drawFrame);
      drawFrame = window.requestAnimationFrame(draw);
    };
    scheduleDrawRef.current = scheduleDraw;
    const observer = new ResizeObserver(scheduleDraw);
    observer.observe(body);
    draw();

    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(drawFrame);
      scheduleDrawRef.current = () => undefined;
      chart.dispose();
    };
  }, [hasChart]);

  useLayoutEffect(() => {
    scheduleDrawRef.current();
  }, [layout]);

  if (error) {
    return (
      <section className={styles.root} aria-label={t("过去一年的 Token 用量")}>
        <div className={styles.header}>
          <span className={styles.title}>{t("年度活动日历（固定最近 365 天，按当前供应商筛选）")}</span>
        </div>
        <div className={styles.state}>{t("日历数据加载失败：{error}", { error })}</div>
      </section>
    );
  }

  if (!layout || !summary) {
    return (
      <section className={styles.root} aria-label={t("过去一年的 Token 用量")}>
        <div className={styles.header}>
          <span className={styles.title}>{t("年度活动日历（固定最近 365 天，按当前供应商筛选）")}</span>
        </div>
        <div className={styles.state}>{loading ? t("正在加载日历数据…") : t("暂无年度活动数据")}</div>
      </section>
    );
  }

  const isWide = geometry?.isWide ?? false;
  const bodyStyle = geometry?.calendarPaneWidth
    ? { gridTemplateColumns: `${geometry.calendarPaneWidth}px minmax(0, 1fr)` }
    : undefined;

  return (
    <section className={styles.root} aria-label={t("过去一年的 Token 用量")}>
      <div className={styles.header}>
        <span className={styles.title}>{t("年度活动日历（固定最近 365 天，按当前供应商筛选）")}</span>
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
                <div className={styles.gridColumn}>
                  <div
                    ref={canvasRef}
                    className={styles.canvas}
                    role="img"
                    aria-label={t("过去一年的 Token 用量日历")}
                  />
                  <div
                    className={styles.axis}
                    style={{ width: geometry?.gridWidth ?? 0 }}
                    aria-hidden="true"
                  >
                    {geometry?.axisLabels.map((label) => (
                      <span key={label.key} style={{ left: label.left }}>{label.text}</span>
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
