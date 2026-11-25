import { useState } from "react";
import type { SpeedAggregate } from "../../../shared/api";
import {
  addUsdStrings,
  convertUsdToDisplayNumber,
  formatConversionNote,
  formatDisplayCost,
  formatDisplayCostExact,
  formatUsdExact,
  type DisplayCurrency,
  type DisplayExchangeRate,
} from "../../../shared/utils/costFormat";
import { formatCompactInteger, formatInteger } from "../../../shared/utils/numberFormat";
import { aggregateTooltip, formatFirstOutput, formatSpeed } from "../../../shared/utils/speedFormat";
import { Icon } from "../../../shared/ui/Icon";
import { useTooltip, type TooltipAnchor } from "../../../shared/ui/Tooltip";
import { informationOutlineIcon } from "../../../shared/ui/icons";
import { RollingNumber } from "../motion/RollingNumber";
import type { MotionTone } from "../motion/rollingDigits";
import type { MetricChanges } from "./useMetricChanges";
import styles from "./HomeMetrics.module.scss";

const PULSE_DURATION_MS = 1_200;

export type HomeMetricsData = {
  llmCalls: number;
  successfulCalls: number;
  failedCalls: number;
  tokenUsage: number;
  promptTokens: number;
  inputTokens: number;
  reportedCacheInputTokens: number;
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
  unreportedCacheCalls: number;
  assumedCacheCalls: number;
  assumedCacheCost: string;
  estimatedCacheReadTokens: number;
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
    onMouseLeave={() => hide()}
    onFocus={(event) => show(elementAnchor(event.currentTarget), undefined, <div className={styles.tooltipText}>{content}</div>)}
    onBlur={() => hide()}
  ><Icon icon={informationOutlineIcon} size="1.1em" /></button>;
}

function SignedChange({ value, timestamp, animate, tone }: { value: string; timestamp: number; animate: boolean; tone?: MotionTone })
{
  const [elapsed] = useState(() => Date.now() - timestamp);
  return <span className={styles.change} data-animate={animate} data-tone={tone !== "none" ? tone : undefined} style={{ animationDelay: `-${Math.max(0, elapsed)}ms` }} title={t("较上次刷新")}>{value}</span>;
}

function CardPulse({ timestamp, animate, tone }: { timestamp: number; animate: boolean; tone?: MotionTone })
{
  const [elapsed] = useState(() => Date.now() - timestamp);
  if (!animate || !tone || tone === "none" || elapsed >= PULSE_DURATION_MS) return null;
  return <span className={styles.cardPulse} data-tone={tone} style={{ animationDelay: `-${Math.max(0, elapsed)}ms` }} aria-hidden="true" />;
}

