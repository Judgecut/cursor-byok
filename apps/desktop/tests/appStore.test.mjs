import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

const source = stripTypeScriptTypes(await readFile(new URL("../src/shared/store/appStore.ts", import.meta.url), "utf8"));
const defaults = {
  locale: "system",
  theme: "default-dark",
  currency: "USD",
  cny_rate: null,
  overview_range_preset: "month",
  overview_chart_mode: "tokens",
  overview_chart_type: "bar",
  overview_calendar_window: "year",
  home_refresh_interval_seconds: 30,
};

function deferred()
{
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) =>
  {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function setup()
{
  let saved = { ...defaults };
  let locale = "system";
  let theme = defaults.theme;
  const writes = [];
  const api = {
    interfaceSettings: async () => ({ ...saved }),
    updateInterfaceSettings: (patch) =>
    {
      const request = deferred();
      writes.push({ ...request, patch });
      return request.promise.then((value) =>
      {
        saved = value;
        return value;
      });
    },
    providers: async () => [],
    reorderProviders: async () => [],
    models: async () => [],
    reorderModels: async () => [],
    calls: async () => ({ items: [], total: 0 }),
    overview: async () => ({}),
    observability: async () => ({ detailed: false }),
    ports: async () => ({ proxy_port: 0, service_port: 0 }),
    pricingModels: async () => [],
    pricingSync: async () => null,
    cursorHarness: async () => null,
    pluginRuntime: async () => null,
    plugins: async () => [],
  };
  const dependencies = {
    react: { useSyncExternalStore: () => undefined },
    "../../i18n/store": {
      applyLocalePreference: (value) =>
      {
        locale = value;
      },
      getLocalePreference: () => locale,
    },
    "../api": { api },
    "../theme/theme": {
      applyTheme: (value) =>
      {
        theme = value;
      },
    },
    "../utils/costFormat": {
      normalizeExchangeRate: (value) =>
      {
        const trimmed = typeof value === "string" ? value.trim() : "";
        if (!trimmed || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmed)) return null;
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) && parsed > 0 ? String(parsed) : null;
      },
    },
  };
  const context = createContext({ Error, t: (source) => source });
  const module = new SourceTextModule(source, { context });
  await module.link((specifier) =>
  {
    const exports = dependencies[specifier];
    assert.ok(exports, `Unexpected dependency: ${specifier}`);
    return new SyntheticModule(Object.keys(exports), function ()
    {
      for (const [name, value] of Object.entries(exports))
      {
        this.setExport(name, value);
      }
    }, { context });
  });
  await module.evaluate();
  const store = module.namespace.appStore;
  await store.hydrateInterfaceSettings();
  return { store, api, writes, saved: () => saved, locale: () => locale, theme: () => theme };
}

test("a failed queued save preserves an earlier successful save and allows retry", async () =>
{
  const app = await setup();
  app.store.selectTheme("default-light");
  app.store.selectOverviewChartType("line");
  await setImmediate();
  assert.equal(app.writes.length, 1);
  app.writes[0].resolve({ ...defaults, theme: "default-light" });
  await setImmediate();
  assert.equal(app.writes.length, 2);
  assert.equal(app.store.getSnapshot().overviewChartType, "line");
  app.writes[1].reject(new Error("chart save failed"));
  await setImmediate();
  assert.equal(app.store.getSnapshot().theme, app.saved().theme);
  assert.equal(app.theme(), "default-light");
  assert.equal(app.store.getSnapshot().overviewChartType, "bar");
  assert.equal(app.store.getSnapshot().error, "chart save failed");

  app.store.selectOverviewChartType("line");
  await setImmediate();
  app.writes[2].resolve({ ...app.saved(), overview_chart_type: "line" });
  await setImmediate();
  assert.equal(app.store.getSnapshot().overviewChartType, "line");
  assert.equal(app.store.getSnapshot().error, null);

  app.store.selectOverviewRangePreset("week");
  app.store.selectOverviewCalendarWindow("month");
  await setImmediate();
  assert.equal(app.store.getSnapshot().overviewRangePreset, "week");
  assert.equal(app.store.getSnapshot().overviewCalendarWindow, "month");
  app.writes[3].resolve({ ...app.saved(), overview_range_preset: "week" });
  await setImmediate();
  app.writes[4].resolve({ ...app.saved(), overview_calendar_window: "month" });
  await setImmediate();
  assert.equal(app.store.getSnapshot().overviewRangePreset, "week");
  assert.equal(app.store.getSnapshot().overviewCalendarWindow, "month");
});

