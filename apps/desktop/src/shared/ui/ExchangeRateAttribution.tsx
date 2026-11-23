import { api } from "../api";
import type { DisplayExchangeRate, ExchangeRateSource } from "../utils/costFormat";
import { useMessage } from "./message";

const SOURCES: Record<ExchangeRateSource, { url: string; name: string }> = {
  exchange_rate_api: { url: "https://www.exchangerate-api.com", name: "Exchange Rate API" },
  float_rates: { url: "https://www.floatrates.com", name: "FloatRates" },
};

export function ExchangeRateAttribution({ source }: { source: DisplayExchangeRate["source"] | null | undefined })
{
  const message = useMessage();
  if (source !== "exchange_rate_api" && source !== "float_rates")
  {
    return null;
  }
  const { url, name } = SOURCES[source];
  return <a href={url} target="_blank" rel="noreferrer" onClick={(event) =>
  {
    if ("__TAURI_INTERNALS__" in window)
    {
      event.preventDefault();
      void api.openExternalUrl(url).catch((cause) => message(cause instanceof Error ? cause.message : String(cause)));
    }
  }}>{t("汇率由 {provider} 提供", { provider: name })}</a>;
}
