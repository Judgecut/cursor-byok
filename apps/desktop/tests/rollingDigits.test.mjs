import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { createContext, SourceTextModule } from "node:vm";

const source = stripTypeScriptTypes(
  await readFile(new URL("../src/features/home/motion/rollingDigits.ts", import.meta.url), "utf8"),
);
const context = createContext({ Array, Number, Math, String, RegExp });
const module = new SourceTextModule(source, { context });
await module.link((specifier) => {
  throw new Error(`Unexpected dependency: ${specifier}`);
});
await module.evaluate();

const {
  buildCyclicSteps,
  buildRollPlan,
  parseFormattedNumber,
  resolveMotionTone,
} = module.namespace;

test("parseFormattedNumber extracts prefixes, signs, digits, and suffixes across metric formats", () => {
  assert.deepEqual({ ...parseFormattedNumber("¥609.23") }, {
    prefix: "¥",
    sign: "",
    leadingText: "¥",
    intDigits: "609",
    fracDigits: "23",
    rawCore: "609.23",
    suffix: "",
  });
  assert.deepEqual({ ...parseFormattedNumber("JP¥15,000.00") }, {
    prefix: "JP¥",
    sign: "",
    leadingText: "JP¥",
    intDigits: "15000",
    fracDigits: "00",
    rawCore: "15,000.00",
    suffix: "",
  });
  assert.deepEqual({ ...parseFormattedNumber("NT$64.00") }, {
    prefix: "NT$",
    sign: "",
    leadingText: "NT$",
    intDigits: "64",
    fracDigits: "00",
    rawCore: "64.00",
    suffix: "",
  });
  assert.deepEqual({ ...parseFormattedNumber("95.59%") }, {
    prefix: "",
    sign: "",
    leadingText: "",
    intDigits: "95",
    fracDigits: "59",
    rawCore: "95.59",
    suffix: "%",
  });
  assert.deepEqual({ ...parseFormattedNumber("147M") }, {
    prefix: "",
    sign: "",
    leadingText: "",
    intDigits: "147",
    fracDigits: "",
    rawCore: "147",
    suffix: "M",
  });
  assert.deepEqual({ ...parseFormattedNumber("≈149 tok/s") }, {
    prefix: "≈",
    sign: "",
    leadingText: "≈",
    intDigits: "149",
    fracDigits: "",
    rawCore: "149",
    suffix: " tok/s",
  });
  assert.deepEqual({ ...parseFormattedNumber("4.7s") }, {
    prefix: "",
    sign: "",
    leadingText: "",
    intDigits: "4",
    fracDigits: "7",
    rawCore: "4.7",
    suffix: "s",
  });
  assert.deepEqual({ ...parseFormattedNumber("18 天") }, {
    prefix: "",
    sign: "",
    leadingText: "",
    intDigits: "18",
    fracDigits: "",
    rawCore: "18",
    suffix: " 天",
  });
  assert.deepEqual({ ...parseFormattedNumber("18 days") }, {
    prefix: "",
    sign: "",
    leadingText: "",
    intDigits: "18",
    fracDigits: "",
    rawCore: "18",
    suffix: " days",
  });
  for (const placeholder of ["—", "暂无数据", "未上报", "Unreported"]) {
    assert.equal(parseFormattedNumber(placeholder), null);
  }
});

test("buildCyclicSteps generates upward and downward cyclic digit sequences", () => {
  assert.deepEqual([...buildCyclicSteps("9", "2", 1)], ["9", "0", "1", "2"]);
  assert.deepEqual([...buildCyclicSteps("7", "5", -1)], ["5", "6", "7"]);
  assert.deepEqual([...buildCyclicSteps("1", "8", -1)], ["8", "9", "0", "1"]);
  assert.deepEqual([...buildCyclicSteps("4", "4", 1)], ["4"]);
});

test("buildRollPlan keeps unchanged digits static and rolls changed digits by place value", () => {
  const plan = buildRollPlan("¥609.23", "¥612.85");
  assert.equal(plan.shouldRoll, true);
  assert.equal(plan.direction, 1);
  assert.deepEqual(
    [...plan.tokens].map((token) => token.kind === "static" ? token.text : { target: token.target, steps: [...token.steps], dir: token.direction }),
    [
      "¥",
      "6",
      { target: "1", steps: ["0", "1"], dir: 1 },
      { target: "2", steps: ["9", "0", "1", "2"], dir: 1 },
      ".",
      { target: "8", steps: ["2", "3", "4", "5", "6", "7", "8"], dir: 1 },
      { target: "5", steps: ["3", "4", "5"], dir: 1 },
    ],
  );
  const digitTokens = plan.tokens.filter((token) => token.kind === "digit");
  assert.equal(digitTokens.at(-1).delayMs, 0);
  assert.equal(digitTokens.at(-2).delayMs, 20);
  assert.equal(plan.maxDelayMs, 60);
});

test("buildRollPlan handles downward transitions, leading carry expansion, currency/unit switches, and identical compact strings", () => {
  const downward = buildRollPlan("4.7s", "4.5s");
  assert.equal(downward.shouldRoll, true);
  assert.equal(downward.direction, -1);
  const downDigit = downward.tokens.find((token) => token.kind === "digit");
  assert.deepEqual([...downDigit.steps], ["5", "6", "7"]);
  assert.equal(downDigit.direction, -1);

  const carry = buildRollPlan("¥99.50", "¥102.30");
  assert.equal(carry.shouldRoll, true);
  const leading = carry.tokens[1];
  assert.equal(leading.kind, "digit");
  assert.equal(leading.entering, true);
  assert.equal(leading.target, "1");

  const currencySwitch = buildRollPlan("$100.00", "¥667.77");
  assert.equal(currencySwitch.shouldRoll, true);
  assert.equal(currencySwitch.tokens.filter((token) => token.kind === "digit").length, 5);

  const unitRoll = buildRollPlan("999K", "1M");
  assert.equal(unitRoll.shouldRoll, true);
  assert.equal(unitRoll.tokens.filter((token) => token.kind === "digit").length, 1);

  const compactUnchanged = buildRollPlan("147M", "147M", { prevNumeric: 147_100_000, nextNumeric: 147_400_000 });
  assert.equal(compactUnchanged.shouldRoll, false);
  assert.equal(compactUnchanged.direction, 1);
});

test("resolveMotionTone maps direction and polarity to semantic colors", () => {
  assert.equal(resolveMotionTone(1, "higher-better"), "positive");
  assert.equal(resolveMotionTone(-1, "higher-better"), "attention");
  assert.equal(resolveMotionTone(-1, "lower-better"), "positive");
  assert.equal(resolveMotionTone(1, "lower-better"), "attention");
  assert.equal(resolveMotionTone(1, "cost"), "attention");
  assert.equal(resolveMotionTone(-1, "cost"), "positive");
  assert.equal(resolveMotionTone(1, "activity"), "active");
  assert.equal(resolveMotionTone(-1, "activity"), "attention");
  assert.equal(resolveMotionTone(1, "neutral"), "none");
  assert.equal(resolveMotionTone(0, "cost"), "none");
});