for (const readMethod of ["refresh", "hydrateInterfaceSettings"])
{
  for (const readStartsBeforeWrite of [false, true])
  {
    test(`${readMethod} ignores stale settings when the read starts ${readStartsBeforeWrite ? "before" : "during"} a save`, async () =>
    {
      const app = await setup();
      const read = deferred();
      app.api.interfaceSettings = () => read.promise;
      let refresh;
      if (readStartsBeforeWrite)
      {
        refresh = app.store[readMethod]();
      }
      app.store.selectTheme("default-light");
      await setImmediate();
      if (!readStartsBeforeWrite)
      {
        refresh = app.store[readMethod]();
      }
      app.writes[0].resolve({ ...defaults, theme: "default-light" });
      await setImmediate();
      read.resolve({ ...defaults });
      await refresh;
      assert.equal(app.store.getSnapshot().theme, app.saved().theme);
      assert.equal(app.theme(), "default-light");
      if (readMethod === "refresh")
      {
        assert.equal(app.store.getSnapshot().refreshTick, 1);
      }
    });
  }
}

test("a read finishing during queued saves preserves optimistic settings", async () =>
{
  const app = await setup();
  app.store.selectTheme("default-light");
  app.store.selectLocalePreference("pt-BR");
  await setImmediate();
  await app.store.refresh();
  assert.equal(app.store.getSnapshot().theme, "default-light");
  assert.equal(app.locale(), "pt-BR");
  app.writes[0].resolve({ ...defaults, theme: "default-light" });
  await setImmediate();
  app.writes[1].resolve({ ...app.saved(), locale: "pt-BR" });
  await setImmediate();
  assert.equal(app.locale(), "pt-BR");
});

test("refresh applies external changes after saves have completed", async () =>
{
  const app = await setup();
  app.store.selectTheme("default-light");
  await setImmediate();
  app.writes[0].resolve({ ...defaults, theme: "default-light" });
  await setImmediate();
  app.api.interfaceSettings = async () => ({ ...defaults, locale: "pt-BR" });
  await app.store.refresh();
  assert.equal(app.store.getSnapshot().theme, "default-dark");
  assert.equal(app.theme(), "default-dark");
  assert.equal(app.locale(), "pt-BR");
});

test("selectCurrency allows CNY before a custom rate is configured and clearCnyRate keeps CNY", async () =>
{
  const app = await setup();
  app.store.selectCurrency("CNY");
  await setImmediate();
  assert.equal(app.store.getSnapshot().currency, "CNY");
  assert.equal(app.store.getSnapshot().cnyRate, null);
  assert.deepEqual({ ...app.writes[0].patch }, { currency: "CNY" });
  app.writes[0].resolve({ ...defaults, currency: "CNY", cny_rate: null });
  await setImmediate();
  assert.equal(app.store.getSnapshot().currency, "CNY");
  assert.equal(app.store.getSnapshot().cnyRate, null);

  assert.equal(await app.store.saveCnyRate("0"), null);
  assert.equal(await app.store.saveCnyRate("-7.2"), null);
  assert.equal(app.writes.length, 1);

  const savePromise = app.store.saveCnyRate("07.20");
  await setImmediate();
  assert.deepEqual({ ...app.writes[1].patch }, { cny_rate: "7.2" });
  app.writes[1].resolve({ ...app.saved(), cny_rate: "7.2" });
  assert.equal(await savePromise, "7.2");
  assert.equal(app.store.getSnapshot().cnyRate, "7.2");

  const clearPromise = app.store.clearCnyRate();
  await setImmediate();
  assert.deepEqual({ ...app.writes[2].patch }, { cny_rate: null });
  app.writes[2].resolve({ ...app.saved(), cny_rate: null });
  const cleared = await clearPromise;
  assert.equal(cleared?.currency, "CNY");
  assert.equal(cleared?.cny_rate, null);
  assert.equal(app.store.getSnapshot().currency, "CNY");
  assert.equal(app.store.getSnapshot().cnyRate, null);
});

