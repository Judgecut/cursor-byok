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
  assert.equal(lines[0], "生成速度：≈120 tok/s（不含首 Token 等待）");
  assert.equal(lines[1], "首 Token：1.4s");
  assert.equal(lines[2], "生成时间：1.0s");
  assert.equal(lines[3], "整体端到端速度：50 tok/s（含首 Token 等待）");
  assert.equal(lines[4], "Token 或计时口径为估算值");
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
  assert.equal(lines[0], "生成速度：85 tok/s（不含首 Token 等待）");
  assert.equal(lines[1], "按总生成输出 ÷ 总生成时间（不含首 Token 等待）汇总，不平均每次调用速度");
  assert.equal(lines[2], "样本：3 次调用 · 1200 Token · 14.1s");
  assert.equal(lines[3], "首 Token 中位数：0.6s");
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
    generationMs: 250,
    durationMs: 750,
  });
  assert.equal(shortButValid.speed_status, "measured");
  assert.equal(shortButValid.tokens_per_second, 160);
  assert.equal(shortButValid.reason, null);

  // Hidden reasoning deducts reasoning_tokens and marks as estimated.
  const hiddenReasoning = evaluatePerformance({
    status: "completed",
    streaming: true,
    outputTokens: 500,
    reasoningTokens: 300,
    observedThinking: false,
    firstOutputMs: 1000,
    generationMs: 2000,
    durationMs: 3000,
  });
  assert.equal(hiddenReasoning.speed_status, "estimated");
  assert.equal(hiddenReasoning.tokens_per_second, 100);

  // Under 200ms generation_ms is rejected.
  const tooFast = evaluatePerformance({
    status: "completed",
    streaming: true,
    outputTokens: 100,
    reasoningTokens: null,
    observedThinking: false,
    firstOutputMs: 200,
    generationMs: 199,
    durationMs: 399,
  });
  assert.equal(tooFast.speed_status, "unavailable");
  assert.equal(tooFast.reason, "short_generation");
  assert.equal(tooFast.tokens_per_second, null);

  const pooled = mockAggregate([
    {
      status: "completed",
      call_origin: "run",
      streaming: true,
      output_tokens: 40,
      reasoning_tokens: null,
      observed_thinking: false,
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
      generation_ms: 199,
      performance: tooFast,
    },
  ]);
  assert.equal(pooled.samples, 2);
  assert.equal(pooled.output_tokens, 240);
  assert.equal(pooled.generation_ms, 2250);
  assert.ok(Math.abs(pooled.average_tokens_per_second - (240 / 2.25)) < 1e-9);
  assert.equal(pooled.first_output_median_ms, 500);
});
