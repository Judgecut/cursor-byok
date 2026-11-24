import type { RequestFormat } from "../api";
import { defaultCustomHeaders } from "./modelDefaults";
import type { ProviderIconKey } from "./providerIcons";

export interface ModelPresetEntry {
  model_id: string;
  display_name: string;
  context_window_tokens: number | null;
  max_output_tokens: number | null;
}

export interface ModelPresetEndpoint {
  baseUrl: string;
  format: RequestFormat;
  customHeaders: Record<string, string> | null;
}

export interface ModelPreset {
  key: ProviderIconKey;
  name: string;
  keyHint: string;
  endpoints: ModelPresetEndpoint[];
  models: ModelPresetEntry[];
}

export const requestFormatLabels: Record<RequestFormat, string> = {
  "openai-chat": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  anthropic: "Anthropic Messages",
  gemini: "Gemini",
};

const entry = (
  modelId: string,
  displayName: string,
  contextWindowTokens: number | null,
  maxOutputTokens: number | null,
): ModelPresetEntry => ({
  model_id: modelId,
  display_name: displayName,
  context_window_tokens: contextWindowTokens,
  max_output_tokens: maxOutputTokens,
});

const anthropic = (baseUrl: string): ModelPresetEndpoint => ({ baseUrl, format: "anthropic", customHeaders: defaultCustomHeaders });
const openaiChat = (baseUrl: string): ModelPresetEndpoint => ({ baseUrl, format: "openai-chat", customHeaders: null });

export const modelPresets: ModelPreset[] = [
  {
    key: "zhipu",
    name: "智谱 GLM",
    keyHint: "bigmodel.cn → GLM Coding Plan → API Key（套餐 Key 与普通 Key 不通用）",
    endpoints: [
      anthropic("https://open.bigmodel.cn/api/anthropic"),
      openaiChat("https://open.bigmodel.cn/api/coding/paas/v4"),
    ],
    models: [
      entry("glm-5.3", "GLM 5.3", 1000000, 65536),
      entry("glm-5.2", "GLM 5.2", 200000, 32768),
      entry("glm-4.7", "GLM 4.7", 200000, 32768),
    ],
  },
  {
    key: "kimi",
    name: "Kimi (Moonshot)",
    keyHint: "Kimi Code 编程套餐页获取 API Key（api.kimi.com/coding 端点）",
    endpoints: [
      anthropic("https://api.kimi.com/coding"),
      openaiChat("https://api.kimi.com/coding"),
    ],
    models: [
      entry("k3", "Kimi K3", 1048576, 65536),
      entry("kimi-for-coding", "K2.7 Coding", 262144, 32768),
    ],
  },
  {
    key: "deepseek",
    name: "DeepSeek",
    keyHint: "platform.deepseek.com → API Keys",
    endpoints: [
      anthropic("https://api.deepseek.com/anthropic"),
      openaiChat("https://api.deepseek.com"),
    ],
    models: [
      entry("deepseek-v4-pro", "DeepSeek V4 Pro", 1000000, 65536),
      entry("deepseek-v4-flash", "DeepSeek V4 Flash", 1000000, null),
    ],
  },
  {
    key: "volcengine",
    name: "火山引擎方舟",
    keyHint: "火山方舟 Coding Plan（ark-code-latest 路由多款代码模型）",
    endpoints: [
      anthropic("https://ark.cn-beijing.volces.com/api/coding"),
      openaiChat("https://ark.cn-beijing.volces.com/api/coding/v3"),
    ],
    models: [entry("ark-code-latest", "Ark Code Latest", 256000, 32768)],
  },
  {
    key: "minimax",
    name: "MiniMax",
    keyHint: "platform.minimaxi.com → 订阅 Coding Plan → API Key",
    endpoints: [
      anthropic("https://api.minimaxi.com/anthropic"),
      { baseUrl: "https://api.minimaxi.com", format: "openai-responses", customHeaders: null },
    ],
    models: [
      entry("MiniMax-M3", "MiniMax M3", 1000000, 65536),
      entry("MiniMax-M2.7", "MiniMax M2.7", 205000, 32768),
    ],
  },
];

export const trimTrailingSlash = (url: string) => url.replace(/\/+$/, "");
