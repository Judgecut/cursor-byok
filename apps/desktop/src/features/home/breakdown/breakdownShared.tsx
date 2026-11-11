import type { PricingSource, SpeedAggregate } from "../../../shared/api";
import {
  compareUsdStrings,
  formatConversionNote,
  formatDisplayCostExact,
  formatUsdExact,
  type DisplayCurrency,
} from "../../../shared/utils/costFormat";
import { formatInteger } from "../../../shared/utils/numberFormat";
import styles from "./BreakdownTable.module.scss";

export type BreakdownSortKey =
  | "token_usage"
  | "speed"
  | "first_output"
  | "llm_calls"
  | "success_rate"
  | "total_cost";

export type BreakdownSort = {
  key: BreakdownSortKey;
  dir: "asc" | "desc";
};

export type BreakdownRowBase = {
  pricing_sources: PricingSource[];
  llm_calls: number;
  successful_calls: number;
  failed_calls: number;
  token_usage: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  total_cost: string;
  input_cost: string;
  output_cost: string;
  cache_read_cost: string;
  cache_write_cost: string;
  average_priced_cost: string | null;
  unpriced_calls: number;
  speed: SpeedAggregate;
};

export function sourceBadgeLabel(source: PricingSource): string {
  if (source === "custom") return t("自定义定价");
  if (source === "catalog") return t("公开目录");
  return t("未定价");
}

export function PricingSourceBadges({ sources }: { sources: PricingSource[] }) {
  if (sources.length === 0) return null;
  if (sources.length > 1) {
    const details = sources.map(sourceBadgeLabel).join("、");
    return <span
      className={styles.badge}
      title={t("当前汇总包含多种定价来源：{sources}", { sources: details })}
    >
      {t("混合来源")}
    </span>;
  }
  const source = sources[0];
  return <span
    className={[
      styles.badge,
      source === "unpriced" ? styles.badgeWarn : styles.badgeActive,
    ].join(" ")}
  >
    {sourceBadgeLabel(source)}
  </span>;
}

export function nextBreakdownSort(current: BreakdownSort, key: BreakdownSortKey): BreakdownSort {
  if (current.key !== key) return { key, dir: "desc" };
  if (key === "token_usage") {
    return { key: "token_usage", dir: current.dir === "desc" ? "asc" : "desc" };
  }
  if (current.dir === "desc") return { key, dir: "asc" };
  return { key: "token_usage", dir: "desc" };
}

export function sortIndicator(sort: BreakdownSort, key: BreakdownSortKey): string {
  if (sort.key !== key) return "↕";
  return sort.dir === "desc" ? "↓" : "↑";
}

export function ariaSortValue(sort: BreakdownSort, key: BreakdownSortKey): "ascending" | "descending" | "none" {
  if (sort.key !== key) return "none";
  return sort.dir === "asc" ? "ascending" : "descending";
}

export function sortBreakdownRows<T extends BreakdownRowBase>(rows: T[], sort: BreakdownSort): T[] {
  const dirFactor = sort.dir === "desc" ? -1 : 1;
  return [...rows].sort((left, right) => {
    switch (sort.key) {
      case "token_usage":
        if (left.token_usage !== right.token_usage) {
          return (left.token_usage - right.token_usage) * dirFactor;
        }
        return right.llm_calls - left.llm_calls;
      case "speed": {
        const a = left.speed.average_tokens_per_second;
        const b = right.speed.average_tokens_per_second;
        if (a == null && b == null) return right.token_usage - left.token_usage;
        if (a == null) return 1;
        if (b == null) return -1;
        return (a - b) * dirFactor;
      }
      case "first_output": {
        const a = left.speed.first_output_median_ms;
        const b = right.speed.first_output_median_ms;
        if (a == null && b == null) return right.token_usage - left.token_usage;
        if (a == null) return 1;
        if (b == null) return -1;
        return (a - b) * dirFactor;
      }
      case "llm_calls":
        return (left.llm_calls - right.llm_calls) * dirFactor;
      case "success_rate": {
        const a = left.llm_calls > 0 ? left.successful_calls / left.llm_calls : null;
        const b = right.llm_calls > 0 ? right.successful_calls / right.llm_calls : null;
        if (a == null && b == null) return 0;
        if (a == null) return 1;
        if (b == null) return -1;
        return (a - b) * dirFactor;
      }
      case "total_cost":
        return compareUsdStrings(left.total_cost, right.total_cost) * dirFactor;
    }
  });
}

