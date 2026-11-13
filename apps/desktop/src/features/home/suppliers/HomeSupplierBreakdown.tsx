import { useMemo, useState } from "react";
import { useI18n } from "../../../i18n/store";
import type { OverviewSupplierBreakdown, PluginDescriptor } from "../../../shared/api";
import { Card } from "../../../shared/ui/Card";
import { Icon } from "../../../shared/ui/Icon";
import { claudeIcon, flatColorOrganizationIcon, openAiIcon } from "../../../shared/ui/icons";
import { formatDisplayCost, type DisplayCurrency } from "../../../shared/utils/costFormat";
import { formatCompactInteger, formatInteger } from "../../../shared/utils/numberFormat";
import { aggregateTooltip, formatFirstOutput, formatSpeed } from "../../../shared/utils/speedFormat";
import { buildPluginLabelMap } from "../../../shared/utils/supplierOptions";
import { ScrollableContent } from "../../../shared/virtual/ScrollableContent";
import {
  ariaSortValue,
  averageCostTitle,
  breakdownCostTitle,
  nextBreakdownSort,
  PricingSourceBadges,
  sortBreakdownRows,
  sortIndicator,
  successRateText,
  tokenShareInfo,
  totalTokensTooltip,
  type BreakdownSort,
  type BreakdownSortKey,
} from "../breakdown/breakdownShared";
import styles from "../breakdown/BreakdownTable.module.scss";

function supplierIcon(sourceKind: string, providerType: string) {
  if (providerType === "anthropic") return claudeIcon;
  if (sourceKind === "plugin") return flatColorOrganizationIcon;
  return openAiIcon;
}

