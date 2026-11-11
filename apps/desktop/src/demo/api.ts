import type {
  CallDetail,
  CallListResult,
  CallPerformance,
  CatalogModel,
  CatalogProviderOption,
  CatalogSearchResult,
  CursorHarnessStatus,
  ExternalApiSettings,
  InterfaceSettings,
  InterfaceSettingsPatch,
  LlmCall,
  Model,
  Overview,
  OverviewActivityDay,
  OverviewFilterModel,
  OverviewFilterSupplier,
  OverviewMetrics,
  OverviewModelSummary,
  OverviewSupplierBreakdown,
  OverviewTokenUsageBucket,
  PricingRates,
  PricingSource,
  PricingSyncState,
  ProxySettings,
  SaveSupplierPricingInput,
  SpeedAggregate,
  SpeedStatus,
  StatisticsStorage,
  SupplierPricingView,
  TabSettings,
} from "../shared/api";
import { normalizeExchangeRate } from "../shared/utils/costFormat";

const API_ROOT = "/__byok-api__/api";
const DEMO_NOW = Date.now();
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MAX_RANGE_BUCKETS = 60;

const models: Model[] = [
  createModel({ hash: "mock-claude-sonnet", order: 1, name: "Claude Sonnet 4", type: "anthropic", url: "https://api.anthropic.com", modelId: "claude-sonnet-4-20250514" }),
  createModel({ hash: "mock-claude-opus", order: 2, name: "Claude Opus 4", type: "anthropic", url: "https://api.anthropic.com", modelId: "claude-opus-4-20250514" }),
  createModel({ hash: "mock-gpt", order: 3, name: "GPT-5.2", type: "openai", url: "https://api.openai.com", modelId: "gpt-5.2" }),
  createModel({ hash: "mock-o3", order: 4, name: "o3", type: "openai", url: "https://api.openai.com", modelId: "o3" }),
  createModel({ hash: "mock-deepseek-v3", order: 5, name: "DeepSeek V3.2", type: "openai", url: "https://api.deepseek.com", modelId: "deepseek-chat", endpoint: "/v1/chat/completions" }),
  createModel({ hash: "mock-deepseek-r1", order: 6, name: "DeepSeek R1", type: "openai", url: "https://api.deepseek.com", modelId: "deepseek-reasoner", endpoint: "/v1/chat/completions" }),
  createModel({ hash: "mock-gemini-pro", order: 7, name: "Gemini 2.5 Pro", type: "openai", url: "https://generativelanguage.googleapis.com", modelId: "gemini-2.5-pro", endpoint: "/v1beta/openai/chat/completions" }),
  createModel({ hash: "mock-gemini-flash", order: 8, name: "Gemini 2.5 Flash", type: "openai", url: "https://generativelanguage.googleapis.com", modelId: "gemini-2.5-flash", endpoint: "/v1beta/openai/chat/completions" }),
  createModel({ hash: "mock-qwen-max", order: 9, name: "Qwen3 Max", type: "openai", url: "https://dashscope.aliyuncs.com/compatible-mode", modelId: "qwen3-max", endpoint: "/v1/chat/completions" }),
  createModel({ hash: "mock-qwen-plus", order: 10, name: "Qwen Plus", type: "openai", url: "https://dashscope.aliyuncs.com/compatible-mode", modelId: "qwen-plus", endpoint: "/v1/chat/completions" }),
  createModel({ hash: "mock-kimi-k2", order: 11, name: "Kimi K2", type: "openai", url: "https://api.moonshot.cn", modelId: "kimi-k2-0711-preview", endpoint: "/v1/chat/completions" }),
  createModel({ hash: "mock-kimi-128k", order: 12, name: "Moonshot V1 128K", type: "openai", url: "https://api.moonshot.cn", modelId: "moonshot-v1-128k", endpoint: "/v1/chat/completions" }),
  createModel({ hash: "mock-glm-45", order: 13, name: "GLM-4.5", type: "openai", url: "https://open.bigmodel.cn", modelId: "glm-4.5", endpoint: "/api/paas/v4/chat/completions" }),
  createModel({ hash: "mock-glm-air", order: 14, name: "GLM-4.5-Air", type: "openai", url: "https://open.bigmodel.cn", modelId: "glm-4.5-air", endpoint: "/api/paas/v4/chat/completions" }),
  createModel({ hash: "mock-mistral-large", order: 15, name: "Mistral Large", type: "openai", url: "https://api.mistral.ai", modelId: "mistral-large-latest", endpoint: "/v1/chat/completions" }),
  createModel({ hash: "mock-mistral-small", order: 16, name: "Mistral Small", type: "openai", url: "https://api.mistral.ai", modelId: "mistral-small-latest", endpoint: "/v1/chat/completions" }),
];

