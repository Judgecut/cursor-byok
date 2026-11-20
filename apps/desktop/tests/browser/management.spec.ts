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

  const cacheRate = page.getByRole("spinbutton", { name: "Assumed cache hit rate (%)", exact: true });
  await expect(cacheRate).toHaveValue("90");
  await cacheRate.fill("75.25");
  await cacheRate.press("Enter");
  await expect.poll(() => management.pricingSettings.assumed_cache_hit_rate_bps).toBe(7525);
  expect(management.writes).toContainEqual({ path: "/pricing/settings", body: { assumed_cache_hit_rate_bps: 7525 } });
  await page.reload();
  await expect(cacheRate).toHaveValue("75.25");

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
        metrics: { llm_calls: 1, successful_calls: 1, failed_calls: 0, token_usage: 300, prompt_tokens: 200, input_tokens: 200, reported_cache_input_tokens: 200, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 100, total_cost: "0", input_cost: "0", output_cost: "0", cache_read_cost: "0", cache_write_cost: "0", average_priced_cost: null, priced_calls: 0, unpriced_calls: 1, incomplete_usage_calls: 0, unreported_cache_calls: 0, assumed_cache_calls: 0, assumed_cache_cost: "0", estimated_cache_read_tokens: 0, speed: { average_tokens_per_second: 100, output_tokens: 100, generation_ms: 1000, samples: 1, first_output_median_ms: 100 } },
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