export function HomeSupplierBreakdown({
  suppliers,
  plugins,
  overallTokenUsage,
  currency,
  cnyRate,
  loading = false,
  error = null,
}: {
  suppliers: OverviewSupplierBreakdown[];
  plugins: PluginDescriptor[];
  overallTokenUsage: number;
  currency: DisplayCurrency;
  cnyRate: string | null;
  loading?: boolean;
  error?: string | null;
}) {
  const { locale } = useI18n();
  const [sort, setSort] = useState<BreakdownSort>({ key: "token_usage", dir: "desc" });
  const pluginLabels = useMemo(() => buildPluginLabelMap(plugins, locale), [locale, plugins]);
  const sortedSuppliers = useMemo(() => sortBreakdownRows(suppliers, sort), [sort, suppliers]);
  const toggleSort = (key: BreakdownSortKey) => setSort((current) => nextBreakdownSort(current, key));

  if (error) {
    return <Card className={styles.card}>
      <div className={styles.empty}>{t("供应商统计加载失败：{error}", { error })}</div>
    </Card>;
  }

  if (suppliers.length === 0) {
    return <Card className={styles.card}>
      <div className={styles.empty}>
        {loading ? t("正在加载供应商统计…") : t("当前筛选范围内暂无供应商调用数据")}
      </div>
    </Card>;
  }

  return <Card className={styles.card}>
    <ScrollableContent horizontal className={styles.viewport} contentClassName={styles.content}>
      <table className={styles.table} aria-label={t("按供应商统计")}>
        <thead>
          <tr>
            <th className={styles.stickyName}>{t("供应商")}</th>
            <th className={styles.stickyTotal} aria-sort={ariaSortValue(sort, "token_usage")}>
              <button
                type="button"
                className={[styles.sortHeader, styles.sortHeaderLeft].join(" ")}
                onClick={() => toggleSort("token_usage")}
                title={t("按总 Token 排序")}
              >
                {t("总 Token")}
                <span className={styles.sortMarker}>{sortIndicator(sort, "token_usage")}</span>
              </button>
            </th>
            <th aria-sort={ariaSortValue(sort, "speed")}>
              <button
                type="button"
                className={styles.sortHeader}
                onClick={() => toggleSort("speed")}
                title={t("按整体速度排序，无样本的行排在最后")}
              >
                {t("整体速度（tok/s）")}
                <span className={styles.sortMarker}>{sortIndicator(sort, "speed")}</span>
              </button>
            </th>
            <th aria-sort={ariaSortValue(sort, "first_output")}>
              <button
                type="button"
                className={styles.sortHeader}
                onClick={() => toggleSort("first_output")}
                title={t("按首 Token 等待时间排序，无样本的行排在最后")}
              >
                {t("首 Token（s）")}
                <span className={styles.sortMarker}>{sortIndicator(sort, "first_output")}</span>
              </button>
            </th>
            <th aria-sort={ariaSortValue(sort, "llm_calls")}>
              <button
                type="button"
                className={styles.sortHeader}
                onClick={() => toggleSort("llm_calls")}
                title={t("按调用次数排序")}
              >
                {t("调用")}
                <span className={styles.sortMarker}>{sortIndicator(sort, "llm_calls")}</span>
              </button>
            </th>
            <th aria-sort={ariaSortValue(sort, "success_rate")}>
              <button
                type="button"
                className={styles.sortHeader}
                onClick={() => toggleSort("success_rate")}
                title={t("按成功率排序")}
              >
                {t("成功率")}
                <span className={styles.sortMarker}>{sortIndicator(sort, "success_rate")}</span>
              </button>
            </th>
            <th>{t("输入")}</th>
            <th>{t("缓存读 / 写")}</th>
            <th>{t("输出")}</th>
            <th aria-sort={ariaSortValue(sort, "total_cost")}>
              <button
                type="button"
                className={styles.sortHeader}
                onClick={() => toggleSort("total_cost")}
                title={t("按估算费用排序")}
              >
                {t("估算费用")}
                <span className={styles.sortMarker}>{sortIndicator(sort, "total_cost")}</span>
              </button>
            </th>
            <th>{t("单次均值")}</th>
          </tr>
        </thead>
        <tbody>
          {sortedSuppliers.map((supplier) => {
            const label = (supplier.source_kind === "plugin" ? pluginLabels.get(supplier.endpoint_key) : undefined)
              || supplier.label;
            const share = tokenShareInfo(supplier.token_usage, overallTokenUsage);
            return <tr key={supplier.supplier_id}>
              <td className={styles.stickyName}>
                <div className={styles.entityCell}>
                  <div className={styles.entityMain}>
                    <Icon
                      icon={supplier.plugin_icon ? undefined : supplierIcon(supplier.source_kind, supplier.provider_type)}
                      src={supplier.plugin_icon || undefined}
                      size="1em"
                    />
                    <span className={styles.entityName} title={label}>{label}</span>
                    {!supplier.active && <span className={styles.badge}>{t("历史")}</span>}
                    {supplier.model_count > 1 && <span className={styles.badge}>
                      {t("{count} 模型", { count: supplier.model_count })}
                    </span>}
                    <PricingSourceBadges sources={supplier.pricing_sources} />
                  </div>
                  <span className={styles.entitySub} title={supplier.endpoint_key}>{supplier.endpoint_key}</span>
                </div>
              </td>
              <td className={styles.stickyTotal} title={totalTokensTooltip(supplier, overallTokenUsage)}>
                <div className={styles.totalCell}>
                  <div className={styles.totalTop}>
                    <span className={styles.totalValue}>{formatCompactInteger(supplier.token_usage)}</span>
                    <span className={styles.shareValue}>{share.label}</span>
                  </div>
                  <div className={styles.shareTrack} aria-hidden="true">
                    <div className={styles.shareFill} style={{ width: share.barWidth }} />
                  </div>
                </div>
              </td>
              <td className={styles.monoNum} title={aggregateTooltip(supplier.speed)}>
                {formatSpeed(supplier.speed.average_tokens_per_second)}
              </td>
              <td className={styles.monoNum} title={aggregateTooltip(supplier.speed)}>
                {formatFirstOutput(supplier.speed.first_output_median_ms)}
              </td>
              <td
                className={styles.monoNum}
                title={t("成功 {successful} / 异常 {failed}", {
                  successful: supplier.successful_calls,
                  failed: supplier.failed_calls,
                })}
              >
                <span>{formatCompactInteger(supplier.llm_calls)}</span>
                {supplier.unpriced_calls > 0 && <span className={styles.subValue}>
                  {t("含 {count} 未定价", { count: formatCompactInteger(supplier.unpriced_calls) })}
                </span>}
              </td>
              <td
                className={styles.monoNum}
                title={t("成功 {successful} / 异常 {failed}", {
                  successful: formatInteger(supplier.successful_calls),
                  failed: formatInteger(supplier.failed_calls),
                })}
              >
                {successRateText(supplier)}
              </td>
              <td className={styles.monoNum} title={formatInteger(supplier.input_tokens)}>
                {formatCompactInteger(supplier.input_tokens)}
              </td>
              <td
                className={styles.monoNum}
                title={`${formatInteger(supplier.cache_read_tokens)} / ${formatInteger(supplier.cache_write_tokens)}`}
              >
                {formatCompactInteger(supplier.cache_read_tokens)} / {formatCompactInteger(supplier.cache_write_tokens)}
              </td>
              <td className={styles.monoNum} title={formatInteger(supplier.output_tokens)}>
                {formatCompactInteger(supplier.output_tokens)}
              </td>
              <td className={styles.monoNum} title={breakdownCostTitle(supplier, currency, cnyRate)}>
                {formatDisplayCost(supplier.total_cost, currency, cnyRate)}
              </td>
              <td
                className={styles.monoNum}
                title={averageCostTitle(supplier.average_priced_cost, currency, cnyRate)}
              >
                {supplier.average_priced_cost
                  ? formatDisplayCost(supplier.average_priced_cost, currency, cnyRate)
                  : "—"}
              </td>
            </tr>;
          })}
        </tbody>
      </table>
    </ScrollableContent>
  </Card>;
}
