import type { CallDetail, CallPerformance, LlmCall } from "../../shared/api";
import { useAppStore } from "../../shared/store/appStore";
import { JsonEditor } from "../../shared/ui/JsonEditor";
import { Tabs, type TabItem } from "../../shared/ui/Tabs";
import {
  formatConversionNote,
  formatDisplayCostExact,
  formatHitRatePercent,
  formatRatePerMillion,
  formatUsdExact,
} from "../../shared/utils/costFormat";
import { formatInteger } from "../../shared/utils/numberFormat";
import {
  formatFirstOutput,
  formatGeneration,
  formatSpeed,
  speedUnavailableText,
} from "../../shared/utils/speedFormat";
import styles from "./CallDetails.module.scss";

const show = (value: string | number | null) => value ?? "-";
const timing = (value: number | null) => value == null ? "-" : `${value} ms`;

function pricingSourceLabel(call: LlmCall) {
  if (call.pricing_source === "custom") return t("自定义单价");
  if (call.pricing_source === "catalog") return t("公开目录");
  return t("未定价");
}

function costStatusBadge(call: LlmCall) {
  if (call.call_kind === "cursor_official") {
    return { label: t("未知"), warn: false };
  }
  if (call.cost_status === "incomplete_usage") {
    return { label: t("用量不完整"), warn: true };
  }
  if (call.cost_status !== "priced") {
    return { label: t("未定价"), warn: true };
  }
  return { label: t("已定价"), warn: false };
}

function PerformanceSection({ call }: { call: LlmCall }) {
  const performance = call.performance;
  const overall = performance.overall_tokens_per_second;
  const generation = performance.tokens_per_second;
  const generationEstimated = performance.speed_status === "estimated";
  const badge = generation == null
    ? { label: t("不可用"), warn: true }
    : generationEstimated
      ? { label: t("估算"), warn: false }
      : { label: t("实测"), warn: false };
  return <section aria-label={t("速度与首次输出")}>
    <h4>{t("速度与首次输出")}</h4>
    <div className={styles.costCard}>
      <div className={styles.costHeader}>
        <div className={styles.costTitle}>
          <span className={[styles.badge, badge.warn ? styles.badgeWarn : styles.badgePrimary].join(" ")}>
            {badge.label}
          </span>
          <span>
            {generation != null ? `${formatSpeed(generation, performance.speed_status)} tok/s` : "—"}
          </span>
          <span className={styles.costTag}>{t("首次输出：{value}", { value: formatFirstOutput(performance.first_output_ms) })}</span>
        </div>
      </div>
      <div className={styles.meta}>
        {generationFormula(performance, call)}
      </div>
      {generation == null && <div className={styles.empty}>{speedUnavailableText(performance.reason)}</div>}
      <div className={styles.meta}>
        {overallFormula(performance, call.output_tokens, call.duration_ms)}
      </div>
      {overall == null && <div className={styles.empty}>{speedUnavailableText(performance.overall_reason)}</div>}
      {generationEstimated && <div className={styles.meta}>{t("按可见输出 Token 与客户端接收时间估算")}</div>}
    </div>
  </section>;
}

/** States the end-to-end rate as a division using the backend's decision. */
function overallFormula(
  performance: CallPerformance,
  outputTokens: number | null,
  durationMs: number | null,
) {
  const rate = performance.overall_tokens_per_second;
  if (rate == null || durationMs == null || outputTokens == null) {
    return t("整体端到端速度：输出 Token ÷ 总耗时（含首次输出等待）。");
  }
  return t("整体端到端速度：{tokens} Token ÷ {seconds}s = {speed} tok/s（含首次输出等待）。", {
    tokens: formatInteger(outputTokens),
    seconds: (durationMs / 1000).toFixed(durationMs < 100 ? 3 : 1),
    speed: formatSpeed(rate),
  });
}

/** States the generation-only rate as a division, excluding the first-token wait. */
function generationFormula(performance: CallPerformance, call: LlmCall) {
  const rate = performance.tokens_per_second;
  const generationMs = performance.generation_ms;
  const effectiveTokens = call.output_tokens == null
    ? null
    : Math.max(0, call.output_tokens - Math.max(0, call.reasoning_tokens ?? 0) - 1);
  if (rate == null || generationMs == null || effectiveTokens == null) {
    return t("生成速度：（输出 Token − 思考 Token − 1）÷ 首末可见输出间隔。");
  }
  return t("生成速度：{tokens} Token ÷ {seconds}s = {speed} tok/s（首末可见输出之间）。", {
    tokens: formatInteger(effectiveTokens),
    seconds: (generationMs / 1000).toFixed(1),
    speed: formatSpeed(rate, performance.speed_status),
  });
}

