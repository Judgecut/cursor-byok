import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/store";
import { appStore, useAppStore, useCurrencyDisplay } from "../../shared/store/appStore";
import { Button } from "../../shared/ui/Button";
import { CurrencySelect } from "../../shared/ui/CurrencySelect";
import { ExchangeRateAttribution } from "../../shared/ui/ExchangeRateAttribution";
import { TextInput } from "../../shared/ui/FormControls";
import { TitledCard } from "../../shared/ui/TitledCard";
import { useMessage } from "../../shared/ui/message";
import { DEFAULT_EXCHANGE_RATES, formatConversionNote, normalizeExchangeRate } from "../../shared/utils/costFormat";
import styles from "./SettingsPage.module.scss";

export function CurrencySettingsCard()
{
  const { customExchangeRate, exchangeRateSync, exchangeRateSyncUpdating } = useAppStore();
  const { currency, exchangeRate } = useCurrencyDisplay();
  const { locale } = useI18n();
  const message = useMessage();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [saving, setSaving] = useState(false);
  const autoSyncEnabled = exchangeRateSync?.auto_sync_enabled ?? true;
  const showManualRate = !autoSyncEnabled && currency !== "USD";
  const modeDisabled = !exchangeRateSync || exchangeRateSyncUpdating || saving;
  const synced = exchangeRateSync?.snapshot;
  const rateInput = draft ?? exchangeRate?.rate ?? "";

  useEffect(() =>
  {
    setDraft(null);
    setInvalid(false);
  }, [currency, customExchangeRate, autoSyncEnabled]);

  const saveRate = async (raw: string) =>
  {
    if (autoSyncEnabled || currency === "USD" || saving || exchangeRateSyncUpdating)
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
        setDraft(null);
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
        <div className={styles.currencyRow}>
          <div>
            <strong>{t("汇率模式")}</strong>
            {autoSyncEnabled && <small>{t("自动同步汇率（每 24 小时）")}</small>}
          </div>
          <div className={styles.currencyRateForm} role="group" aria-label={t("汇率模式")}>
            <Button size="small" variant={autoSyncEnabled ? "primary" : "secondary"} aria-pressed={autoSyncEnabled} disabled={modeDisabled} onClick={() => !autoSyncEnabled && void appStore.setExchangeRateAutoSync(true)}>{t("自动")}</Button>
            <Button size="small" variant={autoSyncEnabled ? "secondary" : "primary"} aria-pressed={!autoSyncEnabled} disabled={modeDisabled} onClick={() => autoSyncEnabled && void appStore.setExchangeRateAutoSync(false)}>{t("手动")}</Button>
          </div>
        </div>
        {currency !== "USD" && <div className={styles.currencyRateHeader}>
          <strong>{t("{currency} 汇率", { currency })}</strong>
          <small>{formatConversionNote(currency, exchangeRate)}</small>
        </div>}
        {autoSyncEnabled && <div className={styles.currencyRateForm}>
          <Button size="small" disabled={modeDisabled || exchangeRateSync?.syncing} onClick={() => void appStore.syncExchangeRates()}>
            {exchangeRateSync?.syncing || exchangeRateSyncUpdating ? t("同步汇率中…") : t("立即同步汇率")}
          </Button>
        </div>}
        {synced && (autoSyncEnabled || exchangeRate?.source === synced.source) && exchangeRateSync?.last_synced_at_ms != null && <small className={styles.currencySyncStatus}>
          <ExchangeRateAttribution source={synced.source} />
          {t("汇率数据日期 {date} · 最近同步 {time}", { date: new Date(synced.published_at_ms).toISOString().slice(0, 10), time: new Date(exchangeRateSync.last_synced_at_ms).toLocaleString(locale) })}
        </small>}
        {autoSyncEnabled && exchangeRateSync?.last_error && <small role="status" title={exchangeRateSync.last_error}>{t("汇率同步失败，继续使用已有汇率。")}</small>}
        {showManualRate && <form className={styles.currencyRateForm} onSubmit={(event) =>
        {
          event.preventDefault();
          void saveRate(rateInput);
        }}>
          <span className={styles.ratePrefix}>1 USD =</span>
          <div className={styles.rateInputWrap}>
            <TextInput ref={inputRef} type="text" inputMode="decimal" value={rateInput} aria-label={t("{currency} 汇率", { currency })} aria-invalid={invalid || undefined} maxLength={64} disabled={modeDisabled} onChange={(event) =>
            {
              setDraft(event.target.value);
              setInvalid(false);
            }} />
          </div>
          <span className={styles.rateSuffix}>{currency}</span>
          <Button variant="primary" size="small" type="submit" disabled={modeDisabled || rateInput === customExchangeRate}>
            {saving ? t("保存中…") : t("保存")}
          </Button>
          {customExchangeRate && <Button size="small" disabled={modeDisabled} onClick={() => void saveRate("")}>{t("恢复默认")}</Button>}
        </form>}
        {showManualRate && invalid && <div className={styles.rateError} role="alert">{t("汇率必须是大于 0 的数字，例如 7.25")}</div>}
      </div>
    </div>
  </TitledCard>;
}
