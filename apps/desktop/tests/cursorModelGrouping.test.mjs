import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { createContext, SourceTextModule } from "node:vm";

const source = stripTypeScriptTypes(
  await readFile(new URL("../src/features/models/cursorModelGrouping.ts", import.meta.url), "utf8"),
);
const context = createContext({ Map });
const module = new SourceTextModule(source, { context });
await module.link((specifier) => {
  throw new Error(`Unexpected dependency: ${specifier}`);
});
await module.evaluate();

const { cursorModelGroups, resolveCursorModelGrouping } = module.namespace;

function provider(overrides) {
  return {
    provider_id: "p1",
    sort_order: 1,
    name: "OpenAI",
    type: "openai",
    base_url: "https://api.openai.com",
    use_full_url: false,
    api_key: "sk-test",
    openai_endpoint: "/v1/responses",
    custom_headers_enabled: false,
    custom_headers: {},
    extra_params_enabled: false,
    extra_params: {},
    created_at_ms: 1,
    updated_at_ms: 1,
    ...overrides,
  };
}

function model(overrides) {
  return {
    model_hash: "m1",
    provider_id: "p1",
    provider_name: "OpenAI",
    sort_order: 1,
    display_name: "GPT-5",
    type: "openai",
    base_url: "https://api.openai.com",
    use_full_url: false,
    api_key: "sk-test",
    openai_endpoint: "/v1/responses",
    custom_headers_enabled: false,
    custom_headers: {},
    extra_params_enabled: false,
    extra_params: {},
    tooltip_data: "OpenAI",
    model_id: "gpt-5",
    reasoning_effort: "high",
    context_window_tokens: null,
    max_output_tokens: null,
    anthropic_thinking_effort: null,
    thinking_budget_tokens: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    ...overrides,
  };
}

test("resolveCursorModelGrouping keeps default provider preference across async initial load", () => {
  // Before async providers load, render flat without clobbering the preferred "provider" state.
  assert.equal(resolveCursorModelGrouping("provider", false, false), "flat");
  // Once providers load, default view immediately resolves back to "provider".
  assert.equal(resolveCursorModelGrouping("provider", true, false), "provider");
  // Explicit user selection of "flat" stays "flat" even when providers are present.
  assert.equal(resolveCursorModelGrouping("flat", true, true), "flat");
  // "type" resolves to "type" once >1 type exists, otherwise displays "flat".
  assert.equal(resolveCursorModelGrouping("type", true, false), "flat");
  assert.equal(resolveCursorModelGrouping("type", true, true), "type");
});

test("cursorModelGroups retains empty providers in both provider and type groupings", () => {
  const providers = [
    provider({ provider_id: "p-oai", name: "OpenAI Official", type: "openai", openai_endpoint: "/v1/responses" }),
    provider({ provider_id: "p-ant-empty", name: "Anthropic Empty", type: "anthropic", openai_endpoint: "" }),
  ];
  const models = [
    model({ model_hash: "m1", provider_id: "p-oai", provider_name: "OpenAI Official" }),
  ];

  const byProvider = Array.from(cursorModelGroups(models, "provider", providers), (group) => ({
    key: group.key,
    label: group.label,
    hasProvider: Boolean(group.provider),
    modelCount: group.models.length,
  }));
  assert.deepEqual(byProvider, [
    { key: "p-oai", label: "OpenAI Official", hasProvider: true, modelCount: 1 },
    { key: "p-ant-empty", label: "Anthropic Empty", hasProvider: true, modelCount: 0 },
  ]);

  const byType = Array.from(cursorModelGroups(models, "type", providers), (group) => ({
    key: group.key,
    label: group.label,
    modelCount: group.models.length,
  }));
  assert.deepEqual(byType, [
    { key: "openai-responses", label: "OpenAI Responses", modelCount: 1 },
    { key: "anthropic", label: "Anthropic", modelCount: 0 },
  ]);
});
