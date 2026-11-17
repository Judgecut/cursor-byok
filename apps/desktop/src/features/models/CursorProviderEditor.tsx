import type { ModelType, Provider, ProviderInput } from "../../shared/api";
import { defaultCustomHeadersText } from "../../shared/utils/modelDefaults";
import { modelPresets, presetEndpoint, trimTrailingSlash, type ModelPreset } from "../../shared/utils/modelPresets";
import { Checkbox } from "../../shared/ui/Checkbox";
import { FormField, SecretTextInput, TextInput } from "../../shared/ui/FormControls";
import { JsonEditor } from "../../shared/ui/JsonEditor";
import { Select } from "../../shared/ui/Select";
import { Switch } from "../../shared/ui/Switch";
import { claudeIcon, openAiIcon } from "../../shared/ui/icons";
import { CursorPresetChips } from "./CursorPresetChips";
import styles from "./CursorSettings.module.scss";

export type CursorProviderDraft = {
  provider: ProviderInput;
  customHeadersText: string;
  extraParamsText: string;
};

export const emptyCursorProviderDraft = (): CursorProviderDraft => ({
  provider: {
    sort_order: 0,
    name: "",
    type: "openai",
    base_url: "",
    use_full_url: false,
    api_key: "",
    openai_endpoint: "/v1/responses",
    custom_headers_enabled: false,
    custom_headers: {},
    extra_params_enabled: false,
    extra_params: {},
  },
  customHeadersText: defaultCustomHeadersText,
  extraParamsText: "{}",
});

export function providerDraftFrom(provider: Provider): CursorProviderDraft {
  const { provider_id: _id, created_at_ms: _created, updated_at_ms: _updated, ...input } = provider;
  return {
    provider: input,
    customHeadersText: JSON.stringify(provider.custom_headers, null, 2),
    extraParamsText: JSON.stringify(provider.extra_params, null, 2),
  };
}

export function providerDraftInput(draft: CursorProviderDraft): ProviderInput {
  const provider: ProviderInput = {
    ...draft.provider,
    name: draft.provider.name.trim(),
    base_url: draft.provider.base_url.trim(),
    api_key: draft.provider.api_key.trim(),
    openai_endpoint: draft.provider.type === "openai" ? draft.provider.openai_endpoint : "",
    custom_headers: parseHeaders(draft.customHeadersText),
    extra_params: parseObject(draft.extraParamsText, t("额外请求参数")),
  };
  if (!provider.name || !provider.base_url || !provider.api_key) {
    throw new Error(t("供应商名称、服务器地址或完整请求 URL 和 API Key 不能为空"));
  }
  return provider;
}

