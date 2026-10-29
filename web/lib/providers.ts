// Model providers configured in the harness's config.toml. Pure: unit-tested in test/providers.test.mjs.
export type ProviderModel = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  provider: string;
  providerName: string;
};

// model_provider from config.toml when it is a custom provider other than NeuralDeep (which has its own tab and model
// list): one entry for its default model, so the picker shows it as the active choice under the provider's name.
export function configuredProviderModels(cfg: any): ProviderModel[] {
  const id = cfg?.model_provider;
  const p = id ? cfg?.model_providers?.[id] : null;
  if (!id || id === "openai" || id === "neuraldeep" || !p || !cfg.model) return [];
  return [{
    id: `${id}:${cfg.model}`,
    model: cfg.model,
    displayName: cfg.model,
    description: "",
    isDefault: true,
    defaultReasoningEffort: "",
    supportedReasoningEfforts: [],
    provider: id,
    providerName: typeof p.name === "string" && p.name ? p.name : id,
  }];
}