const DEMO_CATALOG: CatalogModel[] = [
  catalogEntry("anthropic", "Anthropic", "https://api.anthropic.com", "claude-sonnet-4-20250514", "Claude Sonnet 4", { input_per_million: "3", output_per_million: "15", cache_read_per_million: "0.3", cache_write_per_million: "3.75" }),
  catalogEntry("anthropic", "Anthropic", "https://api.anthropic.com", "claude-opus-4-20250514", "Claude Opus 4", { input_per_million: "15", output_per_million: "75", cache_read_per_million: "1.5", cache_write_per_million: "18.75" }),
  catalogEntry("openai", "OpenAI", "https://api.openai.com", "gpt-5.2", "GPT-5.2", { input_per_million: "2.5", output_per_million: "10", cache_read_per_million: "0.625", cache_write_per_million: "0" }),
  catalogEntry("openai", "OpenAI", "https://api.openai.com", "o3", "o3", { input_per_million: "2", output_per_million: "8", cache_read_per_million: "0.5", cache_write_per_million: "0" }),
  catalogEntry("deepseek", "DeepSeek", "https://api.deepseek.com", "deepseek-chat", "DeepSeek Chat", { input_per_million: "0.27", output_per_million: "1.1", cache_read_per_million: "0.07", cache_write_per_million: "0" }),
  catalogEntry("deepseek", "DeepSeek", "https://api.deepseek.com", "deepseek-reasoner", "DeepSeek Reasoner", { input_per_million: "0.55", output_per_million: "2.19", cache_read_per_million: "0.14", cache_write_per_million: "0" }),
  catalogEntry("google", "Google", "https://generativelanguage.googleapis.com", "gemini-2.5-pro", "Gemini 2.5 Pro", { input_per_million: "1.25", output_per_million: "10", cache_read_per_million: "0.31", cache_write_per_million: "0" }),
  catalogEntry("google", "Google", "https://generativelanguage.googleapis.com", "gemini-2.5-flash", "Gemini 2.5 Flash", { input_per_million: "0.15", output_per_million: "0.6", cache_read_per_million: "0.0375", cache_write_per_million: "0" }),
];

const EMPTY_RATES: PricingRates = {
  input_per_million: null,
  output_per_million: null,
  cache_read_per_million: null,
  cache_write_per_million: null,
};

function catalogEntry(
  provider_id: string,
  provider_name: string,
  provider_api: string | null,
  model_id: string,
  model_name: string,
  rates: PricingRates,
): CatalogModel {
  return { provider_id, provider_name, provider_api, model_id, model_name, rates, synced_at_ms: DEMO_NOW - 30 * MINUTE_MS };
}

function supplierIdForEndpoint(sourceKind: "builtin" | "plugin", endpointKey: string): string {
  return `${sourceKind}::${endpointKey}`;
}

function supplierIdForModel(model: Model): string {
  return supplierIdForEndpoint("builtin", model.base_url);
}

function supplierKeyFor(model: Model): string {
  return `builtin::${model.base_url}::${model.model_id}`;
}

function supplierIdOfCall(call: LlmCall): string {
  const sourceKind = call.provider_type === "plugin" || call.endpoint_key?.startsWith("plugin://") ? "plugin" : "builtin";
  const endpointKey = call.endpoint_key || call.provider_url;
  return supplierIdForEndpoint(sourceKind, endpointKey);
}

function endpointLabel(endpointKey: string): string {
  try {
    return new URL(endpointKey).hostname.toLowerCase();
  } catch {
    return endpointKey;
  }
}

function timestampForCall(index: number): number {
  if (index < 6) return DEMO_NOW - (index + 1) * MINUTE_MS;
  if (index < 18) return DEMO_NOW - (index - 4) * 5 * MINUTE_MS;
  if (index < 36) return DEMO_NOW - (index - 15) * HOUR_MS;
  return DEMO_NOW - (index - 34) * 14 * HOUR_MS;
}

const calls: LlmCall[] = Array.from({ length: 84 }, (_, index) => {
  const model = models[index % models.length];
  const failed = index % 17 === 7;
  const catalog = DEMO_CATALOG.find((item) => item.model_id === model.model_id);
  const billedInput = 1_200 + (index % 11) * 340;
  const outputTokens = failed ? 0 : 760 + (index % 9) * 135;
  const cacheReadTokens = index % 13 === 0 ? 0 : 95_000 + (index % 7) * 12_500;
  const cacheWriteTokens = index % 3 === 0 ? 480 + (index % 5) * 90 : 0;
  const pricingSource: PricingSource = catalog ? (index % 9 === 0 ? "custom" : "catalog") : "unpriced";
  const costStatus = catalog ? "priced" : "unpriced";
  const inputCost = catalog ? formatNano(mulRate(billedInput, catalog.rates.input_per_million)) : null;
  const outputCost = catalog ? formatNano(mulRate(outputTokens, catalog.rates.output_per_million)) : null;
  const cacheReadCost = catalog ? formatNano(mulRate(cacheReadTokens, catalog.rates.cache_read_per_million)) : null;
  const cacheWriteCost = catalog ? formatNano(mulRate(cacheWriteTokens, catalog.rates.cache_write_per_million)) : null;
  const totalNano = catalog
    ? mulRate(billedInput, catalog.rates.input_per_million)
      + mulRate(outputTokens, catalog.rates.output_per_million)
      + mulRate(cacheReadTokens, catalog.rates.cache_read_per_million)
      + mulRate(cacheWriteTokens, catalog.rates.cache_write_per_million)
    : null;
  const firstOutputMs = 380 + (index % 8) * 145;
  const generationMs = failed ? null : 4_800 + (index % 7) * 980;

  return {
    call_kind: "provider_llm",
    route: "local_byok",
    call_id: `mock-call-${String(index + 1).padStart(3, "0")}`,
    run_id: `mock-run-${Math.floor(index / 3) + 1}`,
    conversation_id: `mock-conversation-${Math.floor(index / 4) + 1}`,
    provider_call_index: index + 1,
    model_hash: model.model_hash,
    supplier_key: supplierKeyFor(model),
    endpoint_key: model.base_url,
    provider_type: model.type,
    provider_url: model.base_url,
    request_type: model.type === "anthropic" ? "messages" : "responses",
    request_url: model.type === "anthropic" ? `${model.base_url}/v1/messages` : `${model.base_url}${model.openai_endpoint}`,
    model_id: model.model_id,
    display_name: model.display_name,
    reasoning_effort: index % 2 === 0 ? "high" : null,
    fast: index % 3 === 0,
    status: failed ? "failed" : "completed",
    finish_reason: failed ? null : "stop",
    created_at_ms: timestampForCall(index),
    ttfb_ms: 190 + (index % 6) * 24,
    ttfr_ms: 260 + (index % 6) * 28,
    ttft_ms: 340 + (index % 6) * 32,
    ttfo_ms: firstOutputMs,
    duration_ms: failed ? 812 : firstOutputMs + (generationMs ?? 0),
    generation_ms: generationMs,
    streaming: true,
    call_origin: "run" as const,
    observed_thinking: index % 2 === 0,
    performance: mockPerformance(outputTokens, firstOutputMs, generationMs, failed),
    input_tokens: model.type === "anthropic" ? billedInput : billedInput + cacheReadTokens + cacheWriteTokens,
    billed_input_tokens: billedInput,
    output_tokens: outputTokens,
    total_tokens: failed ? billedInput : billedInput + outputTokens + cacheReadTokens + cacheWriteTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    reasoning_tokens: index % 2 === 0 ? 420 + (index % 5) * 45 : null,
    pricing_source: pricingSource,
    pricing_provider_id: catalog?.provider_id ?? null,
    pricing_model_id: catalog?.model_id ?? null,
    pricing_snapshot_at_ms: DEMO_NOW - 30 * MINUTE_MS,
    unit_input_per_million: catalog?.rates.input_per_million ?? null,
    unit_output_per_million: catalog?.rates.output_per_million ?? null,
    unit_cache_read_per_million: catalog?.rates.cache_read_per_million ?? null,
    unit_cache_write_per_million: catalog?.rates.cache_write_per_million ?? null,
    cost_status: costStatus,
    input_cost: inputCost,
    output_cost: outputCost,
    cache_read_cost: cacheReadCost,
    cache_write_cost: cacheWriteCost,
    total_cost: totalNano == null ? null : formatNano(totalNano),
    cost_calculated_at_ms: timestampForCall(index),
    cost_backfilled: index % 5 === 0,
    message_count: 14 + (index % 8),
    tool_count: 3 + (index % 5),
    http_status: failed ? 429 : 200,
    error_kind: failed ? "provider_rate_limit" : null,
    error_message: failed ? "Mock provider rate limit" : null,
    detailed: true,
  };
});

