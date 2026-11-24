import deepseekIcon from "../assets/provider-icons/deepseek.svg";
import geminiIcon from "../assets/provider-icons/gemini.png";
import volcengineIcon from "../assets/provider-icons/huoshan.png";
import kimiIcon from "../assets/provider-icons/kimi.svg";
import minimaxIcon from "../assets/provider-icons/minimax.svg";
import mistralIcon from "../assets/provider-icons/mistral-color.svg";
import openrouterIcon from "../assets/provider-icons/openrouter.svg";
import qwenIcon from "../assets/provider-icons/qwen-color.svg";
import xaiIcon from "../assets/provider-icons/xai.svg";
import zhipuIcon from "../assets/provider-icons/zhipu.svg";
import type { IconProps } from "../ui/Icon";
import { claudeIcon, flatColorOrganizationIcon, openAiIcon } from "../ui/icons";

type IconVisual = Pick<IconProps, "icon" | "src">;

type ProviderIconPreset = {
  key: string;
  name: string;
  hosts: readonly string[];
  visual: IconVisual;
};

export const providerIconPresets = [
  { key: "openai", name: "OpenAI", hosts: ["api.openai.com"], visual: { icon: openAiIcon } },
  { key: "anthropic", name: "Anthropic (Claude)", hosts: ["api.anthropic.com"], visual: { icon: claudeIcon } },
  { key: "gemini", name: "Google Gemini", hosts: ["generativelanguage.googleapis.com"], visual: { src: geminiIcon } },
  { key: "deepseek", name: "DeepSeek", hosts: ["api.deepseek.com"], visual: { src: deepseekIcon } },
  { key: "kimi", name: "Kimi (Moonshot)", hosts: ["api.kimi.com", "api.moonshot.cn", "api.moonshot.ai"], visual: { src: kimiIcon } },
  { key: "zhipu", name: "智谱 GLM", hosts: ["open.bigmodel.cn", "api.z.ai"], visual: { src: zhipuIcon } },
  { key: "minimax", name: "MiniMax", hosts: ["api.minimaxi.com", "api.minimax.io"], visual: { src: minimaxIcon } },
  { key: "volcengine", name: "火山引擎", hosts: ["ark.cn-beijing.volces.com"], visual: { src: volcengineIcon } },
  { key: "qwen", name: "阿里云百炼", hosts: ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com", "cn-hongkong.dashscope.aliyuncs.com"], visual: { src: qwenIcon } },
  { key: "xai", name: "xAI", hosts: ["api.x.ai"], visual: { src: xaiIcon } },
  { key: "openrouter", name: "OpenRouter", hosts: ["openrouter.ai"], visual: { src: openrouterIcon } },
  { key: "mistral", name: "Mistral", hosts: ["api.mistral.ai"], visual: { src: mistralIcon } },
] as const satisfies readonly ProviderIconPreset[];

export type ProviderIconKey = (typeof providerIconPresets)[number]["key"];

const PROVIDER_ICON_PNG_PREFIX = "data:image/png;base64,";

function presetForHost(baseUrl: string): ProviderIconPreset | undefined
{
  try
  {
    const url = new URL(baseUrl);
    if (url.protocol === "https:" || url.protocol === "http:")
    {
      return providerIconPresets.find((preset: ProviderIconPreset) => preset.hosts.includes(url.hostname));
    }
  }
  catch
  {
    // The address may be incomplete while editing.
  }
  return undefined;
}

export function resolveProviderIcon(icon: string | null, baseUrl = ""): { visual: IconVisual; name?: string }
{
  if (icon?.startsWith(PROVIDER_ICON_PNG_PREFIX))
  {
    return { visual: { src: icon } };
  }
  const preset = icon === null ? presetForHost(baseUrl) : providerIconPresets.find((candidate) => candidate.key === icon);
  return preset ? { visual: preset.visual, name: preset.name } : { visual: { icon: flatColorOrganizationIcon } };
}

export function resolveSupplierIcon({ endpoint_key, plugin_icon }: { endpoint_key: string; plugin_icon: string | null }): IconVisual
{
  return plugin_icon ? { src: plugin_icon } : resolveProviderIcon(null, endpoint_key).visual;
}
