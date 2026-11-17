import { test, expect } from "./fixtures";
import type { ModelConnectivityResult, Provider } from "../../src/shared/api";

const result: ModelConnectivityResult = { duration_ms: 2000, generation_ms: 1000, first_output_ms: 500, output_tokens: 101, overall_tokens_per_second: 50.5, overall_reason: null, tokens_per_second: 100, speed_status: "estimated", speed_reason: null, output: "first last" };

test.beforeEach(async ({ management }) =>
{
  const provider: Provider = { provider_id: "batch-provider", sort_order: 0, name: "Batch provider", type: "openai", base_url: "https://provider.example", use_full_url: false, api_key: "test-key", openai_endpoint: "/v1/responses", custom_headers_enabled: false, custom_headers: {}, extra_params_enabled: false, extra_params: {}, created_at_ms: 1, updated_at_ms: 1 };
  management.providers.push(provider);
  for (const [sort_order, model_hash] of ["first", "second", "third"].entries())
  {
    management.models.push({ ...provider, model_hash, sort_order, provider_name: provider.name, model_id: model_hash, display_name: model_hash, tooltip_data: provider.name, reasoning_effort: null, context_window_tokens: null, max_output_tokens: null, anthropic_thinking_effort: null, thinking_budget_tokens: null });
  }
});

test("batch waits for each response, continues after errors, and explains estimated speed", async ({ page }) =>
{
  const started: string[] = [];
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) =>
  {
    releaseFirst = resolve;
  });
  await page.route("**/__byok-api__/api/models/*/test/*", async (route) =>
  {
    const hash = new URL(route.request().url()).pathname.split("/").at(-3)!;
    started.push(hash);
    if (hash === "first")
    {
      await first;
      await route.fulfill({ status: 502, json: { message: "test upstream unavailable" } });
      return;
    }
    await route.fulfill({ json: result });
  });
  await page.goto("#/harness/cursor");
  await page.getByRole("button", { name: "Test all", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cancel all tests", exact: true })).toBeVisible();
  await expect.poll(() => started).toEqual(["first"]);
  await expect(page.getByRole("button", { name: "Test", exact: true }).first()).toBeDisabled();
  releaseFirst();
  await expect(page.getByRole("button", { name: "Test all", exact: true })).toBeEnabled();
  expect(started).toEqual(["first", "second", "third"]);
  const speed = page.getByText("Generation speed ≈100 tok/s", { exact: true }).first();
  await speed.hover();
  await expect(page.getByRole("tooltip")).toContainText("End-to-end speed: 51 tok/s");
  await expect(page.getByRole("tooltip")).toContainText("the first chunk may contain multiple tokens");
  await expect(page.getByRole("tooltip")).toContainText("Single test result");
});

test("cancel all stops queued models even when the active response arrives late", async ({ page }) =>
{
  const started: string[] = [];
  let releaseFirst!: () => void;
  let cancelled = false;
  const first = new Promise<void>((resolve) =>
  {
    releaseFirst = resolve;
  });
  await page.route("**/__byok-api__/api/models/*/test/*", async (route) =>
  {
    if (route.request().method() === "DELETE")
    {
      cancelled = true;
      releaseFirst();
      await route.fulfill({ status: 204 });
      return;
    }
    started.push(new URL(route.request().url()).pathname.split("/").at(-3)!);
    await first;
    await route.fulfill({ json: result }).catch((error: unknown) =>
    {
      if (!cancelled)
      {
        throw error;
      }
    });
  });
  await page.goto("#/harness/cursor");
  await page.getByRole("button", { name: "Test all", exact: true }).click();
  await expect.poll(() => started).toEqual(["first"]);
  await page.getByRole("button", { name: "Cancel all tests", exact: true }).click();
  await expect.poll(() => cancelled).toBe(true);
  await expect(page.getByRole("button", { name: "Test all", exact: true })).toBeEnabled();
  expect(started).toEqual(["first"]);
  await expect(page.getByText("Test cancelled", { exact: true }).first()).toBeVisible();
});
