export type OverviewPreset = "ten-minutes" | "hour" | "today" | "week" | "month";
export type OverviewRangePreset = OverviewPreset | "custom";
export type QuickPreset = "four-hours" | "twenty-four-hours";
export type TimeRange = { startMs: number; endMs: number };
/** User-chosen range; when `endFollowsNow` is set, `endMs` is replaced by the query time. */
export type CustomRange = TimeRange & { endFollowsNow: boolean };

function quickPresetDurationMs(quick: QuickPreset): number {
  return quick === "four-hours" ? 4 * 60 * 60_000 : 24 * 60 * 60_000;
}

export function quickPresetRange(quick: QuickPreset, now = new Date()): TimeRange {
  const endMs = now.getTime();
  return { startMs: endMs - quickPresetDurationMs(quick), endMs };
}

export function customRangeBounds(range: CustomRange, now = new Date()): TimeRange {
  return { startMs: range.startMs, endMs: range.endFollowsNow ? now.getTime() : range.endMs };
}

export function resolveTimeRange(
  preset: OverviewRangePreset,
  quick: QuickPreset | null,
  customRange: CustomRange | null,
  now = new Date(),
): TimeRange | null {
  if (preset !== "custom") return presetRange(preset, now);
  if (quick) return quickPresetRange(quick, now);
  return customRange && customRangeBounds(customRange, now);
}

export function presetRange(preset: Exclude<OverviewRangePreset, "custom">, now = new Date()): TimeRange {
  const endMs = now.getTime();
  if (preset === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { startMs: start.getTime(), endMs };
  }
  if (preset === "week") {
    const start = new Date(now);
    const mondayOffset = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - mondayOffset);
    start.setHours(0, 0, 0, 0);
    return { startMs: start.getTime(), endMs };
  }
  if (preset === "month") {
    const start = new Date(now);
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    return { startMs: start.getTime(), endMs };
  }
  const duration = preset === "ten-minutes" ? 10 * 60_000 : 60 * 60_000;
  return { startMs: endMs - duration, endMs };
}
