import { useRef } from "react";
import type { Model, ModelInput, ModelType, Provider } from "../../shared/api";
import { modelPresets, presetEndpoint, trimTrailingSlash } from "../../shared/utils/modelPresets";
import { Button } from "../../shared/ui/Button";
import { FormField, TextInput } from "../../shared/ui/FormControls";
import { Combobox, Select, type ComboboxHandle } from "../../shared/ui/Select";
import { claudeIcon, openAiIcon } from "../../shared/ui/icons";
import styles from "./CursorSettings.module.scss";

export type CursorModelDraft = {
  model: ModelInput;
};

export const emptyCursorModelDraft = (provider?: Provider | null): CursorModelDraft => ({
  model: {
    provider_id: provider?.provider_id ?? "",
    sort_order: 0,
    display_name: "",
    tooltip_data: provider?.name ?? "",
    model_id: "",
    reasoning_effort: null,
    context_window_tokens: null,
    max_output_tokens: null,
    anthropic_thinking_effort: provider?.type === "anthropic" ? "xhigh" : null,
    thinking_budget_tokens: null,
  },
});

export function modelDraftFrom(model: Model): CursorModelDraft {
  return {
    model: {
      provider_id: model.provider_id,
      sort_order: model.sort_order,
      display_name: model.display_name,
      tooltip_data: model.tooltip_data,
      model_id: model.model_id,
      reasoning_effort: model.reasoning_effort,
      context_window_tokens: model.context_window_tokens,
      max_output_tokens: model.max_output_tokens,
      anthropic_thinking_effort: model.type === "anthropic" ? model.anthropic_thinking_effort || "xhigh" : null,
      thinking_budget_tokens: model.type === "anthropic" ? model.thinking_budget_tokens : null,
    },
  };
}

export function modelDraftInput(draft: CursorModelDraft): ModelInput {
  const model_id = draft.model.model_id.trim();
  const display_name = (draft.model.display_name.trim() || model_id).trim();
  const tooltip_data = draft.model.tooltip_data.trim();
  if (!draft.model.provider_id.trim() || !model_id || !display_name || !tooltip_data) {
    throw new Error(t("所属供应商、模型名称、显示名称和备注不能为空"));
  }
  for (const [label, value] of [
    [t("上下文窗口 Token"), draft.model.context_window_tokens],
    [t("最大输出 Token"), draft.model.max_output_tokens],
    [t("思考预算 Token"), draft.model.thinking_budget_tokens],
  ] as const) {
    if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(t("{label} 必须是大于 0 的整数", { label }));
    }
  }
  return {
    ...draft.model,
    provider_id: draft.model.provider_id.trim(),
    model_id,
    display_name,
    tooltip_data,
  };
}

