import { useSyncExternalStore } from "react";
import {
  api,
  type CursorHarnessStatus,
  type LlmCall,
  type Model,
  type ModelInput,
  type Overview,
  type PluginDescriptor,
  type PluginRuntimeStatus,
  type PortSettings,
  type PricingSyncState,
  type SaveSupplierPricingInput,
  type SpeedAggregate,
  type SupplierPricingView,
} from "../api";
import { applyTheme, isThemeId, type ThemeId } from "../theme/theme";
import { isValidExchangeRate, normalizeExchangeRate, type DisplayCurrency } from "../utils/costFormat";

export type OverviewChartMode = "tokens" | "cost";
export type OverviewChartType = "bar" | "line";
export type OverviewRangePresetValue = "ten-minutes" | "hour" | "today" | "week" | "month" | "custom";
export type OverviewQuickPresetValue = "four-hours" | "twenty-four-hours";

export const DEFAULT_HOME_REFRESH_INTERVAL_SECONDS = 30;

export function parseHomeRefreshIntervalSeconds(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return null;
  return parsed;
}

export type CallsFilterHandoff = {
  preset: OverviewRangePresetValue;
  quick: OverviewQuickPresetValue | null;
  customRange: { startMs: number; endMs: number } | null;
  customStart: string;
  customEnd: string;
  suppliers: string[];
  models: string[];
  nonce: number;
};

export type AppSnapshot = {
  models: Model[];
  calls: LlmCall[];
  callsTotal: number;
  overview: Overview;
  detailed: boolean;
  ports: PortSettings;
  pricingModels: SupplierPricingView[];
  pricingSync: PricingSyncState | null;
  busy: boolean;
  error: string | null;
  theme: ThemeId;
  currency: DisplayCurrency;
  cnyRate: string | null;
  overviewChartMode: OverviewChartMode;
  overviewChartType: OverviewChartType;
  homeRefreshIntervalSeconds: number;
  refreshTick: number;
  pendingCallsFilter: CallsFilterHandoff | null;
  cursorHarness: CursorHarnessStatus | null;
  cursorBusy: boolean;
  pluginRuntime: PluginRuntimeStatus | null;
  plugins: PluginDescriptor[];
};

const THEME_STORAGE_KEY = "cursor-byok.theme";
const CURRENCY_STORAGE_KEY = "cursor-byok.currency";
const CNY_RATE_STORAGE_KEY = "cursor-byok.cny-rate";
const CHART_MODE_STORAGE_KEY = "cursor-byok.chart-mode";
const CHART_TYPE_STORAGE_KEY = "cursor-byok.chart-type";
const HOME_REFRESH_INTERVAL_STORAGE_KEY = "cursor-byok.home-refresh-interval-seconds";

const savedTheme = (): ThemeId => {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeId(saved) ? saved : "default-dark";
  } catch {
    return "default-dark";
  }
};

const savedCnyRate = (): string | null => {
  try {
    const raw = localStorage.getItem(CNY_RATE_STORAGE_KEY);
    return raw ? normalizeExchangeRate(raw) : null;
  } catch {
    return null;
  }
};

const savedCurrency = (rate: string | null): DisplayCurrency => {
  try {
    const raw = localStorage.getItem(CURRENCY_STORAGE_KEY);
    if (raw === "CNY" && isValidExchangeRate(rate)) return "CNY";
  } catch {
    // Fallback to USD when localStorage is unavailable.
  }
  return "USD";
};

const savedChartMode = (): OverviewChartMode => {
  try {
    return localStorage.getItem(CHART_MODE_STORAGE_KEY) === "cost" ? "cost" : "tokens";
  } catch {
    return "tokens";
  }
};

const savedChartType = (): OverviewChartType => {
  try {
    return localStorage.getItem(CHART_TYPE_STORAGE_KEY) === "line" ? "line" : "bar";
  } catch {
    return "bar";
  }
};

