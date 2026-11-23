import type { Provider, ProviderInput } from "../../shared/api";
import { defaultCustomHeadersText } from "../../shared/utils/modelDefaults";
import { modelPresets, trimTrailingSlash, type ModelPreset, type ModelPresetEndpoint } from "../../shared/utils/modelPresets";
import { FormField, SecretTextInput, TextInput } from "../../shared/ui/FormControls";
import { JsonEditor } from "../../shared/ui/JsonEditor";
import { Switch } from "../../shared/ui/Switch";
import { CursorPresetChips } from "./CursorPresetChips";
import styles from "./CursorSettings.module.scss";

export type CursorProviderDraft = {
  provider: ProviderInput;
  customHeadersText: string;
};

export const emptyCursorProviderDraft = (): CursorProviderDraft => ({
  provider: {
    sort_order: 0,
    name: "",
    base_url: "",
    api_key: "",
    custom_headers_enabled: false,
    custom_headers: {},
  },
  customHeadersText: defaultCustomHeadersText,
});

export function providerDraftFrom(provider: Provider): CursorProviderDraft {
  const { provider_id: _id, created_at_ms: _created, updated_at_ms: _updated, ...input } = provider;
  return {
    provider: input,
    customHeadersText: JSON.stringify(provider.custom_headers, null, 2),
  };
}

export function providerDraftInput(draft: CursorProviderDraft): ProviderInput {
  const provider: ProviderInput = {
    ...draft.provider,
    name: draft.provider.name.trim(),
    base_url: draft.provider.base_url.trim(),
    api_key: draft.provider.api_key.trim(),
    custom_headers: parseHeaders(draft.customHeadersText),
  };
  if (!provider.name || !provider.base_url || !provider.api_key) {
    throw new Error(t("供应商名称、服务器地址和 API Key 不能为空"));
  }
  return provider;
}

export function CursorProviderEditor({ draft, onChange }: {
  draft: CursorProviderDraft;
  onChange: (draft: CursorProviderDraft) => void;
}) {
  const setProvider = (patch: Partial<ProviderInput>) => onChange({ ...draft, provider: { ...draft.provider, ...patch } });
  const applyPreset = (preset: ModelPreset, endpoint: ModelPresetEndpoint) => {
    const currentBase = trimTrailingSlash(draft.provider.base_url.trim());
    const sameProvider = preset.endpoints
      .some((candidate) => trimTrailingSlash(candidate.baseUrl) === currentBase);
    const currentName = draft.provider.name.trim();
    const shouldReplaceName = !currentName || modelPresets.some((candidate) => candidate.name === currentName);
    onChange({
      ...draft,
      provider: {
        ...draft.provider,
        name: shouldReplaceName ? preset.name : draft.provider.name,
        base_url: endpoint.baseUrl,
        custom_headers_enabled: endpoint.customHeaders !== null,
        custom_headers: endpoint.customHeaders ? { ...endpoint.customHeaders } : {},
        api_key: sameProvider ? draft.provider.api_key : "",
      },
      customHeadersText: endpoint.customHeaders ? JSON.stringify(endpoint.customHeaders, null, 2) : draft.customHeadersText,
    });
  };

  return <div className={styles.editor}>
    <CursorPresetChips baseUrl={draft.provider.base_url} onPick={applyPreset} />
    <div className={styles.grid}>
      <FormField className={styles.fullWidth} label={t("供应商名称")} hint={t("用于界面分组、模型徽章以及统计显示。")}>
        <TextInput placeholder={t("例如：OpenAI 官方")} value={draft.provider.name} onChange={(event) => setProvider({ name: event.target.value })} />
      </FormField>
      <FormField label={t("服务器地址")} hint={t("系统会根据请求协议自动追加标准端点路径。")}>
        <TextInput placeholder="https://api.example.com" value={draft.provider.base_url} onChange={(event) => setProvider({ base_url: event.target.value })} />
      </FormField>
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
    </div>
  </div>;
}

export function ToggleJsonField({ label, enabled, text, onEnabledChange, onTextChange }: {
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

export function parseObject(text: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(text || "{}"); } catch { throw new Error(t("{label} 必须是有效 JSON", { label })); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(t("{label} 必须是 JSON 对象", { label }));
  return parsed as Record<string, unknown>;
}
