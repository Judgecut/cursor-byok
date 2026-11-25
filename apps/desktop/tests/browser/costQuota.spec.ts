import { test, expect } from "./fixtures";

test.use({ timezoneId: "America/New_York" });

test("keeps amount, currency, and actions together at desktop window sizes", async ({ page, management }) =>
{
  management.settings.cost_quotas.week = { amount: "1500", currency: "CNY" };
  await page.goto("#/settings");
  for (const width of [1920, 820])
  {
    await page.setViewportSize({ width, height: 558 });
    for (const name of ["Weekly quota", "Monthly quota", "Yearly quota"])
    {
      const form = page.getByRole("form", { name });
      await form.scrollIntoViewIfNeeded();
      const bounds = await Promise.all([
        form.getByText(name, { exact: true }).boundingBox(),
        form.getByRole("textbox").boundingBox(),
        form.getByRole("button", { name: `${name} currency` }).boundingBox(),
        form.getByRole("button", { name: "Save", exact: true }).boundingBox(),
      ]);
      const [label, amount, currency, save] = bounds;
      if (!label || !amount || !currency || !save) throw new Error(`Missing ${name} controls at ${width}px`);
      expect(amount.x - label.x).toBeLessThan(160);
      expect(currency.x).toBeGreaterThan(amount.x);
      expect(save.x).toBeGreaterThan(currency.x);
      expect(currency.y).toBeCloseTo(amount.y, 0);
      expect(save.y).toBeCloseTo(amount.y, 0);
    }
  }
});

test("saves independent cost quotas and displays all of them across activity views", async ({ page, management }) =>
{
  management.settings.home_auto_refresh_enabled = false;
  management.settings.cny_rate = "7";
  management.settings.jpy_rate = "150";
  management.exchangeRateSync.auto_sync_enabled = false;
  management.costQuotaUsage = { week: "10", month: "90", year: "100" };
  management.overview.activity_series = [{ date: "2026-11-25", token_usage: 100, total_cost: "3" }];
  management.overview.available_suppliers = [{ supplier_id: "quota-provider", provider_id: "quota-provider", source_kind: "builtin", endpoint_key: "https://example.com/v1/chat/completions", label: "Quota provider", provider_type: "openai-chat", plugin_icon: null, active: true, model_count: 1 }];
  const quotas = page.getByRole("group", { name: "Global cost quotas" });
  await page.goto("#/");
  await expect(page.getByRole("region", { name: "Token usage over the past year" })).toBeVisible();
  await expect(quotas).toHaveCount(0);
  expect(management.costQuotaQueries).toHaveLength(0);

  await page.goto("#/settings");
  const week = page.getByRole("form", { name: "Weekly quota" });
  const amount = week.getByRole("textbox");
  await amount.fill("0");
  await week.getByRole("button", { name: "Save", exact: true }).click();
  await expect(week.getByRole("alert")).toBeVisible();
  for (const [name, value, currency] of [["Weekly quota", "100", "CNY"], ["Monthly quota", "100", "USD"], ["Yearly quota", "10000", "JPY"]])
  {
    const form = page.getByRole("form", { name });
    await form.getByRole("textbox").fill(value);
    await form.getByRole("button", { name: `${name} currency` }).click();
    await page.getByRole("option", { name: new RegExp(`^${currency} ·`) }).click();
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(form.getByRole("button", { name: "Clear quota" })).toBeVisible();
  }
  await page.reload();
  await expect(amount).toHaveValue("100");
  await expect(week.getByRole("button", { name: "Weekly quota currency" })).toContainText("CNY");

  await page.setViewportSize({ width: 1680, height: 900 });
  await page.goto("#/");
  const weeklyBar = quotas.getByRole("progressbar", { name: "Weekly quota" });
  const monthlyBar = quotas.getByRole("progressbar", { name: "Monthly quota" });
  const yearlyBar = quotas.getByRole("progressbar", { name: "Yearly quota" });
  await expect(weeklyBar).toHaveAttribute("aria-valuetext", "70% · ¥70.00 / ¥100.00");
  await expect(weeklyBar.locator("[data-level]")).toHaveAttribute("data-level", "warning");
  await expect(weeklyBar.locator("[data-level]")).toHaveCSS("background-color", "rgb(215, 165, 0)");
  await expect(monthlyBar.locator("[data-level]")).toHaveAttribute("data-level", "critical");
  await expect(yearlyBar).toHaveAttribute("aria-valuenow", "100");
  await expect(yearlyBar).toHaveAttribute("aria-valuetext", "150% · JP¥15,000.00 / JP¥10,000.00");
  await expect(page.getByText("Total cost", { exact: true })).toBeVisible();

  const queryCount = management.costQuotaQueries.length;
  await page.getByRole("group", { name: "Activity calendar time range" }).getByRole("button", { name: "Week", exact: true }).click();
  await page.getByRole("button", { name: "Display currency", exact: true }).click();
  await page.getByRole("option", { name: /^EUR ·/ }).click();
  await expect.poll(() => management.settings.currency).toBe("EUR");
  await page.getByRole("button", { name: /^Filter providers:/ }).click();
  await page.getByRole("option", { name: "Quota provider" }).click();
  await page.keyboard.press("Escape");
  await expect(weeklyBar).toHaveAttribute("aria-valuetext", "70% · ¥70.00 / ¥100.00");
  expect(management.costQuotaQueries).toHaveLength(queryCount);

  management.exchangeRateSync.auto_sync_enabled = true;
  management.exchangeRateSync.snapshot = { source: "exchange_rate_api", published_at_ms: Date.now(), rates: { CNY: "8", JPY: "160", EUR: "0.9", TWD: "33", TRY: "50", KRW: "1300" } };
  management.settings.theme = "default-light";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(weeklyBar).toHaveAttribute("aria-valuetext", "80% · ¥80.00 / ¥100.00");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "default-light");
  await page.setViewportSize({ width: 820, height: 790 });
  await expect(quotas.getByRole("progressbar")).toHaveCount(3);
  await expect(weeklyBar).toBeVisible();

  await page.goto("#/settings");
  for (const name of ["Weekly quota", "Monthly quota", "Yearly quota"])
  {
    const form = page.getByRole("form", { name });
    await form.getByRole("button", { name: "Clear quota" }).click();
    await expect(form.getByRole("button", { name: "Clear quota" })).toHaveCount(0);
  }
  await page.goto("#/");
  await expect(quotas).toHaveCount(0);
});

