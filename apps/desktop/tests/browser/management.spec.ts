import { test, expect } from "./fixtures";

test("creates a provider and model through the real forms and reloads them", async ({ page, management }) =>
{
  await page.goto("#/harness/cursor");
  await page.getByTitle("Add provider", { exact: true }).click();
  const providerDialog = page.getByRole("dialog", { name: "Add provider", exact: true });
  await providerDialog.getByLabel("Provider name", { exact: true }).fill("Smoke provider");
  await providerDialog.getByLabel("Server address", { exact: true }).fill("https://provider.example");
  await providerDialog.getByPlaceholder("sk-xxxxxx", { exact: true }).fill("test-placeholder");
  await providerDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(providerDialog).toBeHidden();
  await expect.poll(() => management.providers.length).toBe(1);
  expect(management.providers[0]).toMatchObject({ name: "Smoke provider", type: "openai", base_url: "https://provider.example", openai_endpoint: "/v1/responses" });

  await page.getByTitle("Add model", { exact: true }).click();
  const modelDialog = page.getByRole("dialog", { name: "Add model", exact: true });
  await modelDialog.getByPlaceholder("gpt-5", { exact: true }).fill("smoke-model");
  await modelDialog.getByLabel("Display name", { exact: true }).fill("Smoke model");
  await modelDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(modelDialog).toBeHidden();
  await expect(page.getByText("Smoke model", { exact: true })).toBeVisible();
  expect(management.models[0]).toMatchObject({ provider_id: "smoke-provider", model_id: "smoke-model", display_name: "Smoke model", tooltip_data: "Smoke provider" });
  await page.reload();
  await expect(page.getByText("Smoke model", { exact: true })).toBeVisible();
  await expect(page.getByText("Smoke provider", { exact: true }).first()).toBeVisible();
});

test("saves settings, reads them after reload, and applies translated modules", async ({ page, management }) =>
{
  await page.goto("#/settings");
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  const interval = page.getByRole("textbox", { name: "Overview auto-refresh interval (seconds)", exact: true });
  await interval.fill("45");
  await interval.locator("xpath=ancestor::form").getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => management.settings.home_refresh_interval_seconds).toBe(45);
  expect(management.writes).toContainEqual({ path: "/settings/interface", body: { home_refresh_interval_seconds: 45 } });
  await page.reload();
  await expect(interval).toHaveValue("45");

  await page.getByRole("button", { name: "Display language", exact: true }).click();
  await page.getByRole("option", { name: "简体中文", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("textbox", { name: "主页自动刷新间隔（秒）", exact: true })).toHaveValue("45");
  await expect.poll(() => management.settings.locale).toBe("zh-CN");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("textbox", { name: "主页自动刷新间隔（秒）", exact: true })).toHaveValue("45");
});

test("opens call details using the URL sent to the desktop boundary", async ({ page, context, management }) =>
{
  await page.goto("#/calls");
  await page.getByRole("button", { name: "View details", exact: true }).click();
  await expect.poll(() => management.openedUrls.length).toBe(1);
  const url = new URL(management.openedUrls[0]);
  expect(url.origin).toBe(new URL(page.url()).origin);
  expect(url.pathname).toBe("/__byok-api__/");
  expect(url.hash).toBe("#/calls/smoke-call");
  // The native shell opens this URL in a browser; emulate only that OS action.
  const details = await context.newPage();
  await details.goto(url.toString());
  await expect(details.getByRole("heading", { name: "Smoke call model", exact: true })).toBeVisible();
  await expect(details.getByText("smoke-call", { exact: true })).toBeVisible();
  await expect(details.getByText("smoke-conversation", { exact: true })).toBeVisible();
  await expect(details.getByText("https://provider.example/v1/responses", { exact: true })).toBeVisible();
});