let pricingSyncState: PricingSyncState = {
  auto_sync_enabled: true,
  sync_interval_hours: 6,
  catalog_model_count: DEMO_CATALOG.length,
  last_attempted_at_ms: DEMO_NOW - 30 * MINUTE_MS,
  last_synced_at_ms: DEMO_NOW - 30 * MINUTE_MS,
  last_error: null,
  syncing: false,
  backfilling: false,
};

const pricingConfigs = new Map<string, SaveSupplierPricingInput>();

let harnessStatus: CursorHarnessStatus = {
  platform: "macos",
  ca: "ready",
  configured_models: models.length,
  enabled_models: models.length,
  integration: "enabled",
  settings_applied: true,
  proxy_url: "http://127.0.0.1:54321",
  ca_install_command: null,
};

let detailed = true;
let portSettings = { proxy_port: 0, service_port: 0 };
let externalApiSettings: ExternalApiSettings = { enabled: false, api_key: "" };
let proxySettings: ProxySettings = {
  mode: "default",
  address: "",
  auth_enabled: false,
  username: "",
  has_password: false,
};
let tabSettings: TabSettings = { mode: "public", address: "" };
let storage: StatisticsStorage = { call_count: calls.length, trace_count: calls.length };
let interfaceSettings: InterfaceSettings = {
  locale: "system",
  theme: "default-dark",
  currency: "USD",
  cny_rate: null,
  overview_chart_mode: "tokens",
  overview_chart_type: "bar",
  home_refresh_interval_seconds: 30,
};

