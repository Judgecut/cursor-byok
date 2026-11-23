import { test as base, expect } from "@playwright/test";
import type { CallDetail, ExchangeRateSyncState, InterfaceSettings, Model, ModelInput, Overview, PricingSettings, Provider, ProviderInput } from "../../src/shared/api";

type ManagementState = {
  providers: Provider[];
  models: Model[];
  settings: InterfaceSettings;
  pricingSettings: PricingSettings;
  exchangeRateSync: ExchangeRateSyncState;
  nextExchangeRateSnapshot: ExchangeRateSyncState["snapshot"];
  overview: Overview;
  call: CallDetail;
  writes: Array<{ path: string; body: unknown }>;
  openedUrls: string[];
};

const callSummary = {
    call_kind: "provider_llm", route: "local_byok", call_id: "smoke-call", run_id: "smoke-run", conversation_id: "smoke-conversation", provider_call_index: 1, model_hash: "smoke-model", supplier_key: null, endpoint_key: null, provider_type: "openai", provider_url: "https://provider.example", request_type: "responses", request_url: "https://provider.example/v1/responses", model_id: "smoke-model", display_name: "Smoke call model", reasoning_effort: null, fast: false, status: "completed", finish_reason: "stop", created_at_ms: 1_800_000_000_000, ttfb_ms: 100, ttft_ms: 100, ttfr_ms: null, ttfo_ms: 100, duration_ms: 1100, generation_ms: 1000, generation_output_events: 10, streaming: true, call_origin: "run", observed_thinking: false,
    performance: { overall_tokens_per_second: 90.9, overall_reason: null, speed_status: "measured", tokens_per_second: 100, reason: null, first_output_ms: 100, generation_ms: 1000 },
    input_tokens: 200, billed_input_tokens: 200, output_tokens: 100, total_tokens: 300, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, pricing_source: "unpriced", pricing_provider_id: null, pricing_model_id: null, pricing_snapshot_at_ms: null, unit_input_per_million: null, unit_output_per_million: null, unit_cache_read_per_million: null, unit_cache_write_per_million: null, cost_status: "unpriced", cost_basis: null, assumed_cache_hit_rate_bps: null, estimated_cache_read_tokens: null, input_cost: null, output_cost: null, cache_read_cost: null, cache_write_cost: null, total_cost: null, cost_calculated_at_ms: null, cost_backfilled: false, message_count: 1, tool_count: 0, http_status: 200, error_kind: null, error_message: null, detailed: false,
} as const;

const call: CallDetail = {
  call: callSummary,
  request: null,
  response_chunks: [],
  cursor_trace: null,
};

const overview: Overview = {
  metrics: { llm_calls: 1, successful_calls: 1, failed_calls: 0, token_usage: 300, prompt_tokens: 200, input_tokens: 200, reported_cache_input_tokens: 200, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 100, total_cost: "0", input_cost: "0", output_cost: "0", cache_read_cost: "0", cache_write_cost: "0", average_priced_cost: null, priced_calls: 0, unpriced_calls: 1, incomplete_usage_calls: 0, unreported_cache_calls: 0, assumed_cache_calls: 0, assumed_cache_cost: "0", estimated_cache_read_tokens: 0, speed: { average_tokens_per_second: 100, output_tokens: 100, generation_ms: 1000, samples: 1, first_output_median_ms: 100 } },
  token_usage_granularity: "day", token_usage_series: [], activity_series: [], suppliers: [], models: [], available_suppliers: [], available_models: [],
};

