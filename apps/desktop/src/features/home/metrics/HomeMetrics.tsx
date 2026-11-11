import type { SpeedAggregate } from "../../../shared/api";
import {
  addUsdStrings,
  formatConversionNote,
  formatDisplayCost,
  formatDisplayCostExact,
  formatUsdExact,
  type DisplayCurrency,
} from "../../../shared/utils/costFormat";
import { formatCompactInteger, formatInteger } from "../../../shared/utils/numberFormat";
import { aggregateTooltip, formatFirstOutput, formatSpeed } from "../../../shared/utils/speedFormat";
import { Icon } from "../../../shared/ui/Icon";
import { useTooltip, type TooltipAnchor } from "../../../shared/ui/Tooltip";
import { informationOutlineIcon } from "../../../shared/ui/icons";
import styles from "./HomeMetrics.module.scss";

export type HomeMetricsData = {
  llmCalls: number;
  successfulCalls: number;
  failedCalls: number;
  tokenUsage: number;
  promptTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalCost: string;
  inputCost: string;
  outputCost: string;
  cacheReadCost: string;
  cacheWriteCost: string;
  averagePricedCost: string | null;
  pricedCalls: number;
  unpricedCalls: number;
  incompleteUsageCalls: number;
  speed: SpeedAggregate;
};

function formatMetricValue(value: number) {
  const full = formatInteger(value);
  const compact = formatCompactInteger(value);
  return full === compact ? full : `${full} (${compact})`;
}

function formatRate(value: number | null) {
  return value === null ? t("暂无数据") : `${(Math.max(0, Math.min(1, value)) * 100).toFixed(2)}%`;
}

function calculateRate(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : null;
}

function elementAnchor(element: HTMLElement): TooltipAnchor {
  return {
    contextElement: element,
    getBoundingClientRect: () => element.getBoundingClientRect(),
  };
}

function InfoTooltip({ content }: { content: string }) {
  const { show, hide } = useTooltip();

  return <button
    type="button"
    className={styles.info}
    aria-label={t("查看说明")}
    onMouseEnter={(event) => show(elementAnchor(event.currentTarget), undefined, <div className={styles.tooltipText}>{content}</div>)}
    onMouseLeave={hide}
    onFocus={(event) => show(elementAnchor(event.currentTarget), undefined, <div className={styles.tooltipText}>{content}</div>)}
    onBlur={hide}
  ><Icon icon={informationOutlineIcon} size="1.1em" /></button>;
}