test("switches overview activity chart between heatmap, bar, and line across week, month, and year", async ({ page, management }) =>
{
  const activitySeries = Array.from({ length: 45 }, (_, index) =>
  {
    const date = new Date(Date.UTC(2026, 9, 5 + index)).toISOString().slice(0, 10);
    return {
      date,
      token_usage: index % 4 === 0 ? 0 : (index + 1) * 1000,
    };
  });

  await page.setViewportSize({ width: 1680, height: 900 });
  await page.route("**/__byok-api__/api/overview*", async (route) =>
  {
    await route.fulfill({
      json: {
        metrics: { llm_calls: 1, successful_calls: 1, failed_calls: 0, token_usage: 300, prompt_tokens: 200, input_tokens: 200, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 100, total_cost: "0", input_cost: "0", output_cost: "0", cache_read_cost: "0", cache_write_cost: "0", average_priced_cost: null, priced_calls: 0, unpriced_calls: 1, incomplete_usage_calls: 0, speed: { average_tokens_per_second: 100, output_tokens: 100, generation_ms: 1000, samples: 1, first_output_median_ms: 100 } },
        token_usage_granularity: "day",
        token_usage_series: [],
        activity_series: activitySeries,
        suppliers: [],
        models: [],
        available_suppliers: [],
        available_models: [],
      },
    });
  });

  await page.goto("#/");
  const yearSection = page.getByRole("region", { name: "Token usage over the past year", exact: true });
  await expect(yearSection).toBeVisible();
  await expect(yearSection.getByText("Annual activity calendar (last 365 days, filtered by selected providers)", { exact: true })).toBeVisible();
  await expect(yearSection.getByRole("img", { name: "Token usage calendar for the past year", exact: true }).locator("canvas")).toBeVisible();
  await expect(yearSection.getByText("Less", { exact: true })).toBeVisible();
  await expect(yearSection.getByText("Active days", { exact: true })).toBeVisible();
  await expect(yearSection.getByText("Active daily avg", { exact: true })).toBeVisible();
  await expect(yearSection.getByText("Peak day", { exact: true })).toBeVisible();

  const chartTypeGroup = yearSection.getByRole("group", { name: "Activity chart type", exact: true });
  await expect(chartTypeGroup.getByRole("button", { name: "Heatmap", exact: true })).toHaveAttribute("aria-pressed", "true");

  await chartTypeGroup.getByRole("button", { name: "Bar", exact: true }).click();
  await expect(chartTypeGroup.getByRole("button", { name: "Bar", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(yearSection.getByText("Annual activity bar chart (last 365 days, filtered by selected providers)", { exact: true })).toBeVisible();
  await expect(yearSection.getByRole("img", { name: "Token usage bar chart for the past year", exact: true }).locator("canvas")).toBeVisible();
  await expect(yearSection.getByText("Less", { exact: true })).toBeHidden();
  await expect(yearSection.getByText("Active days", { exact: true })).toBeVisible();
  await expect.poll(() => management.settings.overview_calendar_chart_type).toBe("bar");

  await yearSection.getByRole("group", { name: "Activity chart time range", exact: true }).getByRole("button", { name: "Month", exact: true }).click();
  const monthSection = page.getByRole("region", { name: "Token usage this month", exact: true });
  await expect(monthSection.getByText("Monthly activity bar chart (this month, filtered by selected providers)", { exact: true })).toBeVisible();
  await expect(monthSection.getByRole("img", { name: "Token usage bar chart for this month", exact: true }).locator("canvas")).toBeVisible();
  await expect(monthSection.getByText("Total this month", { exact: true })).toBeVisible();

  await monthSection.getByRole("group", { name: "Activity chart type", exact: true }).getByRole("button", { name: "Line", exact: true }).click();
  await monthSection.getByRole("group", { name: "Activity chart time range", exact: true }).getByRole("button", { name: "Week", exact: true }).click();
  const weekSection = page.getByRole("region", { name: "Token usage this week", exact: true });
  await expect(weekSection.getByText("Weekly activity line chart (this week, filtered by selected providers)", { exact: true })).toBeVisible();
  await expect(weekSection.getByRole("img", { name: "Token usage line chart for this week", exact: true }).locator("canvas")).toBeVisible();
  await expect(weekSection.getByText("Total this week", { exact: true })).toBeVisible();
  await expect.poll(() => management.settings.overview_calendar_chart_type).toBe("line");
  await expect.poll(() => management.settings.overview_calendar_window).toBe("week");

  await page.reload();
  await expect(weekSection.getByText("Weekly activity line chart (this week, filtered by selected providers)", { exact: true })).toBeVisible();
  await expect(weekSection.getByRole("group", { name: "Activity chart type", exact: true }).getByRole("button", { name: "Line", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(weekSection.getByRole("group", { name: "Activity chart time range", exact: true }).getByRole("button", { name: "Week", exact: true })).toHaveAttribute("aria-pressed", "true");

  await weekSection.getByRole("group", { name: "Activity chart type", exact: true }).getByRole("button", { name: "Heatmap", exact: true }).click();
  await weekSection.getByRole("group", { name: "Activity calendar time range", exact: true }).getByRole("button", { name: "Year", exact: true }).click();
  await expect(yearSection.getByRole("img", { name: "Token usage calendar for the past year", exact: true }).locator("canvas")).toBeVisible();
  await expect(yearSection.getByText("Less", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(yearSection.getByText("45d total 759K · 33 active days", { exact: true })).toBeVisible();
  await yearSection.getByRole("group", { name: "Activity chart type", exact: true }).getByRole("button", { name: "Line", exact: true }).click();
  await expect(yearSection.getByText("45d total 759K · 33 active days", { exact: true })).toBeVisible();
});
