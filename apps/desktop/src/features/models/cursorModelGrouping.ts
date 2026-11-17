import type { Model, ModelType, Provider } from "../../shared/api";

export type CursorModelGrouping = "provider" | "type";

export type CursorModelGroup = {
  key: string;
  label: string;
  protocol: ModelType;
  provider?: Provider;
  models: Model[];
};

export function providerGroupDescriptor(model: Pick<Model, "provider_id" | "provider_name" | "type">) {
  return {
    key: model.provider_id,
    label: model.provider_name,
    protocol: model.type,
  };
}

export function typeGroupDescriptor(provider: Pick<Provider, "type" | "openai_endpoint">) {
  if (provider.type === "anthropic") return { key: "anthropic", label: "Anthropic", protocol: "anthropic" as const };
  if (provider.openai_endpoint === "/v1/chat/completions") return { key: "openai-chat", label: "OpenAI Chat", protocol: "openai" as const };
  return { key: "openai-responses", label: "OpenAI Responses", protocol: "openai" as const };
}

export function resolveCursorModelGrouping(
  preferred: CursorModelGrouping,
  canGroupByType: boolean,
): CursorModelGrouping {
  if (preferred === "type" && !canGroupByType) return "provider";
  return preferred;
}

export function replaceOrderedSubset(
  allIds: readonly string[],
  reorderedSubset: readonly string[],
): string[] {
  const subsetSet = new Set(reorderedSubset);
  if (subsetSet.size !== reorderedSubset.length) return [...allIds];
  const expectedCount = allIds.filter((id) => subsetSet.has(id)).length;
  if (expectedCount !== reorderedSubset.length) return [...allIds];
  let cursor = 0;
  return allIds.map((id) => (subsetSet.has(id) ? reorderedSubset[cursor++] : id));
}

export function cursorModelGroups(
  models: Model[],
  grouping: CursorModelGrouping,
  providers: Provider[] = [],
): CursorModelGroup[] {
  const groups = new Map<string, CursorModelGroup>();
  if (grouping === "provider") {
    for (const provider of providers) {
      groups.set(provider.provider_id, {
        key: provider.provider_id,
        label: provider.name,
        protocol: provider.type,
        provider,
        models: [],
      });
    }
  } else {
    for (const provider of providers) {
      const descriptor = typeGroupDescriptor(provider);
      if (!groups.has(descriptor.key)) {
        groups.set(descriptor.key, { ...descriptor, models: [] });
      }
    }
  }
  for (const model of models) {
    const descriptor = grouping === "provider" ? providerGroupDescriptor(model) : typeGroupDescriptor(model);
    const group = groups.get(descriptor.key);
    if (group) {
      group.models.push(model);
    } else {
      groups.set(descriptor.key, { ...descriptor, models: [model] });
    }
  }
  return [...groups.values()];
}