export function installDemoApi(initialInterface?: Partial<Pick<InterfaceSettings, "locale" | "theme">>) {
  interfaceSettings = {
    ...interfaceSettings,
    ...(initialInterface?.locale ? { locale: initialInterface.locale } : {}),
    ...(initialInterface?.theme ? { theme: initialInterface.theme } : {}),
  };
  const nativeFetch = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    const requestUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    const url = new URL(requestUrl, window.location.href);
    if (!url.pathname.startsWith(API_ROOT)) return nativeFetch(input, init);

    const path = url.pathname.slice(API_ROOT.length) || "/";
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = await readBody(input, init);

    if (path === "/promotions") return json({ slots: [] });
    if (path === "/plugins/runtime" && method === "GET") {
      return json({
        state: "unsupported",
        version: "0.0.0",
        target: null,
        phase: null,
        downloaded_bytes: 0,
        total_bytes: null,
        error: null,
      });
    }
    if (path === "/plugins" && method === "GET") return json([]);
    if (path === "/models" && method === "GET") return json(models);
    if (path === "/models" && method === "POST") return json(models);
    if (path === "/models/order") return json(models);
    if (path === "/models/discover") return json({ models: models.map((model) => model.model_id) });
    if (path === "/models/import-v0049" && method === "GET") {
      return json({ source: "demo", total: 0, new_models: 0, existing_models: 0, models: [] });
    }
    if (path === "/models/import-v0049") return json({ imported: 0, skipped: 0, total: 0 });
    if (/^\/models\/[^/]+\/test\/[^/]+$/.test(path) && method === "POST") {
      return json({ duration_ms: 1_284, generation_ms: 1_020, first_output_ms: 418, output_tokens: 42, tokens_per_second: 41.2, speed_status: "measured", speed_reason: null, tokens_estimated: false, output: "Mock connectivity test passed." });
    }
    if (/^\/models\/[^/]+\/test\/[^/]+$/.test(path) || /^\/models\/[^/]+$/.test(path)) {
      return method === "DELETE" ? empty() : json(models[0]);
    }
    if (path === "/overview") return json(createOverview(url.searchParams));
    if (path === "/llm-calls") return json(listCalls(url.searchParams));
    if (path.startsWith("/llm-calls/")) return json(createCallDetail(path.slice("/llm-calls/".length)));
    if (path === "/pricing/catalog" && method === "GET") return json(searchCatalog(url.searchParams));
    if (path === "/pricing/models" && method === "GET") return json(buildSupplierPricingViews());
    if (path === "/pricing/models" && method === "PUT") {
      const saveInput = body as SaveSupplierPricingInput;
      const key = `${saveInput.source_kind}::${saveInput.endpoint_key}::${saveInput.model_id}`;
      if (saveInput.binding_mode === "auto" && !hasAnyRate(saveInput.custom_rates)) {
        pricingConfigs.delete(key);
      } else {
        pricingConfigs.set(key, saveInput);
      }
      const updated = buildSupplierPricingViews().find((item) => item.supplier_key === key) ?? buildSupplierPricingViews()[0];
      return json(updated);
    }
    if (path === "/pricing/sync" && method === "GET") return json(pricingSyncState);
    if (path === "/pricing/sync" && method === "PUT") {
      const enabled = Boolean((body as { auto_sync_enabled?: unknown } | null)?.auto_sync_enabled);
      pricingSyncState = { ...pricingSyncState, auto_sync_enabled: enabled };
      return json(pricingSyncState);
    }
    if (path === "/pricing/sync" && method === "POST") {
      pricingSyncState = { ...pricingSyncState, last_attempted_at_ms: DEMO_NOW, last_synced_at_ms: DEMO_NOW, last_error: null };
      return json(pricingSyncState);
    }
    if (path === "/harness/cursor/status") return json(harnessStatus);
    if (path === "/harness/cursor/ca/initialize") return json(harnessStatus);
    if (path === "/harness/cursor/enabled") {
      const enabled = Boolean((body as { enabled?: unknown } | null)?.enabled);
      harnessStatus = {
        ...harnessStatus,
        integration: enabled ? "enabled" : "disabled",
        settings_applied: enabled,
        proxy_url: enabled ? "http://127.0.0.1:54321" : null,
      };
      return json(harnessStatus);
    }
    if (path === "/settings/observability" && method === "GET") return json({ detailed });
    if (path === "/settings/observability") {
      detailed = Boolean((body as { detailed?: unknown } | null)?.detailed);
      return json({ detailed });
    }
    if (path === "/settings/ports" && method === "GET") return json(portSettings);
    if (path === "/settings/ports") {
      portSettings = body as typeof portSettings;
      return json(portSettings);
    }
    if (path === "/settings/external-api" && method === "GET") return json(externalApiSettings);
    if (path === "/settings/external-api") {
      externalApiSettings = body as ExternalApiSettings;
      return json(externalApiSettings);
    }
    if (path === "/settings/storage/statistics" && method === "GET") return json(storage);
    if (path === "/settings/storage/statistics") {
      const scope = (body as { scope?: string } | null)?.scope ?? "details";
      storage = scope === "all" ? { call_count: 0, trace_count: 0 } : storage;
      return json(storage);
    }
    if (path === "/settings/proxy" && method === "GET") return json(proxySettings);
    if (path === "/settings/proxy") {
      const next = body as Partial<ProxySettings>;
      proxySettings = { ...proxySettings, ...next, has_password: Boolean(next.has_password) };
      return json(proxySettings);
    }
    if (path === "/settings/tab" && method === "GET") return json(tabSettings);
    if (path === "/settings/tab") {
      tabSettings = body as TabSettings;
      return json(tabSettings);
    }
    if (path === "/settings/commit") {
      return json({ model_id: "", prompt: "", prompt_locale: "zh", default_prompt: "" });
    }
    if (path === "/settings/interface" && method === "GET") return json(interfaceSettings);
    if (path === "/settings/interface" && method === "PUT") {
      const result = applyDemoInterfacePatch(body as InterfaceSettingsPatch | null);
      if ("error" in result) return json({ message: result.error }, 400);
      interfaceSettings = result.settings;
      return json(interfaceSettings);
    }
    if (path === "/settings/desktop" && method === "GET") return json({ silent_start: false, show_dock_icon: true });
    if (path === "/settings/desktop") return json(body);
    if (path === "/desktop/open-external-url") {
      const target = (body as { url?: string } | null)?.url;
      if (target) {
        const next = new URL(target, window.location.href);
        if (next.origin === window.location.origin && next.hash) window.location.hash = next.hash;
      }
      return empty();
    }
    if (path.endsWith("/dismissals")) return empty();

    return json({ message: `Unhandled demo endpoint: ${method} ${path}` }, 404);
  };
}

function searchCatalog(params: URLSearchParams): CatalogSearchResult {
  const query = (params.get("query") ?? "").trim().toLowerCase();
  const providerId = (params.get("provider_id") ?? "").trim();
  const limit = Math.max(1, Math.min(200, Number(params.get("limit")) || 100));
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  const providersMap = new Map<string, CatalogProviderOption>();
  for (const item of DEMO_CATALOG) {
    const existing = providersMap.get(item.provider_id);
    if (existing) existing.model_count += 1;
    else providersMap.set(item.provider_id, { provider_id: item.provider_id, provider_name: item.provider_name, provider_api: item.provider_api, model_count: 1 });
  }
  const filtered = DEMO_CATALOG.filter((item) => {
    if (providerId && item.provider_id !== providerId) return false;
    if (!query) return true;
    return [item.provider_id, item.provider_name, item.model_id, item.model_name, item.provider_api ?? ""]
      .some((field) => field.toLowerCase().includes(query));
  });
  return { total: filtered.length, providers: [...providersMap.values()], items: filtered.slice(offset, offset + limit) };
}

