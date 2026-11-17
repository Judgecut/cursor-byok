import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { createContext, SourceTextModule } from "node:vm";

const source = stripTypeScriptTypes(await readFile(new URL("../src/shared/utils/timeRange.ts", import.meta.url), "utf8"));
const context = createContext({ Date });
const module = new SourceTextModule(source, { context });
await module.link((specifier) => {
  throw new Error(`Unexpected dependency: ${specifier}`);
});
await module.evaluate();

const {
  presetRange,
  quickPresetRange,
  resolveTimeRange,
} = module.namespace;

test("resolveTimeRange resolves presets, quick presets, and custom ranges", () => {
  const now = new Date(2026, 10, 17, 14, 0, 0, 0);
  const nowMs = now.getTime();

  assert.deepEqual(
    { ...resolveTimeRange("custom", null, { startMs: nowMs - 60_000, endMs: nowMs }, now) },
    { startMs: nowMs - 60_000, endMs: nowMs },
  );
  assert.deepEqual(
    { ...resolveTimeRange("custom", "four-hours", null, now) },
    { ...quickPresetRange("four-hours", now) },
  );
  assert.deepEqual(
    { ...resolveTimeRange("hour", null, null, now) },
    { ...presetRange("hour", now) },
  );
});

test("presetRange anchors week to Monday 00:00 and month to the 1st 00:00 of the current month", () => {
  // Tuesday 2026-11-17 12:23:06
  const tuesday = new Date(2026, 10, 17, 12, 23, 6, 0);
  assert.deepEqual(
    { ...presetRange("week", tuesday) },
    {
      startMs: new Date(2026, 10, 16, 0, 0, 0, 0).getTime(),
      endMs: tuesday.getTime(),
    },
  );
  assert.deepEqual(
    { ...presetRange("month", tuesday) },
    {
      startMs: new Date(2026, 10, 1, 0, 0, 0, 0).getTime(),
      endMs: tuesday.getTime(),
    },
  );

  // Sunday 2026-11-01 08:15:00 -> week starts Monday 2026-10-26 00:00, month starts 2026-11-01 00:00
  const sundayFirst = new Date(2026, 10, 1, 8, 15, 0, 0);
  assert.deepEqual(
    { ...presetRange("week", sundayFirst) },
    {
      startMs: new Date(2026, 9, 26, 0, 0, 0, 0).getTime(),
      endMs: sundayFirst.getTime(),
    },
  );
  assert.deepEqual(
    { ...presetRange("month", sundayFirst) },
    {
      startMs: new Date(2026, 10, 1, 0, 0, 0, 0).getTime(),
      endMs: sundayFirst.getTime(),
    },
  );
});
