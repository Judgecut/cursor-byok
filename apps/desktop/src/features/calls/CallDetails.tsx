import type { CallDetail, CallPerformance, LlmCall } from "../../shared/api";
import { useAppStore } from "../../shared/store/appStore";
import { JsonEditor } from "../../shared/ui/JsonEditor";
import { Tabs, type TabItem } from "../../shared/ui/Tabs";
import {
  formatConversionNote,
  formatDisplayCostExact,
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
  const badge = overall == null
    ? { label: t("不可用"), warn: true }
    : { label: t("实测"), warn: false };
  return <section aria-label={t("速度与首 Token")}>
    <h4>{t("速度与首 Token")}</h4>
    <div className={styles.costCard}>
      <div className={styles.costHeader}>
        <div className={styles.costTitle}>
          <span className={[styles.badge, badge.warn ? styles.badgeWarn : styles.badgePrimary].join(" ")}>
            {badge.label}
          </span>
          <span>
            {overall != null ? `${formatSpeed(overall)} tok/s` : "—"}
          </span>
          <span className={styles.costTag}>{t("首 Token {value}", { value: formatFirstOutput(performance.first_output_ms) })}</span>
        </div>
      </div>
      <div className={styles.meta}>
        {overallFormula(performance, call.output_tokens, call.duration_ms)}
      </div>
      {overall == null && <div className={styles.empty}>{speedUnavailableText(performance.overall_reason)}</div>}
      <div className={styles.meta}>
        {generationFormula(performance, call.output_tokens)}
      </div>
      {generation == null && <div className={styles.empty}>{speedUnavailableText(performance.reason)}</div>}
      {generationEstimated && <div className={styles.meta}>{t("生成速度的 Token 或计时口径为估算值，仅供参考。")}</div>}
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
    return t("计算方式：输出 Token ÷ 总耗时（含首 Token 等待）。");
  }
  return t("计算方式：{tokens} Token ÷ {seconds}s = {speed} tok/s（含首 Token 等待）。", {
    tokens: formatInteger(outputTokens),
    seconds: (durationMs / 1000).toFixed(durationMs < 100 ? 3 : 1),
    speed: formatSpeed(rate),
  });
}

/** States the generation-only rate as a division, excluding the first-token wait. */
function generationFormula(performance: CallPerformance, outputTokens: number | null) {
  const rate = performance.tokens_per_second;
  const generationMs = performance.generation_ms;
  if (rate == null || generationMs == null || outputTokens == null) {
    return t("生成速度：输出 Token ÷ 生成时间（首 Token 之后到调用结束）。");
  }
  return t("生成速度：{tokens} Token ÷ {seconds}s = {speed} tok/s（不含首 Token 等待）。", {
    tokens: formatInteger(outputTokens),
    seconds: (generationMs / 1000).toFixed(1),
    speed: formatSpeed(rate, performance.speed_status),
  });
}

function CostBreakdownSection({ call }: { call: LlmCall }) {
  const { currency, cnyRate } = useAppStore();
  const conversionNote = formatConversionNote(currency, cnyRate);
  const status = costStatusBadge(call);
  const priced = call.call_kind !== "cursor_official" && call.cost_status === "priced";
  const catalogRef = call.pricing_provider_id && call.pricing_model_id
    ? `${call.pricing_provider_id} / ${call.pricing_model_id}`
    : null;
  const rows = [
    {
      key: "input",
      label: t("非缓存输入"),
      tokens: call.billed_input_tokens,
      rate: call.unit_input_per_million,
      cost: call.input_cost,
    },
    {
      key: "output",
      label: t("模型输出"),
      tokens: call.output_tokens,
      rate: call.unit_output_per_million,
      cost: call.output_cost,
    },
    {
      key: "cache_read",
      label: t("缓存读取"),
      tokens: call.cache_read_tokens,
      rate: call.unit_cache_read_per_million,
      cost: call.cache_read_cost,
    },
    {
      key: "cache_write",
      label: t("缓存写入"),
      tokens: call.cache_write_tokens,
      rate: call.unit_cache_write_per_million,
      cost: call.cache_write_cost,
    },
  ];

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
          <small>
            {item.tokens != null ? formatInteger(item.tokens) : "-"} × {formatRatePerMillion(item.rate)}
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
    [t("整体速度（tok/s）"), formatSpeed(call.performance.overall_tokens_per_second)],
    [t("生成速度（tok/s）"), formatSpeed(call.performance.tokens_per_second, call.performance.speed_status)],
    [t("生成时间"), formatGeneration(call.performance.generation_ms)],
    [t("首 Token（首个实际输出）"), formatFirstOutput(call.performance.first_output_ms)],
    ["TTFB", timing(call.ttfb_ms)],
    ["TTFR", timing(call.ttfr_ms)],
    ["TTFT", timing(call.ttft_ms)],
    ["Input Token", show(call.input_tokens)],
    [t("计费输入 Token"), show(call.billed_input_tokens)],
    ["Output Token", show(call.output_tokens)],
    ["Total Token", show(call.total_tokens)],
    ["Cache Read Token", show(call.cache_read_tokens)],
    ["Cache Write Token", show(call.cache_write_tokens)],
    ["Reasoning Token", show(call.reasoning_tokens)],
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