export function HomeMetrics({
  data,
  changes,
  animate,
  resetKey = "",
  suppressFlash = false,
  currency,
  exchangeRate,
  loading = false,
  error = null,
}: {
  data: HomeMetricsData | null;
  changes: MetricChanges | null;
  animate: boolean;
  resetKey?: string;
  suppressFlash?: boolean;
  currency: DisplayCurrency;
  exchangeRate: DisplayExchangeRate | null;
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
      t("生成速度（tok/s）"),
      t("首次输出（s）"),
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

  const defaultCacheHitRate = calculateRate(data.cacheReadTokens, data.cacheReadTokens + data.reportedCacheInputTokens);
  const cacheReuseRate = calculateRate(
    data.cacheReadTokens,
    data.cacheReadTokens + data.cacheWriteTokens + data.reportedCacheInputTokens,
  );
  const allUsageUnreported = data.unreportedCacheCalls > 0
    && data.reportedCacheInputTokens === 0
    && data.cacheReadTokens === 0
    && data.cacheWriteTokens === 0;
  const successfulCallRate = calculateRate(data.successfulCalls, data.llmCalls);
  const cacheCost = addUsdStrings(data.cacheReadCost, data.cacheWriteCost);
  const conversionNote = formatConversionNote(currency, exchangeRate);

  const cacheHitPrimary = allUsageUnreported ? t("未上报") : formatRate(defaultCacheHitRate);
  const cacheHitSecondary = allUsageUnreported
    ? t("{count} 次调用未上报缓存明细", { count: formatCompactInteger(data.unreportedCacheCalls) })
    : defaultCacheHitRate === null
      ? t("计入缓存创建 暂无数据")
      : data.unreportedCacheCalls > 0
        ? t("另有 {count} 次未上报缓存", { count: formatCompactInteger(data.unreportedCacheCalls) })
        : t("计入缓存创建 {rate}", { rate: formatRate(cacheReuseRate) });

  const cacheTooltipLines = [
    t("当前：{rate}", { rate: cacheHitPrimary }),
    t("公式：缓存读取 /（缓存读取 + 已上报缓存调用的非缓存输入）；仅统计明确上报缓存字段的调用。"),
    t("默认 {defaultRate} / 计入创建 {reuseRate}", {
      defaultRate: formatRate(defaultCacheHitRate),
      reuseRate: formatRate(cacheReuseRate),
    }),
  ];
  if (data.unreportedCacheCalls > 0) {
    cacheTooltipLines.push(t("未上报缓存调用：{count} 次（不计入真实命中率分母）", {
      count: formatMetricValue(data.unreportedCacheCalls),
    }));
  }
  if (data.assumedCacheCalls > 0) {
    cacheTooltipLines.push(t("其中 {count} 次计费按默认缓存命中率估算（估算缓存读取约 {tokens}）", {
      count: formatMetricValue(data.assumedCacheCalls),
      tokens: formatMetricValue(data.estimatedCacheReadTokens),
    }));
  }
  const cacheTooltip = cacheTooltipLines.join("\n");

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
    : `${formatSpeed(data.speed.average_tokens_per_second, "estimated")} tok/s`;
  const speedSecondary = data.speed.average_tokens_per_second == null
    ? t("无有效速度样本")
    : t("样本 {count} 条", { count: formatCompactInteger(data.speed.samples) });
  const speedTooltip = [
    aggregateTooltip(data.speed),
    t("仅统计成功、流式、有可见输出且生成时间不少于 200ms 的业务调用；模型测试不计入。"),
  ].join("\n");

  const firstOutputDisplay = formatFirstOutput(data.speed.first_output_median_ms);
  const firstOutputSecondary = data.speed.first_output_median_ms != null
    ? t("成功流式调用中位数")
    : t("无可用首次输出样本");
  const firstOutputTooltip = [
    t("首次输出（中位数）：{value}", { value: firstOutputDisplay }),
    t("统计成功流式调用首次实际输出等待时间的中位数，不二次平均各行中位数。"),
    t("首次实际输出包含非空正文、思考与工具输出，排除响应头、心跳与空事件。"),
    t("首次输出不受生成时间 200ms 门槛限制；模型测试不计入。"),
  ].join("\n");

  const tokensTooltipLines = [
    t("总请求 Token 包含提示词和模型输出。"),
    "",
    t("总请求：{tokens}", { tokens: formatMetricValue(data.tokenUsage) }),
    t("提示词：{tokens}", { tokens: formatMetricValue(data.promptTokens) }),
    t("输出推算：{tokens}", { tokens: formatMetricValue(data.outputTokens) }),
    t("非缓存输入：{tokens}", { tokens: formatMetricValue(data.inputTokens) }),
    t("缓存读取（已上报）：{tokens}", { tokens: formatMetricValue(data.cacheReadTokens) }),
    t("缓存写入（已上报）：{tokens}", { tokens: formatMetricValue(data.cacheWriteTokens) }),
    "",
    t("缓存读写已计入提示词侧统计。"),
  ];
  if (data.unreportedCacheCalls > 0) {
    tokensTooltipLines.push(t("未上报缓存明细：{count} 次调用", { count: formatMetricValue(data.unreportedCacheCalls) }));
  }
  if (data.estimatedCacheReadTokens > 0) {
    tokensTooltipLines.push(t("按估算计费拆分缓存读取：约 {tokens} Token", {
      tokens: formatMetricValue(data.estimatedCacheReadTokens),
    }));
  }
  const tokensTooltip = tokensTooltipLines.join("\n");

  const costTooltipLines = [
    t("基于每条调用冻结的价格快照累计；未定价或用量不完整的调用不计入总金额。"),
    "",
    t("普通输入：{cost}", { cost: formatDisplayCostExact(data.inputCost, currency, exchangeRate) }),
    t("模型输出：{cost}", { cost: formatDisplayCostExact(data.outputCost, currency, exchangeRate) }),
    t("缓存读取：{cost}", { cost: formatDisplayCostExact(data.cacheReadCost, currency, exchangeRate) }),
    t("缓存写入：{cost}", { cost: formatDisplayCostExact(data.cacheWriteCost, currency, exchangeRate) }),
    "",
    t("已计费调用：{count}", { count: formatMetricValue(data.pricedCalls) }),
  ];
  if (data.assumedCacheCalls > 0) {
    costTooltipLines.push(t("其中 {count} 次未上报缓存明细，按默认缓存命中率估算费用 {cost}（估算缓存读取约 {tokens} Token）", {
      count: formatMetricValue(data.assumedCacheCalls),
      cost: formatDisplayCostExact(data.assumedCacheCost, currency, exchangeRate),
      tokens: formatMetricValue(data.estimatedCacheReadTokens),
    }));
  }
  if (data.averagePricedCost) {
    costTooltipLines.push(t("单次平均费用：{cost}", { cost: formatDisplayCostExact(data.averagePricedCost, currency, exchangeRate) }));
  }
  if (data.unpricedCalls > 0) {
    costTooltipLines.push(t("未定价调用：{count}（请前往 设置 -> 模型定价 配置单价）", { count: formatMetricValue(data.unpricedCalls) }));
  }
  if (data.incompleteUsageCalls > 0) {
    costTooltipLines.push(t("用量不完整调用：{count}", { count: formatMetricValue(data.incompleteUsageCalls) }));
  }
  costTooltipLines.push("", t("合计：{cost}", { cost: formatDisplayCostExact(data.totalCost, currency, exchangeRate) }));
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
      : data.assumedCacheCalls > 0
        ? t("含 {count} 次按缓存估算（{cost}）", {
            count: formatCompactInteger(data.assumedCacheCalls),
            cost: formatDisplayCost(data.assumedCacheCost, currency, exchangeRate),
          })
        : t("缓存读写 {cost}", { cost: formatDisplayCost(cacheCost, currency, exchangeRate) });

  const cacheHitChange = changes?.cacheHitRate != null
    ? `${changes.cacheHitRate > 0 ? "+" : "−"}${Math.abs(changes.cacheHitRate).toFixed(2)}%`
    : null;
  const cacheHitTone: MotionTone | undefined = changes?.cacheHitRate != null
    ? (changes.cacheHitRate > 0 ? "positive" : "attention")
    : undefined;

  const callsChange = changes?.calls ? `${changes.calls > 0 ? "+" : "−"}${formatCompactInteger(Math.abs(changes.calls))}` : null;
  const callsTone: MotionTone | undefined = changes && (changes.calls !== 0 || changes.failedCalls > 0)
    ? (changes.failedCalls > 0 && changes.failedCalls === changes.calls
        ? "negative"
        : changes.calls > 0
          ? "active"
          : "attention")
    : undefined;

  const speedChange = changes?.speed != null
    ? `${changes.speed > 0 ? "+" : "−"}${Math.abs(changes.speed) >= 1 ? Math.round(Math.abs(changes.speed)) : Math.abs(changes.speed).toFixed(1)}`
    : null;
  const speedTone: MotionTone | undefined = changes?.speed != null
    ? (changes.speed > 0 ? "positive" : "attention")
    : undefined;

  const firstOutputChange = changes?.firstOutputMs != null
    ? `${changes.firstOutputMs > 0 ? "+" : "−"}${(Math.abs(changes.firstOutputMs) / 1000).toFixed(1)}s`
    : null;
  const firstOutputTone: MotionTone | undefined = changes?.firstOutputMs != null
    ? (changes.firstOutputMs < 0 ? "positive" : "attention")
    : undefined;

  const tokensChange = changes?.tokens ? `${changes.tokens > 0 ? "+" : "−"}${formatCompactInteger(Math.abs(changes.tokens))}` : null;
  const tokensTone: MotionTone | undefined = changes?.tokens
    ? (changes.tokens > 0 ? "active" : "attention")
    : undefined;

  const costChange = changes && changes.cost !== "0"
    ? `${changes.cost.startsWith("-") ? "−" : "+"}${formatDisplayCost(changes.cost.replace(/^-/, ""), currency, exchangeRate)}`
    : null;
  const costTone: MotionTone | undefined = changes && changes.cost !== "0"
    ? (changes.cost.startsWith("-") ? "positive" : "attention")
    : undefined;

  const costDisplay = formatDisplayCost(data.totalCost, currency, exchangeRate);
  const costNumeric = convertUsdToDisplayNumber(data.totalCost, currency, exchangeRate);
  const costValueTitle = conversionNote
    ? `${formatDisplayCostExact(data.totalCost, currency, exchangeRate)}\n${t("原美元金额：{cost}", { cost: formatUsdExact(data.totalCost) })}\n${conversionNote}`
    : formatUsdExact(data.totalCost);

  return <section className={styles.root} aria-label={t("调用统计")}>
    <article className={styles.metric}>
      {changes && cacheHitChange && <CardPulse key={`pulse-${changes.timestamp}-${animate}`} timestamp={changes.timestamp} animate={animate && !suppressFlash} tone={cacheHitTone} />}
      <div className={styles.label}>{t("缓存命中率")}<InfoTooltip content={cacheTooltip} />{changes && cacheHitChange && <SignedChange key={`${changes.timestamp}:${animate}`} value={cacheHitChange} timestamp={changes.timestamp} animate={animate} tone={cacheHitTone} />}</div>
      <div className={styles.body}>
        <div className={styles.value}>
          <RollingNumber
            value={cacheHitPrimary}
            numericValue={allUsageUnreported ? null : defaultCacheHitRate}
            animate={animate}
            resetKey={resetKey}
            polarity="higher-better"
            suppressFlash={suppressFlash}
            rollOnMount
            mountDelayMs={0}
          />
        </div>
        <div className={styles.secondary} title={cacheHitSecondary}>{cacheHitSecondary}</div>
      </div>
    </article>
    <article className={styles.metric}>
      {changes && (callsChange || changes.failedCalls > 0) && <CardPulse key={`pulse-${changes.timestamp}-${animate}`} timestamp={changes.timestamp} animate={animate && !suppressFlash} tone={callsTone} />}
      <div className={styles.label}>{t("LLM 调用")}<InfoTooltip content={callsTooltip} />{changes && callsChange && <SignedChange key={`${changes.timestamp}:${animate}`} value={callsChange} timestamp={changes.timestamp} animate={animate} tone={callsTone} />}</div>
      <div className={styles.body}>
        <div className={styles.value} title={formatInteger(data.llmCalls)}>
          <RollingNumber
            value={formatCompactInteger(data.llmCalls)}
            numericValue={data.llmCalls}
            animate={animate}
            resetKey={resetKey}
            polarity="activity"
            flashTone={callsTone}
            suppressFlash={suppressFlash}
            rollOnMount
            mountDelayMs={28}
          />
        </div>
        <div className={styles.secondary}>{t("成功 {successful} / 异常 {failed}", {
          successful: formatCompactInteger(data.successfulCalls),
          failed: formatCompactInteger(data.failedCalls),
        })}</div>
      </div>
    </article>
    <article className={styles.metric}>
      {changes && speedChange && <CardPulse key={`pulse-${changes.timestamp}-${animate}`} timestamp={changes.timestamp} animate={animate && !suppressFlash} tone={speedTone} />}
      <div className={styles.label}>{t("生成速度（tok/s）")}<InfoTooltip content={speedTooltip} />{changes && speedChange && <SignedChange key={`${changes.timestamp}:${animate}`} value={speedChange} timestamp={changes.timestamp} animate={animate} tone={speedTone} />}</div>
      <div className={styles.body}>
        <div className={styles.value} title={speedDisplay}>
          <RollingNumber
            value={speedDisplay}
            numericValue={data.speed.average_tokens_per_second}
            animate={animate}
            resetKey={resetKey}
            polarity="higher-better"
            suppressFlash={suppressFlash}
            rollOnMount
            mountDelayMs={56}
          />
        </div>
        <div className={styles.secondary} title={speedSecondary}>{speedSecondary}</div>
      </div>
    </article>
    <article className={styles.metric}>
      {changes && firstOutputChange && <CardPulse key={`pulse-${changes.timestamp}-${animate}`} timestamp={changes.timestamp} animate={animate && !suppressFlash} tone={firstOutputTone} />}
      <div className={styles.label}>{t("首次输出（s）")}<InfoTooltip content={firstOutputTooltip} />{changes && firstOutputChange && <SignedChange key={`${changes.timestamp}:${animate}`} value={firstOutputChange} timestamp={changes.timestamp} animate={animate} tone={firstOutputTone} />}</div>
      <div className={styles.body}>
        <div className={styles.value} title={firstOutputDisplay}>
          <RollingNumber
            value={firstOutputDisplay}
            numericValue={data.speed.first_output_median_ms}
            animate={animate}
            resetKey={resetKey}
            polarity="lower-better"
            suppressFlash={suppressFlash}
            rollOnMount
            mountDelayMs={84}
          />
        </div>
        <div className={styles.secondary} title={firstOutputSecondary}>{firstOutputSecondary}</div>
      </div>
    </article>
    <article className={styles.metric}>
      {changes && tokensChange && <CardPulse key={`pulse-${changes.timestamp}-${animate}`} timestamp={changes.timestamp} animate={animate && !suppressFlash} tone={tokensTone} />}
      <div className={styles.label}>{t("Token 消耗")}<InfoTooltip content={tokensTooltip} />{changes && tokensChange && <SignedChange key={`${changes.timestamp}:${animate}`} value={tokensChange} timestamp={changes.timestamp} animate={animate} tone={tokensTone} />}</div>
      <div className={styles.body}>
        <div className={styles.value} title={formatInteger(data.tokenUsage)}>
          <RollingNumber
            value={formatCompactInteger(data.tokenUsage)}
            numericValue={data.tokenUsage}
            animate={animate}
            resetKey={resetKey}
            polarity="activity"
            suppressFlash={suppressFlash}
            rollOnMount
            mountDelayMs={112}
          />
        </div>
        <div className={styles.secondary}>{t("提示词 {tokens}", { tokens: formatCompactInteger(data.promptTokens) })}</div>
      </div>
    </article>
    <article className={styles.metric}>
      {changes && costChange && <CardPulse key={`pulse-${changes.timestamp}-${animate}`} timestamp={changes.timestamp} animate={animate && !suppressFlash} tone={costTone} />}
      <div className={styles.label}>{t("估算费用")}<InfoTooltip content={costTooltipLines.join("\n")} />{changes && costChange && <SignedChange key={`${changes.timestamp}:${animate}`} value={costChange} timestamp={changes.timestamp} animate={animate} tone={costTone} />}</div>
      <div className={styles.body}>
        <div className={styles.value} title={costValueTitle}>
          <RollingNumber
            value={costDisplay}
            numericValue={costNumeric}
            animate={animate}
            resetKey={`${resetKey}|${currency}|${exchangeRate?.rate ?? ""}`}
            polarity="cost"
            suppressFlash={suppressFlash}
            rollOnMount
            mountDelayMs={140}
          />
        </div>
        <div className={styles.secondary} title={costSecondary}>{costSecondary}</div>
      </div>
    </article>
  </section>;
}
