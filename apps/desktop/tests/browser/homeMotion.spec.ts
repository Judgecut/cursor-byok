import type { Locator } from "@playwright/test";
import { test, expect } from "./fixtures";

function rollingSpan(card: Locator) {
  return card.locator("[data-rolling], [data-flash]").first();
}

test("rolls numbers, flashes semantic colors, pulses cards, and settles cleanly on live refresh", async ({ page, management }) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1_000));

  management.settings.home_motion_mode = "on";
  management.settings.home_auto_refresh_enabled = false;
  management.settings.cost_quotas.week = { amount: "100", currency: "USD" };
  management.costQuotaUsage.week = "50";
  management.overview.metrics = {
    ...management.overview.metrics,
    llm_calls: 10,
    successful_calls: 10,
    failed_calls: 0,
    token_usage: 10_000,
    prompt_tokens: 9_000,
    input_tokens: 1_000,
    reported_cache_input_tokens: 100,
    cache_read_tokens: 900,
    cache_write_tokens: 0,
    output_tokens: 1_000,
    total_cost: "10",
    priced_calls: 10,
    unpriced_calls: 0,
    speed: {
      average_tokens_per_second: 100,
      output_tokens: 1_000,
      generation_ms: 10_000,
      samples: 10,
      first_output_median_ms: 4_700,
    },
  };
  management.overview.activity_series = [{ date: "2026-11-25", token_usage: 10_000, total_cost: "10" }];

  await page.goto("#/");
  const metrics = page.getByRole("region", { name: "Call statistics", exact: true });
  const cacheCard = metrics.getByRole("article").filter({ hasText: "Cache hit rate" });
  const callsCard = metrics.getByRole("article").filter({ hasText: "LLM calls" });
  const speedCard = metrics.getByRole("article").filter({ hasText: "Generation speed (tok/s)" });
  const latencyCard = metrics.getByRole("article").filter({ hasText: "First output (s)" });
  const tokensCard = metrics.getByRole("article").filter({ hasText: "Token usage" });
  const costCard = metrics.getByRole("article").filter({ hasText: "Estimated cost" });
  const weeklyBar = page.getByRole("progressbar", { name: "Weekly quota" });

  await expect(rollingSpan(costCard)).toHaveAttribute("data-rolling", "true");
  await expect(weeklyBar).toHaveAttribute("aria-valuetext", "50% · $50.00 / $100.00");
  await page.clock.runFor(800);
  await expect(cacheCard.getByText("90.00%", { exact: true })).toBeVisible();
  await expect(callsCard.getByText("10", { exact: true })).toBeVisible();
  await expect(speedCard.getByText("≈100 tok/s", { exact: true })).toBeVisible();
  await expect(latencyCard.getByText("4.7s", { exact: true })).toBeVisible();
  await expect(tokensCard.getByText("10K", { exact: true })).toBeVisible();
  await expect(costCard.getByText("$10.00", { exact: true })).toBeVisible();
  await expect(weeklyBar).toHaveAttribute("aria-valuetext", "50% · $50.00 / $100.00");

  management.overview.metrics = {
    ...management.overview.metrics,
    llm_calls: 14,
    successful_calls: 14,
    failed_calls: 0,
    token_usage: 14_500,
    prompt_tokens: 13_000,
    input_tokens: 1_000,
    reported_cache_input_tokens: 50,
    cache_read_tokens: 950,
    output_tokens: 1_500,
    total_cost: "12.50",
    priced_calls: 14,
    speed: {
      average_tokens_per_second: 149,
      output_tokens: 1_500,
      generation_ms: 10_067,
      samples: 14,
      first_output_median_ms: 4_200,
    },
  };
  management.costQuotaUsage.week = "75";

  await page.getByRole("button", { name: "Refresh", exact: true }).click();

  await expect(rollingSpan(cacheCard)).toHaveAttribute("data-rolling", "true");
  await expect(rollingSpan(cacheCard)).toHaveAttribute("data-direction", "up");
  await expect(rollingSpan(cacheCard)).toHaveAttribute("data-flash", "positive");
  await expect(cacheCard.getByTitle("Since last refresh")).toHaveText("+5.00%");

  await expect(rollingSpan(callsCard)).toHaveAttribute("data-rolling", "true");
  await expect(rollingSpan(callsCard)).toHaveAttribute("data-direction", "up");
  await expect(rollingSpan(callsCard)).toHaveAttribute("data-flash", "active");
  await expect(callsCard.getByTitle("Since last refresh")).toHaveText("+4");

  await expect(rollingSpan(speedCard)).toHaveAttribute("data-rolling", "true");
  await expect(rollingSpan(speedCard)).toHaveAttribute("data-direction", "up");
  await expect(rollingSpan(speedCard)).toHaveAttribute("data-flash", "positive");
  await expect(speedCard.getByTitle("Since last refresh")).toHaveText("+49");

  await expect(rollingSpan(latencyCard)).toHaveAttribute("data-rolling", "true");
  await expect(rollingSpan(latencyCard)).toHaveAttribute("data-direction", "down");
  await expect(rollingSpan(latencyCard)).toHaveAttribute("data-flash", "positive");
  await expect(latencyCard.getByTitle("Since last refresh")).toHaveText("−0.5s");

  await expect(rollingSpan(tokensCard)).toHaveAttribute("data-rolling", "true");
  await expect(rollingSpan(tokensCard)).toHaveAttribute("data-direction", "up");
  await expect(rollingSpan(tokensCard)).toHaveAttribute("data-flash", "active");
  await expect(tokensCard.getByTitle("Since last refresh")).toHaveText("+4.5K");

  await expect(rollingSpan(costCard)).toHaveAttribute("data-rolling", "true");
  await expect(rollingSpan(costCard)).toHaveAttribute("data-direction", "up");
  await expect(rollingSpan(costCard)).toHaveAttribute("data-flash", "attention");
  await expect(costCard.getByTitle("Since last refresh")).toHaveText("+$2.50");

  await expect(weeklyBar).toHaveAttribute("aria-valuetext", "75% · $75.00 / $100.00");
  await expect(weeklyBar.locator("[data-level]")).toHaveAttribute("data-level", "warning");
  await expect(weeklyBar.locator("[data-pulse]")).toHaveAttribute("data-pulse", "up");

  await page.clock.runFor(700);
  await expect(cacheCard.locator("[data-rolling]")).toHaveCount(0);
  await expect(costCard.locator("[data-rolling]")).toHaveCount(0);
  await expect(cacheCard.getByText("95.00%", { exact: true })).toBeVisible();
  await expect(callsCard.getByText("14", { exact: true })).toBeVisible();
  await expect(speedCard.getByText("≈149 tok/s", { exact: true })).toBeVisible();
  await expect(latencyCard.getByText("4.2s", { exact: true })).toBeVisible();
  await expect(tokensCard.getByText("14.5K", { exact: true })).toBeVisible();
  await expect(costCard.getByText("$12.50", { exact: true })).toBeVisible();

  await page.clock.runFor(600);
  await expect(metrics.locator("[data-flash]")).toHaveCount(0);

  await page.clock.runFor(3_000);
  await expect(metrics.getByTitle("Since last refresh")).toHaveCount(0);
});