function buildSupplierPricingViews(): SupplierPricingView[] {
  return models.map((model) => {
    const key = supplierKeyFor(model);
    const saved = pricingConfigs.get(key);
    const modelCalls = calls.filter((call) => call.supplier_key === key);
    const autoCatalog = DEMO_CATALOG.find((item) => item.model_id === model.model_id) ?? null;
    const bindingMode = saved?.binding_mode ?? "auto";
    const matched = bindingMode === "manual"
      ? DEMO_CATALOG.find((item) => item.provider_id === saved?.catalog_provider_id && item.model_id === saved?.catalog_model_id) ?? null
      : autoCatalog;
    const customRates = saved?.custom_rates ?? EMPTY_RATES;
    const effectiveRates: PricingRates = {
      input_per_million: customRates.input_per_million ?? matched?.rates.input_per_million ?? null,
      output_per_million: customRates.output_per_million ?? matched?.rates.output_per_million ?? null,
      cache_read_per_million: customRates.cache_read_per_million ?? matched?.rates.cache_read_per_million ?? null,
      cache_write_per_million: customRates.cache_write_per_million ?? matched?.rates.cache_write_per_million ?? null,
    };
    const effectiveSource = hasAnyRate(customRates) ? "custom" : hasAnyRate(effectiveRates) ? "catalog" : "unpriced";
    return {
      supplier_key: key,
      source_kind: "builtin",
      endpoint_key: model.base_url,
      model_id: model.model_id,
      display_name: model.display_name,
      provider_type: model.type,
      plugin_icon: null,
      active: true,
      call_count: modelCalls.length,
      unpriced_call_count: modelCalls.filter((call) => call.cost_status !== "priced").length,
      binding_mode: bindingMode,
      catalog_match_kind: bindingMode === "manual" ? (matched ? "manual" : "manual_missing") : (matched ? "auto_exact" : "none"),
      matched_provider_id: matched?.provider_id ?? saved?.catalog_provider_id ?? null,
      matched_provider_name: matched?.provider_name ?? null,
      matched_model_id: matched?.model_id ?? saved?.catalog_model_id ?? null,
      matched_model_name: matched?.model_name ?? null,
      matched_rates: matched?.rates ?? null,
      custom_rates: customRates,
      effective_source: effectiveSource,
      effective_rates: effectiveRates,
      updated_at_ms: saved ? DEMO_NOW : null,
    };
  });
}

function createModel({ hash, order, name, type, url, modelId, endpoint = "/v1/responses" }: {
  hash: string;
  order: number;
  name: string;
  type: Model["type"];
  url: string;
  modelId: string;
  endpoint?: string;
}): Model {
  return {
    model_hash: hash,
    sort_order: order,
    display_name: name,
    group_name: null,
    type,
    base_url: url,
    use_full_url: false,
    api_key: "demo-key",
    tooltip_data: `${name} Mock 通道`,
    model_id: modelId,
    reasoning_effort: type === "openai" ? "high" : null,
    openai_endpoint: type === "openai" ? endpoint : "",
    openai_extra_params_enabled: false,
    openai_extra_params: {},
    custom_headers_enabled: false,
    custom_headers: {},
    anthropic_extra_params_enabled: false,
    anthropic_extra_params: {},
    context_window_tokens: 200_000,
    max_completion_tokens: type === "openai" ? 32_000 : null,
    anthropic_max_tokens: type === "anthropic" ? 32_000 : null,
    anthropic_thinking_effort: type === "anthropic" ? "high" : null,
    thinking_budget_tokens: null,
    created_at_ms: DEMO_NOW - order * DAY_MS,
    updated_at_ms: DEMO_NOW,
  };
}

function parseJsonStringSet(raw: string | null): Set<string> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const values = parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
    return values.length > 0 ? new Set(values) : null;
  } catch {
    return null;
  }
}

function parseOptionalInt(raw: string | null): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function filterDemoCalls(
  startMs: number | null,
  endMs: number | null,
  supplierIds: Set<string> | null,
  supplierKeys: Set<string> | null,
): LlmCall[] {
  return calls.filter((call) => {
    if (startMs != null && call.created_at_ms < startMs) return false;
    if (endMs != null && call.created_at_ms >= endMs) return false;
    if (supplierIds && !supplierIds.has(supplierIdOfCall(call))) return false;
    if (supplierKeys && (!call.supplier_key || !supplierKeys.has(call.supplier_key))) return false;
    return true;
  });
}

function listCalls(params: URLSearchParams): CallListResult {
  const startMs = parseOptionalInt(params.get("start_ms"));
  const endMs = parseOptionalInt(params.get("end_ms"));
  const supplierIds = parseJsonStringSet(params.get("suppliers"));
  const supplierKeys = parseJsonStringSet(params.get("supplier_keys"));
  const limit = Math.max(1, Math.min(200, parseOptionalInt(params.get("limit")) ?? 200));
  const offset = Math.max(0, parseOptionalInt(params.get("offset")) ?? 0);

  const filtered = filterDemoCalls(startMs, endMs, supplierIds, supplierKeys)
    .slice()
    .sort((left, right) => right.created_at_ms - left.created_at_ms || right.call_id.localeCompare(left.call_id));

  return {
    items: filtered.slice(offset, offset + limit),
    total: filtered.length,
  };
}

