import { useEffect, useRef, useState } from "react";
import { appStore, useAppStore } from "../../shared/store/appStore";
import { Button } from "../../shared/ui/Button";
import { CurrencySelect } from "../../shared/ui/CurrencySelect";
import { TextInput } from "../../shared/ui/FormControls";
import { TitledCard } from "../../shared/ui/TitledCard";
import { useMessage } from "../../shared/ui/message";
import { DEFAULT_CNY_RATE, formatConversionNote, normalizeExchangeRate } from "../../shared/utils/costFormat";
import styles from "./SettingsPage.module.scss";

export function CurrencySettingsCard()
{
  const { currency, exchangeRate } = useAppStore();
  const message = useMessage();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(exchangeRate ?? "");
  const [invalid, setInvalid] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() =>
  {
    setDraft(exchangeRate ?? "");
    setInvalid(false);
  }, [currency, exchangeRate]);

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
        message(normalized ? t("汇率已保存（1 USD = {rate} {currency}）", { rate: normalized, currency }) : t("汇率已清除"));
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
            <TextInput ref={inputRef} type="text" inputMode="decimal" value={draft} aria-label={t("{currency} 汇率", { currency })} aria-invalid={invalid || undefined} placeholder={currency === "CNY" ? DEFAULT_CNY_RATE : undefined} maxLength={64} disabled={saving} onChange={(event) =>
            {
              setDraft(event.target.value);
              setInvalid(false);
            }} />
          </div>
          <span className={styles.rateSuffix}>{currency}</span>
          <Button variant="primary" size="small" type="submit" disabled={saving || draft === (exchangeRate ?? "")}>
            {saving ? t("保存中…") : t("保存")}
          </Button>
          {exchangeRate && <Button size="small" disabled={saving} onClick={() => void saveRate("")}>{currency === "CNY" ? t("恢复默认") : t("清除汇率")}</Button>}
        </form>
        {invalid && <div className={styles.rateError} role="alert">{t("汇率必须是大于 0 的数字，例如 7.25")}</div>}
      </div>}
    </div>
  </TitledCard>;
}
