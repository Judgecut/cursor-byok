import { useRef } from "react";
import geminiIconUrl from "../../shared/assets/provider-icons/gemini.png";
import type { Model, ModelInput, RequestFormat, Provider } from "../../shared/api";
import { modelPresets, requestFormatLabels, trimTrailingSlash } from "../../shared/utils/modelPresets";
import { Button } from "../../shared/ui/Button";
import { FormField, TextInput } from "../../shared/ui/FormControls";
import { Combobox, Select, type ComboboxHandle } from "../../shared/ui/Select";
import { claudeIcon, openAiIcon } from "../../shared/ui/icons";
import { parseObject, ToggleJsonField } from "./CursorProviderEditor";
import styles from "./CursorSettings.module.scss";

export type CursorModelDraft = {
  model: Omit<ModelInput, "request_format"> & { request_format: RequestFormat | "" };
  extraParamsText: string;
};

export const emptyCursorModelDraft = (provider?: Provider | null, format: RequestFormat | "" = ""): CursorModelDraft => ({
  extraParamsText: "{}",
  model: {
    provider_id: provider?.provider_id ?? "",
    request_format: format,
    request_url_override: null,
    extra_params_enabled: false,
    extra_params: {},
    sort_order: 0,
    display_name: "",
    tooltip_data: provider?.name ?? "",
    model_id: "",
    reasoning_effort: null,
    context_window_tokens: null,
    max_output_tokens: null,
    anthropic_thinking_effort: format === "anthropic" ? "xhigh" : null,
    thinking_budget_tokens: null,
  },
});

export function modelDraftFrom(model: Model): CursorModelDraft {
  return {
    extraParamsText: JSON.stringify(model.extra_params, null, 2),
    model: {
      provider_id: model.provider_id,
      request_format: model.request_format,
      request_url_override: model.request_url_override,
      extra_params_enabled: model.extra_params_enabled,
      extra_params: model.extra_params,
      sort_order: model.sort_order,
      display_name: model.display_name,
      tooltip_data: model.tooltip_data,
      model_id: model.model_id,
      reasoning_effort: model.reasoning_effort,
      context_window_tokens: model.context_window_tokens,
      max_output_tokens: model.max_output_tokens,
      anthropic_thinking_effort: model.request_format === "anthropic" ? model.anthropic_thinking_effort || "xhigh" : null,
      thinking_budget_tokens: model.request_format === "anthropic" ? model.thinking_budget_tokens : null,
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
  const request_format = draft.model.request_format;
  if (!request_format)
  {
    throw new Error(t("请选择请求格式"));
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
    request_format,
    request_url_override: draft.model.request_url_override?.trim() || null,
    extra_params: parseObject(draft.extraParamsText, t("额外请求参数")),
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
  onDiscover: (providerId: string, format: RequestFormat, requestUrlOverride: string | null) => Promise<boolean>;
}) {
  const modelCombobox = useRef<ComboboxHandle>(null);
  const selectedProvider = providers.find((item) => item.provider_id === draft.model.provider_id) ?? providers[0] ?? null;
  const format = draft.model.request_format;
  const setModel = (patch: Partial<CursorModelDraft["model"]>) => onChange({ ...draft, model: { ...draft.model, ...patch } });
  const setProvider = (provider_id: string) => {
    const next = providers.find((item) => item.provider_id === provider_id);
    const shouldSyncTooltip = !draft.model.tooltip_data.trim() || draft.model.tooltip_data === selectedProvider?.name;
    setModel({
      provider_id,
      ...(shouldSyncTooltip && next ? { tooltip_data: next.name } : {}),
      request_url_override: provider_id === draft.model.provider_id ? draft.model.request_url_override : null,
    });
  };
  const numberValue = (value: string) => value === "" ? null : Math.trunc(Number(value));
  const canDiscover = Boolean(format && selectedProvider && selectedProvider.base_url.trim() && selectedProvider.api_key.trim());
  const presetEntries = selectedProvider
    ? modelPresets
      .filter((preset) => preset.endpoints.some((endpoint) => endpoint.format === format && trimTrailingSlash(endpoint.baseUrl) === trimTrailingSlash(selectedProvider.base_url.trim())))
      .flatMap((preset) => preset.models)
    : [];
  const combinedOptions = [...new Set([...modelOptions, ...presetEntries.map((item) => item.model_id)])];
  const discoverModels = async () => {
    if (format && selectedProvider && await onDiscover(selectedProvider.provider_id, format, draft.model.request_url_override)) {
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
  }));

  return <div className={styles.editor}>
    <div className={styles.grid}>
      <FormField className={styles.fullWidth} label={t("所属供应商")} hint={t("供应商提供基础地址、API Key 和公共请求头。")}>
        <Select ariaLabel={t("所属供应商")} value={selectedProvider?.provider_id ?? ""} options={providerOptions} onChange={setProvider} />
      </FormField>

      <FormField label={t("请求格式")}>
        <Select ariaLabel={t("请求格式")} value={format} options={[
          { value: "", label: t("请选择请求格式") },
          { value: "openai-chat", label: requestFormatLabels["openai-chat"], icon: openAiIcon },
          { value: "openai-responses", label: requestFormatLabels["openai-responses"], icon: openAiIcon },
          { value: "anthropic", label: requestFormatLabels.anthropic, icon: claudeIcon },
          { value: "gemini", label: requestFormatLabels.gemini, iconSrc: geminiIconUrl },
        ]} onChange={(value) => setModel({ request_format: value as RequestFormat | "", reasoning_effort: null, anthropic_thinking_effort: value === "anthropic" ? "xhigh" : null, thinking_budget_tokens: null })} />
      </FormField>
      <FormField label={t("完整请求 URL")} hint={t("留空时，系统会在供应商地址后追加所选格式的标准端点。")}>
        <TextInput placeholder={t("留空使用标准端点")} value={draft.model.request_url_override ?? ""} onChange={(event) => setModel({ request_url_override: event.target.value })} />
      </FormField>

      <FormField label={t("模型名称")} hint={t("可以直接输入模型标识，也可以读取接口返回的模型列表。")}>
        <Combobox
          ref={modelCombobox}
          value={draft.model.model_id}
          options={combinedOptions}
          placeholder={format === "gemini" ? "gemini-2.5-flash" : format === "anthropic" ? "claude-opus-4-6" : "gpt-5"}
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

      {format && format !== "gemini" && (format !== "anthropic" ? (
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
      </>)}
      <ToggleJsonField
        label={t("额外请求参数")}
        enabled={draft.model.extra_params_enabled}
        text={draft.extraParamsText}
        onEnabledChange={(extra_params_enabled) => setModel({ extra_params_enabled })}
        onTextChange={(extraParamsText) => onChange({ ...draft, extraParamsText })}
      />
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