function aggregateCallStats(matchingCalls: LlmCall[]): Omit<OverviewMetrics, "speed"> & { speed: SpeedAggregate } {
  let llmCalls = 0;
  let successfulCalls = 0;
  let failedCalls = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  let inputNano = 0;
  let outputNano = 0;
  let cacheReadNano = 0;
  let cacheWriteNano = 0;
  let totalNano = 0;
  let pricedCalls = 0;
  let unpricedCalls = 0;
  let incompleteCalls = 0;

  for (const call of matchingCalls) {
    llmCalls += 1;
    if (call.status === "completed") successfulCalls += 1;
    else failedCalls += 1;
    inputTokens += call.billed_input_tokens ?? call.input_tokens ?? 0;
    cacheReadTokens += call.cache_read_tokens ?? 0;
    cacheWriteTokens += call.cache_write_tokens ?? 0;
    outputTokens += call.output_tokens ?? 0;

    if (call.cost_status === "priced") {
      pricedCalls += 1;
      inputNano += toNano(call.input_cost);
      outputNano += toNano(call.output_cost);
      cacheReadNano += toNano(call.cache_read_cost);
      cacheWriteNano += toNano(call.cache_write_cost);
      totalNano += toNano(call.total_cost);
    } else if (call.cost_status === "incomplete_usage") {
      incompleteCalls += 1;
    } else {
      unpricedCalls += 1;
    }
  }

  const promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
  return {
    llm_calls: llmCalls,
    successful_calls: successfulCalls,
    failed_calls: failedCalls,
    token_usage: promptTokens + outputTokens,
    prompt_tokens: promptTokens,
    input_tokens: inputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    output_tokens: outputTokens,
    total_cost: formatNano(totalNano),
    input_cost: formatNano(inputNano),
    output_cost: formatNano(outputNano),
    cache_read_cost: formatNano(cacheReadNano),
    cache_write_cost: formatNano(cacheWriteNano),
    average_priced_cost: pricedCalls > 0 ? formatNano(Math.round(totalNano / pricedCalls)) : null,
    priced_calls: pricedCalls,
    unpriced_calls: unpricedCalls,
    incomplete_usage_calls: incompleteCalls,
    speed: mockAggregate(matchingCalls),
  };
}