test("rolls smoothly without alert flashes or loading flicker across currency and filter changes", async ({ page, management }) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1_000));

  management.settings.home_motion_mode = "on";
  management.settings.home_auto_refresh_enabled = false;
  management.settings.cny_rate = "7";
  management.exchangeRateSync.auto_sync_enabled = false;
  management.overview.metrics = {
    ...management.overview.metrics,
    llm_calls: 10,
    successful_calls: 10,
    token_usage: 10_000,
    total_cost: "10",
    priced_calls: 10,
  };

  await page.goto("#/");
  const metrics = page.getByRole("region", { name: "Call statistics", exact: true });
  const costCard = metrics.getByRole("article").filter({ hasText: "Estimated cost" });
  const callsCard = metrics.getByRole("article").filter({ hasText: "LLM calls" });
  await expect(rollingSpan(costCard)).toHaveAttribute("data-rolling", "true");
  await page.clock.runFor(800);
  await expect(costCard.getByText("$10.00", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Display currency", exact: true }).click();
  await page.getByRole("option", { name: /^CNY ·/ }).click();

  await expect(rollingSpan(costCard)).toHaveAttribute("data-rolling", "true");
  await expect(costCard.locator("[data-flash]")).toHaveCount(0);
  await expect(metrics.getByTitle("Since last refresh")).toHaveCount(0);

  await page.clock.runFor(700);
  await expect(costCard.getByText("¥70.00", { exact: true })).toBeVisible();

  let releaseWeek!: () => void;
  const pendingWeek = new Promise<void>((resolve) => {
    releaseWeek = resolve;
  });
  await page.route("**/__byok-api__/api/overview*", async (route) => {
    await pendingWeek;
    await route.fulfill({
      json: {
        ...management.overview,
        metrics: {
          ...management.overview.metrics,
          llm_calls: 42,
          successful_calls: 42,
          token_usage: 88_000,
          total_cost: "25",
        },
      },
    });
  });

  try {
    await page.getByRole("button", { name: "Last week", exact: true }).click();
    await expect(callsCard.getByText("10", { exact: true })).toBeVisible();
    await expect(metrics.getByText("…")).toHaveCount(0);
  } finally {
    releaseWeek();
  }

  await expect(rollingSpan(callsCard)).toHaveAttribute("data-rolling", "true");
  await expect(metrics.locator("[data-flash]")).toHaveCount(0);
  await expect(metrics.getByTitle("Since last refresh")).toHaveCount(0);

  await page.clock.runFor(700);
  await expect(callsCard.getByText("42", { exact: true })).toBeVisible();
  await expect(costCard.getByText("¥175.00", { exact: true })).toBeVisible();
});