export function CursorModelEditor({ draft, providers, modelOptions, discovering, onChange, onDiscover }: {
  draft: CursorModelDraft;
  providers: Provider[];
  modelOptions: string[];
  discovering: boolean;
  onChange: (draft: CursorModelDraft) => void;
  onDiscover: (providerId: string) => Promise<boolean>;
}) {
  const modelCombobox = useRef<ComboboxHandle>(null);
  const selectedProvider = providers.find((item) => item.provider_id === draft.model.provider_id) ?? providers[0] ?? null;
  const providerType: ModelType = selectedProvider?.type ?? "openai";
  const setModel = (patch: Partial<ModelInput>) => onChange({ model: { ...draft.model, ...patch } });
  const setProvider = (provider_id: string) => {
    const next = providers.find((item) => item.provider_id === provider_id);
    const shouldSyncTooltip = !draft.model.tooltip_data.trim() || draft.model.tooltip_data === selectedProvider?.name;
    setModel({
      provider_id,
      ...(shouldSyncTooltip && next ? { tooltip_data: next.name } : {}),
      anthropic_thinking_effort: next?.type === "anthropic" ? draft.model.anthropic_thinking_effort || "xhigh" : null,
    });
  };
  const numberValue = (value: string) => value === "" ? null : Math.trunc(Number(value));
  const canDiscover = Boolean(selectedProvider && selectedProvider.base_url.trim() && selectedProvider.api_key.trim());
  const presetEntries = selectedProvider
    ? modelPresets
      .filter((preset) => trimTrailingSlash(presetEndpoint(preset, providerType).baseUrl) === trimTrailingSlash(selectedProvider.base_url.trim()))
      .flatMap((preset) => preset.models)
    : [];
  const combinedOptions = [...new Set([...modelOptions, ...presetEntries.map((item) => item.model_id)])];
  const discoverModels = async () => {
    if (selectedProvider && await onDiscover(selectedProvider.provider_id)) {
      modelCombobox.current?.openAll();
    }
  };
  const changeModelId = (model_id: string) => {
    const presetModel = presetEntries.find((item) => item.model_id === model_id);
    const shouldSyncDisplayName = !draft.model.display_name.trim() || draft.model.display_name === draft.model.model_id;
    setModel({
      model_id,
      ...(shouldSyncDisplayName ? { display_name: presetModel?.display_name ?? model_id } : {}),
      ...(presetModel && draft.model.context_window_tokens == null ? { context_window_tokens: presetModel.context_window_tokens } : {}),
      ...(presetModel && draft.model.max_output_tokens == null ? { max_output_tokens: presetModel.max_output_tokens } : {}),
    });
  };
  const providerOptions = providers.map((provider) => ({
    value: provider.provider_id,
    label: provider.name,
    icon: provider.type === "anthropic" ? claudeIcon : openAiIcon,
  }));

  return <div className={styles.editor}>
    <div className={styles.grid}>
      <FormField className={styles.fullWidth} label={t("所属供应商")} hint={t("接口地址、API Key 与请求格式由所属供应商统一管理。")}>
        <Select ariaLabel={t("所属供应商")} value={selectedProvider?.provider_id ?? ""} options={providerOptions} onChange={setProvider} />
      </FormField>

      <FormField label={t("模型名称")} hint={t("可以直接输入模型标识，也可以读取接口返回的模型列表。")}>
        <Combobox
          ref={modelCombobox}
          value={draft.model.model_id}
          options={combinedOptions}
          placeholder={providerType === "anthropic" ? "claude-opus-4-6" : "gpt-5"}
          append={<Button className={styles.discoverButton} disabled={discovering || !canDiscover} onClick={() => void discoverModels()}>{discovering ? t("获取中…") : t("获取模型")}</Button>}
          onChange={changeModelId}
        />
      </FormField>
      <FormField label={t("显示名称")} hint={t("仅用于界面展示，不会改变发送给模型服务的模型名称。")}>
        <TextInput placeholder={t("例如：主力模型")} value={draft.model.display_name} onChange={(event) => setModel({ display_name: event.target.value })} />
      </FormField>
      <FormField className={styles.fullWidth} label={t("备注")} hint={t("显示在 Cursor 模型说明中。")}>
        <TextInput placeholder={t("请输入模型备注")} value={draft.model.tooltip_data} onChange={(event) => setModel({ tooltip_data: event.target.value })} />
      </FormField>

      <FormField label={t("上下文窗口 Token")} hint={t("留空时使用默认值。")}>
        <TextInput type="number" min={1} step={1} placeholder={t("留空使用默认值")} value={draft.model.context_window_tokens ?? ""} onChange={(event) => setModel({ context_window_tokens: numberValue(event.target.value) })} />
      </FormField>
      <FormField label={t("最大输出 Token")} hint={t("留空时使用默认值。")}>
        <TextInput type="number" min={1} step={1} placeholder={t("留空使用默认值")} value={draft.model.max_output_tokens ?? ""} onChange={(event) => setModel({ max_output_tokens: numberValue(event.target.value) })} />
      </FormField>

      {providerType === "openai" ? (
        <FormField label={t("推理强度")}>
          <Select ariaLabel={t("推理强度")} value={draft.model.reasoning_effort ?? ""} options={effortOptions(true)} onChange={(value) => setModel({ reasoning_effort: value || null })} />
        </FormField>
      ) : <>
        <FormField label={t("思考强度")}>
          <Select ariaLabel={t("思考强度")} value={draft.model.anthropic_thinking_effort ?? "xhigh"} options={effortOptions(false)} onChange={(anthropic_thinking_effort) => setModel({ anthropic_thinking_effort })} />
        </FormField>
        <FormField label={t("思考预算 Token")} hint={t("留空时使用 adaptive thinking。")}>
          <TextInput type="number" min={1} step={1} placeholder={t("留空使用 adaptive thinking")} value={draft.model.thinking_budget_tokens ?? ""} onChange={(event) => setModel({ thinking_budget_tokens: numberValue(event.target.value) })} />
        </FormField>
      </>}
    </div>
  </div>;
}

function effortOptions(optional: boolean) {
  return [
    ...(optional ? [{ value: "", label: t("不设置") }] : []),
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "Extra High" },
    { value: "max", label: "Max" },
  ];
}
