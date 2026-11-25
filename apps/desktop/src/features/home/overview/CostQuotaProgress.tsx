import type { CostQuotaPeriod, CostQuotas, ExchangeRateSyncState } from "../../../shared/api";
import { convertUsdToDisplayDecimal, costQuotaProgress, exchangeRateKey, formatCurrencyAmountExact, formatDisplayCost, resolveExchangeRate, type ExchangeRates } from "../../../shared/utils/costFormat";
import { COST_QUOTA_PERIODS, costQuotaLabel } from "../../../shared/utils/costQuota";
import styles from "./CostQuotaProgress.module.scss";

export function CostQuotaProgress({ quotas, usage, error, customRates, exchangeRateSync, locale }: { quotas: CostQuotas; usage: Record<CostQuotaPeriod, string | null>; error: boolean; customRates: ExchangeRates; exchangeRateSync: ExchangeRateSyncState | null; locale: string })
{
  const percentFormat = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  return <div className={styles.quotas} role="group" aria-label={t("全局费用额度")}>
    {COST_QUOTA_PERIODS.map((period) =>
    {
      const quota = quotas[period];
      if (!quota) return null;
      const label = costQuotaLabel(period);
      const { currency, amount } = quota;
      const limit = formatCurrencyAmountExact(amount, currency);
      const usd = usage[period];
      if (usd === null)
      {
        return <div className={styles.row} key={period}>
          <span>{label}</span>
          <span className={styles.track} aria-hidden="true" />
          <span>{error ? "—" : t("计算中…")}</span>
          <span className={styles.amounts}>— / {limit}</span>
        </div>;
      }

      const customRate = currency !== "USD" && exchangeRateSync?.auto_sync_enabled === false ? customRates[exchangeRateKey(currency)] : null;
      const rate = resolveExchangeRate(currency, customRate, exchangeRateSync?.snapshot);
      const used = convertUsdToDisplayDecimal(usd, currency, rate).amount;
      const { fill, level, percentTenths } = costQuotaProgress(used, amount);
      const percent = percentFormat.format(Number(percentTenths) / 1_000);
      const exact = `${formatCurrencyAmountExact(used, currency)} / ${limit}`;
      return <div className={styles.row} key={period}>
        <span>{label}</span>
        <div className={styles.track} role="progressbar" aria-label={label} aria-valuenow={fill} aria-valuetext={`${percent} · ${exact}`}>
          <div className={styles.fill} data-level={level} style={{ width: `${fill}%` }} />
        </div>
        <span className={styles.percent}>{percent}</span>
        <span className={styles.amounts} title={exact}><strong>{formatDisplayCost(usd, currency, rate)}</strong> / {limit}</span>
      </div>;
    })}
    {error && <small role="status">{t("额度用量刷新失败")}</small>}
  </div>;
}
