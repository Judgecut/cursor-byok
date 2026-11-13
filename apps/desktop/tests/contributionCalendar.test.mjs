import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { createContext, SourceTextModule } from "node:vm";

const source = stripTypeScriptTypes(
  await readFile(new URL("../src/features/home/charts/contributionCalendar.ts", import.meta.url), "utf8"),
);
const context = createContext({ Date, Intl, Math, Number });
const module = new SourceTextModule(source, { context });
await module.link((specifier) => {
  throw new Error(`Unexpected dependency: ${specifier}`);
});
await module.evaluate();

const {
  CONTRIBUTION_WINDOW_DAYS,
  buildCalendarLayout,
  sliceContributionData,
  summarizeContribution,
} = module.namespace;

function makeSeries(startDate, count, tokenForIndex) {
  const startMs = Date.parse(`${startDate}T00:00:00Z`);
  const dayMs = 24 * 60 * 60 * 1000;
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(startMs + index * dayMs).toISOString().slice(0, 10);
    return { date, tokens: tokenForIndex(index, date) };
  });
}

test("empty input returns empty slice and null layout/summary across all windows", () => {
  assert.deepEqual({ ...CONTRIBUTION_WINDOW_DAYS }, { year: 365, month: 30, week: 7 });

  for (const window of ["year", "month", "week"]) {
    assert.deepEqual([...sliceContributionData([], window)], []);
    assert.equal(buildCalendarLayout([], window, "en-US"), null);
    assert.equal(summarizeContribution([], window), null);
  }
});

test("sliceContributionData sorts chronologically and slices latest window entries", () => {
  const series = makeSeries("2025-01-01", 400, (index) => index * 10);
  const reversed = [...series].reverse();

  const yearSlice = sliceContributionData(reversed, "year");
  assert.equal(yearSlice.length, 365);
  assert.equal(yearSlice[0].date, series[35].date);
  assert.equal(yearSlice[364].date, series[399].date);

  const monthSlice = sliceContributionData(reversed, "month");
  assert.equal(monthSlice.length, 30);
  assert.equal(monthSlice[0].date, series[370].date);
  assert.equal(monthSlice[29].date, series[399].date);

  const weekSlice = sliceContributionData(reversed, "week");
  assert.equal(weekSlice.length, 7);
  assert.equal(weekSlice[0].date, series[393].date);
  assert.equal(weekSlice[6].date, series[399].date);

  const shortSeries = makeSeries("2026-11-10", 4, (index) => (index + 1) * 100);
  assert.equal(sliceContributionData(shortSeries, "week").length, 4);
  assert.equal(sliceContributionData(shortSeries, "month").length, 4);
  assert.equal(sliceContributionData(shortSeries, "year").length, 4);
});

test("buildCalendarLayout computes year 7-row grid, month ticks, and levels", () => {
  // 2025-11-13 is Thursday -> 365 days ending 2026-11-12
  const series = makeSeries("2025-11-13", 365, (index) => {
    if (index === 0) return 0;
    if (index === 1) return 100;
    if (index === 2) return 400;
    if (index === 3) return 750;
    if (index === 4) return 1000;
    return 250;
  });

  const layout = buildCalendarLayout(series, "year", "en-US");
  assert.ok(layout);
  assert.equal(layout.window, "year");
  assert.equal(layout.rowCount, 7);
  assert.equal(layout.cells.length, 365);
  assert.ok(layout.columnCount >= 52 && layout.columnCount <= 54);

  // First day 2025-11-13 is Thursday -> Monday-first row 3
  assert.equal(layout.cells[0].row, 3);
  assert.equal(layout.cells[0].column, 0);
  assert.equal(layout.cells[0].level, 0);

  // Levels scaled against window max (1000): 100->1, 400->2, 750->3, 1000->4
  assert.equal(layout.cells[1].level, 1);
  assert.equal(layout.cells[2].level, 2);
  assert.equal(layout.cells[3].level, 3);
  assert.equal(layout.cells[4].level, 4);

  // Next Monday (2025-11-17, index 4) starts column 1, row 0
  assert.equal(layout.cells[4].row, 0);
  assert.equal(layout.cells[4].column, 1);

  // Month ticks span Nov 2025 through Nov 2026 -> 13 unique YYYY-MM entries
  assert.equal(layout.axisTicks.length, 13);
  assert.equal(layout.axisTicks[0].key, "2025-10");
  assert.equal(layout.axisTicks[0].text, "Nov");
  assert.equal(layout.axisTicks[0].column, 0);
});

test("buildCalendarLayout computes month 30-day multi-week grid and weekly date ticks", () => {
  // 2026-10-14 (Wed) -> 2026-11-12 (Thu), 30 days
  const series = makeSeries("2026-10-14", 30, (index) => (index + 1) * 10);
  const layout = buildCalendarLayout(series, "month", "en-US");
  assert.ok(layout);
  assert.equal(layout.window, "month");
  assert.equal(layout.rowCount, 7);
  assert.equal(layout.cells.length, 30);
  assert.equal(layout.columnCount, 5);

  // 2026-10-14 is Wednesday (row 2), column 0
  assert.equal(layout.cells[0].row, 2);
  assert.equal(layout.cells[0].column, 0);
  // 2026-10-19 is Monday (row 0), column 1
  assert.equal(layout.cells[5].row, 0);
  assert.equal(layout.cells[5].column, 1);

  // One tick per column using the first cell date in that column
  assert.deepEqual(
    Array.from(layout.axisTicks, (tick) => ({ key: tick.key, text: tick.text, column: tick.column })),
    [
      { key: "2026-10-14", text: "10/14", column: 0 },
      { key: "2026-10-19", text: "10/19", column: 1 },
      { key: "2026-10-26", text: "10/26", column: 2 },
      { key: "2026-11-02", text: "11/2", column: 3 },
      { key: "2026-11-09", text: "11/9", column: 4 },
    ],
  );
});