function hasReportedUsage(call: LlmCall) {
  return call.call_kind !== "cursor_official" && call.input_tokens != null;
}

function formatCacheDetailField(tokens: number | null, call: LlmCall): string | number {
  if (!hasReportedUsage(call)) return "-";
  if (tokens == null) return t("未上报");
  if (tokens === 0) return t("0（明确为零）");
  return tokens;
}

function CostBreakdownSection({ call }: { call: LlmCall }) {
  const { currency, cnyRate } = useAppStore();
  const conversionNote = formatConversionNote(currency, cnyRate);
  const status = costStatusBadge(call);
  const reportedUsage = hasReportedUsage(call);
  const priced = call.call_kind !== "cursor_official" && call.cost_status === "priced";
  const assumedCache = priced && call.cost_basis === "assumed_cache";
  const hitRateText = formatHitRatePercent(call.assumed_cache_hit_rate_bps);
  const catalogRef = call.pricing_provider_id && call.pricing_model_id
    ? `${call.pricing_provider_id} / ${call.pricing_model_id}`
    : null;
  const rows = [
    {
      key: "input",
      label: t("非缓存输入"),
      tokenText: call.billed_input_tokens != null
        ? assumedCache
          ? `${formatInteger(call.billed_input_tokens)} (${t("估算")})`
          : formatInteger(call.billed_input_tokens)
        : "-",
      tokenTitle: assumedCache && call.input_tokens != null && call.estimated_cache_read_tokens != null
        ? t("原始总输入 {total}，按 {rate}% 命中率扣除估算缓存读取 {cached}", {
            total: formatInteger(call.input_tokens),
            rate: hitRateText,
            cached: formatInteger(call.estimated_cache_read_tokens),
          })
        : undefined,
      rate: call.unit_input_per_million,
      cost: call.input_cost,
    },
    {
      key: "output",
      label: t("模型输出"),
      tokenText: call.output_tokens != null ? formatInteger(call.output_tokens) : "-",
      tokenTitle: undefined,
      rate: call.unit_output_per_million,
      cost: call.output_cost,
    },
    {
      key: "cache_read",
      label: t("缓存读取"),
      tokenText: assumedCache && call.estimated_cache_read_tokens != null
        ? `~${formatInteger(call.estimated_cache_read_tokens)} (${t("估算")})`
        : reportedUsage && call.cache_read_tokens == null
          ? t("未上报")
          : call.cache_read_tokens != null
            ? formatInteger(call.cache_read_tokens)
            : "-",
      tokenTitle: assumedCache && call.estimated_cache_read_tokens != null
        ? t("上游未上报缓存读取；计费按 {rate}% 缓存命中率估算", { rate: hitRateText })
        : reportedUsage && call.cache_read_tokens == null
          ? t("上游未上报缓存读取字段")
          : reportedUsage && call.cache_read_tokens === 0
            ? t("上游明确上报为 0")
            : undefined,
      rate: call.unit_cache_read_per_million,
      cost: call.cache_read_cost,
    },
    {
      key: "cache_write",
      label: t("缓存写入"),
      tokenText: reportedUsage && call.cache_write_tokens == null
        ? t("未上报")
        : call.cache_write_tokens != null
          ? formatInteger(call.cache_write_tokens)
          : "-",
      tokenTitle: reportedUsage && call.cache_write_tokens == null
        ? t("上游未上报缓存写入字段")
        : reportedUsage && call.cache_write_tokens === 0
          ? t("上游明确上报为 0")
          : undefined,
      rate: call.unit_cache_write_per_million,
      cost: call.cache_write_cost,
    },
  ];

  const basisNote = assumedCache
    ? t("估算说明：上游未上报缓存明细，已按默认 {rate}% 缓存命中率拆分为非缓存输入 {uncached} Token 与缓存读取约 {cached} Token。", {
        rate: hitRateText,
        uncached: formatInteger(call.billed_input_tokens ?? 0),
        cached: formatInteger(call.estimated_cache_read_tokens ?? 0),
      })
    : priced && reportedUsage && call.cache_read_tokens == null && call.cache_write_tokens == null
      ? t("估算说明：上游未上报缓存明细，本次未应用默认缓存命中率估算，仅按已上报字段计费。")
      : null;

  const note = call.call_kind === "cursor_official"
    ? t("Cursor 官方通道不计入本地 BYOK 定价估算。")
    : call.cost_status === "incomplete_usage"
      ? t("此次调用未收到完整用量字段，未生成费用金额。")
      : call.cost_status !== "priced"
        ? t("该供应商模型暂无定价快照；可在 设置 -> 模型定价 中配置单价或绑定公开目录。")
        : null;

  return <section aria-label={t("费用明细")}>
    <h4>{t("定价与费用明细")}</h4>
    <div className={styles.costCard}>
      <div className={styles.costHeader}>
        <div className={styles.costTitle}>
          <span className={[styles.badge, status.warn ? styles.badgeWarn : styles.badgePrimary].join(" ")}>
            {status.label}
          </span>
          {call.call_kind !== "cursor_official" && <span className={styles.badge}>
            {pricingSourceLabel(call)}
          </span>}
          {catalogRef && <span className={styles.badge}>{catalogRef}</span>}
          {priced && call.cost_basis === "assumed_cache" && (
            <span className={styles.badge}>{t("按 {rate}% 缓存估算", { rate: hitRateText })}</span>
          )}
          {priced && call.cost_basis === "reported" && (
            <span className={styles.badge}>{t("按实报用量")}</span>
          )}
          {priced && call.status === "running" && <span className={styles.badge}>{t("暂计费用")}</span>}
          {priced && call.cost_backfilled && <span className={styles.badge}>{t("历史估算")}</span>}
        </div>
        <span
          className={styles.costTotal}
          title={priced && call.total_cost != null && conversionNote
            ? `${t("原美元金额：{cost}", { cost: formatUsdExact(call.total_cost) })}\n${conversionNote}`
            : undefined}
        >
          {priced && call.total_cost != null ? formatDisplayCostExact(call.total_cost, currency, cnyRate) : status.label}
        </span>
      </div>
      <div className={styles.costGrid}>
        {rows.map((item) => <div key={item.key}>
          <span>{item.label}</span>
          <strong
            title={priced && item.cost != null && conversionNote
              ? `${t("原美元金额：{cost}", { cost: formatUsdExact(item.cost) })}\n${conversionNote}`
              : undefined}
          >
            {priced && item.cost != null ? formatDisplayCostExact(item.cost, currency, cnyRate) : "—"}
          </strong>
          <small title={item.tokenTitle}>
            {item.tokenText} × {formatRatePerMillion(item.rate)}
          </small>
        </div>)}
      </div>
      {priced && conversionNote && call.total_cost != null && (
        <div className={styles.costNote}>
          {t("原美元合计：{cost} · {note}（不影响历史冻结快照与美元单价）", {
            cost: formatUsdExact(call.total_cost),
            note: conversionNote,
          })}
        </div>
      )}
      {basisNote && <div className={styles.costNote}>{basisNote}</div>}
      {note && <div className={styles.costNote}>{note}</div>}
    </div>
  </section>;
}

