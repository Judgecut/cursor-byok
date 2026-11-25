import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CostQuotaPeriod, CostQuotas, ExchangeRateSyncState } from "../../../shared/api";
import { compareUsdStrings, convertUsdToDisplayDecimal, costQuotaProgress, exchangeRateKey, formatCurrencyAmountExact, formatDisplayCost, resolveExchangeRate, type ExchangeRates } from "../../../shared/utils/costFormat";
import { COST_QUOTA_PERIODS, costQuotaLabel } from "../../../shared/utils/costQuota";
import { RollingNumber } from "../motion/RollingNumber";
import styles from "./CostQuotaProgress.module.scss";

const PULSE_DURATION_MS = 950;

export function CostQuotaProgress({
  quotas,
  usage,
  error,
  customRates,
  exchangeRateSync,
  locale,
  animate = true,
}: {
  quotas: CostQuotas;
  usage: Record<CostQuotaPeriod, string | null>;
  error: boolean;
  customRates: ExchangeRates;
  exchangeRateSync: ExchangeRateSyncState | null;
  locale: string;
  animate?: boolean;
}) {
  const percentFormat = useMemo(() => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }), [locale]);
  const prevUsedRef = useRef<Partial<Record<CostQuotaPeriod, { key: string; used: string }>>>({});
  const pulseSeqRef = useRef(0);
  const [pulseMap, setPulseMap] = useState<Partial<Record<CostQuotaPeriod, { id: number; direction: "up" }>>>({});

  const resolvedRows = COST_QUOTA_PERIODS.map((period) => {
    const quota = quotas[period];
    if (!quota) return null;
    const usd = usage[period];
    if (usd === null) return { period, quota, usd: null as string | null };
    const customRate = quota.currency !== "USD" && exchangeRateSync?.auto_sync_enabled === false ? customRates[exchangeRateKey(quota.currency)] : null;
    const rate = resolveExchangeRate(quota.currency, customRate, exchangeRateSync?.snapshot);
    const used = convertUsdToDisplayDecimal(usd, quota.currency, rate).amount;
    return { period, quota, usd, rate, used };
  });

  const quotaSnapshotKey = resolvedRows
    .map((row) => (row ? `${row.period}:${row.quota.currency}:${row.quota.amount}:${row.used ?? "null"}` : ""))
    .join("|");

  useLayoutEffect(() => {
    if (!animate) {
      setPulseMap((current) => (Object.keys(current).length > 0 ? {} : current));
      for (const row of resolvedRows) {
        if (!row || row.usd === null) continue;
        prevUsedRef.current[row.period] = { key: `${row.quota.currency}|${row.quota.amount}`, used: row.used };
      }
      return;
    }

    let nextPulses: Partial<Record<CostQuotaPeriod, { id: number; direction: "up" }>> | null = null;
    for (const row of resolvedRows) {
      if (!row || row.usd === null) continue;
      const key = `${row.quota.currency}|${row.quota.amount}`;
      const prev = prevUsedRef.current[row.period];
      prevUsedRef.current[row.period] = { key, used: row.used };
      if (prev && prev.key === key && compareUsdStrings(row.used, prev.used) > 0) {
        if (!nextPulses) nextPulses = {};
        nextPulses[row.period] = { id: ++pulseSeqRef.current, direction: "up" };
      }
    }
    if (nextPulses) {
      setPulseMap((current) => ({ ...current, ...nextPulses }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animate, quotaSnapshotKey]);

  const pulseSignature = COST_QUOTA_PERIODS.map((p) => `${p}:${pulseMap[p]?.id ?? ""}`).join("|");
  useEffect(() => {
    if (!Object.values(pulseMap).some(Boolean)) return;
    const timer = window.setTimeout(() => setPulseMap({}), PULSE_DURATION_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pulseSignature]);

  return <div className={styles.quotas} role="group" aria-label={t("全局费用额度")}>
    {resolvedRows.map((row) =>
    {
      if (!row) return null;
      const { period, quota, usd } = row;
      const label = costQuotaLabel(period);
      const { currency, amount } = quota;
      const limit = formatCurrencyAmountExact(amount, currency);
      if (usd === null)
      {
        return <div className={styles.row} key={period}>
          <span>{label}</span>
          <span className={styles.track} aria-hidden="true" />
          <span>{error ? "—" : t("计算中…")}</span>
          <span className={styles.amounts}>— / {limit}</span>
        </div>;
      }

      const { rate, used } = row;
      const { fill, level, percentTenths } = costQuotaProgress(used, amount);
      const percent = percentFormat.format(Number(percentTenths) / 1_000);
      const exact = `${formatCurrencyAmountExact(used, currency)} / ${limit}`;
      const pulse = pulseMap[period];
      const resetKey = `${period}|${currency}|${amount}`;
      return <div className={styles.row} key={period}>
        <span>{label}</span>
        <div className={styles.track} role="progressbar" aria-label={label} aria-valuenow={fill} aria-valuetext={`${percent} · ${exact}`}>
          <div className={styles.fill} data-level={level} data-animate={animate} data-pulse={pulse?.direction} style={{ width: `${fill}%` }}>
            {animate && pulse && <span key={pulse.id} className={styles.fillShimmer} aria-hidden="true" />}
          </div>
        </div>
        <span className={styles.percent} data-level={level} data-animate={animate}>
          <RollingNumber
            value={percent}
            numericValue={Number(percentTenths) / 10}
            animate={animate}
            resetKey={resetKey}
            polarity="cost"
            rollOnMount
          />
        </span>
        <span className={styles.amounts} title={exact}>
          <strong>
            <RollingNumber
              value={formatDisplayCost(usd, currency, rate)}
              numericValue={Number(used)}
              animate={animate}
              resetKey={resetKey}
              polarity="cost"
              rollOnMount
            />
          </strong> / {limit}
        </span>
      </div>;
    })}
    {error && <small role="status">{t("额度用量刷新失败")}</small>}
  </div>;
}
