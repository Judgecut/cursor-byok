import { addUsdStrings } from "../../../shared/utils/costFormat";

type DailyTokenUsage = {
  date: string;
  tokens: number;
};

export type ContributionDay = DailyTokenUsage & {
  totalCost: string;
};

export type ContributionWindow = "year" | "month" | "week";

export type ContributionChartType = "heatmap" | "bar" | "line";

export const CONTRIBUTION_YEAR_DAYS = 365;

export const CONTRIBUTION_LEVEL_COLORS = [
  "rgba(139, 148, 158, 0.20)",
  "#9be9a8",
  "#40c463",
  "#30a14e",
  "#216e39",
] as const;

export type CalendarCell = DailyTokenUsage & {
  column: number;
  row: number;
  level: number;
};

export type AxisTick = {
  key: string;
  text: string;
  column: number;
};

export type CalendarLayout = {
  window: ContributionWindow;
  cells: CalendarCell[];
  columnCount: number;
  rowCount: number;
  axisTicks: AxisTick[];
};

export type ContributionSeriesPoint = DailyTokenUsage & {
  axisLabel: string;
  tooltipLabel: string;
  level: number;
};

export type ContributionSeries = {
  window: ContributionWindow;
  points: ContributionSeriesPoint[];
  maxTokens: number;
  averageActiveTokens: number | null;
};

export type ContributionSummary = {
  windowDays: number;
  totalTokens: number;
  totalCost: string;
  activeDays: number;
  activeRateLabel: string;
  averageActiveTokens: number | null;
  longestStreak: number;
  peakDay: DailyTokenUsage | null;
  dateRangeLabel: string;
};

const DAY_IN_MS = 24 * 60 * 60 * 1000;

function parseDate(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function mondayIndex(date: Date): number {
  return (date.getUTCDay() + 6) % 7;
}

function sanitizeTokens(tokens: number): number {
  return Number.isFinite(tokens) ? Math.max(0, tokens) : 0;
}

function computeIntensityLevel(tokens: number, maximum: number): number {
  if (tokens <= 0) return 0;
  const scale = Math.max(1, maximum);
  return Math.min(4, Math.max(1, Math.ceil((tokens / scale) * 4)));
}

function createWeekdayFormatter(locale: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    timeZone: "UTC",
  });
}

