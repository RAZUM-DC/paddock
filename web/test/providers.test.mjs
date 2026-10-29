import { test } from "node:test";
import assert from "node:assert/strict";
import { configuredProviderModels } from "../lib/providers.ts";

test("configuredProviderModels: the active custom provider's default model", () => {
  const [m, ...rest] = configuredProviderModels({ model_provider: "corp", model: "m1", model_providers: { corp: { name: "Corp LLM", env_key: "LLM_API_KEY" } } });
  assert.equal(rest.length, 0);
  assert.deepEqual({ model: m.model, provider: m.provider, providerName: m.providerName, isDefault: m.isDefault }, { model: "m1", provider: "corp", providerName: "Corp LLM", isDefault: true });
});

test("configuredProviderModels: nothing for openai, neuraldeep, missing block or model", () => {
  assert.deepEqual(configuredProviderModels({ model_provider: "openai", model: "gpt", model_providers: { openai: {} } }), []);
  assert.deepEqual(configuredProviderModels({ model_provider: "neuraldeep", model: "x", model_providers: { neuraldeep: {} } }), []);
  assert.deepEqual(configuredProviderModels({ model_provider: "corp", model: "m1" }), []);
  assert.deepEqual(configuredProviderModels({ model_provider: "corp", model_providers: { corp: {} } }), []);
  assert.deepEqual(configuredProviderModels(null), []);
});

test("configuredProviderModels: name falls back to the id", () => {
  assert.equal(configuredProviderModels({ model_provider: "corp", model: "m1", model_providers: { corp: {} } })[0].providerName, "corp");
});
