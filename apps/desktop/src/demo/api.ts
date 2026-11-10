import type {
  CallDetail,
  CallPerformance,
  CatalogModel,
  CatalogProviderOption,
  CatalogSearchResult,
  CursorHarnessStatus,
  ExternalApiSettings,
  LlmCall,
  Model,
  Overview,
  OverviewFilterModel,
  OverviewModelSummary,
  OverviewSupplierSummary,
  OverviewTokenUsageBucket,
  PricingRates,
  PricingSyncState,
  ProxySettings,
  SaveSupplierPricingInput,
  SpeedAggregate,
  SpeedStatus,
  StatisticsStorage,
  SupplierPricingView,
  TabSettings,
} from "../shared/api";

const API_ROOT = "/__byok-api__/api";
const FIXED_NOW = Date.UTC(2026, 7, 27, 8, 0, 0);

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
  return { provider_id, provider_name, provider_api, model_id, model_name, rates, synced_at_ms: FIXED_NOW - 30 * 60_000 };
}

function supplierKeyFor(model: Model): string {
  return `builtin::${model.base_url}::${model.model_id}`;
}

const calls: LlmCall[] = Array.from({ length: 24 }, (_, index) => {
  const model = models[index % models.length];
  const failed = index === 7 || index === 19;
  const catalog = DEMO_CATALOG.find((item) => item.model_id === model.model_id);
  const billedInput = 4_800 + index * 337;
  const outputTokens = failed ? 0 : 820 + index * 43;
  const cacheReadTokens = 3_100 + index * 251;
  const cacheWriteTokens = 320 + index * 19;
  const pricingSource = catalog ? "catalog" : "unpriced";
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
    created_at_ms: FIXED_NOW - index * 3 * 60_000,
    ttfb_ms: 210 + index * 13,
    ttfr_ms: 290 + index * 15,
    ttft_ms: 370 + index * 17,
    ttfo_ms: 418 + index * 9,
    duration_ms: failed ? 812 : 1_420 + index * 71,
    generation_ms: failed ? null : 1_002 + index * 62,
    streaming: true,
    call_origin: "run" as const,
    observed_thinking: index % 2 === 0,
    performance: mockPerformance(outputTokens, 418 + index * 9, failed ? null : 1_002 + index * 62, failed),
    input_tokens: model.type === "anthropic" ? billedInput : billedInput + cacheReadTokens + cacheWriteTokens,
    billed_input_tokens: billedInput,
    output_tokens: outputTokens,
    total_tokens: failed ? billedInput : billedInput + outputTokens + cacheReadTokens + cacheWriteTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    reasoning_tokens: index % 2 === 0 ? 420 + index * 11 : null,
    pricing_source: pricingSource,
    pricing_provider_id: catalog?.provider_id ?? null,
    pricing_model_id: catalog?.model_id ?? null,
    pricing_snapshot_at_ms: FIXED_NOW - 30 * 60_000,
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
    cost_calculated_at_ms: FIXED_NOW - index * 3 * 60_000,
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
  last_attempted_at_ms: FIXED_NOW - 30 * 60_000,
  last_synced_at_ms: FIXED_NOW - 30 * 60_000,
  last_error: null,
  syncing: false,
  backfilling: false,
};

let pricingConfigs = new Map<string, SaveSupplierPricingInput>();

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

export function installDemoApi() {
  const nativeFetch = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    const requestUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    const url = new URL(requestUrl, window.location.href);
    if (!url.pathname.startsWith(API_ROOT)) return nativeFetch(input, init);

    const path = url.pathname.slice(API_ROOT.length) || "/";
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = await readBody(input, init);

    if (path === "/promotions") return json({ slots: [] });
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
    if (path === "/llm-calls") return json(calls);
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
      pricingSyncState = { ...pricingSyncState, last_attempted_at_ms: FIXED_NOW, last_synced_at_ms: FIXED_NOW, last_error: null };
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
      updated_at_ms: saved ? FIXED_NOW : null,
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
    created_at_ms: FIXED_NOW - order * 86_400_000,
    updated_at_ms: FIXED_NOW,
  };
}