test("separates unreported cache from explicit zero and displays assumed cache cost basis", async ({ page }) => {
  const baseCall = {
    call_kind: "provider_llm",
    route: "local_byok",
    run_id: "cache-run",
    conversation_id: "cache-conv",
    provider_call_index: 1,
    model_hash: "gemini-2-5-hash",
    supplier_key: "gateway-sup",
    endpoint_key: "https://gateway.example/v1",
    provider_type: "anthropic",
    provider_url: "https://gateway.example/v1",
    request_type: "anthropic",
    request_url: "https://gateway.example/v1/messages",
    model_id: "gemini-2.5-pro",
    display_name: "Gemini 2.5 Pro",
    reasoning_effort: null,
    fast: false,
    status: "completed",
    finish_reason: "stop",
    created_at_ms: 1_800_000_000_000,
    ttfb_ms: 100,
    ttft_ms: 100,
    ttfr_ms: null,
    ttfo_ms: 100,
    duration_ms: 1100,
    generation_ms: 1000,
    generation_output_events: 10,
    streaming: true,
    call_origin: "run",
    observed_thinking: false,
    performance: {
      overall_tokens_per_second: 90.9,
      overall_reason: null,
      speed_status: "measured",
      tokens_per_second: 100,
      reason: null,
      first_output_ms: 100,
      generation_ms: 1000,
    },
    output_tokens: 100_000,
    reasoning_tokens: null,
    pricing_source: "custom",
    pricing_provider_id: null,
    pricing_model_id: null,
    pricing_snapshot_at_ms: 1_800_000_000_000,
    unit_input_per_million: "1.5",
    unit_output_per_million: "7.5",
    unit_cache_read_per_million: "0.075",
    unit_cache_write_per_million: "0.375",
    cost_status: "priced",
    output_cost: "0.75",
    cache_write_cost: "0",
    cost_calculated_at_ms: 1_800_000_000_000,
    cost_backfilled: false,
    message_count: 1,
    tool_count: 0,
    http_status: 200,
    error_kind: null,
    error_message: null,
    detailed: false,
  };
  const unreportedCall = {
    ...baseCall,
    call_id: "unreported-call",
    input_tokens: 1_000_000,
    billed_input_tokens: 100_000,
    total_tokens: 1_100_000,
    cache_read_tokens: null,
    cache_write_tokens: null,
    cost_basis: "assumed_cache",
    assumed_cache_hit_rate_bps: 9_000,
    estimated_cache_read_tokens: 900_000,
    input_cost: "0.15",
    cache_read_cost: "0.0675",
    total_cost: "0.9675",
  };
  const explicitZeroCall = {
    ...baseCall,
    call_id: "explicit-zero-call",
    provider_call_index: 2,
    input_tokens: 1_000_000,
    billed_input_tokens: 1_000_000,
    total_tokens: 1_100_000,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_basis: "reported",
    assumed_cache_hit_rate_bps: null,
    estimated_cache_read_tokens: null,
    input_cost: "1.5",
    cache_read_cost: "0",
    total_cost: "2.25",
  };

  await page.route(/\/__byok-api__\/api\/llm-calls(?:\/|\?|$)/, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/api/llm-calls/unreported-call")) {
      await route.fulfill({ json: { call: unreportedCall, request: null, response_chunks: [], cursor_trace: null } });
      return;
    }
    if (pathname.endsWith("/api/llm-calls/explicit-zero-call")) {
      await route.fulfill({ json: { call: explicitZeroCall, request: null, response_chunks: [], cursor_trace: null } });
      return;
    }
    await route.fulfill({ json: { items: [unreportedCall, explicitZeroCall], total: 2 } });
  });

  await page.route("**/__byok-api__/api/overview*", async (route) => {
    await route.fulfill({
      json: {
        metrics: {
          llm_calls: 2,
          successful_calls: 2,
          failed_calls: 0,
          token_usage: 2_200_000,
          prompt_tokens: 2_000_000,
          input_tokens: 1_100_000,
          reported_cache_input_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          output_tokens: 200_000,
          total_cost: "1.935",
          input_cost: "0.3",
          output_cost: "1.5",
          cache_read_cost: "0.135",
          cache_write_cost: "0",
          average_priced_cost: "0.9675",
          priced_calls: 2,
          unpriced_calls: 0,
          incomplete_usage_calls: 0,
          unreported_cache_calls: 2,
          assumed_cache_calls: 2,
          assumed_cache_cost: "1.935",
          estimated_cache_read_tokens: 1_800_000,
          speed: { average_tokens_per_second: 100, output_tokens: 200_000, generation_ms: 2000, samples: 2, first_output_median_ms: 100 },
        },
        token_usage_granularity: "day",
        token_usage_series: [],
        activity_series: [],
        suppliers: [],
        models: [
          {
            model_id: "gemini-2.5-pro",
            supplier_count: 1,
            pricing_sources: ["custom"],
            llm_calls: 2,
            successful_calls: 2,
            failed_calls: 0,
            token_usage: 2_200_000,
            prompt_tokens: 2_000_000,
            input_tokens: 1_100_000,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            output_tokens: 200_000,
            total_cost: "1.935",
            input_cost: "0.3",
            output_cost: "1.5",
            cache_read_cost: "0.135",
            cache_write_cost: "0",
            average_priced_cost: "0.9675",
            priced_calls: 2,
            unpriced_calls: 0,
            incomplete_usage_calls: 0,
            unreported_cache_calls: 2,
            assumed_cache_calls: 2,
            assumed_cache_cost: "1.935",
            estimated_cache_read_tokens: 1_800_000,
            speed: { average_tokens_per_second: 100, output_tokens: 200_000, generation_ms: 2000, samples: 2, first_output_median_ms: 100 },
          },
        ],
        available_suppliers: [],
        available_models: [],
      },
    });
  });

  await page.goto("#/");
  const stats = page.getByRole("region", { name: "Call statistics", exact: true });
  await expect(stats.getByText("Unreported", { exact: true })).toBeVisible();
  await expect(stats.getByText("2 calls omitted cache details", { exact: true })).toBeVisible();
  await expect(stats.getByText("Incl. 2 assumed-cache ($1.93)", { exact: true })).toBeVisible();
  await expect(page.getByText("Assumed cache", { exact: true })).toBeVisible();

  await page.goto("#/calls");
  await expect(page.getByText("~90% cache", { exact: true })).toBeVisible();
  await expect(page.getByText("Unreported", { exact: true }).first()).toBeVisible();

  await page.goto("#/calls/unreported-call");
  await expect(page.getByText("Est. 90% cache", { exact: true })).toBeVisible();
  await expect(page.getByText("Unreported", { exact: true }).first()).toBeVisible();

  await page.goto("#/calls/explicit-zero-call");
  await expect(page.getByRole("region", { name: "Cost breakdown", exact: true }).getByText("Reported usage", { exact: true })).toBeVisible();
  await expect(page.getByText("0 (explicit zero)", { exact: true }).first()).toBeVisible();
});

