import type { Locator } from "@playwright/test";
import type { OverviewFilterSupplier, OverviewModelSummary } from "../../src/shared/api";
import { test, expect } from "./fixtures";

async function selectProviderIcon(input: Locator, name: string, content: number | number[] | string)
{
  await input.evaluate((element, { name, content }) =>
  {
    const bytes = typeof content === "number" ? new Uint8Array(content) : Uint8Array.from(typeof content === "string" ? Array.from(atob(content), (character) => character.charCodeAt(0)) : content);
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], name, { type: "image/png" }));
    (element as HTMLInputElement).files = transfer.files;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, { name, content });
}

test("previews, stores, and resets provider icons across model views", async ({ page, management }) =>
{
  await page.goto("#/harness/cursor");
  await page.getByTitle("Add provider", { exact: true }).click();
  const add = page.getByRole("dialog", { name: "Add provider", exact: true });
  const address = add.getByLabel("Server address", { exact: true });
  await add.getByLabel("Provider name", { exact: true }).fill("Gateway");
  await add.getByPlaceholder("sk-xxxxxx", { exact: true }).fill("test-placeholder");
  await address.fill("https://api.deepseek.com.example");
  await expect(add.getByText("Auto-match · Generic icon")).toBeVisible();
  await address.fill("https://api.deepseek.com/v1");
  await expect(add.getByText("Auto-match · DeepSeek")).toBeVisible();
  await add.getByRole("button", { name: "Change icon" }).click();
  await add.getByRole("button", { name: "OpenAI", exact: true }).press("Escape");
  await expect(add.getByRole("button", { name: "Change icon" })).toBeFocused();
  await add.getByRole("button", { name: "Change icon" }).click();
  await add.getByRole("button", { name: "OpenAI", exact: true }).click();
  await address.fill("https://api.anthropic.com");
  await expect(add.getByText("OpenAI", { exact: true })).toBeVisible();
  await add.getByRole("button", { name: "Save", exact: true }).click();
  await expect(add).toBeHidden();
  expect(management.providers[0].icon).toBe("openai");

  const providerCard = page.locator('[data-provider-id="smoke-provider"]');
  const editProvider = providerCard.getByRole("button", { name: "Add model", exact: true }).locator("..").getByRole("button", { name: "Edit", exact: true });
  await editProvider.click();
  const edit = page.getByRole("dialog", { name: "Edit provider", exact: true });
  await edit.getByRole("button", { name: "Change icon" }).click();
  await edit.getByRole("button", { name: "Use automatic matching" }).click();
  await expect(edit.getByText("Auto-match · Anthropic (Claude)")).toBeVisible();
  await edit.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(management.providers[0].icon).toBe("openai");

  await editProvider.click();
  await edit.getByRole("button", { name: "Change icon" }).click();
  const file = edit.locator('input[type="file"]');
  await selectProviderIcon(file, "oversized.png", 2 * 1024 * 1024 + 1);
  await expect(edit.getByRole("alert")).toHaveText("The image must be 2 MB or smaller");
  await selectProviderIcon(file, "invalid.png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  await expect(edit.getByRole("alert")).toHaveText("Could not read the image");
  await expect(edit.getByText("OpenAI", { exact: true }).first()).toBeVisible();

  const image = await page.evaluate(() =>
  {
    const decode = window.createImageBitmap.bind(window);
    window.createImageBitmap = async (source) =>
    {
      await new Promise<void>((resolve) => window.addEventListener("release-provider-icon", () => resolve(), { once: true }));
      return decode(source);
    };
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 8;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#f00";
    context.fillRect(0, 0, 16, 8);
    return canvas.toDataURL().split(",")[1];
  });
  await selectProviderIcon(file, "logo.png", image);
  await expect(edit.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  const providerName = edit.getByLabel("Provider name", { exact: true });
  await providerName.fill("Renamed gateway");
  await page.evaluate(() => window.dispatchEvent(new Event("release-provider-icon")));
  await expect(edit.getByText("Custom icon", { exact: true })).toBeVisible();
  await expect(providerName).toBeFocused();

  const providerRoute = "**/api/providers/smoke-provider";
  let releaseSave!: () => void;
  const pendingSave = new Promise<void>((resolve) => { releaseSave = resolve; });
  await page.route(providerRoute, async (route) => {
    await pendingSave;
    await route.fallback();
  });
  try
  {
    await edit.getByRole("button", { name: "Change icon" }).click();
    await edit.getByRole("button", { name: "Save", exact: true }).click();
    await expect(edit.getByRole("button", { name: "Processing…", exact: true })).toBeDisabled();
    await expect(edit.getByRole("button", { name: "Change icon" })).toBeDisabled();
    await expect(edit.getByRole("button", { name: "Use automatic matching" })).toBeDisabled();
    await expect(edit.getByRole("button", { name: "OpenAI", exact: true })).toBeDisabled();
    await expect(edit.getByRole("button", { name: "Upload image", exact: true })).toBeDisabled();
    await expect(file).toBeDisabled();
  }
  finally
  {
    releaseSave();
  }
  await expect(edit).toBeHidden();
  await page.unroute(providerRoute);
  const saved = management.providers[0];
  expect(saved.name).toBe("Renamed gateway");
  expect(saved.icon).toMatch(/^data:image\/png;base64,/);
  const png = new DataView(Uint8Array.from(atob(saved.icon!.split(",")[1]), (character) => character.charCodeAt(0)).buffer);
  expect([png.getUint32(16), png.getUint32(20)]).toEqual([96, 96]);

  await page.reload();
  await expect(providerCard.locator("img")).toHaveAttribute("src", saved.icon!);
  await providerCard.getByRole("button", { name: "Add model", exact: true }).click();
  const model = page.getByRole("dialog", { name: "Add model", exact: true });
  await expect(model.getByRole("button", { name: "Provider", exact: true }).locator("img")).toHaveAttribute("src", saved.icon!);
  await model.getByRole("button", { name: "Request format", exact: true }).click();
  await page.getByRole("option", { name: "Anthropic Messages", exact: true }).click();
  await model.getByPlaceholder("claude-opus-4-6", { exact: true }).fill("custom-model");
  await model.getByLabel("Display name", { exact: true }).fill("Custom model");
  await model.getByRole("button", { name: "Save", exact: true }).click();
  await expect(model).toBeHidden();

  management.providers.push({ ...saved, provider_id: "second-provider", icon: "gemini" });
  management.models.push({ ...management.models[0], provider_id: "second-provider", model_hash: "second-model", display_name: "Second model", model_id: "second-model" });
  management.settings.theme = "default-light";
  await page.goto("#/settings");
  await page.reload();
  const commit = page.getByText("Commit Message Model Settings", { exact: true }).locator("xpath=ancestor::section[1]");
  await commit.getByRole("button", { name: "Edit", exact: true }).click();
  await commit.getByRole("button", { name: /Generation model/ }).click();
  const models = page.getByRole("listbox", { name: "Generation model", exact: true });
  await expect(models.getByRole("option").first()).toHaveText("Direct");
  await expect(models.getByText("Renamed gateway", { exact: true })).toHaveCount(2);
  await expect(models.locator("img").first()).toHaveAttribute("src", saved.icon!);
  await expect(models.locator("img").nth(1)).toHaveAttribute("src", /gemini/);
  await page.keyboard.press("Escape");

  await page.goto("#/harness/cursor");
  await editProvider.click();
  await edit.getByRole("button", { name: "Change icon" }).click();
  await edit.getByRole("button", { name: "Use automatic matching" }).click();
  await edit.getByRole("button", { name: "Save", exact: true }).click();
  await expect(edit).toBeHidden();
  expect(management.providers[0].icon).toBeNull();
});

test("uses the endpoint brand and updates overview supplier icons after saving an override", async ({ page, management }) =>
{
  const base = "https://ark.cn-beijing.volces.com/api/coding";
  const endpoint = base + "/v1/messages";
  const providerId = "overview-provider";
  const supplier: OverviewFilterSupplier = { supplier_id: "builtin::provider::overview-provider", provider_id: providerId, source_kind: "builtin", endpoint_key: endpoint, label: "Volcengine", provider_type: "anthropic", plugin_icon: null, active: true, model_count: 1 };
  management.providers.push({ provider_id: providerId, sort_order: 1, name: "Volcengine", icon: null, base_url: base, api_key: "test-placeholder", custom_headers_enabled: false, custom_headers: {}, created_at_ms: 1, updated_at_ms: 1 });
  management.overview.suppliers = [{ ...management.overview.metrics, ...supplier, pricing_sources: [] }];
  management.overview.available_suppliers = [supplier];
  management.overview.available_models = [{ supplier_key: "ark-model", source_kind: supplier.source_kind, endpoint_key: endpoint, model_id: "ark-code-latest", label: "Ark Code", group: supplier.label, provider_type: supplier.provider_type, plugin_icon: null, active: true }];

  await page.goto("#/");
  await page.getByRole("tab", { name: /^Provider/ }).click();
  const row = page.getByRole("table", { name: "Statistics by provider" }).getByRole("row").filter({ hasText: "Volcengine" });
  await expect(row.locator("img")).toHaveAttribute("src", /huoshan/);

  await page.getByRole("button", { name: /^Filter providers:/ }).click();
  await expect(page.getByRole("option", { name: /Volcengine/ }).locator("img")).toHaveAttribute("src", /huoshan/);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Custom", exact: true }).click();
  await page.getByRole("button", { name: /Filter.*Model/ }).click();
  await expect(page.getByRole("option", { name: "Ark Code" }).locator("img")).toHaveAttribute("src", /huoshan/);
  await page.keyboard.press("Escape");

  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle r="8" cx="10" cy="10" fill="red"/></svg>';
  await page.route("**/api/providers/icon", (route) => route.fulfill({ json: { image: "data:image/svg+xml;base64," + btoa(svg) } }));
  await page.goto("#/harness/cursor");
  await page.locator('[data-provider-id="overview-provider"]').getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit provider", exact: true });
  await dialog.getByRole("button", { name: "Change icon" }).click();
  await dialog.getByRole("button", { name: "Fetch from upstream" }).click();
  await expect(dialog.getByText("Custom icon", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  const saved = management.providers[0].icon;
  expect(saved).toMatch(/^data:image\/png;base64,/);

  await page.goto("#/");
  await page.getByRole("tab", { name: /^Provider/ }).click();
  await expect(row.locator("img")).toHaveAttribute("src", saved!);
  await page.getByRole("button", { name: /^Filter providers:/ }).click();
  await expect(page.getByRole("option", { name: /Volcengine/ }).locator("img")).toHaveAttribute("src", saved!);
});

test("shows a recognized deleted provider by its brand name in history and the supplier filter", async ({ page, management }) =>
{
  const host = "ark.cn-beijing.volces.com";
  const endpoint = "https://" + host;
  const supplier: OverviewFilterSupplier = { supplier_id: "builtin::host::" + host, provider_id: null, source_kind: "builtin", endpoint_key: endpoint, label: host, provider_type: "anthropic", plugin_icon: null, active: false, model_count: 1 };
  management.overview.suppliers = [{ ...management.overview.metrics, ...supplier, pricing_sources: ["catalog"] }];
  management.overview.available_suppliers = [supplier];

  await page.goto("#/");
  await page.getByRole("tab", { name: /^Provider/ }).click();
  const row = page.getByRole("table", { name: "Statistics by provider" }).getByRole("row").filter({ hasText: "火山引擎" });
  await expect(row.getByText("火山引擎", { exact: true })).toHaveAttribute("title", endpoint);
  await expect(row.getByText("Historical", { exact: true })).toBeVisible();
  await expect(row.getByText(endpoint, { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: /^Filter providers:/ }).click();
  await expect(page.getByRole("option", { name: /火山引擎/ })).toBeVisible();
});

test("previews an upstream SVG as a local PNG and ignores a result for a changed address", async ({ page, management }) =>
{
  let finishLookup!: () => void;
  const pendingLookup = new Promise<void>((resolve) => { finishLookup = resolve; });
  const lookups: unknown[] = [];
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><rect width="64" height="32" fill="red"/></svg>';
  const image = 'data:image/svg+xml;base64,' + btoa(svg);
  await page.route("**/api/providers/icon", async (route) => {
    lookups.push(route.request().postDataJSON());
    await pendingLookup;
    await route.fulfill({ json: { image } });
  });

  await page.goto("#/harness/cursor");
  await page.getByTitle("Add provider", { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add provider", exact: true });
  const address = dialog.getByLabel("Server address", { exact: true });
  await dialog.getByLabel("Provider name", { exact: true }).fill("Relay");
  await dialog.getByPlaceholder("sk-xxxxxx", { exact: true }).fill("test-placeholder");
  await address.fill("https://api.example.com/v1?example=value");
  await dialog.getByRole("button", { name: "Change icon" }).click();
  const fetchIcon = dialog.getByRole("button", { name: "Fetch from upstream" });
  try
  {
    await fetchIcon.click();
    await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await address.fill("https://relay.example.org/openai/v1");
  }
  finally
  {
    finishLookup();
  }
  await expect(dialog.getByRole("alert")).toHaveText("The server address changed. Fetch the icon again.");
  await fetchIcon.click();
  await expect(dialog.getByText("Custom icon", { exact: true })).toBeVisible();
  expect(lookups).toEqual([{ base_url: "https://api.example.com" }, { base_url: "https://relay.example.org" }]);
  expect(management.providers).toHaveLength(0);

  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  const saved = management.providers[0];
  expect(saved.icon).toMatch(/^data:image\/png;base64,/);
  const png = new DataView(Uint8Array.from(atob(saved.icon!.split(",")[1]), (character) => character.charCodeAt(0)).buffer);
  expect([png.getUint32(16), png.getUint32(20)]).toEqual([96, 96]);
  await page.reload();
  await expect(page.locator('[data-provider-id="smoke-provider"] img')).toHaveAttribute("src", saved.icon!);
});

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
  expect(management.providers[0]).toMatchObject({ name: "Smoke provider", base_url: "https://provider.example" });

  await page.getByTitle("Add model", { exact: true }).click();
  const modelDialog = page.getByRole("dialog", { name: "Add model", exact: true });
  await modelDialog.getByRole("button", { name: "Request format", exact: true }).click();
  await page.getByRole("option", { name: "OpenAI Responses", exact: true }).click();
  await modelDialog.getByPlaceholder("gpt-5", { exact: true }).fill("smoke-model");
  await modelDialog.getByLabel("Display name", { exact: true }).fill("Smoke model");
  await modelDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(modelDialog).toBeHidden();
  await expect(page.getByText("Smoke model", { exact: true })).toBeVisible();
  expect(management.models[0]).toMatchObject({ provider_id: "smoke-provider", model_id: "smoke-model", display_name: "Smoke model", tooltip_data: "Smoke provider", request_format: "openai-responses" });
  await page.getByTitle("Add model", { exact: true }).click();
  await modelDialog.getByRole("button", { name: "Request format", exact: true }).click();
  await page.getByRole("option", { name: "Anthropic Messages", exact: true }).click();
  await modelDialog.getByLabel("Complete request URL", { exact: true }).fill("https://provider.example/edge/messages?route=tools");
  await modelDialog.getByRole("button", { name: "Fetch models", exact: true }).click();
  await page.getByRole("option", { name: "discovered-claude", exact: true }).click();
  expect(management.writes).toContainEqual({
    path: "/providers/smoke-provider/discover",
    body: { request_format: "anthropic", request_url_override: "https://provider.example/edge/messages?route=tools" },
  });
  await modelDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(modelDialog).toBeHidden();

  await page.getByRole("button", { name: "By format", exact: true }).click();
  await expect(page.getByText("OpenAI Responses", { exact: true })).toBeVisible();
  await expect(page.getByText("Anthropic Messages", { exact: true })).toBeVisible();
  const claude = page.locator('[data-model-hash="smoke-model-1"]');
  await claude.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect.poll(() => management.models.length).toBe(3);
  expect(management.models[2]).toMatchObject({ request_format: "anthropic", request_url_override: "https://provider.example/edge/messages?route=tools" });

  await claude.getByRole("button", { name: "Edit", exact: true }).click();
  const editDialog = page.getByRole("dialog", { name: "Edit model", exact: true });
  await expect(editDialog.getByRole("button", { name: "Request format", exact: true })).toContainText("Anthropic Messages");
  await editDialog.getByLabel("Complete request URL", { exact: true }).clear();
  await editDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editDialog).toBeHidden();
  await expect.poll(() => management.models[1].request_url_override).toBeNull();

  await page.getByTitle("Add model", { exact: true }).click();
  await modelDialog.getByRole("button", { name: "Request format", exact: true }).click();
  await page.getByRole("option", { name: "Gemini", exact: true }).click();
  await expect(modelDialog.getByRole("button", { name: "Request format", exact: true })).toContainText("Gemini");
  await modelDialog.getByPlaceholder("gemini-2.5-flash", { exact: true }).fill("gemini-model");
  await modelDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(modelDialog).toBeHidden();
  expect(management.models[3]).toMatchObject({ provider_id: "smoke-provider", request_format: "gemini", model_id: "gemini-model", request_url_override: null });
  await expect(page.getByText("Gemini", { exact: true })).toBeVisible();

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

test("controls overview polling independently of update animations", async ({ page, management }) =>
{
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1_000));
  await page.goto("#/settings");

  const motion = page.getByRole("button", { name: "Overview animations", exact: true });
  const autoRefresh = page.getByRole("checkbox", { name: "Auto-refresh", exact: true });
  const interval = page.getByRole("textbox", { name: "Overview auto-refresh interval (seconds)", exact: true });
  await motion.click();
  await page.getByRole("option", { name: "Off", exact: true }).click();
  await autoRefresh.press("Space");
  await expect.poll(() => management.settings.home_motion_mode).toBe("off");
  await expect.poll(() => management.settings.home_auto_refresh_enabled).toBe(false);
  await expect(interval).toBeDisabled();

  await page.reload();
  await expect(autoRefresh).not.toBeChecked();
  await expect(interval).toHaveValue("30");
  let overviewRequests = 0;
  page.on("requestfinished", (request) =>
  {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/api/overview") && url.searchParams.has("start_ms"))
    {
      overviewRequests += 1;
    }
  });

  await page.goto("#/");
  const calls = page.getByRole("article").filter({ hasText: "LLM calls" });
  await expect(calls.getByText("1", { exact: true })).toBeVisible();
  const initialRequests = overviewRequests;
  management.overview.metrics.llm_calls = 4;
  await page.clock.runFor(60_000);
  expect(overviewRequests).toBe(initialRequests);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const delta = calls.getByTitle("Since last refresh");
  await expect(calls.getByText("4", { exact: true })).toBeVisible();
  await expect(delta).toHaveText("+3");
  await expect(delta).toHaveCSS("animation-name", "none");
  await page.clock.runFor(4_000);
  await expect(delta).toHaveCount(0);

  await page.goto("#/settings");
  await motion.click();
  await page.getByRole("option", { name: "Follow system", exact: true }).click();
  await autoRefresh.press("Space");
  await expect.poll(() => management.settings.home_motion_mode).toBe("system");
  await expect.poll(() => management.settings.home_auto_refresh_enabled).toBe(true);
  await expect(interval).toBeEnabled();
  await page.emulateMedia({ reducedMotion: "reduce" });

  const beforeReturn = overviewRequests;
  await page.goto("#/");
  await expect.poll(() => overviewRequests).toBeGreaterThan(beforeReturn);
  await expect(delta).toHaveCount(0);
  management.overview.metrics.llm_calls = 3;
  await page.clock.runFor(30_000);
  await expect(delta).toHaveText("−1");
  await expect(delta).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(delta).toHaveAttribute("data-animate", "true");
});

test("refreshes call history at the saved interval while the page is active", async ({ page, management }) =>
{
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1_000));
  await page.goto("#/settings");
  const interval = page.getByRole("spinbutton", { name: "Call history auto-refresh interval (seconds)", exact: true });
  await expect(interval).toHaveValue("5");
  await interval.fill("4");
  await interval.press("Enter");
  expect(management.writes).toEqual([]);
  await interval.fill("10");
  await interval.press("Enter");
  await expect.poll(() => management.settings.calls_refresh_interval_seconds).toBe(10);
  await expect(page.getByText("Call history auto-refresh interval saved", { exact: true })).toBeVisible();

  let callsRequests = 0;
  page.on("requestfinished", (request) =>
  {
    if (new URL(request.url()).pathname.endsWith("/api/llm-calls"))
    {
      callsRequests += 1;
    }
  });
  await page.goto("#/calls");
  await expect.poll(() => callsRequests).toBe(1);
  await page.clock.runFor(9_999);
  expect(callsRequests).toBe(1);
  await page.clock.runFor(1);
  await expect.poll(() => callsRequests).toBe(2);

  await page.goto("#/settings");
  await expect(interval).toBeVisible();
  await page.clock.runFor(10_000);
  expect(callsRequests).toBe(2);
  await page.reload();
  await expect(interval).toHaveValue("10");
});

test("stores each display currency rate independently and shares selection with the overview", async ({ page, management }) =>
{
  await page.goto("#/settings");
  const currency = page.getByRole("button", { name: "Display currency", exact: true });
  const choose = async (code: string) =>
  {
    await currency.click();
    await page.getByRole("option", { name: new RegExp(`^${code} ·`) }).click();
  };

  await currency.click();
  for (const code of ["USD", "CNY", "EUR", "JPY", "TWD", "TRY", "KRW"])
  {
    await expect(page.getByRole("option", { name: new RegExp(`^${code} ·`) })).toBeAttached();
  }
  await currency.press("Escape");

  await choose("EUR");
  await page.getByRole("button", { name: "Manual", exact: true }).click();
  const euroRate = page.getByRole("textbox", { name: "EUR exchange rate" });
  await expect(euroRate).toHaveValue("0.9099");
  await expect(page.getByText(/0\.9099 EUR.*2026-11-20/)).toBeVisible();
  await euroRate.fill("0");
  await euroRate.press("Enter");
  await expect(euroRate).toHaveAttribute("aria-invalid", "true");
  await euroRate.fill("0.9200");
  await euroRate.press("Enter");
  await expect(euroRate).toHaveValue("0.92");
  await expect.poll(() => management.settings.eur_rate).toBe("0.92");

  await choose("JPY");
  const yenRate = page.getByRole("textbox", { name: "JPY exchange rate" });
  await expect(yenRate).toHaveValue("158.64");
  await yenRate.fill("150");
  await yenRate.press("Enter");
  await expect.poll(() => management.settings.jpy_rate).toBe("150");
  await page.reload();
  await expect(yenRate).toHaveValue("150");

  await page.goto("#/");
  await expect(currency).toHaveText(/JPY/);
  await choose("EUR");
  await expect.poll(() => management.settings.currency).toBe("EUR");
  await page.goto("#/settings");
  await expect(euroRate).toHaveValue("0.92");
  await page.getByRole("button", { name: "Restore default", exact: true }).click();
  await expect(euroRate).toHaveValue("0.9099");
  await expect(page.getByText(/0\.9099 EUR.*2026-11-20/)).toBeVisible();
  expect(management.settings.jpy_rate).toBe("150");
});

test("switches between synced and saved exchange rates across overview and call details", async ({ page, management }) =>
{
  management.settings.currency = "EUR";
  management.overview.metrics.total_cost = "2";
  management.overview.metrics.priced_calls = 1;
  management.call.call.cost_status = "priced";
  management.call.call.total_cost = "2";
  const detail = await page.context().newPage();
  await page.goto("#/settings");
  await detail.goto("#/calls/smoke-call");
  await expect(detail.getByText("€1.8198", { exact: true })).toBeVisible();

  const automatic = page.getByRole("button", { name: "Automatic", exact: true });
  const manual = page.getByRole("button", { name: "Manual", exact: true });
  const rate = page.getByRole("textbox", { name: "EUR exchange rate" });
  const sync = page.getByRole("button", { name: "Sync exchange rates now" });
  await expect(automatic).toHaveAttribute("aria-pressed", "true");
  await expect(rate).toHaveCount(0);
  await sync.click();
  await expect(page.getByText("Exchange rate sync failed. Existing rates are still in use.")).toBeVisible();

  management.nextExchangeRateSnapshot = { source: "exchange_rate_api", published_at_ms: Date.UTC(2026, 10, 23), rates: { EUR: "0.95", CNY: "6.7", JPY: "158", TWD: "33", TRY: "50", KRW: "1340" } };
  await sync.click();
  await manual.click();
  await expect(manual).toHaveAttribute("aria-pressed", "true");
  await expect(rate).toHaveValue("0.95");
  await expect(sync).toHaveCount(0);
  expect(management.settings.eur_rate).toBeNull();
  await page.goto("#/");
  await expect(page.getByText("€1.90", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Display currency", exact: true })).toContainText("0.95");
  await detail.bringToFront();
  await detail.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(detail.getByText("€1.90", { exact: true })).toBeVisible();

  await page.bringToFront();
  await page.goto("#/settings");
  await rate.fill("0.5");
  await rate.press("Enter");
  await expect.poll(() => management.settings.eur_rate).toBe("0.5");
  await automatic.click();
  management.nextExchangeRateSnapshot.rates.EUR = "0.96";
  await sync.click();
  await expect(page.getByText(/Converted at the synced rate.*0\.96 EUR/)).toBeVisible();
  await expect(rate).toHaveCount(0);
  await page.goto("#/");
  await expect(page.getByText("€1.92", { exact: true }).first()).toBeVisible();
  await detail.bringToFront();
  await detail.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(detail.getByText("€1.92", { exact: true })).toBeVisible();

  await page.bringToFront();
  await page.goto("#/settings");
  await manual.click();
  await expect(rate).toHaveValue("0.5");
  await page.goto("#/");
  await expect(page.getByText("€1.00", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Display currency", exact: true })).toContainText("0.50");
  await detail.bringToFront();
  await detail.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(detail.getByText("€1.00", { exact: true })).toBeVisible();
  await page.bringToFront();
  await page.goto("#/settings");
  await page.getByRole("button", { name: "Restore default", exact: true }).click();
  await expect(rate).toHaveValue("0.96");
  await expect(page.getByText(/Converted at the synced rate.*0\.96 EUR/)).toBeVisible();
  await detail.close();
});

test("collapses the sidebar at minimum window size and remembers the choice with save rollback", async ({ page, management }) =>
{
  await page.setViewportSize({ width: 820, height: 558 });
  const imageUrl = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  await page.route("**/__byok-api__/api/promotions*", (route) => route.fulfill({ json: { slots: [{
    id: "sidebar-ad", enabled: true, placement: "menu",
    target: { title: "Sidebar example", description: "Example description", imageUrl },
    content: { title: "Sidebar promotion", description: "Example content", imageUrl, details: [], button: { label: "Open", action: { type: "open_browser", url: "https://example.com" } } },
  }] } }));
  await page.route("**/__byok-api__/api/promotions/sidebar-ad/dismissals", (route) => route.fulfill({ status: 204 }));
  await page.goto("#/");

  const collapse = page.getByRole("button", { name: "Collapse sidebar", exact: true });
  const expand = page.getByRole("button", { name: "Expand sidebar", exact: true });
  const navigation = page.locator("#main-navigation");
  const sidebar = page.locator("aside").filter({ has: navigation });
  const main = page.getByRole("main");
  const overview = navigation.getByRole("link", { name: "Overview", exact: true });
  const calls = navigation.getByRole("link", { name: "Call history", exact: true });
  await expect(sidebar).toHaveCSS("width", "204px");
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await expect(overview.getByText("Overview", { exact: true })).toBeVisible();
  const expandedContentWidth = (await main.boundingBox())!.width;

  await collapse.press("Enter");
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar).toHaveCSS("width", "56px");
  await expect.poll(async () => (await main.boundingBox())!.width).toBe(expandedContentWidth + 148);
  await expect(overview.getByText("Overview", { exact: true })).toBeHidden();
  await expect(overview).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("Tab");
  await expect(overview).toBeFocused();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toHaveText("Overview");
  await expect.poll(async () => (await tooltip.boundingBox())!.x).toBeGreaterThan((await sidebar.boundingBox())!.x + 56);
  await page.keyboard.press("Escape");
  await expect(tooltip).toBeHidden();
  await navigation.getByRole("link", { name: /^Cursor/ }).hover();
  await expect(tooltip).toHaveText("Cursor · Not taken over");

  const promotion = navigation.getByRole("button", { name: /^Sidebar example/ });
  await expect(promotion.getByText("Sidebar example")).toHaveCount(0);
  await promotion.click();
  await expect(page.getByRole("dialog", { name: "Sidebar promotion" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(promotion).toBeFocused();
  await page.mouse.move(400, 200);
  await page.keyboard.press("Tab");
  const dismiss = navigation.getByRole("button", { name: /^Hide ad/ });
  await expect(dismiss).toBeFocused();
  await dismiss.press("Enter");
  const dismissal = page.getByRole("alertdialog", { name: "Do not show this ad again" });
  await dismissal.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(promotion).toHaveCount(0);

  await calls.click();
  await expect(calls).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeInViewport();
  await expect.poll(() => management.settings.sidebar_collapsed).toBe(true);
  await page.reload();
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect(calls).toHaveAttribute("aria-current", "page");

  let failSave!: () => void;
  const saveResponse = new Promise<void>((resolve) =>
  {
    failSave = resolve;
  });
  await page.route("**/__byok-api__/api/settings/interface", async (route) =>
  {
    if (route.request().method() !== "PUT")
    {
      await route.fallback();
      return;
    }
    await saveResponse;
    await route.fulfill({ status: 500, json: { message: "Sidebar preference could not be saved." } });
  });
  await expand.press("Space");
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  failSave();
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("status").getByText("Sidebar preference could not be saved.")).toBeVisible();
  expect(management.settings.sidebar_collapsed).toBe(true);
});

test("shows approximate speed when generation speed is unavailable", async ({ page, management }) =>
{
  const base = management.call.call;
  const records = [
    { ...base, call_id: "generation-speed", display_name: "Generation sample", performance: { ...base.performance, speed_status: "estimated" } },
    { ...base, call_id: "overall-speed", display_name: "Short tool output", performance: { ...base.performance, tokens_per_second: null, speed_status: "unavailable", reason: "short_generation", overall_tokens_per_second: 35, generation_ms: 4 } },
    { ...base, call_id: "no-speed", status: "error", display_name: "Failed sample", performance: { ...base.performance, tokens_per_second: null, speed_status: "unavailable", reason: "not_completed", overall_tokens_per_second: null, overall_reason: "not_completed", generation_ms: null } },
  ];
  await page.route("**/__byok-api__/api/llm-calls?*", (route) => route.fulfill({ json: { items: records, total: records.length } }));
  await page.goto("#/calls");
  const header = page.getByRole("columnheader", { name: "Speed (tok/s)", exact: true });
  const speedIndex = await header.evaluate((cell: HTMLTableCellElement) => cell.cellIndex);
  const speedCell = (name: string) => page.getByRole("row", { name }).getByRole("cell").nth(speedIndex);
  await expect(speedCell("Generation sample")).toHaveText("≈100");
  await expect(speedCell("Short tool output")).toHaveText("≈35");
  await expect(speedCell("Short tool output")).toHaveAttribute("title", /4ms/);
  await expect(speedCell("Failed sample")).toHaveText("—");
});

test("keeps the call table compact in call history and overview", async ({ page, management }) =>
{
  await page.setViewportSize({ width: 1280, height: 800 });
  const records = Array.from({ length: 24 }, (_, index) => ({ ...management.call.call, call_id: `smoke-call-${index}` }));
  await page.route("**/__byok-api__/api/llm-calls?*", (route) => route.fulfill({ json: { items: records, total: records.length } }));
  const table = page.getByRole("table").filter({ has: page.getByRole("columnheader", { name: "Speed (tok/s)", exact: true }) });
  const dimensions = async () =>
  {
    await expect(table.locator("tbody tr").first()).toBeVisible();
    return table.evaluate((element: HTMLTableElement) =>
    {
      const header = element.tHead!.rows[0];
      const row = element.tBodies[0].rows[0];
      const viewport = element.parentElement!.parentElement!;
      return { headerFont: getComputedStyle(header.cells[0]).fontSize, rowFont: getComputedStyle(row.cells[0]).fontSize, headerHeight: header.getBoundingClientRect().height, rowHeight: row.getBoundingClientRect().height, tableWidth: element.scrollWidth, visibleRows: Math.floor((viewport.clientHeight - header.getBoundingClientRect().height) / row.getBoundingClientRect().height) };
    });
  };

  await page.goto("#/calls");
  const history = await dimensions();
  expect(history).toMatchObject({ headerFont: "12px", rowFont: "12px", headerHeight: 30, rowHeight: 32, visibleRows: expect.any(Number) });
  expect(history.visibleRows).toBeGreaterThanOrEqual(20);
  expect(history.tableWidth).toBeLessThan(3600);

  await page.goto("#/");
  await page.getByRole("tab", { name: /^Calls/ }).click();
  const overview = await dimensions();
  expect(overview).toMatchObject({ headerFont: history.headerFont, rowFont: history.rowFont, headerHeight: history.headerHeight, rowHeight: history.rowHeight });
});

test("leads with status, call index and time, and explains status dots in a tooltip", async ({ page, management }) =>
{
  const base = management.call.call;
  const records = [
    { ...base, call_id: "completed-call", provider_call_index: 3, display_name: "Success sample", status: "completed", http_status: 200, finish_reason: "stop", created_at_ms: Date.UTC(2026, 10, 23, 9, 12, 34) },
    { ...base, call_id: "failed-call", provider_call_index: 2, display_name: "Failure sample", status: "error", http_status: 502, finish_reason: null, error_kind: "upstream_error", error_message: "upstream returned 502", created_at_ms: Date.UTC(2026, 10, 23, 9, 11, 34) },
    { ...base, call_id: "running-call", provider_call_index: 1, display_name: "Running sample", status: "running", http_status: null, finish_reason: null, created_at_ms: Date.UTC(2026, 10, 23, 9, 10, 34) },
  ];
  await page.route("**/__byok-api__/api/llm-calls?*", (route) => route.fulfill({ json: { items: records, total: records.length } }));
  await page.goto("#/calls");

  const headers = await page.getByRole("columnheader").allTextContents();
  expect(headers.slice(0, 4)).toEqual(["Status", "Call Index", "Time", "Display name"]);

  const rows = page.locator("tbody tr");
  const timeCell = rows.nth(0).getByRole("cell").nth(2);
  await expect(timeCell).toHaveText(/^\d{1,2}:\d{2}:\d{2}[\s\u202f]?[AP]M$/i);
  expect(await timeCell.getAttribute("title")).toContain("11/23/2026");

  const completedDot = rows.nth(0).locator("span[data-status]");
  const failedDot = rows.nth(1).locator("span[data-status]");
  const runningDot = rows.nth(2).locator("span[data-status]");
  await expect(completedDot).toHaveAttribute("data-status", "completed");
  await expect(failedDot).toHaveAttribute("data-status", "error");
  await expect(runningDot).toHaveAttribute("data-status", "running");
  const animation = async (locator: typeof completedDot) => locator.evaluate((element) => getComputedStyle(element).animationName);
  expect(await animation(completedDot)).toBe("none");
  expect(await animation(failedDot)).toBe("none");
  expect(await animation(runningDot)).not.toBe("none");
  await failedDot.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText("HTTP 502");
  await expect(tooltip).toContainText("upstream returned 502");
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

test("shows up to seven trend groups ranked by the selected metric", async ({ page, management }) =>
{
  const start = Date.UTC(2026, 10, 25);
  const bucket = {
    bucket_start_ms: start, input_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0,
    input_cost: "20", output_cost: "0", cache_read_cost: "0", cache_write_cost: "0", total_cost: "20",
    priced_calls: 8, unpriced_calls: 0, incomplete_usage_calls: 0, unreported_cache_calls: 0,
    assumed_cache_calls: 0, assumed_cache_cost: "0", estimated_cache_read_tokens: 0,
  };
  const models = Array.from({ length: 8 }, (_, index) => ({
    id: `trend-model-${index + 1}`,
    label: `Trend model ${index + 1}`,
    token_rank: index < 7 ? index + 1 : null,
    cost_rank: index > 0 ? 8 - index : null,
    buckets: [{ bucket_start_ms: start, token_usage: 8 - index, total_cost: String(index + 1) }],
  }));
  const suppliers = [{ id: "trend-provider", label: "Trend provider", token_rank: 1, cost_rank: 1, buckets: [{ bucket_start_ms: start, token_usage: 36, total_cost: "36" }] }];
  management.overview.token_usage_series = [bucket, { ...bucket, bucket_start_ms: start + 3_600_000 }];
  management.overview.trend_breakdown = { models, suppliers };

  await page.goto("#/");
  const grouping = page.getByRole("group", { name: "Trend grouping", exact: true });
  await expect(grouping.getByRole("button", { name: "Total", exact: true })).toHaveAttribute("aria-pressed", "true");
  await grouping.getByRole("button", { name: "Model", exact: true }).click();
  const modelLabels = page.getByRole("listitem").filter({ hasText: /^Trend model \d+$/ });
  await expect(modelLabels).toHaveText(["Trend model 1", "Trend model 2", "Trend model 3", "Trend model 4", "Trend model 5", "Trend model 6", "Trend model 7"]);

  await page.getByRole("group", { name: "Chart metric", exact: true }).getByRole("button", { name: "Cost", exact: true }).click();
  await expect(modelLabels).toHaveText(["Trend model 8", "Trend model 7", "Trend model 6", "Trend model 5", "Trend model 4", "Trend model 3", "Trend model 2"]);

  await page.getByRole("group", { name: "Trend chart type", exact: true }).getByRole("button", { name: "Line", exact: true }).click();
  await grouping.getByRole("button", { name: "Provider", exact: true }).click();
  await expect(page.getByText("Trend provider", { exact: true })).toBeVisible();
  await expect(modelLabels).toHaveCount(0);
  await grouping.getByRole("button", { name: "Total", exact: true }).click();
  await expect(page.getByText("Trend provider", { exact: true })).toHaveCount(0);
});

test("switches overview activity chart between heatmap, bar, and line across week, month, and year", async ({ page, management }) =>
{
  management.exchangeRateSync.auto_sync_enabled = false;
  management.settings.eur_rate = "0.9";
  const activitySeries = Array.from({ length: 45 }, (_, index) =>
  {
    const date = new Date(Date.UTC(2026, 9, 5 + index)).toISOString().slice(0, 10);
    return {
      date,
      token_usage: index % 4 === 0 ? 0 : (index + 1) * 1000,
      total_cost: index === 42 ? "12" : index === 43 ? "18" : index % 4 === 0 ? "0" : "3",
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
  await expect(yearSection.getByText("Total cost", { exact: true })).toBeVisible();
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
  await expect(weekSection.getByText("$30.00", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Display currency", exact: true }).click();
  await page.getByRole("option", { name: /^EUR ·/ }).click();
  await expect(weekSection.getByText("€27.00", { exact: true })).toBeVisible();
  await expect.poll(() => management.settings.currency).toBe("EUR");
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

  await page.setViewportSize({ width: 820, height: 558 });
  const lineChart = yearSection.getByRole("img", { name: "Token usage line chart for the past year", exact: true }).locator("canvas");
  await expect(lineChart).toBeVisible();
  const expandedChartWidth = (await lineChart.boundingBox())!.width;
  await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await expect.poll(async () => (await lineChart.boundingBox())?.width ?? 0).toBeGreaterThan(expandedChartWidth);
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

test("shows cache hit rate and orders average cost before estimated cost in the model breakdown", async ({ page, management }) =>
{
  const base: Omit<OverviewModelSummary, "model_id"> = {
    supplier_count: 1,
    pricing_sources: ["catalog"],
    llm_calls: 4,
    successful_calls: 4,
    failed_calls: 0,
    token_usage: 400_000,
    prompt_tokens: 300_000,
    input_tokens: 100_000,
    cache_read_tokens: 200_000,
    cache_write_tokens: 0,
    output_tokens: 100_000,
    total_cost: "0.5",
    input_cost: "0.1",
    output_cost: "0.4",
    cache_read_cost: "0",
    cache_write_cost: "0",
    average_priced_cost: "0.125",
    priced_calls: 4,
    unpriced_calls: 0,
    incomplete_usage_calls: 0,
    unreported_cache_calls: 0,
    assumed_cache_calls: 0,
    assumed_cache_cost: "0",
    estimated_cache_read_tokens: 0,
    speed: { average_tokens_per_second: 100, output_tokens: 100_000, generation_ms: 1_000_000, samples: 4, first_output_median_ms: 100 },
  };
  management.overview.models = [
    { ...base, model_id: "reported-model" },
    { ...base, model_id: "unreported-model", cache_read_tokens: 0, unreported_cache_calls: 4 },
  ];
  await page.goto("#/");
  await page.getByRole("tab", { name: /^Model/ }).click();

  const table = page.getByRole("table", { name: "Statistics by model", exact: true });
  await expect(table).toBeVisible();
  const headers = (await table.getByRole("columnheader").allTextContents()).slice(-5)
    .map((text) => text.replace(/[↕↑↓]/g, "").trim());
  expect(headers).toEqual(["Input", "Cache hit rate", "Output", "Avg / call", "Estimated cost"]);
  await expect(table.getByRole("row", { name: /^reported-model/ }).getByRole("cell").nth(7)).toHaveText("66.7%");
  await expect(table.getByRole("row", { name: /^unreported-model/ }).getByRole("cell").nth(7)).toHaveText("—");
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
    total_cost: "0",
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
      position: {
        scrollTop: vertical?.scrollTop ?? 0,
        scrollLeft: horizontal?.scrollLeft ?? 0,
      },
      maxScrollTop: vertical ? vertical.scrollHeight - vertical.clientHeight : 0,
      viewportWidth: vertical?.clientWidth ?? 0,
    };
  });
  const readPosition = async () => (await readScroll()).position;

  await page.evaluate(() => {
    const vertical = [...document.querySelectorAll("*")].find((el) => {
      const style = getComputedStyle(el);
      return (style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight;
    });
    const horizontal = [...document.querySelectorAll("*")].find((el) => el.scrollWidth > el.clientWidth + 100);
    if (vertical) vertical.scrollTop = vertical.scrollHeight;
    if (horizontal) horizontal.scrollLeft = 800;
  });

  await expect.poll(async () => (await readPosition()).scrollTop).toBeGreaterThan(300);
  const initial = await readPosition();
  expect(initial.scrollLeft).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
  await expect(page.getByText("scroll-call-20", { exact: true })).toBeVisible();
  expect(await readPosition()).toEqual(initial);

  await page.getByRole("button", { name: "Items per page", exact: true }).click();
  await page.getByRole("option", { name: "50 per page", exact: true }).click();
  await expect(page.getByText("Page 1 of 1", { exact: true })).toBeVisible();
  await expect(page.getByText("scroll-call-44", { exact: true })).toBeVisible();
  expect(await readPosition()).toEqual(initial);

  await page.getByRole("button", { name: "Last calendar day", exact: true }).click();
  await expect(page.getByRole("button", { name: "Last calendar day", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await readPosition()).toEqual(initial);

  await page.getByRole("link", { name: "Call history", exact: true }).click();
  await expect(page.getByText("scroll-call-0", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page.getByText("scroll-call-44", { exact: true })).toBeVisible();
  await expect.poll(readPosition).toEqual(initial);

  const beforeCollapse = await readScroll();
  await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await expect.poll(async () => {
    const afterCollapse = await readScroll();
    const heightChange = afterCollapse.maxScrollTop - beforeCollapse.maxScrollTop;
    const positionChange = afterCollapse.position.scrollTop - beforeCollapse.position.scrollTop;
    return afterCollapse.viewportWidth > beforeCollapse.viewportWidth && positionChange >= Math.min(0, heightChange) && positionChange <= Math.max(0, heightChange);
  }).toBe(true);
});