// Only the HTTP/native boundary is simulated. The production build supplies React,
// routing, stores, API serialization, virtualization, and static i18n transforms.
export const test = base.extend<{ management: ManagementState }>({
  management: [async ({ context }, use) =>
  {
    const settings = { sidebar_collapsed: false, locale: "system", theme: "default-dark", currency: "USD", cny_rate: null, eur_rate: null, jpy_rate: null, twd_rate: null, try_rate: null, krw_rate: null, overview_range_preset: "today", overview_chart_mode: "tokens", overview_chart_type: "bar", overview_calendar_window: "year", overview_calendar_chart_type: "heatmap", home_refresh_interval_seconds: 30 } as const;
    const state: ManagementState = {
      providers: [],
      models: [],
      settings,
      pricingSettings: { assumed_cache_hit_rate_bps: 9_000 },
      exchangeRateSync: { auto_sync_enabled: true, snapshot: null, last_attempted_at_ms: null, last_synced_at_ms: null, last_error: null, syncing: false },
      nextExchangeRateSnapshot: null,
      overview: structuredClone(overview),
      call: structuredClone(call),
      writes: [],
      openedUrls: [],
    };
    const unexpected: string[] = [];
    const errors: string[] = [];
    context.on("page", (page) =>
    {
      page.on("pageerror", (error) => errors.push(error.message));
    });
    await context.route("**/__byok-api__/api/**", async (route) =>
    {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace("/__byok-api__/api", "");
      const method = request.method();
      const body = request.postData() ? request.postDataJSON() : undefined;
      if (method !== "GET")
      {
        state.writes.push({ path, body });
      }
      let response: unknown;
      if (path === "/providers" && method === "POST")
      {
        const provider: Provider = { ...body as ProviderInput, provider_id: "smoke-provider", created_at_ms: 1, updated_at_ms: 1 };
        state.providers.push(provider);
        response = provider;
      }
      else if (path === "/models" && method === "POST")
      {
        const inputs = (body as { models: ModelInput[] }).models;
        const created = inputs.map((input, index): Model =>
        {
          const provider = state.providers.find((item) => item.provider_id === input.provider_id);
          expect(provider).toBeDefined();
          return { ...provider!, ...input, model_hash: `smoke-model-${state.models.length + index}`, provider_name: provider!.name, created_at_ms: 1, updated_at_ms: 1 };
        });
        state.models.push(...created);
        response = created;
      }
      else if (path === "/providers/smoke-provider/discover" && method === "POST")
      {
        response = { models: body.request_format === "anthropic" ? ["discovered-claude"] : ["discovered-gpt"] };
      }
      else if (path.startsWith("/models/") && method === "PUT")
      {
        const hash = path.split("/").at(-1);
        const model = state.models.find((item) => item.model_hash === hash);
        expect(model).toBeDefined();
        Object.assign(model!, body);
        response = model;
      }
      else if (path === "/settings/interface" && method === "PUT")
      {
        Object.assign(state.settings, body);
        response = state.settings;
      }
      else if (path === "/settings/exchange-rates")
      {
        const sync = state.exchangeRateSync;
        if (method === "PUT")
        {
          sync.auto_sync_enabled = body.auto_sync_enabled;
        }
        if (method === "POST")
        {
          sync.last_attempted_at_ms = Date.now();
          if (state.nextExchangeRateSnapshot)
          {
            sync.snapshot = structuredClone(state.nextExchangeRateSnapshot);
            sync.last_synced_at_ms = sync.last_attempted_at_ms;
            sync.last_error = null;
          }
          else
          {
            sync.last_error = "Test feeds unavailable";
          }
        }
        response = sync;
      }
      else if (path === "/settings/commit" && method === "PUT")
      {
        response = { ...body, default_prompt: "Write a commit message." };
      }
      else if (path === "/pricing/settings" && method === "PUT")
      {
        state.pricingSettings = body as PricingSettings;
        response = state.pricingSettings;
      }
      else if (path === "/desktop/open-external-url" && method === "POST")
      {
        state.openedUrls.push(body.url);
        await route.fulfill({ status: 204 });
        return;
      }
      else if (method === "GET")
      {
        const responses: Record<string, unknown> = {
          "/providers": state.providers,
          "/models": state.models,
          "/overview": state.overview,
          "/llm-calls": { items: [state.call.call], total: 1 },
          "/llm-calls/smoke-call": state.call,
          "/settings/interface": state.settings,
          "/settings/observability": { detailed: false },
          "/settings/ports": { proxy_port: 0, service_port: 0 },
          "/settings/storage/statistics": { call_count: 1, trace_count: 0 },
          "/settings/proxy": { mode: "default", address: "", auth_enabled: false, username: "", has_password: false },
          "/settings/tab": { mode: "public", address: "" },
          "/settings/desktop": { silent_start: false, show_dock_icon: true },
          "/settings/external-api": { enabled: false, api_key: "" },
          "/settings/commit": { model_id: "", prompt: "", prompt_locale: "en-US", default_prompt: "Write a commit message." },
          "/pricing/models": [],
          "/pricing/settings": state.pricingSettings,
          "/pricing/sync": { auto_sync_enabled: false, sync_interval_hours: 24, catalog_model_count: 0, last_attempted_at_ms: null, last_synced_at_ms: null, last_error: null, syncing: false, backfilling: false },
          "/harness/cursor/status": { platform: "windows", ca: "ready", configured_models: state.models.length, enabled_models: 0, integration: "disabled", settings_applied: false, proxy_url: null, ca_install_command: null },
          "/plugins": [],
          "/promotions": { slots: [] },
          "/plugins/runtime": { state: "ready", version: "test", target: null, phase: null, downloaded_bytes: 0, total_bytes: null, error: null },
        };
        response = responses[path];
      }
      if (response === undefined)
      {
        unexpected.push(`${method} ${path}`);
        await route.fulfill({ status: 501, json: { message: `Unhandled test request: ${method} ${path}` } });
        return;
      }
      await route.fulfill({ json: response });
    });
    await use(state);
    expect(unexpected, "all management requests use explicit fixtures").toEqual([]);
    expect(errors, "production modules render without browser exceptions").toEqual([]);
  }, { auto: true }],
});

export { expect };