function createOverview(params: URLSearchParams): Overview {
  const start = Number(params.get("start_ms"));
  const end = Number(params.get("end_ms"));
  const rawSupplierKeys = params.get("supplier_keys");
  const filterKeys = rawSupplierKeys ? new Set(JSON.parse(rawSupplierKeys) as string[]) : null;
  const selectedModels = filterKeys?.size ? models.filter((m) => filterKeys.has(supplierKeyFor(m))) : models;
  const duration = Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : 365 * 86_400_000;
  const granularity = duration <= 2 * 60 * 60_000 ? "minute" : duration <= 2 * 86_400_000 ? "hour" : "day";
  const step = granularity === "minute" ? 60_000 : granularity === "hour" ? 3_600_000 : 86_400_000;
  const count = granularity === "minute" ? Math.min(60, Math.max(10, Math.ceil(duration / step))) : granularity === "hour" ? Math.min(24, Math.max(8, Math.ceil(duration / step))) : Math.min(365, Math.max(7, Math.ceil(duration / step)));
  const series = createSeries(count, step, Number.isFinite(end) && end > 0 ? end : FIXED_NOW);

  const modelSummaries = createModelSummaries(selectedModels);
  const totals = series.reduce((sum, bucket) => ({
    input: sum.input + bucket.input_tokens,
    cacheRead: sum.cacheRead + bucket.cache_read_tokens,
    cacheWrite: sum.cacheWrite + bucket.cache_write_tokens,
    output: sum.output + bucket.output_tokens,
    inputNano: sum.inputNano + toNano(bucket.input_cost),
    outputNano: sum.outputNano + toNano(bucket.output_cost),
    cacheReadNano: sum.cacheReadNano + toNano(bucket.cache_read_cost),
    cacheWriteNano: sum.cacheWriteNano + toNano(bucket.cache_write_cost),
    totalNano: sum.totalNano + toNano(bucket.total_cost),
    priced: sum.priced + bucket.priced_calls,
    unpriced: sum.unpriced + bucket.unpriced_calls,
    incomplete: sum.incomplete + bucket.incomplete_usage_calls,
  }), { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, inputNano: 0, outputNano: 0, cacheReadNano: 0, cacheWriteNano: 0, totalNano: 0, priced: 0, unpriced: 0, incomplete: 0 });
  const llmCalls = Math.max(selectedModels.length, totals.priced + totals.unpriced + totals.incomplete);
  const failedCalls = Math.max(0, Math.floor(llmCalls * 0.008));

  const availableModels: OverviewFilterModel[] = models.map((model) => ({
    supplier_key: supplierKeyFor(model),
    source_kind: "builtin",
    endpoint_key: model.base_url,
    model_id: model.model_id,
    label: model.display_name,
    group: new URL(model.base_url).hostname.toLowerCase(),
    provider_type: model.type,
    plugin_icon: null,
    active: true,
  }));

  return {
    metrics: {
      llm_calls: llmCalls,
      successful_calls: llmCalls - failedCalls,
      failed_calls: failedCalls,
      token_usage: totals.input + totals.cacheRead + totals.cacheWrite + totals.output,
      prompt_tokens: totals.input + totals.cacheRead + totals.cacheWrite,
      input_tokens: totals.input,
      cache_read_tokens: totals.cacheRead,
      cache_write_tokens: totals.cacheWrite,
      output_tokens: totals.output,
      total_cost: formatNano(totals.totalNano),
      input_cost: formatNano(totals.inputNano),
      output_cost: formatNano(totals.outputNano),
      cache_read_cost: formatNano(totals.cacheReadNano),
      cache_write_cost: formatNano(totals.cacheWriteNano),
      average_priced_cost: totals.priced > 0 ? formatNano(Math.round(totals.totalNano / totals.priced)) : null,
      priced_calls: totals.priced,
      unpriced_calls: totals.unpriced,
      incomplete_usage_calls: totals.incomplete,
    },
    token_usage_granularity: granularity,
    token_usage_series: series,
    models: modelSummaries,
    available_models: availableModels,
  };
}

