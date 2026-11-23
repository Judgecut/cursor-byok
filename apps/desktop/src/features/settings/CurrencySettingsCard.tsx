import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/store";
import { appStore, useAppStore } from "../../shared/store/appStore";
import { Button } from "../../shared/ui/Button";
import { Checkbox } from "../../shared/ui/Checkbox";
import { CurrencySelect } from "../../shared/ui/CurrencySelect";
import { ExchangeRateAttribution } from "../../shared/ui/ExchangeRateAttribution";
import { TextInput } from "../../shared/ui/FormControls";
import { TitledCard } from "../../shared/ui/TitledCard";
import { useMessage } from "../../shared/ui/message";
import { DEFAULT_EXCHANGE_RATES, formatConversionNote, normalizeExchangeRate, resolveExchangeRate } from "../../shared/utils/costFormat";
import styles from "./SettingsPage.module.scss";

export function CurrencySettingsCard()
{
  const { currency, customExchangeRate, exchangeRateSync, exchangeRateSyncUpdating } = useAppStore();
  const { locale } = useI18n();
  const message = useMessage();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(customExchangeRate ?? "");
  const [invalid, setInvalid] = useState(false);
  const [saving, setSaving] = useState(false);
  const synced = exchangeRateSync?.snapshot;
  const exchangeRate = resolveExchangeRate(currency, customExchangeRate, synced);
  const referenceRate = currency === "USD" ? undefined : synced?.rates[currency] ?? DEFAULT_EXCHANGE_RATES[currency];

  useEffect(() =>
  {
    setDraft(customExchangeRate ?? "");
    setInvalid(false);
  }, [currency, customExchangeRate]);

  const saveRate = async (raw: string) =>
  {
    if (currency === "USD" || saving)
    {
      return;
    }
    const trimmed = raw.trim();
    const normalized = normalizeExchangeRate(trimmed);
    if (trimmed && !normalized)
    {
      setInvalid(true);
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }
    setSaving(true);
    try
    {
      if (await appStore.saveExchangeRate(currency, normalized))
      {
        setDraft(normalized ?? "");
        setInvalid(false);
        const reference = appStore.getSnapshot().exchangeRateSync?.snapshot?.rates[currency] ?? DEFAULT_EXCHANGE_RATES[currency];
        message(normalized ? t("汇率已保存（1 USD = {rate} {currency}）", { rate: normalized, currency }) : t("已恢复参考汇率（1 USD = {rate} {currency}）", { rate: reference, currency }));
      }
    }
    finally
    {
      setSaving(false);
    }
  };

  return <TitledCard title={t("货币显示")}>
    <div className={styles.currencySection}>
      <div className={styles.currencyRow}>
        <div>
          <strong>{t("显示币种")}</strong>
          <small>{t("汇率仅用于费用显示，原始费用和模型单价以美元记录。")}</small>
        </div>
        <div className={styles.currencyActions}>
          <CurrencySelect value={currency} disabled={saving} onChange={appStore.selectCurrency} />
        </div>
      </div>
      <div className={styles.currencyRateBlock}>
        <div className={styles.currencyRateForm}>
          <Checkbox checked={exchangeRateSync?.auto_sync_enabled ?? true} disabled={!exchangeRateSync || exchangeRateSyncUpdating} label={t("自动同步汇率（每 24 小时）")} onChange={(enabled) => void appStore.setExchangeRateAutoSync(enabled)} />
          <Button size="small" disabled={exchangeRateSyncUpdating || exchangeRateSync?.syncing} onClick={() => void appStore.syncExchangeRates()}>
            {exchangeRateSync?.syncing || exchangeRateSyncUpdating ? t("同步汇率中…") : t("立即同步汇率")}
          </Button>
        </div>
        {synced && exchangeRateSync?.last_synced_at_ms != null && <small className={styles.currencySyncStatus}>
          <ExchangeRateAttribution source={synced.source} />
          {t("汇率数据日期 {date} · 最近同步 {time}", { date: new Date(synced.published_at_ms).toISOString().slice(0, 10), time: new Date(exchangeRateSync.last_synced_at_ms).toLocaleString(locale) })}
        </small>}
        {exchangeRateSync?.last_error && <small role="status" title={exchangeRateSync.last_error}>{t("汇率同步失败，继续使用已有汇率。")}</small>}
      </div>
      {currency !== "USD" && <div className={styles.currencyRateBlock}>
        <div className={styles.currencyRateHeader}>
          <strong>{t("{currency} 汇率", { currency })}</strong>
          <small>{formatConversionNote(currency, exchangeRate)}</small>
        </div>
        <form className={styles.currencyRateForm} onSubmit={(event) =>
        {
          event.preventDefault();
          void saveRate(draft);
        }}>
          <span className={styles.ratePrefix}>1 USD =</span>
          <div className={styles.rateInputWrap}>
            <TextInput ref={inputRef} type="text" inputMode="decimal" value={draft} aria-label={t("{currency} 汇率", { currency })} aria-invalid={invalid || undefined} placeholder={referenceRate} maxLength={64} disabled={saving} onChange={(event) =>
            {
              setDraft(event.target.value);
              setInvalid(false);
            }} />
          </div>
          <span className={styles.rateSuffix}>{currency}</span>
          <Button variant="primary" size="small" type="submit" disabled={saving || draft === (customExchangeRate ?? "")}>
            {saving ? t("保存中…") : t("保存")}
          </Button>
          {customExchangeRate && <Button size="small" disabled={saving} onClick={() => void saveRate("")}>{t("恢复默认")}</Button>}
        </form>
        {invalid && <div className={styles.rateError} role="alert">{t("汇率必须是大于 0 的数字，例如 7.25")}</div>}
      </div>}
    </div>
  </TitledCard>;
}