const savedHomeRefreshIntervalSeconds = (): number => {
  try {
    const raw = localStorage.getItem(HOME_REFRESH_INTERVAL_STORAGE_KEY);
    return raw ? (parseHomeRefreshIntervalSeconds(raw) ?? DEFAULT_HOME_REFRESH_INTERVAL_SECONDS) : DEFAULT_HOME_REFRESH_INTERVAL_SECONDS;
  } catch {
    return DEFAULT_HOME_REFRESH_INTERVAL_SECONDS;
  }
};

const emptySpeed = (): SpeedAggregate => ({
  average_tokens_per_second: null,
  status: "unavailable",
  measured: { output_tokens: 0, generation_ms: 0, samples: 0 },
  estimated: { output_tokens: 0, generation_ms: 0, samples: 0 },
  first_output_median_ms: null,
});

const initialRate = savedCnyRate();
let handoffSeed = 0;

let snapshot: AppSnapshot = {
  models: [],
  calls: [],
  callsTotal: 0,
  overview: {
    metrics: {
      llm_calls: 0,
      successful_calls: 0,
      failed_calls: 0,
      token_usage: 0,
      prompt_tokens: 0,
      input_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 0,
      total_cost: "0",
      input_cost: "0",
      output_cost: "0",
      cache_read_cost: "0",
      cache_write_cost: "0",
      average_priced_cost: null,
      priced_calls: 0,
      unpriced_calls: 0,
      incomplete_usage_calls: 0,
      speed: emptySpeed(),
    },
    token_usage_granularity: "day",
    token_usage_series: [],
    activity_series: [],
    suppliers: [],
    models: [],
    available_suppliers: [],
    available_models: [],
  },
  detailed: false,
  ports: { proxy_port: 0, service_port: 0 },
  pricingModels: [],
  pricingSync: null,
  busy: false,
  error: null,
  theme: savedTheme(),
  currency: savedCurrency(initialRate),
  cnyRate: initialRate,
  overviewChartMode: savedChartMode(),
  overviewChartType: savedChartType(),
  homeRefreshIntervalSeconds: savedHomeRefreshIntervalSeconds(),
  refreshTick: 0,
  pendingCallsFilter: null,
  cursorHarness: null,
  cursorBusy: false,
  pluginRuntime: null,
  plugins: [],
};

const listeners = new Set<() => void>();

function update(patch: Partial<AppSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((listener) => listener());
}

async function perform(task: () => Promise<void>) {
  update({ error: null });
  try {
    await task();
  } catch (cause) {
    update({ error: cause instanceof Error ? cause.message : String(cause) });
  }
}

