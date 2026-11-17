import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

function translate(source, params) {
  if (!params) return source;
  return source.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => String(params[name]));
}

const speedFormatSource = stripTypeScriptTypes(
  await readFile(new URL("../src/shared/utils/speedFormat.ts", import.meta.url), "utf8"),
);
const speedContext = createContext({ Error, Number, Math, t: translate });
const speedModule = new SourceTextModule(speedFormatSource, { context: speedContext });
await speedModule.link((specifier) => {
  throw new Error(`Unexpected dependency: ${specifier}`);
});
await speedModule.evaluate();

const {
  aggregateTooltip,
  formatSpeed,
  generationSpeedTooltip,
  speedUnavailableText,
} = speedModule.namespace;

test("speedUnavailableText describes 200ms threshold and visible output gate", () => {
  assert.equal(speedUnavailableText("short_output"), "无有效可见输出，无法计算速度");
  assert.equal(speedUnavailableText("short_generation"), "生成时间少于 200ms，样本不足");
});

test("generationSpeedTooltip prioritizes generation speed and keeps end-to-end speed secondary", () => {
  const text = generationSpeedTooltip({
    overall_tokens_per_second: 50,
    overall_reason: null,
    speed_status: "estimated",
    tokens_per_second: 120,
    reason: null,
    first_output_ms: 1400,
    generation_ms: 1000,
  });
  const lines = text.split("\n");
  assert.equal(lines[0], "生成速度：≈120 tok/s（首末可见输出之间）");
  assert.equal(lines[1], "首次输出：1.4s");
  assert.equal(lines[2], "生成时间：1.0s");
  assert.equal(lines[3], "整体端到端速度：50 tok/s（含首次输出等待）");
  assert.equal(lines[4], "按可见输出 Token 与客户端接收时间估算；首批可能包含多个 Token，分块方式会影响结果");
});

test("aggregateTooltip reports pooled generation speed and generation_ms", () => {
  const text = aggregateTooltip({
    average_tokens_per_second: 85.4,
    output_tokens: 1200,
    generation_ms: 14050,
    samples: 3,
    first_output_median_ms: 600,
  });
  const lines = text.split("\n");
  assert.equal(lines[0], "生成速度：≈85 tok/s（首末可见输出之间）");
  assert.equal(lines[1], "按首个 Token 之后的可见输出总数 ÷ 首末可见输出间隔汇总");
  assert.match(lines[2], /首批可能包含多个 Token/);
  assert.equal(lines[3], "样本：3 次调用 · 1200 Token · 14.1s");
  assert.equal(lines[4], "首次输出中位数：0.6s");
  assert.equal(formatSpeed(85.4, "measured"), "85");
  assert.equal(formatSpeed(0.4, "estimated"), "≈0.4");
});

test("demo api evaluates and pools generation speed with hidden reasoning deduction and 200ms gate", async () => {
  const demoSource = stripTypeScriptTypes(
    await readFile(new URL("../src/demo/api.ts", import.meta.url), "utf8"),
  );
  const appendedSource = `${demoSource}\nexport { evaluatePerformance as __evaluatePerformance, mockAggregate as __mockAggregate };`;
  const demoContext = createContext({
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Response,
    Set,
    URL,
    URLSearchParams,
    window: {},
  });
  const demoModule = new SourceTextModule(appendedSource, { context: demoContext });
  await demoModule.link((specifier) => {
    assert.equal(specifier, "../shared/utils/costFormat");
    return new SyntheticModule(["normalizeExchangeRate"], function () {
      this.setExport("normalizeExchangeRate", () => null);
    }, { context: demoContext });
  });
  await demoModule.evaluate();
  const { __evaluatePerformance: evaluatePerformance, __mockAggregate: mockAggregate } = demoModule.namespace;

  // Short output (<100 tokens) is valid when generation_ms >= 200.
  const shortButValid = evaluatePerformance({
    status: "completed",
    streaming: true,
    outputTokens: 40,
    reasoningTokens: null,
    observedThinking: false,
    firstOutputMs: 500,
    generationOutputEvents: 2,
    generationMs: 250,
    durationMs: 750,
  });
  assert.equal(shortButValid.speed_status, "estimated");
  assert.equal(shortButValid.tokens_per_second, 156);
  assert.equal(shortButValid.reason, null);

  // Hidden reasoning deducts reasoning_tokens and marks as estimated.
  const hiddenReasoning = evaluatePerformance({
    status: "completed",
    streaming: true,
    outputTokens: 500,
    reasoningTokens: 300,
    observedThinking: false,
    firstOutputMs: 1000,
    generationOutputEvents: 2,
    generationMs: 2000,
    durationMs: 3000,
  });
  assert.equal(hiddenReasoning.speed_status, "estimated");
  assert.equal(hiddenReasoning.tokens_per_second, 99.5);

  // Under 200ms generation_ms is rejected.
  const tooFast = evaluatePerformance({
    status: "completed",
    streaming: true,
    outputTokens: 100,
    reasoningTokens: null,
    observedThinking: false,
    firstOutputMs: 200,
    generationOutputEvents: 2,
    generationMs: 199,
    durationMs: 399,
  });
  assert.equal(tooFast.speed_status, "unavailable");
  assert.equal(tooFast.reason, "short_generation");
  assert.equal(tooFast.tokens_per_second, null);

  const visibleSample = { status: "completed", streaming: true, outputTokens: 401, reasoningTokens: 300, observedThinking: true, firstOutputMs: 100, generationMs: 1000, generationOutputEvents: 2, durationMs: 1600 };
  assert.equal(evaluatePerformance(visibleSample).tokens_per_second, 100);
  assert.equal(evaluatePerformance(visibleSample).speed_status, "estimated");
  assert.equal(evaluatePerformance({ ...visibleSample, reasoningTokens: null }).reason, "missing_visible_output_tokens");
  assert.equal(evaluatePerformance({ ...visibleSample, generationOutputEvents: 1 }).reason, "insufficient_output_events");
  assert.equal(evaluatePerformance({ ...visibleSample, generationOutputEvents: null }).tokens_per_second, null);
  assert.equal(evaluatePerformance({ ...visibleSample, outputTokens: null }).reason, "missing_output_tokens");

  const pooled = mockAggregate([
    {
      status: "completed",
      call_origin: "run",
      streaming: true,
      output_tokens: 40,
      reasoning_tokens: null,
      observed_thinking: false,
      generation_output_events: 2,
      generation_ms: 250,
      performance: shortButValid,
    },
    {
      status: "completed",
      call_origin: "run",
      streaming: true,
      output_tokens: 500,
      reasoning_tokens: 300,
      observed_thinking: false,
      generation_output_events: 2,
      generation_ms: 2000,
      performance: hiddenReasoning,
    },
    {
      status: "completed",
      call_origin: "run",
      streaming: true,
      output_tokens: 100,
      reasoning_tokens: null,
      observed_thinking: false,
      generation_output_events: 2,
      generation_ms: 199,
      performance: tooFast,
    },
  ]);
  assert.equal(pooled.samples, 2);
  assert.equal(pooled.output_tokens, 238);
  assert.equal(pooled.generation_ms, 2250);
  assert.ok(Math.abs(pooled.average_tokens_per_second - (238 / 2.25)) < 1e-9);
  assert.equal(pooled.first_output_median_ms, 500);
});
