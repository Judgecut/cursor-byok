export type OverviewRangePreset = "ten-minutes" | "hour" | "today" | "week" | "month" | "custom";
export type QuickPreset = "four-hours" | "twenty-four-hours";
export type TimeRange = { startMs: number; endMs: number };

export function quickPresetDurationMs(quick: QuickPreset): number {
  return quick === "four-hours" ? 4 * 60 * 60_000 : 24 * 60 * 60_000;
}

export function quickPresetRange(quick: QuickPreset, now = new Date()): TimeRange {
  const endMs = now.getTime();
  return { startMs: endMs - quickPresetDurationMs(quick), endMs };
}

export function resolveTimeRange(
  preset: OverviewRangePreset,
  quick: QuickPreset | null,
  customRange: TimeRange | null,
  now = new Date(),
): TimeRange | null {
  if (preset !== "custom") return presetRange(preset, now);
  if (quick) return quickPresetRange(quick, now);
  return customRange;
}

export function presetRange(preset: Exclude<OverviewRangePreset, "custom">, now = new Date()): TimeRange {
  const endMs = now.getTime();
  if (preset === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { startMs: start.getTime(), endMs };
  }
  if (preset === "month") {
    const start = new Date(now);
    start.setMonth(start.getMonth() - 1);
    return { startMs: start.getTime(), endMs };
  }
  const duration = preset === "ten-minutes" ? 10 * 60_000
    : preset === "hour" ? 60 * 60_000
    : 7 * 24 * 60 * 60_000;
  return { startMs: now.getTime() - duration, endMs };
}
