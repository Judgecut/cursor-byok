export type ContributionDay = {
  date: string;
  tokens: number;
};

export type ContributionWindow = "year" | "month" | "week";

export const CONTRIBUTION_WINDOW_DAYS: Record<ContributionWindow, number> = {
  year: 365,
  month: 30,
  week: 7,
};

export type CalendarCell = ContributionDay & {
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

export type ContributionSummary = {
  windowDays: number;
  totalTokens: number;
  activeDays: number;
  activeRateLabel: string;
  averageActiveTokens: number | null;
  longestStreak: number;
  peakDay: ContributionDay | null;
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

export function sliceContributionData(
  data: ContributionDay[],
  window: ContributionWindow,
): ContributionDay[] {
  if (data.length === 0) return [];
  const sorted = [...data].sort((left, right) =>
    left.date < right.date ? -1 : left.date > right.date ? 1 : 0,
  );
  return sorted.slice(-CONTRIBUTION_WINDOW_DAYS[window]);
}

export function buildCalendarLayout(
  data: ContributionDay[],
  window: ContributionWindow,
  locale: string,
): CalendarLayout | null {
  const sliced = sliceContributionData(data, window);
  if (sliced.length === 0) return null;

  const maximum = Math.max(1, ...sliced.map((day) => sanitizeTokens(day.tokens)));

  if (window === "week") {
    const weekdayFormatter = new Intl.DateTimeFormat(locale, {
      weekday: "short",
      timeZone: "UTC",
    });
    const monthDayFormatter = new Intl.DateTimeFormat(locale, {
      month: "numeric",
      day: "numeric",
      timeZone: "UTC",
    });

    const cells: CalendarCell[] = sliced.map((day, index) => {
      const tokens = sanitizeTokens(day.tokens);
      const level = tokens === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((tokens / maximum) * 4)));
      return {
        date: day.date,
        tokens,
        column: index,
        row: 0,
        level,
      };
    });

    const axisTicks: AxisTick[] = cells.map((cell) => {
      const date = parseDate(cell.date);
      return {
        key: cell.date,
        text: `${weekdayFormatter.format(date)} ${monthDayFormatter.format(date)}`,
        column: cell.column,
      };
    });

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
    const level = tokens === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((tokens / maximum) * 4)));
    return {
      date: day.date,
      tokens,
      column: Math.floor(daysFromStart / 7),
      row: mondayIndex(date),
      level,
    };
  });

  const columnCount = cells[cells.length - 1].column + 1;

  if (window === "month") {
    const monthDayFormatter = new Intl.DateTimeFormat(locale, {
      month: "numeric",
      day: "numeric",
      timeZone: "UTC",
    });
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

export function summarizeContribution(
  data: ContributionDay[],
  window: ContributionWindow,
): ContributionSummary | null {
  const sliced = sliceContributionData(data, window);
  if (sliced.length === 0) return null;

  let totalTokens = 0;
  let activeDays = 0;
  let longestStreak = 0;
  let currentStreak = 0;
  let previousActiveMs: number | null = null;
  let peakDay: ContributionDay | null = null;

  for (const day of sliced) {
    const tokens = sanitizeTokens(day.tokens);
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

  const windowDays = sliced.length;
  const activeRate = windowDays > 0 ? (activeDays / windowDays) * 100 : 0;
  const activeRateLabel = `${activeRate.toFixed(1).replace(/\.0$/, "")}%`;
  const firstDate = sliced[0].date;
  const lastDate = sliced[sliced.length - 1].date;

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
