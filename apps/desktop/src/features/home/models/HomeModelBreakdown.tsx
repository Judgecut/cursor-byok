import { Fragment, useMemo, useState } from "react";
import type { OverviewModelSummary, PricingSource } from "../../../shared/api";
import { Card } from "../../../shared/ui/Card";
import { Icon } from "../../../shared/ui/Icon";
import { chevronRightIcon, claudeIcon, flatColorOrganizationIcon, openAiIcon } from "../../../shared/ui/icons";
import { formatUsd, formatUsdExact } from "../../../shared/utils/costFormat";
import { formatCompactInteger, formatInteger } from "../../../shared/utils/numberFormat";
import { aggregateTooltip, formatFirstOutput, formatSpeed } from "../../../shared/utils/speedFormat";
import { ScrollableContent } from "../../../shared/virtual/ScrollableContent";
import styles from "./HomeModelBreakdown.module.scss";

function sourceBadgeLabel(source: PricingSource): string {
  if (source === "custom") return t("自定义定价");
  if (source === "catalog") return t("公开目录");
  return t("未定价");
}

function supplierIcon(sourceKind: string, providerType: string) {
  if (providerType === "anthropic") return claudeIcon;
  if (sourceKind === "plugin") return flatColorOrganizationIcon;
  return openAiIcon;
}

function costTitle(item: {
  total_cost: string;
  input_cost: string;
  output_cost: string;
  cache_read_cost: string;
  cache_write_cost: string;
}) {
  return [
    t("合计：{cost}", { cost: formatUsdExact(item.total_cost) }),
    t("输入：{cost}", { cost: formatUsdExact(item.input_cost) }),
    t("输出：{cost}", { cost: formatUsdExact(item.output_cost) }),
    t("缓存读取：{cost}", { cost: formatUsdExact(item.cache_read_cost) }),
    t("缓存写入：{cost}", { cost: formatUsdExact(item.cache_write_cost) }),
  ].join("\n");
}

