import { useMemo, useState } from "react";
import type { OverviewModelSummary } from "../../../shared/api";
import { Card } from "../../../shared/ui/Card";
import { formatDisplayCost, type DisplayCurrency } from "../../../shared/utils/costFormat";
import { formatCompactInteger, formatInteger } from "../../../shared/utils/numberFormat";
import { aggregateTooltip, formatFirstOutput, formatSpeed } from "../../../shared/utils/speedFormat";
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

export function HomeModelBreakdown({
  models,
  overallTokenUsage,
  currency,
  cnyRate,
  loading = false,
  error = null,
}: {
  models: OverviewModelSummary[];
  overallTokenUsage: number;
  currency: DisplayCurrency;
  cnyRate: string | null;
  loading?: boolean;
  error?: string | null;
}) {
  const [sort, setSort] = useState<BreakdownSort>({ key: "token_usage", dir: "desc" });
  const sortedModels = useMemo(() => sortBreakdownRows(models, sort), [models, sort]);
  const toggleSort = (key: BreakdownSortKey) => setSort((current) => nextBreakdownSort(current, key));

  if (error) {
    return <Card className={styles.card}>
      <div className={styles.empty}>{t("模型统计加载失败：{error}", { error })}</div>
    </Card>;
  }

  if (models.length === 0) {
    return <Card className={styles.card}>
      <div className={styles.empty}>
        {loading ? t("正在加载模型统计…") : t("当前筛选范围内暂无模型调用数据")}
      </div>
    </Card>;
  }

  return <Card className={styles.card}>
    <ScrollableContent horizontal className={styles.viewport} contentClassName={styles.content}>
      <table className={styles.table} aria-label={t("按模型统计")}>
        <thead>
          <tr>
            <th className={styles.stickyName}>{t("模型")}</th>
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
                title={t("按平均速度排序，无样本的行排在最后")}
              >
                {t("平均速度（tok/s）")}
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
          {sortedModels.map((model) => {
            const share = tokenShareInfo(model.token_usage, overallTokenUsage);
            return <tr key={model.model_id}>
              <td className={styles.stickyName}>
                <div className={styles.entityCell}>
                  <div className={styles.entityMain}>
                    <span className={styles.entityName} title={model.model_id}>{model.model_id}</span>
                    {model.supplier_count > 1 && <span className={styles.badge}>
                      {t("{count} 供应商", { count: model.supplier_count })}
                    </span>}
                    <PricingSourceBadges sources={model.pricing_sources} />
                  </div>
                </div>
              </td>
              <td className={styles.stickyTotal} title={totalTokensTooltip(model, overallTokenUsage)}>
                <div className={styles.totalCell}>
                  <div className={styles.totalTop}>
                    <span className={styles.totalValue}>{formatCompactInteger(model.token_usage)}</span>
                    <span className={styles.shareValue}>{share.label}</span>
                  </div>
                  <div className={styles.shareTrack} aria-hidden="true">
                    <div className={styles.shareFill} style={{ width: share.barWidth }} />
                  </div>
                </div>
              </td>
              <td className={styles.monoNum} title={aggregateTooltip(model.speed)}>
                {formatSpeed(model.speed.average_tokens_per_second, model.speed.status)}
              </td>
              <td className={styles.monoNum} title={aggregateTooltip(model.speed)}>
                {formatFirstOutput(model.speed.first_output_median_ms)}
              </td>
              <td
                className={styles.monoNum}
                title={t("成功 {successful} / 异常 {failed}", {
                  successful: model.successful_calls,
                  failed: model.failed_calls,
                })}
              >
                <span>{formatCompactInteger(model.llm_calls)}</span>
                {model.unpriced_calls > 0 && <span className={styles.subValue}>
                  {t("含 {count} 未定价", { count: formatCompactInteger(model.unpriced_calls) })}
                </span>}
              </td>
              <td
                className={styles.monoNum}
                title={t("成功 {successful} / 异常 {failed}", {
                  successful: formatInteger(model.successful_calls),
                  failed: formatInteger(model.failed_calls),
                })}
              >
                {successRateText(model)}
              </td>
              <td className={styles.monoNum} title={formatInteger(model.input_tokens)}>
                {formatCompactInteger(model.input_tokens)}
              </td>
              <td
                className={styles.monoNum}
                title={`${formatInteger(model.cache_read_tokens)} / ${formatInteger(model.cache_write_tokens)}`}
              >
                {formatCompactInteger(model.cache_read_tokens)} / {formatCompactInteger(model.cache_write_tokens)}
              </td>
              <td className={styles.monoNum} title={formatInteger(model.output_tokens)}>
                {formatCompactInteger(model.output_tokens)}
              </td>
              <td className={styles.monoNum} title={breakdownCostTitle(model, currency, cnyRate)}>
                {formatDisplayCost(model.total_cost, currency, cnyRate)}
              </td>
              <td
                className={styles.monoNum}
                title={averageCostTitle(model.average_priced_cost, currency, cnyRate)}
              >
                {model.average_priced_cost
                  ? formatDisplayCost(model.average_priced_cost, currency, cnyRate)
                  : "—"}
              </td>
            </tr>;
          })}
        </tbody>
      </table>
    </ScrollableContent>
  </Card>;
}
