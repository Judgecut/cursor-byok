import type { Model, ModelType, Provider } from "../../shared/api";

export type CursorModelGrouping = "flat" | "provider" | "type";

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
  canGroupByProvider: boolean,
  canGroupByType: boolean,
): CursorModelGrouping {
  if (preferred === "provider" && !canGroupByProvider) return "flat";
  if (preferred === "type" && !canGroupByType) return "flat";
  return preferred;
}

export function cursorModelGroups(
  models: Model[],
  grouping: Exclude<CursorModelGrouping, "flat">,
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