function createOverview(params: URLSearchParams): Overview {
  const startMs = parseOptionalInt(params.get("start_ms"));
  const endMs = parseOptionalInt(params.get("end_ms"));
  const supplierIds = parseJsonStringSet(params.get("suppliers"));
  const supplierKeys = parseJsonStringSet(params.get("supplier_keys"));

  const matchingCalls = filterDemoCalls(startMs, endMs, supplierIds, supplierKeys);
  const metrics = aggregateCallStats(matchingCalls);

  const rangeEnd = endMs ?? DEMO_NOW;
  const rangeStart = startMs ?? (rangeEnd - 30 * DAY_MS);
  const spanMs = Math.max(MINUTE_MS, rangeEnd - rangeStart);
  const granularity: Overview["token_usage_granularity"] =
    spanMs <= 2 * HOUR_MS ? "minute" : spanMs <= 2 * DAY_MS ? "hour" : "day";
  const baseStep = granularity === "minute" ? MINUTE_MS : granularity === "hour" ? HOUR_MS : DAY_MS;
  const stepCount = Math.max(1, Math.ceil(spanMs / baseStep));
  const bucketMs = stepCount > MAX_RANGE_BUCKETS
    ? Math.max(baseStep, Math.ceil(stepCount / MAX_RANGE_BUCKETS) * baseStep)
    : baseStep;
  const seriesStart = Math.floor(rangeStart / bucketMs) * bucketMs;
  const seriesEnd = Math.floor(Math.max(rangeStart, rangeEnd - 1) / bucketMs) * bucketMs;

  const bucketMap = new Map<number, OverviewTokenUsageBucket>();
  for (let start = seriesStart; start <= seriesEnd; start += bucketMs) {
    bucketMap.set(start, {
      bucket_start_ms: start,
      input_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 0,
      input_cost: "0",
      output_cost: "0",
      cache_read_cost: "0",
      cache_write_cost: "0",
      total_cost: "0",
      priced_calls: 0,
      unpriced_calls: 0,
      incomplete_usage_calls: 0,
    });
  }
  const bucketNano = new Map<number, { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }>();
  for (const call of matchingCalls) {
    const bucketStart = Math.floor(call.created_at_ms / bucketMs) * bucketMs;
    const bucket = bucketMap.get(bucketStart);
    if (!bucket) continue;
    bucket.input_tokens += call.billed_input_tokens ?? call.input_tokens ?? 0;
    bucket.cache_read_tokens += call.cache_read_tokens ?? 0;
    bucket.cache_write_tokens += call.cache_write_tokens ?? 0;
    bucket.output_tokens += call.output_tokens ?? 0;
    const nano = bucketNano.get(bucketStart) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    if (call.cost_status === "priced") {
      bucket.priced_calls += 1;
      nano.input += toNano(call.input_cost);
      nano.output += toNano(call.output_cost);
      nano.cacheRead += toNano(call.cache_read_cost);
      nano.cacheWrite += toNano(call.cache_write_cost);
      nano.total += toNano(call.total_cost);
    } else if (call.cost_status === "incomplete_usage") {
      bucket.incomplete_usage_calls += 1;
    } else {
      bucket.unpriced_calls += 1;
    }
    bucketNano.set(bucketStart, nano);
  }
  const tokenUsageSeries: OverviewTokenUsageBucket[] = [...bucketMap.values()].map((bucket) => {
    const nano = bucketNano.get(bucket.bucket_start_ms);
    return nano
      ? {
          ...bucket,
          input_cost: formatNano(nano.input),
          output_cost: formatNano(nano.output),
          cache_read_cost: formatNano(nano.cacheRead),
          cache_write_cost: formatNano(nano.cacheWrite),
          total_cost: formatNano(nano.total),
        }
      : bucket;
  });

  // Activity calendar uses fixed 365-day window under supplier selection only.
  const activityCalls = filterDemoCalls(null, null, supplierIds, supplierKeys);
  const tokensByDate = new Map<string, number>();
  for (const call of activityCalls) {
    const d = new Date(call.created_at_ms);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    const billedInput = call.billed_input_tokens ?? call.input_tokens ?? 0;
    const cacheRead = call.cache_read_tokens ?? 0;
    const cacheWrite = call.cache_write_tokens ?? 0;
    const output = call.output_tokens ?? 0;
    tokensByDate.set(key, (tokensByDate.get(key) ?? 0) + billedInput + cacheRead + cacheWrite + output);
  }
  const activitySeries: OverviewActivityDay[] = [];
  const todayUtc = new Date(DEMO_NOW);
  todayUtc.setUTCHours(0, 0, 0, 0);
  for (let offset = 364; offset >= 0; offset -= 1) {
    const day = new Date(todayUtc.getTime() - offset * DAY_MS);
    const date = `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, "0")}-${String(day.getUTCDate()).padStart(2, "0")}`;
    activitySeries.push({ date, token_usage: tokensByDate.get(date) ?? 0 });
  }

  // Complete supplier metadata from configured models.
  const supplierMeta = new Map<string, OverviewFilterSupplier>();
  for (const model of models) {
    const supplierId = supplierIdForModel(model);
    const existing = supplierMeta.get(supplierId);
    if (existing) {
      existing.model_count += 1;
    } else {
      supplierMeta.set(supplierId, {
        supplier_id: supplierId,
        source_kind: "builtin",
        endpoint_key: model.base_url,
        label: endpointLabel(model.base_url),
        provider_type: model.type,
        plugin_icon: null,
        active: true,
        model_count: 1,
      });
    }
  }
  const availableSuppliers = [...supplierMeta.values()].sort((a, b) => a.label.localeCompare(b.label));

  // Cross-model supplier breakdowns.
  const callsBySupplier = new Map<string, LlmCall[]>();
  for (const call of matchingCalls) {
    const sid = supplierIdOfCall(call);
    const group = callsBySupplier.get(sid);
    if (group) group.push(call);
    else callsBySupplier.set(sid, [call]);
  }
  const suppliers: OverviewSupplierBreakdown[] = [...callsBySupplier.entries()]
    .map(([supplierId, supplierCalls]) => {
      const stats = aggregateCallStats(supplierCalls);
      const meta = supplierMeta.get(supplierId);
      const pricingSources = [...new Set(supplierCalls.map((c) => c.pricing_source).filter((s): s is PricingSource => s != null))];
      const sample = supplierCalls[0];
      return {
        supplier_id: supplierId,
        source_kind: meta?.source_kind ?? "builtin",
        endpoint_key: meta?.endpoint_key ?? (sample.endpoint_key || sample.provider_url),
        label: meta?.label ?? endpointLabel(sample.endpoint_key || sample.provider_url),
        provider_type: meta?.provider_type ?? sample.provider_type,
        plugin_icon: meta?.plugin_icon ?? null,
        active: meta?.active ?? false,
        model_count: new Set(supplierCalls.map((c) => c.model_id)).size,
        pricing_sources: pricingSources,
        ...stats,
      };
    })
    .sort((left, right) => right.token_usage - left.token_usage || left.label.localeCompare(right.label));

  // Cross-supplier model summaries.
  const callsByModel = new Map<string, LlmCall[]>();
  for (const call of matchingCalls) {
    const group = callsByModel.get(call.model_id);
    if (group) group.push(call);
    else callsByModel.set(call.model_id, [call]);
  }
  const modelSummaries: OverviewModelSummary[] = [...callsByModel.entries()]
    .map(([modelId, modelCalls]) => {
      const stats = aggregateCallStats(modelCalls);
      const pricingSources = [...new Set(modelCalls.map((c) => c.pricing_source).filter((s): s is PricingSource => s != null))];
      return {
        model_id: modelId,
        supplier_count: new Set(modelCalls.map((c) => supplierIdOfCall(c))).size,
        pricing_sources: pricingSources,
        ...stats,
      };
    })
    .sort((left, right) => right.token_usage - left.token_usage || left.model_id.localeCompare(right.model_id));

  const availableModels: OverviewFilterModel[] = models.map((model) => ({
    supplier_key: supplierKeyFor(model),
    source_kind: "builtin",
    endpoint_key: model.base_url,
    model_id: model.model_id,
    label: model.display_name,
    group: endpointLabel(model.base_url),
    provider_type: model.type,
    plugin_icon: null,
    active: true,
  }));

  return {
    metrics,
    token_usage_granularity: granularity,
    token_usage_series: tokenUsageSeries,
    activity_series: activitySeries,
    suppliers,
    models: modelSummaries,
    available_suppliers: availableSuppliers,
    available_models: availableModels,
  };
}

function createCallDetail(id: string): CallDetail {
  const call = calls.find((item) => item.call_id === decodeURIComponent(id)) ?? calls[0];
  return {
    call,
    request: {
      headers: { authorization: "Bearer sk-demo-••••", "content-type": "application/json" },
      body: { model: call.model_id, stream: true, messages: [{ role: "user", content: "Mock Agent request" }] },
      byte_count: 8_426,
    },
    response_chunks: [
      { seq: 1, received_offset_ms: 418, data: "event: response.created", byte_count: 128 },
      { seq: 2, received_offset_ms: 512, data: "event: response.output_text.delta", byte_count: 256 },
    ],
    cursor_trace: null,
  };
}

function mulRate(tokens: number, rate: string | null | undefined): number {
  if (!rate) return 0;
  return Math.round((tokens / 1_000_000) * Number(rate) * 1_000_000_000);
}

