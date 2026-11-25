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
  convertUsdToDisplayDecimal,
  convertUsdToDisplayNumber,
  costQuotaProgress,
  formatAxisCost,
  formatConversionNote,
  formatDisplayCost,
  formatDisplayCostExact,
  formatHitRatePercent,
  normalizeExchangeRate,
  normalizeCostQuotaAmount,
  resolveExchangeRate,
} = module.namespace;

test("cost quota thresholds use exact decimal ratios and fill is capped", () =>
{
  for (const [amount, percentTenths, fill, level] of [["0", 0n, 0, "normal"], ["69.99999999999999", 699n, 69.9, "normal"], ["70", 700n, 70, "warning"], ["89.99999999999999", 899n, 89.9, "warning"], ["90", 900n, 90, "critical"], ["150", 1500n, 100, "critical"]])
  {
    assert.deepEqual({ ...costQuotaProgress(amount, "100") }, { percentTenths, fill, level });
  }
  assert.equal(normalizeCostQuotaAmount("001.2500"), "1.25");
  for (const invalid of ["", "0", "-1", "1e3", "Infinity", "1".repeat(65)]) assert.equal(normalizeCostQuotaAmount(invalid), null);
});

test("resolveExchangeRate uses the reference rate without a valid override", () =>
{
  for (const override of [null, undefined, "", "0", "-7.2"])
  {
    assert.deepEqual({ ...resolveExchangeRate("CNY", override) }, { rate: "6.6777", source: "built_in", referenceDate: "2026-11-20" });
  }

  assert.deepEqual({ ...resolveExchangeRate("CNY", "07.20") }, { rate: "7.2", source: "custom" });
  assert.deepEqual({ ...resolveExchangeRate("CNY", "6.6777") }, { rate: "6.6777", source: "custom" });
  assert.equal(normalizeExchangeRate("06.80"), "6.8");
});

test("CNY conversions use the reference rate and honor the configured rate", () => {
  assert.deepEqual({ ...convertUsdToDisplayDecimal("1.5", "USD", resolveExchangeRate("USD", null)) }, {
    currency: "USD",
    amount: "1.5",
    rateUsed: null,
  });
  assert.deepEqual({ ...convertUsdToDisplayDecimal("1.5", "CNY", resolveExchangeRate("CNY", null)) }, {
    currency: "CNY",
    amount: "10.01655",
    rateUsed: "6.6777",
  });
  assert.deepEqual({ ...convertUsdToDisplayDecimal("1.5", "CNY", resolveExchangeRate("CNY", "7.2")) }, {
    currency: "CNY",
    amount: "10.8",
    rateUsed: "7.2",
  });

  assert.equal(convertUsdToDisplayNumber("2", "CNY", resolveExchangeRate("CNY", null)), 13.3554);
  assert.equal(convertUsdToDisplayNumber("2", "CNY", resolveExchangeRate("CNY", "7.25")), 14.5);

  assert.equal(formatDisplayCost("1.5", "USD", resolveExchangeRate("USD", null)), "$1.50");
  assert.equal(formatDisplayCost("1.5", "CNY", resolveExchangeRate("CNY", null)), "¥10.01");
  assert.equal(formatDisplayCost("1.5", "CNY", resolveExchangeRate("CNY", "7.2")), "¥10.80");

  assert.equal(formatDisplayCostExact("0.001", "CNY", resolveExchangeRate("CNY", null)), "¥0.0066777");
  assert.equal(formatDisplayCostExact("0.001", "CNY", resolveExchangeRate("CNY", "7.25")), "¥0.00725");
  assert.equal(formatAxisCost(10.2, "CNY"), "¥10.20");
  assert.equal(formatAxisCost(0, "CNY"), "¥0");
});

test("formatConversionNote distinguishes default rate vs configured rate", () => {
  assert.equal(formatConversionNote("USD", resolveExchangeRate("USD", null)), null);
  assert.equal(formatConversionNote("USD", resolveExchangeRate("USD", "7.2")), null);
  assert.equal(formatConversionNote("CNY", resolveExchangeRate("CNY", null)), "按默认汇率折算（1 USD = 6.6777 CNY，参考日期 2026-11-20）");
  assert.equal(formatConversionNote("CNY", resolveExchangeRate("CNY", "7.20")), "按设置汇率折算（1 USD = 7.2 CNY）");
  assert.equal(formatConversionNote("CNY", resolveExchangeRate("CNY", "6.8")), "按设置汇率折算（1 USD = 6.8 CNY）");
});

test("additional currencies use their own reference rate, override and symbol", () =>
{
  for (const [currency, reference, rate, symbol, amount] of [
    ["EUR", "0.9099", "0.92", "€", "1.84"],
    ["JPY", "158.64", "150", "JP¥", "300.00"],
    ["TWD", "32.936", "32", "NT$", "64.00"],
    ["TRY", "50.5722", "40", "₺", "80.00"],
    ["KRW", "1339.44", "1400", "₩", "2,800.00"],
  ])
  {
    assert.equal(formatDisplayCost("2", currency, resolveExchangeRate(currency, rate)), `${symbol}${amount}`);
    assert.equal(formatDisplayCostExact("2", currency, resolveExchangeRate(currency, rate)), `${symbol}${amount}`);
    assert.equal(formatAxisCost(Number(rate) * 2, currency), `${symbol}${amount}`);
    assert.deepEqual({ ...convertUsdToDisplayDecimal("1", currency, resolveExchangeRate(currency, null)) }, { currency, amount: reference, rateUsed: reference });
    assert.equal(convertUsdToDisplayNumber("1", currency, resolveExchangeRate(currency, null)), Number(reference));
  }
});

test("formatHitRatePercent converts basis points with fallback", () => {
  assert.equal(formatHitRatePercent(null), "90");
  assert.equal(formatHitRatePercent(undefined, 85), "85");
  assert.equal(formatHitRatePercent(9000), "90");
  assert.equal(formatHitRatePercent(8750), "87.5");
  assert.equal(formatHitRatePercent(9025), "90.25");
  assert.equal(formatHitRatePercent(9004), "90.04");
});