export function HomeModelBreakdown({ models }: { models: OverviewModelSummary[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // Rows keep the backend cost order until the speed header is used; rows without
  // a sample always sort last so an unknown rate never looks like the slowest.
  const [speedSort, setSpeedSort] = useState<"desc" | "asc" | null>(null);
  const sortedModels = useMemo(() => {
    if (speedSort == null) return models;
    return [...models].sort((left, right) => {
      const leftSpeed = left.speed.average_tokens_per_second;
      const rightSpeed = right.speed.average_tokens_per_second;
      if (leftSpeed == null && rightSpeed == null) return 0;
      if (leftSpeed == null) return 1;
      if (rightSpeed == null) return -1;
      return speedSort === "desc" ? rightSpeed - leftSpeed : leftSpeed - rightSpeed;
    });
  }, [models, speedSort]);
  const toggleSpeedSort = () => {
    setSpeedSort((current) => current == null ? "desc" : current === "desc" ? "asc" : null);
  };

  const toggle = (modelId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  };

  if (models.length === 0) {
    return <Card className={styles.card}>
      <div className={styles.empty}>{t("当前筛选范围内暂无模型调用数据")}</div>
    </Card>;
  }

  return <Card className={styles.card}>
    <ScrollableContent horizontal className={styles.viewport} contentClassName={styles.content}>
      <table className={styles.table} aria-label={t("按模型与供应商统计")}>
        <thead>
          <tr>
            <th>{t("模型 / 供应商")}</th>
            <th>{t("调用")}</th>
            <th>{t("输入")}</th>
            <th>{t("缓存读 / 写")}</th>
            <th>{t("输出")}</th>
            <th aria-sort={speedSort === "asc" ? "ascending" : speedSort === "desc" ? "descending" : "none"}>
              <button
                type="button"
                className={styles.sortHeader}
                onClick={toggleSpeedSort}
                title={t("按平均速度排序，无样本的行排在最后")}
              >
                {t("平均速度（tok/s）")}
                <span className={styles.sortMarker}>
                  {speedSort === "desc" ? "↓" : speedSort === "asc" ? "↑" : "↕"}
                </span>
              </button>
            </th>
            <th>{t("首 Token（s）")}</th>
            <th>{t("估算费用")}</th>
            <th>{t("单次均值")}</th>
          </tr>
        </thead>
        <tbody>
          {sortedModels.map((model) => {
            const isOpen = expanded.has(model.model_id);
            return <Fragment key={model.model_id}>
              <tr className={styles.parentRow} onClick={() => toggle(model.model_id)}>
                <td>
                  <button
                    type="button"
                    className={styles.toggle}
                    aria-expanded={isOpen}
                    onClick={(event) => { event.stopPropagation(); toggle(model.model_id); }}
                  >
                    <Icon
                      icon={chevronRightIcon}
                      size="1.1em"
                      className={[styles.chevron, isOpen && styles.chevronExpanded].filter(Boolean).join(" ")}
                    />
                    <span className={styles.modelName}>{model.model_id}</span>
                    {model.providers.length > 1 && <span className={styles.badge}>
                      {t("{count} 供应商", { count: model.providers.length })}
                    </span>}
                  </button>
                </td>
                <td className={styles.monoNum} title={t("成功 {successful} / 异常 {failed}", { successful: model.successful_calls, failed: model.failed_calls })}>
                  <span>{formatCompactInteger(model.llm_calls)}</span>
                  {model.unpriced_calls > 0 && <span className={styles.subValue}>{t("含 {count} 未定价", { count: formatCompactInteger(model.unpriced_calls) })}</span>}
                </td>
                <td className={styles.monoNum} title={formatInteger(model.input_tokens)}>{formatCompactInteger(model.input_tokens)}</td>
                <td className={styles.monoNum} title={`${formatInteger(model.cache_read_tokens)} / ${formatInteger(model.cache_write_tokens)}`}>
                  {formatCompactInteger(model.cache_read_tokens)} / {formatCompactInteger(model.cache_write_tokens)}
                </td>
                <td className={styles.monoNum} title={formatInteger(model.output_tokens)}>{formatCompactInteger(model.output_tokens)}</td>
                <td className={styles.monoNum} title={aggregateTooltip(model.speed)}>
                  {formatSpeed(model.speed.average_tokens_per_second, model.speed.status)}
                </td>
                <td className={styles.monoNum} title={aggregateTooltip(model.speed)}>
                  {formatFirstOutput(model.speed.first_output_median_ms)}
                </td>
                <td className={styles.monoNum} title={costTitle(model)}>{formatUsd(model.total_cost)}</td>
                <td className={styles.monoNum} title={model.average_priced_cost ? formatUsdExact(model.average_priced_cost) : undefined}>
                  {model.average_priced_cost ? formatUsd(model.average_priced_cost) : "—"}
                </td>
              </tr>
              {isOpen && model.providers.map((provider) => <tr key={provider.supplier_key} className={styles.childRow}>
                <td>
                  <div className={styles.supplierCell}>
                    <div className={styles.supplierMain}>
                      <Icon icon={supplierIcon(provider.source_kind, provider.provider_type)} size="1em" />
                      <span>{provider.label}</span>
                      <span className={[
                        styles.badge,
                        provider.pricing_source === "unpriced" ? styles.badgeWarn : styles.badgeActive,
                      ].join(" ")}>{sourceBadgeLabel(provider.pricing_source)}</span>
                      {!provider.active && <span className={styles.badge}>{t("历史")}</span>}
                    </div>
                    <span className={styles.supplierEndpoint}>{provider.endpoint_key}</span>
                  </div>
                </td>
                <td className={styles.monoNum} title={t("成功 {successful} / 异常 {failed}", { successful: provider.successful_calls, failed: provider.failed_calls })}>
                  <span>{formatCompactInteger(provider.llm_calls)}</span>
                  {provider.unpriced_calls > 0 && <span className={styles.subValue}>{t("含 {count} 未定价", { count: formatCompactInteger(provider.unpriced_calls) })}</span>}
                </td>
                <td className={styles.monoNum} title={formatInteger(provider.input_tokens)}>{formatCompactInteger(provider.input_tokens)}</td>
                <td className={styles.monoNum} title={`${formatInteger(provider.cache_read_tokens)} / ${formatInteger(provider.cache_write_tokens)}`}>
                  {formatCompactInteger(provider.cache_read_tokens)} / {formatCompactInteger(provider.cache_write_tokens)}
                </td>
                <td className={styles.monoNum} title={formatInteger(provider.output_tokens)}>{formatCompactInteger(provider.output_tokens)}</td>
                <td className={styles.monoNum} title={aggregateTooltip(provider.speed)}>
                  {formatSpeed(provider.speed.average_tokens_per_second, provider.speed.status)}
                </td>
                <td className={styles.monoNum} title={aggregateTooltip(provider.speed)}>
                  {formatFirstOutput(provider.speed.first_output_median_ms)}
                </td>
                <td className={styles.monoNum} title={costTitle(provider)}>{formatUsd(provider.total_cost)}</td>
                <td className={styles.monoNum} title={provider.average_priced_cost ? formatUsdExact(provider.average_priced_cost) : undefined}>
                  {provider.average_priced_cost ? formatUsd(provider.average_priced_cost) : "—"}
                </td>
              </tr>)}
            </Fragment>;
          })}
        </tbody>
      </table>
    </ScrollableContent>
  </Card>;
}