function createMonthDayFormatter(locale: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatWeekdayMonthDay(
  date: Date,
  weekdayFormatter: Intl.DateTimeFormat,
  monthDayFormatter: Intl.DateTimeFormat,
): string {
  return `${weekdayFormatter.format(date)} ${monthDayFormatter.format(date)}`;
}

export function sliceContributionData(
  data: ContributionDay[],
  window: ContributionWindow,
): ContributionDay[] {
  if (data.length === 0) return [];
  const sorted = [...data].sort((left, right) =>
    left.date < right.date ? -1 : left.date > right.date ? 1 : 0,
  );
  if (window === "year") {
    return sorted.slice(-CONTRIBUTION_YEAR_DAYS);
  }
  const latestDate = parseDate(sorted[sorted.length - 1].date);
  const startMs = window === "month"
    ? Date.UTC(latestDate.getUTCFullYear(), latestDate.getUTCMonth(), 1)
    : latestDate.getTime() - mondayIndex(latestDate) * DAY_IN_MS;
  return sorted.filter((day) => parseDate(day.date).getTime() >= startMs);
}

export function buildCalendarLayout(
  data: ContributionDay[],
  window: ContributionWindow,
  locale: string,
): CalendarLayout | null {
  const sliced = sliceContributionData(data, window);
  if (sliced.length === 0) return null;

  const maximum = sliced.reduce((max, day) => Math.max(max, sanitizeTokens(day.tokens)), 1);

  if (window === "week") {
    const weekdayFormatter = createWeekdayFormatter(locale);
    const monthDayFormatter = createMonthDayFormatter(locale);

    const cells: CalendarCell[] = sliced.map((day, index) => {
      const tokens = sanitizeTokens(day.tokens);
      return {
        date: day.date,
        tokens,
        column: index,
        row: 0,
        level: computeIntensityLevel(tokens, maximum),
      };
    });

    const axisTicks: AxisTick[] = cells.map((cell) => ({
      key: cell.date,
      text: formatWeekdayMonthDay(parseDate(cell.date), weekdayFormatter, monthDayFormatter),
      column: cell.column,
    }));

    return {
      window,
      cells,
      columnCount: sliced.length,
      rowCount: 1,
      axisTicks,
    };
  }

  const firstDate = parseDate(sliced[0].date);
  const calendarStart = new Date(firstDate.getTime() - mondayIndex(firstDate) * DAY_IN_MS);

  const cells: CalendarCell[] = sliced.map((day) => {
    const tokens = sanitizeTokens(day.tokens);
    const date = parseDate(day.date);
    const daysFromStart = Math.round((date.getTime() - calendarStart.getTime()) / DAY_IN_MS);
    return {
      date: day.date,
      tokens,
      column: Math.floor(daysFromStart / 7),
      row: mondayIndex(date),
      level: computeIntensityLevel(tokens, maximum),
    };
  });

  const columnCount = cells[cells.length - 1].column + 1;

  if (window === "month") {
    const monthDayFormatter = createMonthDayFormatter(locale);
    const axisTicks = cells.reduce<AxisTick[]>((ticks, cell) => {
      if (ticks.at(-1)?.column !== cell.column) {
        ticks.push({
          key: cell.date,
          text: monthDayFormatter.format(parseDate(cell.date)),
          column: cell.column,
        });
      }
      return ticks;
    }, []);

    return {
      window,
      cells,
      columnCount,
      rowCount: 7,
      axisTicks,
    };
  }

  const monthFormatter = new Intl.DateTimeFormat(locale, {
    month: "short",
    timeZone: "UTC",
  });
  const axisTicks = cells.reduce<AxisTick[]>((ticks, cell) => {
    const date = parseDate(cell.date);
    const key = `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
    if (ticks.at(-1)?.key !== key) {
      ticks.push({
        key,
        text: monthFormatter.format(date),
        column: cell.column,
      });
    }
    return ticks;
  }, []);

  return {
    window,
    cells,
    columnCount,
    rowCount: 7,
    axisTicks,
  };
}

function summarizeSlicedContribution(sliced: ContributionDay[]): ContributionSummary {
  let totalTokens = 0;
  let totalCost = "0";
  let activeDays = 0;
  let longestStreak = 0;
  let currentStreak = 0;
  let previousActiveMs: number | null = null;
  let peakDay: DailyTokenUsage | null = null;

  for (const day of sliced) {
    const tokens = sanitizeTokens(day.tokens);
    totalTokens += tokens;
    totalCost = addUsdStrings(totalCost, day.totalCost);
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

  const windowDays = sliced.length;
  const activeRate = windowDays > 0 ? (activeDays / windowDays) * 100 : 0;
  const activeRateLabel = `${activeRate.toFixed(1).replace(/\.0$/, "")}%`;
  const firstDate = sliced[0].date;
  const lastDate = sliced[sliced.length - 1].date;

  return {
    windowDays,
    totalTokens,
    totalCost,
    activeDays,
    activeRateLabel,
    averageActiveTokens: activeDays > 0 ? Math.round(totalTokens / activeDays) : null,
    longestStreak,
    peakDay,
    dateRangeLabel: firstDate === lastDate ? firstDate : `${firstDate} ~ ${lastDate}`,
  };
}

export function buildContributionSeries(
  data: ContributionDay[],
  window: ContributionWindow,
  locale: string,
): ContributionSeries | null {
  const sliced = sliceContributionData(data, window);
  if (sliced.length === 0) return null;

  const summary = summarizeSlicedContribution(sliced);
  const maxTokens = summary.peakDay?.tokens ?? 0;
  const weekdayFormatter = createWeekdayFormatter(locale);
  const monthDayFormatter = createMonthDayFormatter(locale);

  const points: ContributionSeriesPoint[] = sliced.map((day) => {
    const tokens = sanitizeTokens(day.tokens);
    const date = parseDate(day.date);
    const axisLabel = window === "week"
      ? formatWeekdayMonthDay(date, weekdayFormatter, monthDayFormatter)
      : monthDayFormatter.format(date);

    return {
      date: day.date,
      tokens,
      axisLabel,
      tooltipLabel: `${day.date} ${weekdayFormatter.format(date)}`,
      level: computeIntensityLevel(tokens, maxTokens),
    };
  });

  return {
    window,
    points,
    maxTokens,
    averageActiveTokens: summary.averageActiveTokens,
  };
}

export function summarizeContribution(
  data: ContributionDay[],
  window: ContributionWindow,
): ContributionSummary | null {
  const sliced = sliceContributionData(data, window);
  if (sliced.length === 0) return null;
  return summarizeSlicedContribution(sliced);
}