export function CursorProviderEditor({ draft, onChange }: {
  draft: CursorProviderDraft;
  onChange: (draft: CursorProviderDraft) => void;
}) {
  const setProvider = (patch: Partial<ProviderInput>) => onChange({ ...draft, provider: { ...draft.provider, ...patch } });
  const setType = (type: ModelType) => {
    const other: ModelType = type === "anthropic" ? "openai" : "anthropic";
    const preset = modelPresets.find((candidate) => trimTrailingSlash(presetEndpoint(candidate, other).baseUrl) === trimTrailingSlash(draft.provider.base_url.trim()));
    const endpoint = preset ? presetEndpoint(preset, type) : null;
    onChange({
      ...draft,
      provider: {
        ...draft.provider,
        type,
        ...(endpoint ? {
          base_url: endpoint.baseUrl,
          use_full_url: endpoint.useFullUrl,
          custom_headers_enabled: endpoint.customHeaders !== null,
          custom_headers: endpoint.customHeaders ? { ...endpoint.customHeaders } : {},
        } : {}),
        openai_endpoint: type === "openai" ? (endpoint?.openaiEndpoint || draft.provider.openai_endpoint || "/v1/responses") : "",
      },
      customHeadersText: endpoint?.customHeaders ? JSON.stringify(endpoint.customHeaders, null, 2) : draft.customHeadersText,
    });
  };
  const applyPreset = (preset: ModelPreset) => {
    const endpoint = presetEndpoint(preset, draft.provider.type);
    const currentBase = trimTrailingSlash(draft.provider.base_url.trim());
    const sameProvider = [preset.endpoints.anthropic, preset.endpoints.openai]
      .some((candidate) => trimTrailingSlash(candidate.baseUrl) === currentBase);
    const currentName = draft.provider.name.trim();
    const shouldReplaceName = !currentName || modelPresets.some((candidate) => candidate.name === currentName);
    onChange({
      ...draft,
      provider: {
        ...draft.provider,
        name: shouldReplaceName ? preset.name : draft.provider.name,
        base_url: endpoint.baseUrl,
        use_full_url: endpoint.useFullUrl,
        openai_endpoint: draft.provider.type === "openai" ? endpoint.openaiEndpoint : draft.provider.openai_endpoint,
        custom_headers_enabled: endpoint.customHeaders !== null,
        custom_headers: endpoint.customHeaders ? { ...endpoint.customHeaders } : {},
        api_key: sameProvider ? draft.provider.api_key : "",
      },
      customHeadersText: endpoint.customHeaders ? JSON.stringify(endpoint.customHeaders, null, 2) : draft.customHeadersText,
    });
  };

  const requestUrlPlaceholder = draft.provider.use_full_url
    ? draft.provider.type === "anthropic"
      ? "https://api.anthropic.com/v1/messages"
      : draft.provider.openai_endpoint === "/v1/chat/completions"
        ? "https://api.openai.com/v1/chat/completions"
        : "https://api.openai.com/v1/responses"
    : draft.provider.type === "anthropic"
      ? "https://api.anthropic.com"
      : "https://api.openai.com";

  const typeOptions = [
    { value: "openai", label: "OpenAI", icon: openAiIcon },
    { value: "anthropic", label: "Anthropic", icon: claudeIcon },
  ];

  return <div className={styles.editor}>
    <CursorPresetChips type={draft.provider.type} baseUrl={draft.provider.base_url} onPick={applyPreset} />
    <div className={styles.grid}>
      <FormField className={styles.fullWidth} label={t("供应商名称")} hint={t("用于界面分组、模型徽章以及统计显示。")}>
        <TextInput placeholder={t("例如：OpenAI 官方")} value={draft.provider.name} onChange={(event) => setProvider({ name: event.target.value })} />
      </FormField>
      <FormField label={t("协议类型")}>
        <Select ariaLabel={t("协议类型")} value={draft.provider.type} options={typeOptions} onChange={(value) => setType(value as ModelType)} />
      </FormField>
      {draft.provider.type === "openai" && <FormField label={t("请求协议")} hint={t("只决定请求与响应的格式，不会改变请求地址。")}>
        <Select ariaLabel={t("请求协议")} value={draft.provider.openai_endpoint} options={[
          { value: "/v1/responses", label: "Responses API" },
          { value: "/v1/chat/completions", label: "Chat Completions API" },
        ]} onChange={(openai_endpoint) => setProvider({ openai_endpoint })} />
      </FormField>}

      <div className={styles.urlField}>
        <FormField label={draft.provider.use_full_url ? t("完整请求 URL") : t("服务器地址")} hint={draft.provider.use_full_url ? t("系统会原样使用此地址，不追加或修改请求路径。") : t("系统会根据请求协议自动追加标准端点路径。")}>
          <TextInput placeholder={requestUrlPlaceholder} value={draft.provider.base_url} onChange={(event) => setProvider({ base_url: event.target.value })} />
        </FormField>
        <Checkbox checked={draft.provider.use_full_url} label={t("使用完整请求地址")} onChange={(use_full_url) => setProvider({ use_full_url })} />
      </div>
      <FormField label="API Key" hint={t("访问供应商服务所需的密钥。")}>
        <SecretTextInput placeholder="sk-xxxxxx" autoComplete="off" value={draft.provider.api_key} onChange={(event) => setProvider({ api_key: event.target.value })} />
      </FormField>

      <ToggleJsonField
        label={t("自定义 Headers")}
        enabled={draft.provider.custom_headers_enabled}
        text={draft.customHeadersText}
        onEnabledChange={(custom_headers_enabled) => setProvider({ custom_headers_enabled })}
        onTextChange={(customHeadersText) => onChange({ ...draft, customHeadersText })}
      />
      <ToggleJsonField
        label={t("额外请求参数")}
        enabled={draft.provider.extra_params_enabled}
        text={draft.extraParamsText}
        onEnabledChange={(extra_params_enabled) => setProvider({ extra_params_enabled })}
        onTextChange={(extraParamsText) => onChange({ ...draft, extraParamsText })}
      />
    </div>
  </div>;
}

function ToggleJsonField({ label, enabled, text, onEnabledChange, onTextChange }: {
  label: string;
  enabled: boolean;
  text: string;
  onEnabledChange: (enabled: boolean) => void;
  onTextChange: (text: string) => void;
}) {
  return <div className={`${styles.fullWidth} ${styles.jsonOption}`}>
    <label><span>{label}</span><Switch label={label} checked={enabled} onChange={onEnabledChange} /></label>
    {enabled && <JsonEditor ariaLabel={label} value={text} onChange={onTextChange} />}
  </div>;
}

function parseHeaders(text: string): Record<string, string> {
  const parsed = parseObject(text, t("自定义 Headers"));
  if (Object.values(parsed).some((value) => typeof value !== "string")) throw new Error(t("自定义 Headers 的值必须都是字符串"));
  return parsed as Record<string, string>;
}

function parseObject(text: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(text || "{}"); } catch { throw new Error(t("{label} 必须是有效 JSON", { label })); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(t("{label} 必须是 JSON 对象", { label }));
  return parsed as Record<string, unknown>;
}