export function CallDetails({ detail }: { detail: CallDetail }) {
  const { call, request, response_chunks: chunks, cursor_trace: cursorTrace } = detail;
  const responseBody = chunks.map((chunk) => chunk.data).join("");
  const responseBytes = chunks.reduce((total, chunk) => total + chunk.byte_count, 0);
  const fields: Array<[string, string | number]> = [
    ["Call ID", call.call_id],
    [t("调用类型"), call.call_kind === "cursor_official" ? t("Cursor 官方") : "LLM"],
    [t("路由"), call.route === "cursor_official" ? t("Cursor 官方") : call.route === "external_api" ? "External API" : "BYOK"],
    ["Run ID", call.run_id],
    ["Conversation ID", call.conversation_id],
    [t("上游调用序号"), call.provider_call_index],
    ["Model Hash", show(call.model_hash)],
    ["Supplier Key", show(call.supplier_key)],
    ["Endpoint Key", show(call.endpoint_key)],
    [t("上游类型"), call.provider_type],
    [t("上游地址"), call.provider_url],
    [t("最终请求类型"), call.request_type],
    [t("最终请求地址"), call.request_url],
    ["Model ID", call.model_id],
    [t("显示名称"), call.display_name],
    [t("思考强度"), show(call.reasoning_effort)],
    ["Fast", call.fast == null ? "-" : call.fast ? t("是") : t("否")],
    [t("状态"), call.status],
    ["Finish Reason", show(call.finish_reason)],
    ["HTTP Status", show(call.http_status)],
    ["Created At", `${call.created_at_ms} · ${new Date(call.created_at_ms).toLocaleString()}`],
    [t("耗时"), timing(call.duration_ms)],
    [t("生成速度（tok/s）"), formatSpeed(call.performance.tokens_per_second, call.performance.speed_status)],
    [t("整体端到端速度（tok/s）"), formatSpeed(call.performance.overall_tokens_per_second)],
    [t("生成时间"), formatGeneration(call.performance.generation_ms)],
    [t("首次输出"), formatFirstOutput(call.performance.first_output_ms)],
    ["TTFB", timing(call.ttfb_ms)],
    ["TTFR", timing(call.ttfr_ms)],
    ["TTFT", timing(call.ttft_ms)],
    ["Input Token", show(call.input_tokens)],
    [t("计费输入 Token"), show(call.billed_input_tokens)],
    ["Output Token", show(call.output_tokens)],
    ["Total Token", show(call.total_tokens)],
    ["Cache Read Token", formatCacheDetailField(call.cache_read_tokens, call)],
    ["Cache Write Token", formatCacheDetailField(call.cache_write_tokens, call)],
    ["Reasoning Token", show(call.reasoning_tokens)],
    [
      t("计费口径"),
      call.cost_basis === "assumed_cache"
        ? t("按 {rate}% 缓存命中率估算（约 {tokens} Token）", {
            rate: formatHitRatePercent(call.assumed_cache_hit_rate_bps),
            tokens: formatInteger(call.estimated_cache_read_tokens ?? 0),
          })
        : call.cost_basis === "reported"
          ? t("按实报用量")
          : "-",
    ],
    [t("价格快照时间"), call.pricing_snapshot_at_ms ? new Date(call.pricing_snapshot_at_ms).toLocaleString() : "-"],
    [t("计费时间"), call.cost_calculated_at_ms ? new Date(call.cost_calculated_at_ms).toLocaleString() : "-"],
    [t("消息数"), call.message_count],
    [t("工具数"), call.tool_count],
    [t("详细记录"), call.detailed ? t("是") : t("否")],
    ["Error Kind", show(call.error_kind)],
    ["Error Message", show(call.error_message)],
  ];

  const tabs: TabItem[] = [
    { value: "call", label: t("调用信息"), content: <section>
      <dl className={styles.details}>{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd><code>{value}</code></dd></div>)}</dl>
      <PerformanceSection call={call} />
      <CostBreakdownSection call={call} />
    </section> },
    { value: "request", label: t("请求"), content: <section>
      {request ? <>
        <div className={styles.meta}>{t("字节数")}：{request.byte_count}</div>
        <h4>{t("请求头")}</h4><JsonEditor ariaLabel={t("请求头")} value={JSON.stringify(request.headers)} readOnly />
        <h4>{t("请求体")}</h4><JsonEditor ariaLabel={t("请求体")} value={JSON.stringify(request.body)} readOnly detail />
      </> : <div className={styles.empty}>{t("未记录请求内容，请开启详细记录后重试。")}</div>}
    </section> },
    { value: "response", label: t("响应流"), content: <section>
      {chunks.length > 0 ? <>
        <div className={styles.meta}>{t("分块数")}：{chunks.length} · {t("字节数")}：{responseBytes}</div>
        <JsonEditor ariaLabel={t("响应流")} value={responseBody} readOnly detail />
      </> : <div className={styles.empty}>{t("未记录响应内容，请开启详细记录后重试。")}</div>}
    </section> },
  ];

  if (cursorTrace) tabs.push({ value: "cursor-trace", label: t("Cursor 追踪"), content: <section>
      <div className={styles.meta}>
        Request ID：{cursorTrace.trace.request_id} · {t("工件数")}：{cursorTrace.artifacts.length}
      </div>
      <JsonEditor
        ariaLabel={t("Cursor 追踪")}
        value={JSON.stringify({ trace: cursorTrace.trace, artifacts: cursorTrace.artifacts })}
        readOnly
        detail
      />
    </section> });

  return <div className={styles.root}><Tabs items={tabs} /></div>;
}