test("reorderProviders optimistically regroups models, fetches sequentially, and rolls back on failure", async () => {
  const app = await setup();
  const initialProviders = [
    { provider_id: "p1", sort_order: 1, name: "P1" },
    { provider_id: "p2", sort_order: 2, name: "P2" },
  ];
  const initialModels = [
    { model_hash: "p1-a", provider_id: "p1", sort_order: 1 },
    { model_hash: "p1-b", provider_id: "p1", sort_order: 2 },
    { model_hash: "p2-a", provider_id: "p2", sort_order: 1 },
  ];
  app.api.providers = async () => initialProviders;
  app.api.models = async () => initialModels;
  await app.store.refresh();

  assert.equal(await app.store.reorderProviders(["p1"]), false);
  assert.equal(app.store.getSnapshot().error, "供应商配置已发生变化，请刷新后重试");

  const sequence = [];
  const reorderReq = deferred();
  const modelsReq = deferred();
  app.api.reorderProviders = (ids) => {
    sequence.push(`reorderProviders:${ids.join(",")}`);
    return reorderReq.promise;
  };
  app.api.models = () => {
    sequence.push("models");
    return modelsReq.promise;
  };

  const reorderPromise = app.store.reorderProviders(["p2", "p1"]);
  assert.equal(app.store.getSnapshot().cursorBusy, true);
  assert.deepEqual(
    Array.from(app.store.getSnapshot().providers, (p) => [p.provider_id, p.sort_order]),
    [["p2", 1], ["p1", 2]],
  );
  assert.deepEqual(
    Array.from(app.store.getSnapshot().models, (m) => m.model_hash),
    ["p2-a", "p1-a", "p1-b"],
  );
  assert.deepEqual(sequence, ["reorderProviders:p2,p1"]);

  const serverProviders = [
    { provider_id: "p2", sort_order: 1, name: "P2" },
    { provider_id: "p1", sort_order: 2, name: "P1" },
  ];
  const serverModels = [
    { model_hash: "p2-a", provider_id: "p2", sort_order: 1 },
    { model_hash: "p1-a", provider_id: "p1", sort_order: 1 },
    { model_hash: "p1-b", provider_id: "p1", sort_order: 2 },
  ];
  reorderReq.resolve(serverProviders);
  await setImmediate();
  assert.deepEqual(sequence, ["reorderProviders:p2,p1", "models"]);
  modelsReq.resolve(serverModels);
  assert.equal(await reorderPromise, true);
  assert.equal(app.store.getSnapshot().cursorBusy, false);
  assert.equal(app.store.getSnapshot().error, null);
  assert.deepEqual(app.store.getSnapshot().providers, serverProviders);
  assert.deepEqual(app.store.getSnapshot().models, serverModels);

  const failingReorder = deferred();
  app.api.reorderProviders = () => failingReorder.promise;
  const failPromise = app.store.reorderProviders(["p1", "p2"]);
  failingReorder.reject(new Error("provider reorder failed"));
  assert.equal(await failPromise, false);
  assert.equal(app.store.getSnapshot().cursorBusy, false);
  assert.equal(app.store.getSnapshot().error, "provider reorder failed");
  assert.deepEqual(app.store.getSnapshot().providers, serverProviders);
  assert.deepEqual(app.store.getSnapshot().models, serverModels);
});

test("reorderCursorModels scopes validation and optimistic splice to providerId and rolls back on failure", async () => {
  const app = await setup();
  const initialProviders = [
    { provider_id: "p1", sort_order: 1, name: "P1" },
    { provider_id: "p2", sort_order: 2, name: "P2" },
  ];
  const initialModels = [
    { model_hash: "p1-a", provider_id: "p1", sort_order: 1 },
    { model_hash: "p1-b", provider_id: "p1", sort_order: 2 },
    { model_hash: "p2-a", provider_id: "p2", sort_order: 1 },
  ];
  app.api.providers = async () => initialProviders;
  app.api.models = async () => initialModels;
  await app.store.refresh();

  assert.equal(await app.store.reorderCursorModels("p1", ["p1-a", "p2-a"]), false);
  assert.equal(app.store.getSnapshot().error, "模型配置已发生变化，请刷新后重试");

  const reorderReq = deferred();
  let calledWith = null;
  app.api.reorderModels = (providerId, hashes) => {
    calledWith = { providerId, hashes };
    return reorderReq.promise;
  };
  const promise = app.store.reorderCursorModels("p1", ["p1-b", "p1-a"]);
  assert.equal(app.store.getSnapshot().cursorBusy, true);
  assert.deepEqual(
    Array.from(app.store.getSnapshot().models, (m) => [m.model_hash, m.sort_order]),
    [["p1-b", 1], ["p1-a", 2], ["p2-a", 1]],
  );
  assert.deepEqual(calledWith, { providerId: "p1", hashes: ["p1-b", "p1-a"] });

  const serverModels = [
    { model_hash: "p1-b", provider_id: "p1", sort_order: 1 },
    { model_hash: "p1-a", provider_id: "p1", sort_order: 2 },
    { model_hash: "p2-a", provider_id: "p2", sort_order: 1 },
  ];
  reorderReq.resolve(serverModels);
  assert.equal(await promise, true);
  assert.equal(app.store.getSnapshot().cursorBusy, false);
  assert.deepEqual(app.store.getSnapshot().models, serverModels);

  const failingReq = deferred();
  app.api.reorderModels = () => failingReq.promise;
  const failPromise = app.store.reorderCursorModels("p1", ["p1-a", "p1-b"]);
  failingReq.reject(new Error("model reorder failed"));
  assert.equal(await failPromise, false);
  assert.equal(app.store.getSnapshot().cursorBusy, false);
  assert.equal(app.store.getSnapshot().error, "model reorder failed");
  assert.deepEqual(app.store.getSnapshot().models, serverModels);
});