/** Pools sample numerators and denominators, preferring measured over estimated. */
function mockAggregate(callList: LlmCall[]): SpeedAggregate {
  const measured = { output_tokens: 0, generation_ms: 0, samples: 0 };
  const estimated = { output_tokens: 0, generation_ms: 0, samples: 0 };
  const waits: number[] = [];
  for (const call of callList) {
    const first = call.performance.first_output_ms;
    if (call.status === "completed" && call.streaming && first != null) waits.push(first);
    if (call.performance.tokens_per_second == null) continue;
    const target = call.performance.speed_status === "estimated" ? estimated : measured;
    target.output_tokens += call.output_tokens ?? 0;
    target.generation_ms += call.performance.generation_ms ?? 0;
    target.samples += 1;
  }
  waits.sort((left, right) => left - right);
  const middle = Math.floor(waits.length / 2);
  const firstOutputMedian = waits.length === 0
    ? null
    : waits.length % 2 === 1
      ? waits[middle]
      : Math.trunc((waits[middle - 1] + waits[middle]) / 2);
  const status: SpeedStatus = measured.samples > 0
    ? "measured"
    : estimated.samples > 0
      ? "estimated"
      : "unavailable";
  const pool = status === "estimated" ? estimated : measured;
  const average = status !== "unavailable" && pool.generation_ms > 0
    ? pool.output_tokens / (pool.generation_ms / 1000)
    : null;
  return {
    average_tokens_per_second: average,
    status,
    measured,
    estimated,
    first_output_median_ms: firstOutputMedian,
  };
}

/** Mirrors the server's speed rules closely enough for the demo dashboard. */
function mockPerformance(
  outputTokens: number,
  firstOutputMs: number,
  generationMs: number | null,
  failed: boolean,
): CallPerformance {
  if (failed) {
    return {
      speed_status: "unavailable",
      tokens_per_second: null,
      reason: "not_completed",
      first_output_ms: firstOutputMs,
      generation_ms: generationMs,
    };
  }
  if (generationMs == null || outputTokens < 100 || generationMs < 100) {
    return {
      speed_status: "unavailable",
      tokens_per_second: null,
      reason: generationMs == null ? "missing_generation" : generationMs < 100 ? "short_generation" : "short_output",
      first_output_ms: firstOutputMs,
      generation_ms: generationMs,
    };
  }
  return {
    speed_status: "measured",
    tokens_per_second: outputTokens / (generationMs / 1000),
    reason: null,
    first_output_ms: firstOutputMs,
    generation_ms: generationMs,
  };
}

function toNano(usd: string | null | undefined): number {
  if (!usd) return 0;
  return Math.round(Number(usd) * 1_000_000_000);
}

function formatNano(nano: number): string {
  const scaled = (nano / 1_000_000_000).toFixed(9).replace(/\.?0+$/, "");
  return scaled || "0";
}

function hasAnyRate(rates: PricingRates): boolean {
  return Boolean(
    rates.input_per_million != null
    || rates.output_per_million != null
    || rates.cache_read_per_million != null
    || rates.cache_write_per_million != null,
  );
}

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : null);
  if (typeof raw !== "string" || raw.length === 0) return null;
  try { return JSON.parse(raw) as unknown; }
  catch { return raw; }
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function applyDemoInterfacePatch(
  patch: InterfaceSettingsPatch | null,
): { settings: InterfaceSettings } | { error: string } {
  if (!patch || typeof patch !== "object") {
    return { settings: interfaceSettings };
  }
  const next: InterfaceSettings = { ...interfaceSettings };
  if (patch.locale !== undefined) {
    if (!["system", "zh-CN", "en-US", "pt-BR"].includes(patch.locale)) {
      return { error: "invalid interface locale" };
    }
    next.locale = patch.locale;
  }
  if (patch.theme !== undefined) {
    if (!["system", "default-dark", "default-light"].includes(patch.theme)) {
      return { error: "invalid interface theme" };
    }
    next.theme = patch.theme;
  }
  if (patch.overview_chart_mode !== undefined) {
    if (!["tokens", "cost"].includes(patch.overview_chart_mode)) {
      return { error: "invalid overview chart mode" };
    }
    next.overview_chart_mode = patch.overview_chart_mode;
  }
  if (patch.overview_chart_type !== undefined) {
    if (!["bar", "line"].includes(patch.overview_chart_type)) {
      return { error: "invalid overview chart type" };
    }
    next.overview_chart_type = patch.overview_chart_type;
  }
  if (patch.home_refresh_interval_seconds !== undefined) {
    if (
      typeof patch.home_refresh_interval_seconds !== "number"
      || !Number.isSafeInteger(patch.home_refresh_interval_seconds)
      || patch.home_refresh_interval_seconds < 1
    ) {
      return { error: "home refresh interval must be at least 1 second" };
    }
    next.home_refresh_interval_seconds = patch.home_refresh_interval_seconds;
  }
  if ("cny_rate" in patch) {
    if (patch.cny_rate == null) {
      next.cny_rate = null;
    } else if (typeof patch.cny_rate === "string") {
      const trimmed = patch.cny_rate.trim();
      if (trimmed === "") {
        next.cny_rate = null;
      } else if (trimmed.length > 64) {
        return { error: "CNY exchange rate is too long" };
      } else {
        const normalized = normalizeExchangeRate(trimmed);
        if (!normalized) {
          return { error: "CNY exchange rate must be greater than 0" };
        }
        next.cny_rate = normalized;
      }
    } else {
      return { error: "invalid CNY exchange rate" };
    }
  }
  if (patch.currency !== undefined) {
    if (!["USD", "CNY"].includes(patch.currency)) {
      return { error: "invalid display currency" };
    }
    next.currency = patch.currency;
  }
  return { settings: next };
}

function empty() {
  return new Response(null, { status: 204 });
}
