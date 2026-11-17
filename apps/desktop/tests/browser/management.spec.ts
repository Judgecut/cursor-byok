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