test("buildCalendarLayout computes week single-row card layout and handles partial or invalid data", () => {
  // 14 days where early days have huge peak (10000) and last 7 days peak at 400
  const series = makeSeries("2026-11-01", 14, (index) => {
    if (index === 0) return 10000;
    if (index === 7) return -50;
    if (index === 8) return Number.NaN;
    if (index === 9) return 100;
    if (index === 13) return 400;
    return 200;
  });

  const weekLayout = buildCalendarLayout(series, "week", "en-US");
  assert.ok(weekLayout);
  assert.equal(weekLayout.window, "week");
  assert.equal(weekLayout.rowCount, 1);
  assert.equal(weekLayout.columnCount, 7);
  assert.equal(weekLayout.cells.length, 7);

  // Every cell is row 0, sequential column 0..6
  weekLayout.cells.forEach((cell, index) => {
    assert.equal(cell.row, 0);
    assert.equal(cell.column, index);
  });

  // Invalid/negative tokens become 0 with level 0; level is scaled to week max (400), not earlier 10000
  assert.equal(weekLayout.cells[0].tokens, 0);
  assert.equal(weekLayout.cells[0].level, 0);
  assert.equal(weekLayout.cells[1].tokens, 0);
  assert.equal(weekLayout.cells[1].level, 0);
  assert.equal(weekLayout.cells[2].tokens, 100);
  assert.equal(weekLayout.cells[2].level, 1);
  assert.equal(weekLayout.cells[6].tokens, 400);
  assert.equal(weekLayout.cells[6].level, 4);

  // One tick per cell with short weekday + date
  assert.equal(weekLayout.axisTicks.length, 7);
  assert.equal(weekLayout.axisTicks[0].column, 0);
  assert.equal(weekLayout.axisTicks[0].key, "2026-11-08");
  assert.match(weekLayout.axisTicks[0].text, /Sun.*11\/8/);

  // Partial input (<7 days)
  const partial = makeSeries("2026-11-10", 3, (index) => (index + 1) * 50);
  const partialWeek = buildCalendarLayout(partial, "week", "zh-CN");
  assert.ok(partialWeek);
  assert.equal(partialWeek.rowCount, 1);
  assert.equal(partialWeek.columnCount, 3);
  assert.equal(partialWeek.cells.length, 3);
  assert.equal(partialWeek.axisTicks.length, 3);
});

test("summarizeContribution computes window-scoped totals, streaks, peaks, averages, and ranges", () => {
  // 10 days: days 0..2 have huge tokens + 3-day streak; days 3..9 (week window) have 2-day streak + 1-day streak
  const series = [
    { date: "2026-11-01", tokens: 9000 },
    { date: "2026-11-02", tokens: 9000 },
    { date: "2026-11-03", tokens: 9000 },
    { date: "2026-11-04", tokens: 0 },
    { date: "2026-11-05", tokens: 100 },
    { date: "2026-11-06", tokens: 300 },
    { date: "2026-11-07", tokens: 0 },
    { date: "2026-11-08", tokens: 0 },
    { date: "2026-11-09", tokens: 200 },
    { date: "2026-11-10", tokens: 0 },
  ];

  const weekSummary = summarizeContribution(series, "week");
  assert.ok(weekSummary);
  assert.equal(weekSummary.windowDays, 7);
  assert.equal(weekSummary.totalTokens, 600);
  assert.equal(weekSummary.activeDays, 3);
  assert.equal(weekSummary.activeRateLabel, "42.9%");
  assert.equal(weekSummary.averageActiveTokens, 200);
  assert.equal(weekSummary.longestStreak, 2);
  assert.deepEqual({ ...weekSummary.peakDay }, { date: "2026-11-06", tokens: 300 });
  assert.equal(weekSummary.dateRangeLabel, "2026-11-04 ~ 2026-11-10");

  const monthSummary = summarizeContribution(series, "month");
  assert.ok(monthSummary);
  assert.equal(monthSummary.windowDays, 10);
  assert.equal(monthSummary.totalTokens, 27600);
  assert.equal(monthSummary.activeDays, 6);
  assert.equal(monthSummary.activeRateLabel, "60%");
  assert.equal(monthSummary.averageActiveTokens, 4600);
  assert.equal(monthSummary.longestStreak, 3);
  assert.deepEqual({ ...monthSummary.peakDay }, { date: "2026-11-01", tokens: 9000 });
  assert.equal(monthSummary.dateRangeLabel, "2026-11-01 ~ 2026-11-10");

  // Single inactive day
  const singleZero = summarizeContribution([{ date: "2026-11-10", tokens: 0 }], "week");
  assert.ok(singleZero);
  assert.equal(singleZero.windowDays, 1);
  assert.equal(singleZero.totalTokens, 0);
  assert.equal(singleZero.activeDays, 0);
  assert.equal(singleZero.activeRateLabel, "0%");
  assert.equal(singleZero.averageActiveTokens, null);
  assert.equal(singleZero.longestStreak, 0);
  assert.equal(singleZero.peakDay, null);
  assert.equal(singleZero.dateRangeLabel, "2026-11-10");
});