test("disables rolling digits, flashes, and progress transitions when motion is off or reduced", async ({ page, management }) => {
  management.settings.home_motion_mode = "off";
  management.settings.home_auto_refresh_enabled = false;
  management.settings.cost_quotas.week = { amount: "100", currency: "USD" };
  management.costQuotaUsage.week = "25";
  management.overview.metrics = {
    ...management.overview.metrics,
    llm_calls: 5,
    successful_calls: 5,
    token_usage: 5_000,
    total_cost: "5",
    priced_calls: 5,
  };
  management.overview.activity_series = [{ date: "2026-11-25", token_usage: 5_000, total_cost: "5" }];

  await page.goto("#/");
  const metrics = page.getByRole("region", { name: "Call statistics", exact: true });
  const costCard = metrics.getByRole("article").filter({ hasText: "Estimated cost" });
  const weeklyBar = page.getByRole("progressbar", { name: "Weekly quota" });
  const fill = weeklyBar.locator("[data-level]");

  await expect(costCard.getByText("$5.00", { exact: true })).toBeVisible();
  await expect(fill).toHaveAttribute("data-animate", "false");
  await expect(fill).toHaveCSS("animation-name", "none");
  await expect(fill).toHaveCSS("transition-duration", "0s");

  management.overview.metrics = {
    ...management.overview.metrics,
    llm_calls: 8,
    successful_calls: 8,
    token_usage: 9_000,
    total_cost: "8.50",
  };
  management.costQuotaUsage.week = "60";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();

  await expect(costCard.getByText("$8.50", { exact: true })).toBeVisible();
  await expect(metrics.locator("[data-rolling]")).toHaveCount(0);
  await expect(metrics.locator("[data-flash]")).toHaveCount(0);
  await expect(costCard.getByTitle("Since last refresh")).toHaveAttribute("data-animate", "false");
  await expect(costCard.getByTitle("Since last refresh")).toHaveCSS("animation-name", "none");
  await expect(weeklyBar).toHaveAttribute("aria-valuetext", "60% · $60.00 / $100.00");

  await page.emulateMedia({ reducedMotion: "reduce" });
  management.settings.home_motion_mode = "system";
  await page.goto("#/settings");
  await page.goto("#/");
  await expect(fill).toHaveAttribute("data-animate", "false");
  await expect(metrics.locator("[data-rolling]")).toHaveCount(0);
});