function createModelSummaries(selected: Model[]): OverviewModelSummary[] {
  const byModel = new Map<string, OverviewSupplierSummary[]>();
  const views = new Map(buildSupplierPricingViews().map((view) => [view.supplier_key, view]));
  for (const model of selected) {
    const key = supplierKeyFor(model);
    const matchingCalls = calls.filter((c) => c.supplier_key === key);
    const llmCalls = Math.max(1, matchingCalls.length);
    const failed = matchingCalls.filter((c) => c.status !== "completed").length;
    const input = matchingCalls.reduce((s, c) => s + (c.billed_input_tokens ?? 0), 0) || 4_800;
    const cacheRead = matchingCalls.reduce((s, c) => s + (c.cache_read_tokens ?? 0), 0) || 3_100;
    const cacheWrite = matchingCalls.reduce((s, c) => s + (c.cache_write_tokens ?? 0), 0) || 320;
    const output = matchingCalls.reduce((s, c) => s + (c.output_tokens ?? 0), 0) || 820;
    const priced = matchingCalls.filter((c) => c.cost_status === "priced").length;
    const unpriced = matchingCalls.filter((c) => !c.cost_status || c.cost_status === "unpriced").length;
    const incomplete = matchingCalls.filter((c) => c.cost_status === "incomplete_usage").length;
    const inputNano = matchingCalls.reduce((s, c) => s + toNano(c.input_cost), 0);
    const outputNano = matchingCalls.reduce((s, c) => s + toNano(c.output_cost), 0);
    const cacheReadNano = matchingCalls.reduce((s, c) => s + toNano(c.cache_read_cost), 0);
    const cacheWriteNano = matchingCalls.reduce((s, c) => s + toNano(c.cache_write_cost), 0);
    const totalNano = inputNano + outputNano + cacheReadNano + cacheWriteNano;
    const supplier: OverviewSupplierSummary = {
      supplier_key: key,
      source_kind: "builtin",
      endpoint_key: model.base_url,
      model_id: model.model_id,
      label: model.display_name,
      provider_type: model.type,
      active: true,
      pricing_source: views.get(key)?.effective_source ?? "unpriced",
      llm_calls: llmCalls,
      successful_calls: llmCalls - failed,
      failed_calls: failed,
      token_usage: input + cacheRead + cacheWrite + output,
      prompt_tokens: input + cacheRead + cacheWrite,
      input_tokens: input,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      output_tokens: output,
      total_cost: formatNano(totalNano),
      input_cost: formatNano(inputNano),
      output_cost: formatNano(outputNano),
      cache_read_cost: formatNano(cacheReadNano),
      cache_write_cost: formatNano(cacheWriteNano),
      average_priced_cost: priced > 0 ? formatNano(Math.round(totalNano / priced)) : null,
      priced_calls: priced,
      unpriced_calls: unpriced,
      incomplete_usage_calls: incomplete,
      speed: mockAggregate(matchingCalls),
    };
    const existing = byModel.get(model.model_id);
    if (existing) existing.push(supplier);
    else byModel.set(model.model_id, [supplier]);
  }
  return [...byModel.entries()].map(([model_id, providers]) => {
    const priced = providers.reduce((s, p) => s + p.priced_calls, 0);
    const totalNano = providers.reduce((s, p) => s + toNano(p.total_cost), 0);
    const matchingCallsForModel = calls.filter((call) => call.model_id === model_id);
    return {
      model_id,
      llm_calls: providers.reduce((s, p) => s + p.llm_calls, 0),
      successful_calls: providers.reduce((s, p) => s + p.successful_calls, 0),
      failed_calls: providers.reduce((s, p) => s + p.failed_calls, 0),
      token_usage: providers.reduce((s, p) => s + p.token_usage, 0),
      prompt_tokens: providers.reduce((s, p) => s + p.prompt_tokens, 0),
      input_tokens: providers.reduce((s, p) => s + p.input_tokens, 0),
      cache_read_tokens: providers.reduce((s, p) => s + p.cache_read_tokens, 0),
      cache_write_tokens: providers.reduce((s, p) => s + p.cache_write_tokens, 0),
      output_tokens: providers.reduce((s, p) => s + p.output_tokens, 0),
      total_cost: formatNano(totalNano),
      input_cost: formatNano(providers.reduce((s, p) => s + toNano(p.input_cost), 0)),
      output_cost: formatNano(providers.reduce((s, p) => s + toNano(p.output_cost), 0)),
      cache_read_cost: formatNano(providers.reduce((s, p) => s + toNano(p.cache_read_cost), 0)),
      cache_write_cost: formatNano(providers.reduce((s, p) => s + toNano(p.cache_write_cost), 0)),
      average_priced_cost: priced > 0 ? formatNano(Math.round(totalNano / priced)) : null,
      priced_calls: priced,
      unpriced_calls: providers.reduce((s, p) => s + p.unpriced_calls, 0),
      incomplete_usage_calls: providers.reduce((s, p) => s + p.incomplete_usage_calls, 0),
      speed: mockAggregate(matchingCallsForModel),
      providers,
    };
  });
}

function createSeries(count: number, step: number, end: number): OverviewTokenUsageBucket[] {
  return Array.from({ length: count }, (_, index) => {
    const wave = 0.72 + ((index * 17) % 31) / 50;
    const input = Math.round(800 * wave);
    const cacheRead = Math.round(79_200 * wave);
    const cacheWrite = Math.round(7_500 * wave);
    const output = Math.round(12_500 * wave);
    const inputNano = mulRate(input, "2.5");
    const cacheReadNano = mulRate(cacheRead, "0.3");
    const cacheWriteNano = mulRate(cacheWrite, "3.125");
    const outputNano = mulRate(output, "12.5");
    return {
      bucket_start_ms: end - (count - index) * step,
      // input : cache_read = 1 : 99，使默认口径缓存命中率恰为 99%
      input_tokens: input,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      output_tokens: output,
      input_cost: formatNano(inputNano),
      output_cost: formatNano(outputNano),
      cache_read_cost: formatNano(cacheReadNano),
      cache_write_cost: formatNano(cacheWriteNano),
      total_cost: formatNano(inputNano + outputNano + cacheReadNano + cacheWriteNano),
      priced_calls: 4,
      unpriced_calls: index % 4 === 0 ? 1 : 0,
      incomplete_usage_calls: 0,
    };
  });
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
function mockPerformance(  outputTokens: number,
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

function empty() {
  return new Response(null, { status: 204 });
}