export function tokenShareInfo(tokenUsage: number, overallTokenUsage: number): {
  label: string;
  barWidth: string;
  exactPercent: string | null;
} {
  if (overallTokenUsage <= 0) {
    return { label: "—", barWidth: "0%", exactPercent: null };
  }
  const ratio = Math.max(0, Math.min(1, tokenUsage / overallTokenUsage));
  const percent = ratio * 100;
  const label = percent > 0 && percent < 0.05 ? "<0.1%" : `${percent.toFixed(1)}%`;
  return {
    label,
    barWidth: `${percent.toFixed(2)}%`,
    exactPercent: percent.toFixed(2),
  };
}

export function totalTokensTooltip(row: BreakdownRowBase, overallTokenUsage: number): string {
  const share = tokenShareInfo(row.token_usage, overallTokenUsage);
  const lines = [
    t("总 Token：{tokens}", { tokens: formatInteger(row.token_usage) }),
    share.exactPercent !== null
      ? t("占当前筛选总用量：{percent}%（{part} / {total}）", {
          percent: share.exactPercent,
          part: formatInteger(row.token_usage),
          total: formatInteger(overallTokenUsage),
        })
      : t("当前筛选总用量为 0"),
    t("非缓存输入：{tokens}", { tokens: formatInteger(row.input_tokens) }),
    t("缓存读取：{tokens}", { tokens: formatInteger(row.cache_read_tokens) }),
    t("缓存写入：{tokens}", { tokens: formatInteger(row.cache_write_tokens) }),
    t("模型输出：{tokens}", { tokens: formatInteger(row.output_tokens) }),
  ];
  return lines.join("\n");
}

export function successRateText(row: BreakdownRowBase): string {
  if (row.llm_calls <= 0) return "—";
  return `${((row.successful_calls / row.llm_calls) * 100).toFixed(1)}%`;
}

export function breakdownCostTitle(
  row: BreakdownRowBase,
  currency: DisplayCurrency,
  cnyRate: string | null,
): string {
  const lines = [
    t("合计：{cost}", { cost: formatDisplayCostExact(row.total_cost, currency, cnyRate) }),
    t("输入：{cost}", { cost: formatDisplayCostExact(row.input_cost, currency, cnyRate) }),
    t("输出：{cost}", { cost: formatDisplayCostExact(row.output_cost, currency, cnyRate) }),
    t("缓存读取：{cost}", { cost: formatDisplayCostExact(row.cache_read_cost, currency, cnyRate) }),
    t("缓存写入：{cost}", { cost: formatDisplayCostExact(row.cache_write_cost, currency, cnyRate) }),
  ];
  const note = formatConversionNote(currency, cnyRate);
  if (note) {
    lines.push(
      t("原美元金额：{cost}", { cost: formatUsdExact(row.total_cost) }),
      note,
    );
  }
  return lines.join("\n");
}

export function averageCostTitle(
  usdCost: string | null,
  currency: DisplayCurrency,
  cnyRate: string | null,
): string | undefined {
  if (!usdCost) return undefined;
  const note = formatConversionNote(currency, cnyRate);
  const exact = formatDisplayCostExact(usdCost, currency, cnyRate);
  return note
    ? `${exact}\n${t("原美元金额：{cost}", { cost: formatUsdExact(usdCost) })}\n${note}`
    : exact;
}