export function HomeMetrics({
  data,
  currency,
  cnyRate,
  loading = false,
  error = null,
}: {
  data: HomeMetricsData | null;
  currency: DisplayCurrency;
  cnyRate: string | null;
  loading?: boolean;
  error?: string | null;
}) {
  if (!data) {
    const placeholder = loading ? "…" : "—";
    const statusText = error
      ? t("统计加载失败：{error}", { error })
      : loading
        ? t("正在加载…")
        : t("暂无数据");
    const titles = [
      t("缓存命中率"),
      t("LLM 调用"),
      t("平均速度（tok/s）"),
      t("首 Token（s）"),
      t("Token 消耗"),
      t("估算费用"),
    ];
    return <section className={styles.root} aria-label={t("调用统计")} aria-busy={loading}>
      {titles.map((title) => (
        <article className={styles.metric} key={title}>
          <div className={styles.label}>{title}</div>
          <div className={styles.body}>
            <div className={styles.value}>{placeholder}</div>
            <div className={styles.secondary} title={statusText}>{statusText}</div>
          </div>
        </article>
      ))}
    </section>;
  }

  const defaultCacheHitRate = calculateRate(data.cacheReadTokens, data.cacheReadTokens + data.inputTokens);
  const cacheReuseRate = calculateRate(
    data.cacheReadTokens,
    data.cacheReadTokens + data.cacheWriteTokens + data.inputTokens,
  );
  const successfulCallRate = calculateRate(data.successfulCalls, data.llmCalls);
  const cacheCost = addUsdStrings(data.cacheReadCost, data.cacheWriteCost);
  const conversionNote = formatConversionNote(currency, cnyRate);

  const cacheHitPrimary = formatRate(defaultCacheHitRate);
  const cacheHitSecondary = defaultCacheHitRate === null
    ? t("计入缓存创建 暂无数据")
    : t("计入缓存创建 {rate}", { rate: formatRate(cacheReuseRate) });

  const cacheTooltip = [
    t("当前：{rate}", { rate: formatRate(defaultCacheHitRate) }),
    t("公式：缓存读取 /（缓存读取 + 非缓存输入）"),
    t("默认 {defaultRate} / 计入创建 {reuseRate}", {
      defaultRate: formatRate(defaultCacheHitRate),
      reuseRate: formatRate(cacheReuseRate),
    }),
  ].join("\n");

  const callsTooltip = [
    t("按历史 LLM 调用记录汇总，进行中的调用不计入。"),
    "",
    t("总调用：{count}", { count: formatMetricValue(data.llmCalls) }),
    t("成功调用：{count}", { count: formatMetricValue(data.successfulCalls) }),
    t("异常调用：{count}", { count: formatMetricValue(data.failedCalls) }),
    t("成功占比：{rate}", { rate: formatRate(successfulCallRate) }),
  ].join("\n");

  const speedDisplay = data.speed.average_tokens_per_second == null
    ? "—"
    : `${formatSpeed(data.speed.average_tokens_per_second, data.speed.status)} tok/s`;
  const speedSamples = data.speed.status === "estimated"
    ? data.speed.estimated.samples
    : data.speed.measured.samples;
  const speedSecondary = data.speed.average_tokens_per_second == null
    ? t("无有效速度样本")
    : data.speed.status === "estimated"
      ? t("估算样本 {count} 条", { count: formatCompactInteger(speedSamples) })
      : t("实测样本 {count} 条", { count: formatCompactInteger(speedSamples) });
  const speedTooltip = [
    aggregateTooltip(data.speed),
    t("仅统计成功流式且输出 ≥100 Token、生成时间 ≥100ms 的调用；模型测试不计入。"),
  ].join("\n");

  const firstOutputDisplay = formatFirstOutput(data.speed.first_output_median_ms);
  const firstOutputSecondary = data.speed.first_output_median_ms != null
    ? t("成功流式调用中位数")
    : t("无可用首 Token 样本");
  const firstOutputTooltip = [
    t("首 Token（中位数）：{value}", { value: firstOutputDisplay }),
    t("统计成功流式调用首次实际输出等待时间的中位数，不二次平均各行中位数。"),
    t("首次实际输出包含非空正文、思考与工具输出，排除响应头、心跳与空事件。"),
    t("首 Token 不受 100 Token 输出门槛限制；模型测试不计入。"),
  ].join("\n");

  const tokensTooltip = [
    t("总请求 Token 包含提示词和模型输出。"),
    "",
    t("总请求：{tokens}", { tokens: formatMetricValue(data.tokenUsage) }),
    t("提示词：{tokens}", { tokens: formatMetricValue(data.promptTokens) }),
    t("输出推算：{tokens}", { tokens: formatMetricValue(data.outputTokens) }),
    t("非缓存输入：{tokens}", { tokens: formatMetricValue(data.inputTokens) }),
    t("缓存读取：{tokens}", { tokens: formatMetricValue(data.cacheReadTokens) }),
    t("缓存写入：{tokens}", { tokens: formatMetricValue(data.cacheWriteTokens) }),
    "",
    t("缓存读写已计入提示词侧统计。"),
  ].join("\n");

  const costTooltipLines = [
    t("基于每条调用冻结的价格快照累计；未定价或用量不完整的调用不计入总金额。"),
    "",
    t("普通输入：{cost}", { cost: formatDisplayCostExact(data.inputCost, currency, cnyRate) }),
    t("模型输出：{cost}", { cost: formatDisplayCostExact(data.outputCost, currency, cnyRate) }),
    t("缓存读取：{cost}", { cost: formatDisplayCostExact(data.cacheReadCost, currency, cnyRate) }),
    t("缓存写入：{cost}", { cost: formatDisplayCostExact(data.cacheWriteCost, currency, cnyRate) }),
    "",
    t("已计费调用：{count}", { count: formatMetricValue(data.pricedCalls) }),
  ];
  if (data.averagePricedCost) {
    costTooltipLines.push(t("单次平均费用：{cost}", { cost: formatDisplayCostExact(data.averagePricedCost, currency, cnyRate) }));
  }
  if (data.unpricedCalls > 0) {
    costTooltipLines.push(t("未定价调用：{count}（请前往 设置 -> 模型定价 配置单价）", { count: formatMetricValue(data.unpricedCalls) }));
  }
  if (data.incompleteUsageCalls > 0) {
    costTooltipLines.push(t("用量不完整调用：{count}", { count: formatMetricValue(data.incompleteUsageCalls) }));
  }
  costTooltipLines.push("", t("合计：{cost}", { cost: formatDisplayCostExact(data.totalCost, currency, cnyRate) }));
  if (conversionNote) {
    costTooltipLines.push(
      t("原美元金额：{cost}", { cost: formatUsdExact(data.totalCost) }),
      conversionNote,
    );
  }

  const costSecondary = data.unpricedCalls > 0
    ? t("含 {count} 次未定价调用", { count: formatCompactInteger(data.unpricedCalls) })
    : data.incompleteUsageCalls > 0 && data.pricedCalls === 0
      ? t("含 {count} 次用量不完整", { count: formatCompactInteger(data.incompleteUsageCalls) })
      : t("缓存读写 {cost}", { cost: formatDisplayCost(cacheCost, currency, cnyRate) });

  const costValueTitle = conversionNote
    ? `${formatDisplayCostExact(data.totalCost, currency, cnyRate)}\n${t("原美元金额：{cost}", { cost: formatUsdExact(data.totalCost) })}\n${conversionNote}`
    : formatUsdExact(data.totalCost);

  return <section className={styles.root} aria-label={t("调用统计")}>
    <article className={styles.metric}>
      <div className={styles.label}>{t("缓存命中率")}<InfoTooltip content={cacheTooltip} /></div>
      <div className={styles.body}>
        <div className={styles.value}>{cacheHitPrimary}</div>
        <div className={styles.secondary} title={cacheHitSecondary}>{cacheHitSecondary}</div>
      </div>
    </article>
    <article className={styles.metric}>
      <div className={styles.label}>{t("LLM 调用")}<InfoTooltip content={callsTooltip} /></div>
      <div className={styles.body}>
        <div className={styles.value} title={formatInteger(data.llmCalls)}>{formatCompactInteger(data.llmCalls)}</div>
        <div className={styles.secondary}>{t("成功 {successful} / 异常 {failed}", {
          successful: formatCompactInteger(data.successfulCalls),
          failed: formatCompactInteger(data.failedCalls),
        })}</div>
      </div>
    </article>
    <article className={styles.metric}>
      <div className={styles.label}>{t("平均速度（tok/s）")}<InfoTooltip content={speedTooltip} /></div>
      <div className={styles.body}>
        <div className={styles.value} title={speedDisplay}>{speedDisplay}</div>
        <div className={styles.secondary} title={speedSecondary}>{speedSecondary}</div>
      </div>
    </article>
    <article className={styles.metric}>
      <div className={styles.label}>{t("首 Token（s）")}<InfoTooltip content={firstOutputTooltip} /></div>
      <div className={styles.body}>
        <div className={styles.value} title={firstOutputDisplay}>{firstOutputDisplay}</div>
        <div className={styles.secondary} title={firstOutputSecondary}>{firstOutputSecondary}</div>
      </div>
    </article>
    <article className={styles.metric}>
      <div className={styles.label}>{t("Token 消耗")}<InfoTooltip content={tokensTooltip} /></div>
      <div className={styles.body}>
        <div className={styles.value} title={formatInteger(data.tokenUsage)}>{formatCompactInteger(data.tokenUsage)}</div>
        <div className={styles.secondary}>{t("提示词 {tokens}", { tokens: formatCompactInteger(data.promptTokens) })}</div>
      </div>
    </article>
    <article className={styles.metric}>
      <div className={styles.label}>{t("估算费用")}<InfoTooltip content={costTooltipLines.join("\n")} /></div>
      <div className={styles.body}>
        <div className={styles.value} title={costValueTitle}>{formatDisplayCost(data.totalCost, currency, cnyRate)}</div>
        <div className={styles.secondary} title={costSecondary}>{costSecondary}</div>
      </div>
    </article>
  </section>;
}