export const appStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => snapshot,

  async refresh() {
    update({ busy: true, error: null });
    try {
      const [models, callsResult, overview, settings, ports, pricingModels, pricingSync, cursorHarness, pluginRuntime, plugins] = await Promise.all([
        api.models(),
        api.calls({ limit: 20, offset: 0 }),
        api.overview(),
        api.observability(),
        api.ports(),
        api.pricingModels(),
        api.pricingSync(),
        api.cursorHarness(),
        api.pluginRuntime(),
        api.plugins(),
      ]);
      update({
        models,
        calls: callsResult.items,
        callsTotal: callsResult.total,
        overview,
        detailed: settings.detailed,
        ports,
        pricingModels,
        pricingSync,
        cursorHarness,
        pluginRuntime,
        plugins,
        refreshTick: snapshot.refreshTick + 1,
      });
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      update({ busy: false });
    }
  },

  async deleteModel(modelHash: string) {
    await perform(async () => {
      await api.deleteModel(modelHash);
      await appStore.refresh();
    });
  },

  async initializeCursorCa() {
    update({ cursorBusy: true, error: null });
    try {
      const status = await api.initializeCursorCa();
      update({ cursorHarness: status });
      return status;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    } finally { update({ cursorBusy: false }); }
  },
  async initializePluginRuntime() {
    update({ error: null });
    try {
      const pluginRuntime = await api.initializePluginRuntime();
      update({ pluginRuntime });
      return pluginRuntime;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    }
  },
  async refreshPluginRuntime() {
    try {
      const wasReady = snapshot.pluginRuntime?.state === "ready";
      const pluginRuntime = await api.pluginRuntime();
      update({ pluginRuntime });
      if (!wasReady && pluginRuntime.state === "ready") {
        const plugins = await api.plugins();
        update({ plugins });
      }
      return pluginRuntime;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    }
  },
  async cancelPluginRuntimeInitialization() {
    try {
      const pluginRuntime = await api.cancelPluginRuntimeInitialization();
      update({ pluginRuntime });
      return pluginRuntime;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    }
  },
  async refreshPlugins() {
    try {
      update({ plugins: await api.plugins() });
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  },
  async removePluginConfiguration(pluginId: string) {
    await perform(async () => {
      await api.removePluginConfiguration(pluginId);
      update({ plugins: await api.plugins() });
    });
  },
  async setCursorEnabled(enabled: boolean) {
    update({ cursorBusy: true, error: null });
    try { update({ cursorHarness: await api.setCursorEnabled(enabled) }); }
    catch (cause) { update({ error: cause instanceof Error ? cause.message : String(cause) }); }
    finally { update({ cursorBusy: false }); }
  },
  async createModels(models: ModelInput[]) {
    update({ cursorBusy: true, error: null });
    try {
      const created = await api.createModels(models);
      await appStore.refresh();
      return created;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    } finally { update({ cursorBusy: false }); }
  },
  async importV0049Models() {
    update({ cursorBusy: true, error: null });
    try {
      const result = await api.importV0049Models();
      await appStore.refresh();
      return result;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    } finally { update({ cursorBusy: false }); }
  },
  async updateCursorModel(hash: string, model: ModelInput) {
    update({ cursorBusy: true, error: null });
    try {
      const updated = await api.updateModel(hash, model);
      await appStore.refresh();
      return updated;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    } finally { update({ cursorBusy: false }); }
  },
  async reorderCursorModels(modelHashes: string[]) {
    const previous = snapshot.models;
    const byHash = new Map(previous.map((model) => [model.model_hash, model]));
    if (modelHashes.length !== previous.length || new Set(modelHashes).size !== previous.length) {
      update({ error: t("模型配置已发生变化，请刷新后重试") });
      return false;
    }
    const reordered: Model[] = [];
    for (const [index, hash] of modelHashes.entries()) {
      const model = byHash.get(hash);
      if (!model) {
        update({ error: t("模型配置已发生变化，请刷新后重试") });
        return false;
      }
      reordered.push({ ...model, sort_order: index + 1 });
    }
    update({ models: reordered, cursorBusy: true, error: null });
    try {
      update({ models: await api.reorderModels(modelHashes) });
      return true;
    } catch (cause) {
      update({
        models: previous,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return false;
    } finally {
      update({ cursorBusy: false });
    }
  },

  async openCallDetails(callId: string) {
    await perform(() => api.openCallDetails(callId));
  },
  async updateDetailed(detailed: boolean) {
    await perform(async () => update(await api.setObservability(detailed)));
  },
  async updatePorts(ports: PortSettings) {
    try {
      update({ error: null });
      update({ ports: await api.setPorts(ports) });
      return true;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return false;
    }
  },
  async refreshPricing() {
    try {
      const [pricingModels, pricingSync, overview, callsResult] = await Promise.all([
        api.pricingModels(),
        api.pricingSync(),
        api.overview(),
        api.calls({ limit: 20, offset: 0 }),
      ]);
      update({
        pricingModels,
        pricingSync,
        overview,
        calls: callsResult.items,
        callsTotal: callsResult.total,
      });
      return pricingSync;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    }
  },
  async refreshPricingSyncOnly() {
    try {
      const pricingSync = await api.pricingSync();
      update({ pricingSync });
      return pricingSync;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    }
  },
  async savePricingModel(input: SaveSupplierPricingInput) {
    try {
      update({ error: null });
      const saved = await api.savePricingModel(input);
      await appStore.refreshPricing();
      return saved;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    }
  },
  async setPricingAutoSync(enabled: boolean) {
    try {
      update({ error: null });
      const pricingSync = await api.setPricingAutoSync(enabled);
      update({ pricingSync });
      return pricingSync;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    }
  },
  async syncPricingNow() {
    try {
      update({ error: null });
      const pricingSync = await api.syncPricingNow();
      update({ pricingSync });
      await appStore.refreshPricing();
      return pricingSync;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    }
  },
  selectTheme(theme: ThemeId) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Theme still applies for the current session when storage is unavailable.
    }
    applyTheme(theme);
    update({ theme });
  },
  selectCurrency(currency: DisplayCurrency): boolean {
    if (currency === "CNY" && !isValidExchangeRate(snapshot.cnyRate)) {
      return false;
    }
    try {
      localStorage.setItem(CURRENCY_STORAGE_KEY, currency);
    } catch {
      // Currency still updates in memory for the active session.
    }
    update({ currency });
    return true;
  },
  setCnyRate(rawRate: string): string | null {
    const trimmed = rawRate.trim();
    if (!trimmed) {
      try {
        localStorage.removeItem(CNY_RATE_STORAGE_KEY);
        if (snapshot.currency === "CNY") localStorage.setItem(CURRENCY_STORAGE_KEY, "USD");
      } catch {
        // Ignore storage restrictions.
      }
      update({
        cnyRate: null,
        currency: "USD",
      });
      return null;
    }
    const normalized = normalizeExchangeRate(trimmed);
    if (!normalized) {
      return null;
    }
    try {
      localStorage.setItem(CNY_RATE_STORAGE_KEY, normalized);
    } catch {
      // Ignore storage restrictions.
    }
    update({ cnyRate: normalized });
    return normalized;
  },
  selectOverviewChartMode(overviewChartMode: OverviewChartMode) {
    try {
      localStorage.setItem(CHART_MODE_STORAGE_KEY, overviewChartMode);
    } catch {
      // Ignore storage restrictions.
    }
    update({ overviewChartMode });
  },
  selectOverviewChartType(overviewChartType: OverviewChartType) {
    try {
      localStorage.setItem(CHART_TYPE_STORAGE_KEY, overviewChartType);
    } catch {
      // Ignore storage restrictions.
    }
    update({ overviewChartType });
  },
  setHomeRefreshIntervalSeconds(rawInterval: string | number): number | null {
    const parsed = typeof rawInterval === "number"
      ? (Number.isSafeInteger(rawInterval) && rawInterval >= 1 ? rawInterval : null)
      : parseHomeRefreshIntervalSeconds(rawInterval);
    if (parsed === null) {
      return null;
    }
    try {
      localStorage.setItem(HOME_REFRESH_INTERVAL_STORAGE_KEY, String(parsed));
    } catch {
      // Setting remains active in memory for the current session when storage is unavailable.
    }
    update({ homeRefreshIntervalSeconds: parsed });
    return parsed;
  },
  handoffCallsFilter(filter: Omit<CallsFilterHandoff, "nonce">) {
    handoffSeed += 1;
    update({
      pendingCallsFilter: {
        ...filter,
        suppliers: [...filter.suppliers],
        models: [...filter.models],
        nonce: handoffSeed,
      },
    });
  },
  consumeCallsFilter(nonce: number) {
    if (snapshot.pendingCallsFilter?.nonce === nonce) {
      update({ pendingCallsFilter: null });
    }
  },
};

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === THEME_STORAGE_KEY) {
      const nextTheme = savedTheme();
      applyTheme(nextTheme);
      update({ theme: nextTheme });
    } else if (event.key === CNY_RATE_STORAGE_KEY || event.key === CURRENCY_STORAGE_KEY) {
      const nextRate = savedCnyRate();
      const nextCurrency = savedCurrency(nextRate);
      update({ cnyRate: nextRate, currency: nextCurrency });
    } else if (event.key === CHART_MODE_STORAGE_KEY) {
      update({ overviewChartMode: savedChartMode() });
    } else if (event.key === CHART_TYPE_STORAGE_KEY) {
      update({ overviewChartType: savedChartType() });
    } else if (event.key === HOME_REFRESH_INTERVAL_STORAGE_KEY) {
      update({ homeRefreshIntervalSeconds: savedHomeRefreshIntervalSeconds() });
    }
  });
}

export function useAppStore() {
  return useSyncExternalStore(appStore.subscribe, appStore.getSnapshot);
}
