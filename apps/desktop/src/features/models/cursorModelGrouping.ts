import type { Model, RequestFormat, Provider } from "../../shared/api";

export type CursorModelGrouping = "provider" | "type";

export type CursorModelGroup = {
  key: string;
  label: string;
  protocol?: RequestFormat;
  provider?: Provider;
  models: Model[];
};

const formatLabels: Record<RequestFormat, string> = {
  "openai-chat": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  anthropic: "Anthropic Messages",
  gemini: "Gemini",
};

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
        provider,
        models: [],
      });
    }
  }
  for (const model of models)
  {
    const format = model.request_format;
    const descriptor = grouping === "provider"
      ? { key: model.provider_id, label: model.provider_name }
      : { key: format, label: formatLabels[format], protocol: format };
    const group = groups.get(descriptor.key);
    if (group) {
      group.models.push(model);
    } else {
      groups.set(descriptor.key, { ...descriptor, models: [model] });
    }
  }
  return [...groups.values()];
}
