import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { createContext, SourceTextModule } from "node:vm";

const source = stripTypeScriptTypes(await readFile(new URL("../src/features/models/modelTestBatch.ts", import.meta.url), "utf8"));
const module = new SourceTextModule(source, { context: createContext({}) });
await module.link((specifier) =>
{
  throw new Error(`Unexpected dependency: ${specifier}`);
});
await module.evaluate();
const { runModelTestBatch } = module.namespace;
const models = ["first", "second", "third"].map((model_hash) => ({ model_hash, display_name: model_hash }));

test("batch waits for each model and continues after a failed connectivity test", async () =>
{
  const started = [];
  let finishFirst;
  const first = new Promise((resolve) =>
  {
    finishFirst = resolve;
  });
  const batch = runModelTestBatch(models, async (model) =>
  {
    started.push(model.model_hash);
    return model.model_hash === "first" ? await first : "success";
  }, new AbortController().signal);
  assert.deepEqual(started, ["first"]);
  finishFirst("failure");
  assert.deepEqual(Array.from(await batch), ["failure", "success", "success"]);
  assert.deepEqual(started, ["first", "second", "third"]);
});

test("cancelling an active batch never starts queued models", async () =>
{
  const controller = new AbortController();
  const started = [];
  const results = await runModelTestBatch(models, async (model) =>
  {
    started.push(model.model_hash);
    controller.abort();
    return "cancelled";
  }, controller.signal);
  assert.deepEqual(started, ["first"]);
  assert.deepEqual(Array.from(results), ["cancelled"]);
});

test("a batch cancelled before starting makes no request", async () =>
{
  const controller = new AbortController();
  controller.abort();
  const results = await runModelTestBatch(models, async () =>
  {
    assert.fail("cancelled batch started a request");
  }, controller.signal);
  assert.equal(results.length, 0);
});
