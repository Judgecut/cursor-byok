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
  CONTRIBUTION_LEVEL_COLORS,
  CONTRIBUTION_YEAR_DAYS,
  buildCalendarLayout,
  buildContributionSeries,
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

test("empty input returns empty slice and null layout/series/summary across all windows", () => {
  assert.equal(CONTRIBUTION_YEAR_DAYS, 365);
  assert.equal(CONTRIBUTION_LEVEL_COLORS.length, 5);

  for (const window of ["year", "month", "week"]) {
    assert.deepEqual([...sliceContributionData([], window)], []);
    assert.equal(buildCalendarLayout([], window, "en-US"), null);
    assert.equal(buildContributionSeries([], window, "en-US"), null);
    assert.equal(summarizeContribution([], window), null);
  }
});

test("sliceContributionData slices year as rolling 365 days, month from the 1st, and week from Monday", () => {
  // 400 days from 2025-10-14 through 2026-11-17 (Tuesday)
  const series = makeSeries("2025-10-14", 400, (index) => index * 10);
  const reversed = [...series].reverse();

  const yearSlice = sliceContributionData(reversed, "year");
  assert.equal(yearSlice.length, 365);
  assert.equal(yearSlice[0].date, "2025-11-18");
  assert.equal(yearSlice[364].date, "2026-11-17");

  const monthSlice = sliceContributionData(reversed, "month");
  assert.equal(monthSlice.length, 17);
  assert.equal(monthSlice[0].date, "2026-11-01");
  assert.equal(monthSlice[16].date, "2026-11-17");

  const weekSlice = sliceContributionData(reversed, "week");
  assert.equal(weekSlice.length, 2);
  assert.equal(weekSlice[0].date, "2026-11-16");
  assert.equal(weekSlice[1].date, "2026-11-17");

  // Week crossing month boundary: latest day is Sunday 2026-11-01 -> week starts Monday 2026-10-26
  const crossMonth = makeSeries("2026-10-20", 13, (index) => (index + 1) * 10);
  const crossMonthWeek = sliceContributionData(crossMonth, "week");
  assert.equal(crossMonthWeek.length, 7);
  assert.equal(crossMonthWeek[0].date, "2026-10-26");
  assert.equal(crossMonthWeek[6].date, "2026-11-01");

  const crossMonthMonth = sliceContributionData(crossMonth, "month");
  assert.equal(crossMonthMonth.length, 1);
  assert.equal(crossMonthMonth[0].date, "2026-11-01");
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

test("buildCalendarLayout computes month grid from the 1st of the current month and weekly date ticks", () => {
  // 2026-10-14 (Wed) -> 2026-11-17 (Tue), 35 days; current month is Nov 1 (Sun) -> Nov 17 (Tue), 17 days
  const series = makeSeries("2026-10-14", 35, (index) => (index + 1) * 10);
  const layout = buildCalendarLayout(series, "month", "en-US");
  assert.ok(layout);
  assert.equal(layout.window, "month");
  assert.equal(layout.rowCount, 7);
  assert.equal(layout.cells.length, 17);
  assert.equal(layout.columnCount, 4);

  // 2026-11-01 is Sunday (row 6), column 0
  assert.equal(layout.cells[0].date, "2026-11-01");
  assert.equal(layout.cells[0].row, 6);
  assert.equal(layout.cells[0].column, 0);
  // 2026-11-02 is Monday (row 0), column 1
  assert.equal(layout.cells[1].date, "2026-11-02");
  assert.equal(layout.cells[1].row, 0);
  assert.equal(layout.cells[1].column, 1);

  // One tick per column using the first cell date in that column
  assert.deepEqual(
    Array.from(layout.axisTicks, (tick) => ({ key: tick.key, text: tick.text, column: tick.column })),
    [
      { key: "2026-11-01", text: "11/1", column: 0 },
      { key: "2026-11-02", text: "11/2", column: 1 },
      { key: "2026-11-09", text: "11/9", column: 2 },
      { key: "2026-11-16", text: "11/16", column: 3 },
    ],
  );
});

test("buildCalendarLayout computes week single-row card layout starting from Monday and handles partial or invalid data", () => {
  // 15 days from 2026-11-01 (Sun) through 2026-11-15 (Sun); current week is Mon 2026-11-09 .. Sun 2026-11-15
  const series = makeSeries("2026-11-01", 15, (index) => {
    if (index === 0) return 10000;
    if (index === 8) return -50;
    if (index === 9) return Number.NaN;
    if (index === 10) return 100;
    if (index === 14) return 400;
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

  // One tick per cell with short weekday + date starting on Monday
  assert.equal(weekLayout.axisTicks.length, 7);
  assert.equal(weekLayout.axisTicks[0].column, 0);
  assert.equal(weekLayout.axisTicks[0].key, "2026-11-09");
  assert.match(weekLayout.axisTicks[0].text, /Mon.*11\/9/);

  // Mid-week series ending on Wednesday 2026-11-11 -> slices Mon 11/9 .. Wed 11/11 (3 days)
  const partial = makeSeries("2026-11-05", 7, (index) => (index + 1) * 50);
  const partialWeek = buildCalendarLayout(partial, "week", "zh-CN");
  assert.ok(partialWeek);
  assert.equal(partialWeek.rowCount, 1);
  assert.equal(partialWeek.columnCount, 3);
  assert.equal(partialWeek.cells.length, 3);
  assert.equal(partialWeek.cells[0].date, "2026-11-09");
  assert.equal(partialWeek.axisTicks.length, 3);
});

test("summarizeContribution computes window-scoped totals, streaks, peaks, averages, and ranges", () => {
  // Series ending on Thursday 2026-11-12 -> week starts Monday 2026-11-09 (4 days), month starts 2026-11-01 (12 days)
  const series = [
    { date: "2026-10-31", tokens: 50000 },
    { date: "2026-11-01", tokens: 9000 },
    { date: "2026-11-02", tokens: 9000 },
    { date: "2026-11-03", tokens: 9000 },
    { date: "2026-11-04", tokens: 0 },
    { date: "2026-11-05", tokens: 100 },
    { date: "2026-11-06", tokens: 300 },
    { date: "2026-11-07", tokens: 0 },
    { date: "2026-11-08", tokens: 0 },
    { date: "2026-11-09", tokens: 100 },
    { date: "2026-11-10", tokens: 300 },
    { date: "2026-11-11", tokens: 0 },
    { date: "2026-11-12", tokens: 200 },
  ];

  const weekSummary = summarizeContribution(series, "week");
  assert.ok(weekSummary);
  assert.equal(weekSummary.windowDays, 4);
  assert.equal(weekSummary.totalTokens, 600);
  assert.equal(weekSummary.activeDays, 3);
  assert.equal(weekSummary.activeRateLabel, "75%");
  assert.equal(weekSummary.averageActiveTokens, 200);
  assert.equal(weekSummary.longestStreak, 2);
  assert.deepEqual({ ...weekSummary.peakDay }, { date: "2026-11-10", tokens: 300 });
  assert.equal(weekSummary.dateRangeLabel, "2026-11-09 ~ 2026-11-12");

  const monthSummary = summarizeContribution(series, "month");
  assert.ok(monthSummary);
  assert.equal(monthSummary.windowDays, 12);
  assert.equal(monthSummary.totalTokens, 28000);
  assert.equal(monthSummary.activeDays, 8);
  assert.equal(monthSummary.activeRateLabel, "66.7%");
  assert.equal(monthSummary.averageActiveTokens, 3500);
  assert.equal(monthSummary.longestStreak, 3);
  assert.deepEqual({ ...monthSummary.peakDay }, { date: "2026-11-01", tokens: 9000 });
  assert.equal(monthSummary.dateRangeLabel, "2026-11-01 ~ 2026-11-12");

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

test("buildContributionSeries aligns slicing, levels, maxTokens, and averageActiveTokens across year, month, and week", () => {
  // 400 days from 2025-10-14 through 2026-11-17 (Tuesday), passed unsorted
  const raw = makeSeries("2025-10-14", 400, (index) => {
    if (index === 399) return 1000;
    if (index === 398) return 200;
    if (index % 5 === 0) return 0;
    return ((index % 4) + 1) * 200;
  });
  const reversed = [...raw].reverse();

  for (const window of ["year", "month", "week"]) {
    const layout = buildCalendarLayout(reversed, window, "en-US");
    const summary = summarizeContribution(reversed, window);
    const series = buildContributionSeries(reversed, window, "en-US");

    assert.ok(layout);
    assert.ok(summary);
    assert.ok(series);
    assert.equal(series.window, window);
    assert.equal(series.points.length, layout.cells.length);
    assert.equal(series.maxTokens, summary.peakDay?.tokens ?? 0);
    assert.equal(series.averageActiveTokens, summary.averageActiveTokens);

    series.points.forEach((point, index) => {
      assert.equal(point.date, layout.cells[index].date);
      assert.equal(point.tokens, layout.cells[index].tokens);
      assert.equal(point.level, layout.cells[index].level);
    });
  }

  const weekSeries = buildContributionSeries(reversed, "week", "en-US");
  assert.ok(weekSeries);
  assert.equal(weekSeries.points.length, 2);
  assert.equal(weekSeries.maxTokens, 1000);
  assert.equal(weekSeries.averageActiveTokens, 600);
  assert.match(weekSeries.points[0].axisLabel, /Mon.*11\/16/);
  assert.match(weekSeries.points[1].axisLabel, /Tue.*11\/17/);
  assert.match(weekSeries.points[0].tooltipLabel, /^2026-11-16 Mon/);
  assert.match(weekSeries.points[1].tooltipLabel, /^2026-11-17 Tue/);

  const monthSeries = buildContributionSeries(reversed, "month", "en-US");
  assert.ok(monthSeries);
  assert.equal(monthSeries.points.length, 17);
  assert.equal(monthSeries.points[0].axisLabel, "11/1");
  assert.equal(monthSeries.points[16].axisLabel, "11/17");

  const yearSeries = buildContributionSeries(reversed, "year", "zh-CN");
  assert.ok(yearSeries);
  assert.equal(yearSeries.points.length, 365);
  assert.equal(yearSeries.points[0].date, "2025-11-18");
  assert.equal(yearSeries.points[0].axisLabel, "11/18");
  assert.equal(yearSeries.points[364].date, "2026-11-17");
  assert.equal(yearSeries.points[364].axisLabel, "11/17");
  assert.match(yearSeries.points[364].tooltipLabel, /^2026-11-17 /);
});

test("buildContributionSeries sanitizes invalid tokens and handles inactive or single-day windows", () => {
  const invalidSeries = [
    { date: "2026-11-09", tokens: -25 },
    { date: "2026-11-10", tokens: Number.NaN },
    { date: "2026-11-11", tokens: Number.POSITIVE_INFINITY },
  ];
  const allZero = buildContributionSeries(invalidSeries, "week", "en-US");
  assert.ok(allZero);
  assert.equal(allZero.maxTokens, 0);
  assert.equal(allZero.averageActiveTokens, null);
  allZero.points.forEach((point) => {
    assert.equal(point.tokens, 0);
    assert.equal(point.level, 0);
  });

  const singleActive = buildContributionSeries([{ date: "2026-11-12", tokens: 450 }], "week", "en-US");
  assert.ok(singleActive);
  assert.equal(singleActive.points.length, 1);
  assert.equal(singleActive.maxTokens, 450);
  assert.equal(singleActive.averageActiveTokens, 450);
  assert.equal(singleActive.points[0].level, 4);
  assert.match(singleActive.points[0].axisLabel, /Thu.*11\/12/);
  assert.match(singleActive.points[0].tooltipLabel, /^2026-11-12 Thu/);
});
