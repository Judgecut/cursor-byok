import type { PricingSource, SpeedAggregate } from "../../../shared/api";
import {
  compareUsdStrings,
  formatConversionNote,
  formatDisplayCost,
  formatDisplayCostExact,
  formatUsdExact,
  type DisplayCurrency,
} from "../../../shared/utils/costFormat";
import { formatCompactInteger, formatInteger } from "../../../shared/utils/numberFormat";
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
  incomplete_usage_calls: number;
  unreported_cache_calls: number;
  assumed_cache_calls: number;
  assumed_cache_cost: string;
  estimated_cache_read_tokens: number;
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

export function allCacheUsageUnreported(row: BreakdownRowBase): boolean {
  return row.unreported_cache_calls > 0
    && row.unreported_cache_calls + row.incomplete_usage_calls >= row.llm_calls;
}

export function renderBreakdownCacheCell(row: BreakdownRowBase) {
  if (allCacheUsageUnreported(row)) {
    return <span className={styles.subValue}>{t("未上报")}</span>;
  }
  const counts = `${formatCompactInteger(row.cache_read_tokens)} / ${formatCompactInteger(row.cache_write_tokens)}`;
  if (row.unreported_cache_calls <= 0) {
    return counts;
  }
  return <>
    <div>{counts}</div>
    <div className={styles.subValue}>
      {t("含 {count} 次未上报", { count: formatCompactInteger(row.unreported_cache_calls) })}
    </div>
  </>;
}

export function breakdownCacheTitle(row: BreakdownRowBase): string {
  if (allCacheUsageUnreported(row)) {
    const base = t("已上报用量的 {count} 次调用均未提供缓存读写字段", {
      count: formatInteger(row.unreported_cache_calls),
    });
    return row.assumed_cache_calls > 0
      ? `${base}\n${t("计费已对 {count} 次调用按默认命中率估算缓存读取（约 {tokens} Token）", {
          count: formatInteger(row.assumed_cache_calls),
          tokens: formatInteger(row.estimated_cache_read_tokens),
        })}`
      : base;
  }
  const lines = [
    `${formatInteger(row.cache_read_tokens)} / ${formatInteger(row.cache_write_tokens)}`,
  ];
  if (
    row.cache_read_tokens === 0
    && row.cache_write_tokens === 0
    && row.unreported_cache_calls === 0
    && row.llm_calls > row.incomplete_usage_calls
  ) {
    lines.push(t("缓存读写均明确上报为 0"));
  }
  if (row.unreported_cache_calls > 0) {
    lines.push(t("另有 {count} 次调用未上报缓存字段", {
      count: formatInteger(row.unreported_cache_calls),
    }));
  }
  if (row.assumed_cache_calls > 0) {
    lines.push(t("计费已对 {count} 次调用按默认命中率估算缓存读取（约 {tokens} Token）", {
      count: formatInteger(row.assumed_cache_calls),
      tokens: formatInteger(row.estimated_cache_read_tokens),
    }));
  }
  return lines.join("\n");
}

export function renderBreakdownCostCell(
  row: BreakdownRowBase,
  currency: DisplayCurrency,
  exchangeRate: string | null,
) {
  const main = formatDisplayCost(row.total_cost, currency, exchangeRate);
  if (row.assumed_cache_calls <= 0) return main;
  return <>
    <div>{main}</div>
    <div className={styles.subValue}>
      {row.assumed_cache_calls === row.llm_calls
        ? t("含估算缓存")
        : t("含 {count} 次缓存估算", { count: formatCompactInteger(row.assumed_cache_calls) })}
    </div>
  </>;
}

export function breakdownCostTitle(
  row: BreakdownRowBase,
  currency: DisplayCurrency,
  exchangeRate: string | null,
): string {
  const lines = [
    t("合计：{cost}", { cost: formatDisplayCostExact(row.total_cost, currency, exchangeRate) }),
    t("输入：{cost}", { cost: formatDisplayCostExact(row.input_cost, currency, exchangeRate) }),
    t("输出：{cost}", { cost: formatDisplayCostExact(row.output_cost, currency, exchangeRate) }),
    t("缓存读取：{cost}", { cost: formatDisplayCostExact(row.cache_read_cost, currency, exchangeRate) }),
    t("缓存写入：{cost}", { cost: formatDisplayCostExact(row.cache_write_cost, currency, exchangeRate) }),
  ];
  if (row.assumed_cache_calls > 0) {
    lines.push(t("其中 {count} 次未上报缓存明细，按默认命中率估算费用 {cost}（缓存读取约 {tokens} Token）", {
      count: formatInteger(row.assumed_cache_calls),
      cost: formatDisplayCostExact(row.assumed_cache_cost, currency, exchangeRate),
      tokens: formatInteger(row.estimated_cache_read_tokens),
    }));
  } else if (row.unreported_cache_calls > 0) {
    lines.push(t("其中 {count} 次调用未上报缓存明细", {
      count: formatInteger(row.unreported_cache_calls),
    }));
  }
  const note = formatConversionNote(currency, exchangeRate);
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
  exchangeRate: string | null,
): string | undefined {
  if (!usdCost) return undefined;
  const note = formatConversionNote(currency, exchangeRate);
  const exact = formatDisplayCostExact(usdCost, currency, exchangeRate);
  return note
    ? `${exact}\n${t("原美元金额：{cost}", { cost: formatUsdExact(usdCost) })}\n${note}`
    : exact;
}