test("refreshes current quota periods at local midnight with auto-refresh off", async ({ page, management }) =>
{
  await page.clock.install({ time: new Date("2027-01-01T04:59:08.000Z") });
  management.settings.home_auto_refresh_enabled = false;
  management.settings.cost_quotas = { week: { amount: "100", currency: "USD" }, month: null, year: { amount: "100", currency: "USD" } };
  management.costQuotaUsage = { week: "25", month: "20", year: "80" };
  await page.goto("#/");
  const year = page.getByRole("progressbar", { name: "Yearly quota" });
  await expect(year).toHaveAttribute("aria-valuenow", "80");
  expect(Number(management.costQuotaQueries.at(-1)?.get("year_start_ms"))).toBe(Date.parse("2026-01-01T05:00:00Z"));

  management.costQuotaUsage = { week: "25", month: "0", year: "0" };
  await page.clock.fastForward(55_000);
  await expect(year).toHaveAttribute("aria-valuenow", "0");
  await expect(page.getByRole("progressbar", { name: "Weekly quota" })).toHaveAttribute("aria-valuenow", "25");
  const query = management.costQuotaQueries.at(-1);
  expect(Number(query?.get("week_start_ms"))).toBe(Date.parse("2026-12-28T05:00:00Z"));
  expect(Number(query?.get("month_start_ms"))).toBe(Date.parse("2027-01-01T05:00:00Z"));
  expect(query?.get("year_start_ms")).toBe(query?.get("month_start_ms"));
});

test("keeps the last quota usage on a refresh error and retries on the next refresh", async ({ page, management }) =>
{
  management.settings.home_auto_refresh_enabled = false;
  management.settings.cost_quotas.week = { amount: "100", currency: "USD" };
  management.costQuotaUsage.week = "25";
  await page.goto("#/");
  const bar = page.getByRole("progressbar", { name: "Weekly quota" });
  await expect(bar).toHaveAttribute("aria-valuenow", "25");
  await expect(bar.locator("[data-level]")).toHaveCSS("background-color", "rgb(47, 129, 247)");
  const route = "**/overview/cost-quota-usage?*";
  await page.route(route, (request) => request.fulfill({ status: 503 }));
  const refresh = page.getByRole("button", { name: "Refresh", exact: true });
  await refresh.click();
  const failure = page.getByRole("status").filter({ hasText: "Failed to refresh quota usage" });
  await expect(failure).toBeVisible();
  await expect(bar).toHaveAttribute("aria-valuenow", "25");
  await page.unroute(route);
  management.costQuotaUsage.week = "30";
  await refresh.click();
  await expect(bar).toHaveAttribute("aria-valuenow", "30");
  await expect(failure).toHaveCount(0);
});