test("preserves overview table scroll position across call pagination, page size changes, filter changes, and route switches", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 960 });

  const calls = Array.from({ length: 45 }, (_, index) => ({
    call_kind: "provider_llm",
    route: "local_byok",
    call_id: `scroll-call-${index}`,
    run_id: `scroll-run-${index}`,
    conversation_id: `scroll-conv-${index}`,
    provider_call_index: 1,
    model_hash: "smoke-model",
    supplier_key: null,
    endpoint_key: null,
    provider_type: "openai",
    provider_url: "https://provider.example",
    request_type: "responses",
    request_url: "https://provider.example/v1/responses",
    model_id: "gpt-5",
    display_name: "GPT 5",
    reasoning_effort: null,
    fast: false,
    status: "completed",
    finish_reason: "stop",
    created_at_ms: 1_800_000_000_000 - index * 1000,
    ttfb_ms: 100,
    ttft_ms: 100,
    ttfr_ms: null,
    ttfo_ms: 100,
    duration_ms: 1100,
    generation_ms: 1000,
    generation_output_events: 10,
    streaming: true,
    call_origin: "run",
    observed_thinking: false,
    performance: {
      overall_tokens_per_second: 90.9,
      overall_reason: null,
      speed_status: "measured",
      tokens_per_second: 100,
      reason: null,
      first_output_ms: 100,
      generation_ms: 1000,
    },
    input_tokens: 34_800,
    billed_input_tokens: 2_100,
    output_tokens: 563,
    total_tokens: 35_363,
    cache_read_tokens: 32_700,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    pricing_source: "unpriced",
    pricing_provider_id: null,
    pricing_model_id: null,
    pricing_snapshot_at_ms: null,
    unit_input_per_million: null,
    unit_output_per_million: null,
    unit_cache_read_per_million: null,
    unit_cache_write_per_million: null,
    cost_status: "unpriced",
    cost_basis: null,
    assumed_cache_hit_rate_bps: null,
    estimated_cache_read_tokens: null,
    input_cost: null,
    output_cost: null,
    cache_read_cost: null,
    cache_write_cost: null,
    total_cost: null,
    cost_calculated_at_ms: null,
    cost_backfilled: false,
    message_count: 1,
    tool_count: 0,
    http_status: 200,
    error_kind: null,
    error_message: null,
    detailed: false,
  }));

  const activitySeries = Array.from({ length: 45 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 9, 5 + index)).toISOString().slice(0, 10),
    token_usage: (index + 1) * 1000,
  }));
  const tokenUsageSeries = Array.from({ length: 7 }, (_, index) => ({
    bucket_start_ms: Date.UTC(2026, 10, 1 + index),
    input_tokens: 10_000,
    cache_read_tokens: 20_000,
    cache_write_tokens: 0,
    output_tokens: 2_000,
    input_cost: "0",
    output_cost: "0",
    cache_read_cost: "0",
    cache_write_cost: "0",
    total_cost: "0",
    priced_calls: 0,
    unpriced_calls: 1,
    incomplete_usage_calls: 0,
    unreported_cache_calls: 0,
    assumed_cache_calls: 0,
    assumed_cache_cost: "0",
    estimated_cache_read_tokens: 0,
  }));

  await page.route("**/__byok-api__/api/llm-calls*", async (route) => {
    const url = new URL(route.request().url());
    const limit = Number(url.searchParams.get("limit") ?? "20");
    const offset = Number(url.searchParams.get("offset") ?? "0");
    await new Promise((resolve) => setTimeout(resolve, 40));
    await route.fulfill({ json: { items: calls.slice(offset, offset + limit), total: calls.length } });
  });

  await page.route("**/__byok-api__/api/overview*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    await route.fulfill({
      json: {
        metrics: { llm_calls: 45, successful_calls: 45, failed_calls: 0, token_usage: 1_000_000, prompt_tokens: 800_000, input_tokens: 200_000, reported_cache_input_tokens: 600_000, cache_read_tokens: 600_000, cache_write_tokens: 0, output_tokens: 200_000, total_cost: "0", input_cost: "0", output_cost: "0", cache_read_cost: "0", cache_write_cost: "0", average_priced_cost: null, priced_calls: 0, unpriced_calls: 45, incomplete_usage_calls: 0, unreported_cache_calls: 0, assumed_cache_calls: 0, assumed_cache_cost: "0", estimated_cache_read_tokens: 0, speed: { average_tokens_per_second: 100, output_tokens: 200_000, generation_ms: 2_000_000, samples: 45, first_output_median_ms: 100 } },
        token_usage_granularity: "day",
        token_usage_series: tokenUsageSeries,
        activity_series: activitySeries,
        suppliers: [],
        models: [],
        available_suppliers: [],
        available_models: [],
      },
    });
  });

  await page.goto("#/");
  await page.getByRole("tab", { name: /^Calls/ }).click();
  await expect(page.getByText("Page 1 of 3", { exact: true })).toBeVisible();
  await expect(page.getByText("scroll-call-0", { exact: true })).toBeVisible();

  const readScroll = () => page.evaluate(() => {
    const vertical = [...document.querySelectorAll("*")].find((el) => {
      const style = getComputedStyle(el);
      return (style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight;
    });
    const horizontal = [...document.querySelectorAll("*")].find((el) => el.scrollWidth > el.clientWidth + 100);
    return {
      scrollTop: vertical?.scrollTop ?? 0,
      scrollLeft: horizontal?.scrollLeft ?? 0,
    };
  });

  await page.evaluate(() => {
    const vertical = [...document.querySelectorAll("*")].find((el) => {
      const style = getComputedStyle(el);
      return (style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight;
    });
    const horizontal = [...document.querySelectorAll("*")].find((el) => el.scrollWidth > el.clientWidth + 100);
    if (vertical) vertical.scrollTop = vertical.scrollHeight;
    if (horizontal) horizontal.scrollLeft = 800;
  });

  await expect.poll(async () => (await readScroll()).scrollTop).toBeGreaterThan(300);
  const initial = await readScroll();
  expect(initial.scrollLeft).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
  await expect(page.getByText("scroll-call-20", { exact: true })).toBeVisible();
  expect(await readScroll()).toEqual(initial);

  await page.getByRole("button", { name: "Items per page", exact: true }).click();
  await page.getByRole("option", { name: "50 per page", exact: true }).click();
  await expect(page.getByText("Page 1 of 1", { exact: true })).toBeVisible();
  await expect(page.getByText("scroll-call-44", { exact: true })).toBeVisible();
  expect(await readScroll()).toEqual(initial);

  await page.getByRole("button", { name: "Last calendar day", exact: true }).click();
  await expect(page.getByRole("button", { name: "Last calendar day", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await readScroll()).toEqual(initial);

  await page.getByRole("link", { name: "Call history", exact: true }).click();
  await expect(page.getByText("scroll-call-0", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page.getByText("scroll-call-44", { exact: true })).toBeVisible();
  await expect.poll(readScroll).toEqual(initial);
});
