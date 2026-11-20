import { useSyncExternalStore } from "react";
import {
  applyLocalePreference,
  getLocalePreference,
  type LocalePreference,
} from "../../i18n/store";
import {
  api,
  type CursorHarnessStatus,
  type InterfaceSettings,
  type InterfaceSettingsPatch,
  type LlmCall,
  type Model,
  type ModelInput,
  type Overview,
  type OverviewCalendarChartType,
  type OverviewCalendarWindow,
  type OverviewChartMode,
  type OverviewChartType,
  type OverviewRangePresetOption,
  type PluginDescriptor,
  type PluginRuntimeStatus,
  type PortSettings,
  type PricingSettings,
  type PricingSyncState,
  type Provider,
  type ProviderInput,
  type SaveSupplierPricingInput,
  type SpeedAggregate,
  type SupplierPricingView,
} from "../api";
import { applyTheme, type ThemeId } from "../theme/theme";
import { normalizeExchangeRate, type DisplayCurrency } from "../utils/costFormat";
import type { CustomRange } from "../utils/timeRange";

export type {
  OverviewCalendarChartType,
  OverviewCalendarWindow,
  OverviewChartMode,
  OverviewChartType,
  OverviewRangePresetOption,
} from "../api";
export type OverviewRangePresetValue = OverviewRangePresetOption | "custom";
export type OverviewQuickPresetValue = "four-hours" | "twenty-four-hours";

export const DEFAULT_HOME_REFRESH_INTERVAL_SECONDS = 30;

const DEFAULT_INTERFACE_SETTINGS: InterfaceSettings = {
  locale: "system",
  theme: "default-dark",
  currency: "USD",
  cny_rate: null,
  overview_range_preset: "month",
  overview_chart_mode: "tokens",
  overview_chart_type: "bar",
  overview_calendar_window: "year",
  overview_calendar_chart_type: "heatmap",
  home_refresh_interval_seconds: DEFAULT_HOME_REFRESH_INTERVAL_SECONDS,
};

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
  customRange: CustomRange | null;
  suppliers: string[];
  models: string[];
  nonce: number;
};

export type AppSnapshot = {
  providers: Provider[];
  models: Model[];
  calls: LlmCall[];
  callsTotal: number;
  overview: Overview;
  detailed: boolean;
  ports: PortSettings;
  pricingModels: SupplierPricingView[];
  pricingSettings: PricingSettings | null;
  pricingSync: PricingSyncState | null;
  busy: boolean;
  error: string | null;
  theme: ThemeId;
  currency: DisplayCurrency;
  cnyRate: string | null;
  overviewRangePreset: OverviewRangePresetOption;
  overviewChartMode: OverviewChartMode;
  overviewChartType: OverviewChartType;
  overviewCalendarWindow: OverviewCalendarWindow;
  overviewCalendarChartType: OverviewCalendarChartType;
  homeRefreshIntervalSeconds: number;
  refreshTick: number;
  pendingCallsFilter: CallsFilterHandoff | null;
  cursorHarness: CursorHarnessStatus | null;
  cursorBusy: boolean;
  pluginRuntime: PluginRuntimeStatus | null;
  plugins: PluginDescriptor[];
};

const emptySpeed = (): SpeedAggregate => ({
  average_tokens_per_second: null,
  output_tokens: 0,
  generation_ms: 0,
  samples: 0,
  first_output_median_ms: null,
});

let handoffSeed = 0;
let persistedInterface: InterfaceSettings = { ...DEFAULT_INTERFACE_SETTINGS };
let interfaceRevision = 0;
let pendingInterfaceWrites = 0;
let interfaceWriteQueue: Promise<void> = Promise.resolve();

