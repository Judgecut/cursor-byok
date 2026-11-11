import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { createContext, SourceTextModule } from "node:vm";

function translate(source, params) {
  if (!params) return source;
  return source.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => String(params[name]));
}

const source = stripTypeScriptTypes(await readFile(new URL("../src/shared/utils/costFormat.ts", import.meta.url), "utf8"));
const context = createContext({ Error, BigInt, Number, Math, t: translate });
const module = new SourceTextModule(source, { context });
await module.link((specifier) => {
  throw new Error(`Unexpected dependency: ${specifier}`);
});
await module.evaluate();

const {
  DEFAULT_CNY_RATE,
  convertUsdToDisplayDecimal,
  convertUsdToDisplayNumber,
  formatAxisCost,
  formatConversionNote,
  formatDisplayCost,
  formatDisplayCostExact,
  normalizeExchangeRate,
  resolveExchangeRate,
} = module.namespace;

test("DEFAULT_CNY_RATE is 6.8 and resolveExchangeRate falls back to it only when unconfigured", () => {
  assert.equal(DEFAULT_CNY_RATE, "6.8");
  assert.deepEqual({ ...resolveExchangeRate(null) }, { rate: "6.8", isDefault: true });
  assert.deepEqual({ ...resolveExchangeRate(undefined) }, { rate: "6.8", isDefault: true });
  assert.deepEqual({ ...resolveExchangeRate("") }, { rate: "6.8", isDefault: true });
  assert.deepEqual({ ...resolveExchangeRate("0") }, { rate: "6.8", isDefault: true });
  assert.deepEqual({ ...resolveExchangeRate("-7.2") }, { rate: "6.8", isDefault: true });

  assert.deepEqual({ ...resolveExchangeRate("07.20") }, { rate: "7.2", isDefault: false });
  assert.deepEqual({ ...resolveExchangeRate("6.8") }, { rate: "6.8", isDefault: false });
  assert.equal(normalizeExchangeRate("06.80"), "6.8");
});

test("CNY conversions use 6.8 by default and override with configured rate", () => {
  assert.deepEqual({ ...convertUsdToDisplayDecimal("1.5", "USD", null) }, {
    currency: "USD",
    amount: "1.5",
    rateUsed: null,
  });
  assert.deepEqual({ ...convertUsdToDisplayDecimal("1.5", "CNY", null) }, {
    currency: "CNY",
    amount: "10.2",
    rateUsed: "6.8",
  });
  assert.deepEqual({ ...convertUsdToDisplayDecimal("1.5", "CNY", "7.2") }, {
    currency: "CNY",
    amount: "10.8",
    rateUsed: "7.2",
  });

  assert.equal(convertUsdToDisplayNumber("2", "CNY", null), 13.6);
  assert.equal(convertUsdToDisplayNumber("2", "CNY", "7.25"), 14.5);

  assert.equal(formatDisplayCost("1.5", "USD", null), "$1.50");
  assert.equal(formatDisplayCost("1.5", "CNY", null), "¥10.20");
  assert.equal(formatDisplayCost("1.5", "CNY", "7.2"), "¥10.80");

  assert.equal(formatDisplayCostExact("0.001", "CNY", null), "¥0.0068");
  assert.equal(formatDisplayCostExact("0.001", "CNY", "7.25"), "¥0.00725");
  assert.equal(formatAxisCost(10.2, "CNY"), "¥10.20");
  assert.equal(formatAxisCost(0, "CNY"), "¥0");
});

test("formatConversionNote distinguishes default rate vs configured rate", () => {
  assert.equal(formatConversionNote("USD", null), null);
  assert.equal(formatConversionNote("USD", "7.2"), null);
  assert.equal(formatConversionNote("CNY", null), "按默认汇率折算（1 USD = 6.8 CNY）");
  assert.equal(formatConversionNote("CNY", "7.20"), "按设置汇率折算（1 USD = 7.2 CNY）");
  assert.equal(formatConversionNote("CNY", "6.8"), "按设置汇率折算（1 USD = 6.8 CNY）");
});
