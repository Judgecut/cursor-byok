import { useId, useRef, useState } from "react";
import type { CostQuota, CostQuotaPeriod } from "../../shared/api";
import { appStore, useAppStore } from "../../shared/store/appStore";
import { Button } from "../../shared/ui/Button";
import { CurrencySelect } from "../../shared/ui/CurrencySelect";
import { TextInput } from "../../shared/ui/FormControls";
import { TitledCard } from "../../shared/ui/TitledCard";
import { COST_QUOTA_PERIODS, costQuotaLabel } from "../../shared/utils/costQuota";
import { normalizeCostQuotaAmount, type DisplayCurrency } from "../../shared/utils/costFormat";
import styles from "./CostQuotaSettingsCard.module.scss";

export function CostQuotaSettingsCard()
{
  const { costQuotas, currency } = useAppStore();
  return <TitledCard title={t("费用额度")}>
    <div className={styles.rows}>
      {COST_QUOTA_PERIODS.map((period) =>
      {
        const quota = costQuotas[period];
        return <CostQuotaRow key={`${period}:${quota?.amount ?? ""}:${quota?.currency ?? ""}`} period={period} quota={quota} defaultCurrency={currency} />;
      })}
    </div>
  </TitledCard>;
}

function CostQuotaRow({ period, quota, defaultCurrency }: { period: CostQuotaPeriod; quota: CostQuota | null; defaultCurrency: DisplayCurrency })
{
  const [amountDraft, setAmountDraft] = useState<string | null>(null);
  const [currencyDraft, setCurrencyDraft] = useState<DisplayCurrency | null>(null);
  const [saving, setSaving] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const amountId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const label = costQuotaLabel(period);
  const amount = amountDraft ?? quota?.amount ?? "";
  const currency = currencyDraft ?? quota?.currency ?? defaultCurrency;
  const changed = quota ? quota.amount !== amount || quota.currency !== currency : amount.trim() !== "";

  const save = async (value: CostQuota | null) =>
  {
    setSaving(true);
    try
    {
      if (await appStore.saveCostQuota(period, value))
      {
        setAmountDraft(null);
        setCurrencyDraft(null);
        setInvalid(false);
      }
    }
    finally
    {
      setSaving(false);
    }
  };

  return <form aria-label={label} className={styles.row} onSubmit={(event) =>
  {
    event.preventDefault();
    if (saving || !changed) return;
    const normalized = normalizeCostQuotaAmount(amount);
    if (!normalized)
    {
      setInvalid(true);
      inputRef.current?.focus();
      return;
    }
    void save({ amount: normalized, currency });
  }}>
    <label className={styles.period} htmlFor={amountId}>{label}</label>
    <div className={styles.controls}>
      <div className={styles.fields}>
        <TextInput id={amountId} ref={inputRef} className={styles.amount} inputMode="decimal" maxLength={64} placeholder="—" value={amount} aria-label={t("{period}金额", { period: label })} aria-invalid={invalid || undefined} disabled={saving} onChange={(event) =>
        {
          setAmountDraft(event.target.value);
          setInvalid(false);
        }} />
        <CurrencySelect value={currency} disabled={saving} ariaLabel={t("{period}币种", { period: label })} onChange={setCurrencyDraft} />
      </div>
      <div className={styles.actions}>
        <Button className={styles.save} variant={changed ? "primary" : "secondary"} type="submit" disabled={saving || !changed}>{saving ? t("保存中…") : t("保存")}</Button>
        {quota && <Button className={styles.clear} disabled={saving} onClick={() => void save(null)}>{t("清除额度")}</Button>}
      </div>
    </div>
    {invalid && <small className={styles.error} role="alert">{t("额度必须是大于 0 的金额，例如 1500.50")}</small>}
  </form>;
}