let snapshot: AppSnapshot = {
  providers: [],
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
      reported_cache_input_tokens: 0,
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
      unreported_cache_calls: 0,
      assumed_cache_calls: 0,
      assumed_cache_cost: "0",
      estimated_cache_read_tokens: 0,
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
  pricingSettings: null,
  pricingSync: null,
  busy: false,
  error: null,
  theme: DEFAULT_INTERFACE_SETTINGS.theme,
  currency: DEFAULT_INTERFACE_SETTINGS.currency,
  cnyRate: DEFAULT_INTERFACE_SETTINGS.cny_rate,
  overviewRangePreset: DEFAULT_INTERFACE_SETTINGS.overview_range_preset,
  overviewChartMode: DEFAULT_INTERFACE_SETTINGS.overview_chart_mode,
  overviewChartType: DEFAULT_INTERFACE_SETTINGS.overview_chart_type,
  overviewCalendarWindow: DEFAULT_INTERFACE_SETTINGS.overview_calendar_window,
  overviewCalendarChartType: DEFAULT_INTERFACE_SETTINGS.overview_calendar_chart_type,
  homeRefreshIntervalSeconds: DEFAULT_INTERFACE_SETTINGS.home_refresh_interval_seconds,
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

function applyInterfaceSettings(
  next: InterfaceSettings,
  options?: { forceApplyTheme?: boolean; forceApplyLocale?: boolean; extra?: Partial<AppSnapshot> },
) {
  const themeChanged = options?.forceApplyTheme || snapshot.theme !== next.theme;
  const localeChanged = options?.forceApplyLocale || getLocalePreference() !== next.locale;
  persistedInterface = next;
  if (themeChanged) applyTheme(next.theme);
  if (localeChanged) applyLocalePreference(next.locale);
  update({
    theme: next.theme,
    currency: next.currency,
    cnyRate: next.cny_rate,
    overviewRangePreset: next.overview_range_preset,
    overviewChartMode: next.overview_chart_mode,
    overviewChartType: next.overview_chart_type,
    overviewCalendarWindow: next.overview_calendar_window,
    overviewCalendarChartType: next.overview_calendar_chart_type,
    homeRefreshIntervalSeconds: next.home_refresh_interval_seconds,
    ...options?.extra,
  });
}

function enqueueInterfaceWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = interfaceWriteQueue.then(task);
  interfaceWriteQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function persistInterfacePatch(
  patch: InterfaceSettingsPatch,
  options: { optimistic: boolean },
): Promise<InterfaceSettings | null> {
  const revision = interfaceRevision + 1;
  interfaceRevision = revision;
  pendingInterfaceWrites += 1;

  if (options.optimistic) {
    const optimisticPatch: Partial<AppSnapshot> = { error: null };
    if (patch.theme !== undefined) {
      if (snapshot.theme !== patch.theme) applyTheme(patch.theme);
      optimisticPatch.theme = patch.theme;
    }
    if (patch.locale !== undefined && getLocalePreference() !== patch.locale) {
      applyLocalePreference(patch.locale);
    }
    if (patch.currency !== undefined) optimisticPatch.currency = patch.currency;
    if (patch.cny_rate !== undefined) optimisticPatch.cnyRate = patch.cny_rate;
    if (patch.overview_range_preset !== undefined) {
      optimisticPatch.overviewRangePreset = patch.overview_range_preset;
    }
    if (patch.overview_chart_mode !== undefined) optimisticPatch.overviewChartMode = patch.overview_chart_mode;
    if (patch.overview_chart_type !== undefined) optimisticPatch.overviewChartType = patch.overview_chart_type;
    if (patch.overview_calendar_window !== undefined) {
      optimisticPatch.overviewCalendarWindow = patch.overview_calendar_window;
    }
    if (patch.overview_calendar_chart_type !== undefined) {
      optimisticPatch.overviewCalendarChartType = patch.overview_calendar_chart_type;
    }
    if (patch.home_refresh_interval_seconds !== undefined) {
      optimisticPatch.homeRefreshIntervalSeconds = patch.home_refresh_interval_seconds;
    }
    update(optimisticPatch);
  } else {
    update({ error: null });
  }

  try {
    const saved = await enqueueInterfaceWrite(() => api.updateInterfaceSettings(patch));
    // Every successful response advances the rollback state, even when newer writes are queued.
    persistedInterface = saved;
    if (interfaceRevision === revision) {
      applyInterfaceSettings(saved);
    }
    return saved;
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    if (interfaceRevision === revision) {
      applyInterfaceSettings(persistedInterface, { extra: { error } });
    } else {
      update({ error });
    }
    return null;
  }
  finally
  {
    pendingInterfaceWrites -= 1;
  }
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

  async hydrateInterfaceSettings() {
    const revisionBefore = interfaceRevision;
    // A read started during a write can return stale settings after that write completes.
    const canApplyInterfaceSettings = pendingInterfaceWrites === 0;
    try {
      const settings = await api.interfaceSettings();
      if (canApplyInterfaceSettings && interfaceRevision === revisionBefore)
      {
        applyInterfaceSettings(settings, {
          forceApplyTheme: true,
          forceApplyLocale: true,
        });
        return;
      }
    } catch {
      // Keep default theme and system locale when management API is unreachable; refresh() surfaces errors.
    }
    applyTheme(snapshot.theme);
    applyLocalePreference(getLocalePreference());
  },

  async refresh() {
    update({ busy: true, error: null });
    const interfaceRevisionBefore = interfaceRevision;
    const canApplyInterfaceSettings = pendingInterfaceWrites === 0;
    const pricingSettingsBefore = snapshot.pricingSettings;
    try {
      const [providers, models, callsResult, overview, settings, ports, interfaceSettings, pricingModels, pricingSettings, pricingSync, cursorHarness, pluginRuntime, plugins] = await Promise.all([
        api.providers(),
        api.models(),
        api.calls({ limit: 20, offset: 0 }),
        api.overview(),
        api.observability(),
        api.ports(),
        api.interfaceSettings(),
        api.pricingModels(),
        api.pricingSettings(),
        api.pricingSync(),
        api.cursorHarness(),
        api.pluginRuntime(),
        api.plugins(),
      ]);
      const patch: Partial<AppSnapshot> = {
        providers,
        models,
        calls: callsResult.items,
        callsTotal: callsResult.total,
        overview,
        detailed: settings.detailed,
        ports,
        pricingModels,
        pricingSettings: snapshot.pricingSettings === pricingSettingsBefore ? pricingSettings : snapshot.pricingSettings,
        pricingSync,
        cursorHarness,
        pluginRuntime,
        plugins,
        refreshTick: snapshot.refreshTick + 1,
      };
      if (canApplyInterfaceSettings && interfaceRevision === interfaceRevisionBefore)
      {
        applyInterfaceSettings(interfaceSettings, { extra: patch });
      } else {
        update(patch);
      }
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      update({ busy: false });
    }
  },

  async createProvider(provider: ProviderInput) {
    update({ cursorBusy: true, error: null });
    try {
      const created = await api.createProvider(provider);
      await appStore.refresh();
      return created;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    } finally { update({ cursorBusy: false }); }
  },
  async updateProvider(providerId: string, provider: ProviderInput) {
    update({ cursorBusy: true, error: null });
    try {
      const updated = await api.updateProvider(providerId, provider);
      await appStore.refresh();
      return updated;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    } finally { update({ cursorBusy: false }); }
  },
  async deleteProvider(providerId: string) {
    update({ cursorBusy: true, error: null });
    try {
      await api.deleteProvider(providerId);
      await appStore.refresh();
      return true;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return false;
    } finally { update({ cursorBusy: false }); }
  },
  async reorderProviders(providerIds: string[]) {
    const previousProviders = snapshot.providers;
    const previousModels = snapshot.models;
    const byId = new Map(previousProviders.map((provider) => [provider.provider_id, provider]));
    if (providerIds.length !== previousProviders.length || new Set(providerIds).size !== previousProviders.length) {
      update({ error: t("供应商配置已发生变化，请刷新后重试") });
      return false;
    }
    const reorderedProviders: Provider[] = [];
    for (const [index, providerId] of providerIds.entries()) {
      const provider = byId.get(providerId);
      if (!provider) {
        update({ error: t("供应商配置已发生变化，请刷新后重试") });
        return false;
      }
      reorderedProviders.push({ ...provider, sort_order: index + 1 });
    }
    const modelsByProvider = new Map<string, Model[]>();
    const orphanModels: Model[] = [];
    for (const model of previousModels) {
      if (byId.has(model.provider_id)) {
        const list = modelsByProvider.get(model.provider_id);
        if (list) list.push(model);
        else modelsByProvider.set(model.provider_id, [model]);
      } else {
        orphanModels.push(model);
      }
    }
    const reorderedModels = [
      ...providerIds.flatMap((providerId) => modelsByProvider.get(providerId) ?? []),
      ...orphanModels,
    ];
    update({
      providers: reorderedProviders,
      models: reorderedModels,
      cursorBusy: true,
      error: null,
    });
    try {
      const providers = await api.reorderProviders(providerIds);
      const models = await api.models();
      update({ providers, models });
      return true;
    } catch (cause) {
      update({
        providers: previousProviders,
        models: previousModels,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return false;
    } finally {
      update({ cursorBusy: false });
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
  async reorderCursorModels(providerId: string, modelHashes: string[]) {
    const previous = snapshot.models;
    const scoped = previous.filter((model) => model.provider_id === providerId);
    const byHash = new Map(scoped.map((model) => [model.model_hash, model]));
    if (modelHashes.length !== scoped.length || new Set(modelHashes).size !== scoped.length) {
      update({ error: t("模型配置已发生变化，请刷新后重试") });
      return false;
    }
    const reorderedGroup: Model[] = [];
    for (const [index, hash] of modelHashes.entries()) {
      const model = byHash.get(hash);
      if (!model) {
        update({ error: t("模型配置已发生变化，请刷新后重试") });
        return false;
      }
      reorderedGroup.push({ ...model, sort_order: index + 1 });
    }
    let cursor = 0;
    const reordered = previous.map((model) => (model.provider_id === providerId ? reorderedGroup[cursor++] : model));
    update({ models: reordered, cursorBusy: true, error: null });
    try {
      update({ models: await api.reorderModels(providerId, modelHashes) });
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
  async savePricingSettings(settings: PricingSettings)
  {
    try
    {
      update({ error: null });
      const pricingSettings = await api.savePricingSettings(settings);
      update({ pricingSettings });
      return pricingSettings;
    }
    catch (cause)
    {
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
  selectLocalePreference(locale: LocalePreference) {
    if (getLocalePreference() === locale && persistedInterface.locale === locale) return;
    void persistInterfacePatch({ locale }, { optimistic: true });
  },
  selectTheme(theme: ThemeId) {
    if (snapshot.theme === theme && persistedInterface.theme === theme) return;
    void persistInterfacePatch({ theme }, { optimistic: true });
  },
  selectCurrency(currency: DisplayCurrency) {
    if (snapshot.currency === currency && persistedInterface.currency === currency) {
      return;
    }
    void persistInterfacePatch({ currency }, { optimistic: true });
  },
  async saveCnyRate(rawRate: string): Promise<string | null> {
    const normalized = normalizeExchangeRate(rawRate);
    if (!normalized) {
      return null;
    }
    const saved = await persistInterfacePatch({ cny_rate: normalized }, { optimistic: false });
    return saved?.cny_rate ?? null;
  },
  async clearCnyRate(): Promise<InterfaceSettings | null> {
    return persistInterfacePatch({ cny_rate: null }, { optimistic: false });
  },
  selectOverviewRangePreset(overviewRangePreset: OverviewRangePresetOption) {
    if (
      snapshot.overviewRangePreset === overviewRangePreset
      && persistedInterface.overview_range_preset === overviewRangePreset
    ) {
      return;
    }
    void persistInterfacePatch({ overview_range_preset: overviewRangePreset }, { optimistic: true });
  },
  selectOverviewChartMode(overviewChartMode: OverviewChartMode) {
    if (snapshot.overviewChartMode === overviewChartMode && persistedInterface.overview_chart_mode === overviewChartMode) {
      return;
    }
    void persistInterfacePatch({ overview_chart_mode: overviewChartMode }, { optimistic: true });
  },
  selectOverviewChartType(overviewChartType: OverviewChartType) {
    if (snapshot.overviewChartType === overviewChartType && persistedInterface.overview_chart_type === overviewChartType) {
      return;
    }
    void persistInterfacePatch({ overview_chart_type: overviewChartType }, { optimistic: true });
  },
  selectOverviewCalendarWindow(overviewCalendarWindow: OverviewCalendarWindow) {
    if (
      snapshot.overviewCalendarWindow === overviewCalendarWindow
      && persistedInterface.overview_calendar_window === overviewCalendarWindow
    ) {
      return;
    }
    void persistInterfacePatch({ overview_calendar_window: overviewCalendarWindow }, { optimistic: true });
  },
  selectOverviewCalendarChartType(overviewCalendarChartType: OverviewCalendarChartType) {
    if (
      snapshot.overviewCalendarChartType === overviewCalendarChartType
      && persistedInterface.overview_calendar_chart_type === overviewCalendarChartType
    ) {
      return;
    }
    void persistInterfacePatch({ overview_calendar_chart_type: overviewCalendarChartType }, { optimistic: true });
  },
  async saveHomeRefreshIntervalSeconds(rawInterval: string | number): Promise<number | null> {
    const parsed = typeof rawInterval === "number"
      ? (Number.isSafeInteger(rawInterval) && rawInterval >= 1 ? rawInterval : null)
      : parseHomeRefreshIntervalSeconds(rawInterval);
    if (parsed === null) {
      return null;
    }
    const saved = await persistInterfacePatch({ home_refresh_interval_seconds: parsed }, { optimistic: false });
    return saved?.home_refresh_interval_seconds ?? null;
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

export function useAppStore() {
  return useSyncExternalStore(appStore.subscribe, appStore.getSnapshot);
}
