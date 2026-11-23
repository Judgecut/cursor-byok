import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { createContext, SourceTextModule } from "node:vm";

const source = stripTypeScriptTypes(
  await readFile(new URL("../src/features/models/cursorModelGrouping.ts", import.meta.url), "utf8"),
);
const context = createContext({ Map, Set });
const module = new SourceTextModule(source, { context });
await module.link((specifier) => {
  throw new Error(`Unexpected dependency: ${specifier}`);
});
await module.evaluate();

const { cursorModelGroups, replaceOrderedSubset, resolveCursorModelGrouping } = module.namespace;

function provider(overrides) {
  return {
    provider_id: "p1",
    sort_order: 1,
    name: "OpenAI",
    base_url: "https://api.openai.com",
    api_key: "sk-test",
    custom_headers_enabled: false,
    custom_headers: {},
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
    request_format: "openai-responses",
    base_url: "https://api.openai.com",
    api_key: "sk-test",
    request_url_override: null,
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

test("resolveCursorModelGrouping keeps provider as default and falls back from type when fewer than two types exist", () => {
  assert.equal(resolveCursorModelGrouping("provider", false), "provider");
  assert.equal(resolveCursorModelGrouping("provider", true), "provider");
  assert.equal(resolveCursorModelGrouping("type", false), "provider");
  assert.equal(resolveCursorModelGrouping("type", true), "type");
});

test("cursorModelGroups retains empty providers and preserves provider/model order in provider and type groupings", () => {
  const providers = [
    provider({ provider_id: "p-oai", name: "OpenAI Official" }),
    provider({ provider_id: "p-ant-empty", name: "Anthropic Empty" }),
    provider({ provider_id: "p-oai-2", name: "OpenAI Backup" }),
  ];
  const models = [
    model({ model_hash: "m2", provider_id: "p-oai", provider_name: "OpenAI Official", display_name: "GPT-5 Mini" }),
    model({ model_hash: "m1", provider_id: "p-oai", provider_name: "OpenAI Official", display_name: "GPT-5", request_format: "anthropic" }),
    model({ model_hash: "m3", provider_id: "p-oai-2", provider_name: "OpenAI Backup", display_name: "GPT-4.1" }),
  ];

  const byProvider = Array.from(cursorModelGroups(models, "provider", providers), (group) => ({
    key: group.key,
    label: group.label,
    hasProvider: Boolean(group.provider),
    modelHashes: Array.from(group.models, (item) => item.model_hash),
  }));
  assert.deepEqual(byProvider, [
    { key: "p-oai", label: "OpenAI Official", hasProvider: true, modelHashes: ["m2", "m1"] },
    { key: "p-ant-empty", label: "Anthropic Empty", hasProvider: true, modelHashes: [] },
    { key: "p-oai-2", label: "OpenAI Backup", hasProvider: true, modelHashes: ["m3"] },
  ]);

  const byType = Array.from(cursorModelGroups(models, "type", providers), (group) => ({
    key: group.key,
    label: group.label,
    modelHashes: Array.from(group.models, (item) => item.model_hash),
  }));
  assert.deepEqual(byType, [
    { key: "openai-responses", label: "OpenAI Responses", modelHashes: ["m2", "m3"] },
    { key: "anthropic", label: "Anthropic Messages", modelHashes: ["m1"] },
  ]);
});

test("replaceOrderedSubset splices reordered subset back into original slots", () => {
  assert.deepEqual(
    Array.from(replaceOrderedSubset(["p-oai-1", "p-ant", "p-oai-2", "p-chat"], ["p-oai-2", "p-oai-1"])),
    ["p-oai-2", "p-ant", "p-oai-1", "p-chat"],
  );
  assert.deepEqual(
    Array.from(replaceOrderedSubset(["p1", "p2"], ["p1", "p1"])),
    ["p1", "p2"],
  );
  assert.deepEqual(
    Array.from(replaceOrderedSubset(["p1", "p2"], ["p1"])),
    ["p1", "p2"],
  );
});
