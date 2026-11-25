import { useCallback, useMemo, useState } from "react";
import { useI18n } from "../../../i18n/store";
import type { OverviewSupplierBreakdown, PluginDescriptor } from "../../../shared/api";
import { Card } from "../../../shared/ui/Card";
import { Icon } from "../../../shared/ui/Icon";
import { formatDisplayCost, type DisplayCurrency, type DisplayExchangeRate } from "../../../shared/utils/costFormat";
import { formatCompactInteger, formatInteger } from "../../../shared/utils/numberFormat";
import { historicalSupplierBrand, resolveSupplierIcon } from "../../../shared/utils/providerIcons";
import { aggregateTooltip, formatFirstOutput, formatSpeed } from "../../../shared/utils/speedFormat";
import { buildPluginLabelMap } from "../../../shared/utils/supplierOptions";
import { ScrollableContent } from "../../../shared/virtual/ScrollableContent";
import { RollingNumber } from "../motion/RollingNumber";
import {
  ariaSortValue,
  averageCostTitle,
  breakdownCacheTitle,
  breakdownCostTitle,
  cacheHitRateText,
  nextBreakdownSort,
  PricingSourceBadges,
  renderBreakdownCostCell,
  sortBreakdownRows,
  sortIndicator,
  successRateText,
  tokenShareInfo,
  totalTokensTooltip,
  useBreakdownHighlights,
  type BreakdownSort,
  type BreakdownSortKey,
} from "../breakdown/breakdownShared";
import styles from "../breakdown/BreakdownTable.module.scss";

export function HomeSupplierBreakdown({
  suppliers,
  providerIcons,
  plugins,
  overallTokenUsage,
  currency,
  exchangeRate,
  animate = true,
  filterKey = "",
  loading = false,
  error = null,
}: {
  suppliers: OverviewSupplierBreakdown[];
  providerIcons: ReadonlyMap<string, string | null>;
  plugins: PluginDescriptor[];
  overallTokenUsage: number;
  currency: DisplayCurrency;
  exchangeRate: DisplayExchangeRate | null;
  animate?: boolean;
  filterKey?: string;
  loading?: boolean;
  error?: string | null;
}) {
  const { locale } = useI18n();
  const [sort, setSort] = useState<BreakdownSort>({ key: "token_usage", dir: "desc" });
  const pluginLabels = useMemo(() => buildPluginLabelMap(plugins, locale), [locale, plugins]);
  const sortedSuppliers = useMemo(() => sortBreakdownRows(suppliers, sort), [sort, suppliers]);
  const getSupplierId = useCallback((supplier: OverviewSupplierBreakdown) => supplier.supplier_id, []);
  const highlightedIds = useBreakdownHighlights(suppliers, getSupplierId, filterKey, animate);
  const costResetKey = `${filterKey}|${currency}|${exchangeRate?.rate ?? ""}`;
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
                title={t("按生成速度排序，无样本的行排在最后")}
              >
                {t("生成速度（tok/s）")}
                <span className={styles.sortMarker}>{sortIndicator(sort, "speed")}</span>
              </button>
            </th>
            <th aria-sort={ariaSortValue(sort, "first_output")}>
              <button
                type="button"
                className={styles.sortHeader}
                onClick={() => toggleSort("first_output")}
                title={t("按首次输出等待时间排序，无样本的行排在最后")}
              >
                {t("首次输出（s）")}
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
            <th>{t("缓存命中率")}</th>
            <th>{t("输出")}</th>
            <th>{t("单次均值")}</th>
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
          </tr>
        </thead>
        <tbody>
          {sortedSuppliers.map((supplier) => {
            const historicalBrand = historicalSupplierBrand(supplier);
            const label = (supplier.source_kind === "plugin" ? pluginLabels.get(supplier.endpoint_key) : undefined)
              || historicalBrand
              || supplier.label;
            const share = tokenShareInfo(supplier.token_usage, overallTokenUsage);
            const updated = highlightedIds.has(supplier.supplier_id);
            return <tr key={supplier.supplier_id} className={updated ? styles.updatedRow : undefined} data-animate={animate}>
              <td className={styles.stickyName}>
                <div className={styles.entityCell}>
                  <div className={styles.entityMain}>
                    <Icon {...resolveSupplierIcon(supplier, supplier.provider_id ? providerIcons.get(supplier.provider_id) : null)} />
                    <span className={styles.entityName} title={historicalBrand ? supplier.endpoint_key : label}>{label}</span>
                    {!supplier.active && <span className={styles.badge}>{t("历史")}</span>}
                    {supplier.model_count > 1 && <span className={styles.badge}>
                      {t("{count} 模型", { count: supplier.model_count })}
                    </span>}
                    <PricingSourceBadges sources={supplier.pricing_sources} />
                  </div>
                  {!historicalBrand && <span className={styles.entitySub} title={supplier.endpoint_key}>{supplier.endpoint_key}</span>}
                </div>
              </td>
              <td className={styles.stickyTotal} title={totalTokensTooltip(supplier, overallTokenUsage)}>
                <div className={styles.totalCell}>
                  <div className={styles.totalTop}>
                    <span className={styles.totalValue}>
                      <RollingNumber
                        value={formatCompactInteger(supplier.token_usage)}
                        numericValue={supplier.token_usage}
                        animate={animate}
                        resetKey={filterKey}
                        polarity="activity"
                      />
                    </span>
                    <span className={styles.shareValue}>
                      <RollingNumber
                        value={share.label}
                        numericValue={share.exactPercent !== null ? Number(share.exactPercent) : null}
                        animate={animate}
                        resetKey={filterKey}
                        polarity="neutral"
                      />
                    </span>
                  </div>
                  <div className={styles.shareTrack} aria-hidden="true">
                    <div className={styles.shareFill} data-animate={animate} data-updated={updated ? "true" : undefined} style={{ width: share.barWidth }} />
                  </div>
                </div>
              </td>
              <td className={styles.monoNum} title={aggregateTooltip(supplier.speed)}>
                {formatSpeed(supplier.speed.average_tokens_per_second, "estimated")}
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
              <td className={styles.monoNum} title={breakdownCacheTitle(supplier)}>
                {cacheHitRateText(supplier)}
              </td>
              <td className={styles.monoNum} title={formatInteger(supplier.output_tokens)}>
                {formatCompactInteger(supplier.output_tokens)}
              </td>
              <td
                className={styles.monoNum}
                title={averageCostTitle(supplier.average_priced_cost, currency, exchangeRate)}
              >
                {supplier.average_priced_cost
                  ? formatDisplayCost(supplier.average_priced_cost, currency, exchangeRate)
                  : "—"}
              </td>
              <td className={styles.monoNum} title={breakdownCostTitle(supplier, currency, exchangeRate)}>
                {renderBreakdownCostCell(supplier, currency, exchangeRate, { animate, resetKey: costResetKey })}
              </td>
            </tr>;
          })}
        </tbody>
      </table>
    </ScrollableContent>
  </Card>;
}
