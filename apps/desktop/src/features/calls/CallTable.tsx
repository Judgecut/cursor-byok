import type { ReactNode } from "react";
import type { LlmCall } from "../../shared/api";
import { useAppStore } from "../../shared/store/appStore";
import controls from "../../shared/ui/Controls.module.scss";
import { DataTable, type DataTableColumn, type ServerPagination } from "../../shared/ui/DataTable";
import { Icon } from "../../shared/ui/Icon";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { eyeIcon } from "../../shared/ui/icons";
import {
  formatConversionNote,
  formatDisplayCost,
  formatDisplayCostExact,
  formatUsdExact,
  type DisplayCurrency,
} from "../../shared/utils/costFormat";
import { formatCompactInteger, formatInteger } from "../../shared/utils/numberFormat";
import { formatFirstOutput, formatSpeed, overallSpeedTooltip } from "../../shared/utils/speedFormat";
import styles from "./CallTable.module.scss";
import { useCallHighlights } from "./useCallHighlights";

const value = (input: string | number | null) => input ?? "-";
const tokenCount = (input: number | null) => input == null ? "-" : formatCompactInteger(input);
const tokenTitle = (input: number | null) => input == null ? undefined : formatInteger(input);

function renderCost(call: LlmCall, currency: DisplayCurrency, cnyRate: string | null) {
  if (call.call_kind === "cursor_official") {
    return <span className={styles.costMuted}>{t("未知")}</span>;
  }
  if (call.cost_status === "incomplete_usage") {
    return <span className={styles.costMuted}>{t("用量不完整")}</span>;
  }
  if (call.cost_status !== "priced" || call.total_cost == null) {
    return <span className={styles.costMuted}>{t("未定价")}</span>;
  }
  const tag = call.status === "running"
    ? t("暂计")
    : call.cost_backfilled
      ? t("历史估算")
      : null;
  return <span className={styles.costCell}>
    <span className={styles.costAmount}>{formatDisplayCost(call.total_cost, currency, cnyRate)}</span>
    {tag && <span className={styles.costTag}>{tag}</span>}
  </span>;
}

function costTitle(call: LlmCall, currency: DisplayCurrency, cnyRate: string | null): string | undefined {
  if (call.call_kind === "cursor_official") return t("Cursor 官方通道无法估算费用");
  if (call.cost_status === "incomplete_usage") return t("调用用量字段不完整");
  if (call.cost_status !== "priced" || call.total_cost == null) return t("该供应商模型尚未配置定价");
  const base = t("总费用：{total}（输入 {input} · 输出 {output} · 缓存读 {read} · 缓存写 {write}）", {
    total: formatDisplayCostExact(call.total_cost, currency, cnyRate),
    input: formatDisplayCostExact(call.input_cost, currency, cnyRate),
    output: formatDisplayCostExact(call.output_cost, currency, cnyRate),
    read: formatDisplayCostExact(call.cache_read_cost, currency, cnyRate),
    write: formatDisplayCostExact(call.cache_write_cost, currency, cnyRate),
  });
  const note = formatConversionNote(currency, cnyRate);
  if (!note) return base;
  return `${base}\n${t("原美元金额：{cost}", { cost: formatUsdExact(call.total_cost) })}\n${note}`;
}

export function CallTable({
  calls,
  queryKey,
  ready,
  onDetails,
  serverPagination,
  loading = false,
  emptyText,
}: {
  calls: LlmCall[];
  queryKey: string;
  ready: boolean;
  onDetails: (call: LlmCall) => void;
  serverPagination?: ServerPagination;
  loading?: boolean;
  emptyText?: ReactNode;
}) {
  const { currency, cnyRate } = useAppStore();
  const rowRef = useCallHighlights(calls, queryKey, ready);
  const columns: DataTableColumn<LlmCall>[] = [
    {
      key: "status",
      header: t("状态"),
      render: (call) => (
        <span
          className={[styles.status, styles[call.status]]
            .filter(Boolean)
            .join(" ")}
        >
          {call.status}
        </span>
      ),
    },
    {
      key: "display_name",
      header: t("显示名称"),
      render: (call) => call.display_name,
      title: (call) => call.display_name,
    },
    {
      key: "created_at",
      header: t("时间"),
      render: (call) => new Date(call.created_at_ms).toLocaleString(),
    },
    {
      key: "model_id",
      header: t("模型名称"),
      render: (call) => call.model_id,
      title: (call) => call.model_id,
    },
    {
      key: "estimated_cost",
      header: t("估算费用"),
      render: (call) => renderCost(call, currency, cnyRate),
      title: (call) => costTitle(call, currency, cnyRate),
    },
    {
      key: "reasoning_effort",
      header: t("思考强度"),
      render: (call) => value(call.reasoning_effort),
    },
    {
      key: "input_tokens",
      header: "Input Token",
      render: (call) => tokenCount(call.input_tokens),
      title: (call) => tokenTitle(call.input_tokens),
    },
    {
      key: "output_tokens",
      header: "Output Token",
      render: (call) => tokenCount(call.output_tokens),
      title: (call) => tokenTitle(call.output_tokens),
    },
    {
      key: "total_tokens",
      header: "Total Token",
      render: (call) => tokenCount(call.total_tokens),
      title: (call) => tokenTitle(call.total_tokens),
    },
    {
      key: "cache_read",
      header: "Cache Read",
      render: (call) => tokenCount(call.cache_read_tokens),
      title: (call) => tokenTitle(call.cache_read_tokens),
    },
    {
      key: "cache_write",
      header: "Cache Write",
      render: (call) => tokenCount(call.cache_write_tokens),
      title: (call) => tokenTitle(call.cache_write_tokens),
    },
    {
      key: "reasoning_tokens",
      header: "Reasoning Token",
      render: (call) => tokenCount(call.reasoning_tokens),
      title: (call) => tokenTitle(call.reasoning_tokens),
    },
    {
      key: "speed",
      header: t("整体速度（tok/s）"),
      title: (call) => overallSpeedTooltip(call.performance),
      render: (call) => formatSpeed(call.performance.overall_tokens_per_second),
    },
    {
      key: "first_output",
      header: t("首 Token（s）"),
      title: (call) => overallSpeedTooltip(call.performance),
      render: (call) => formatFirstOutput(call.performance.first_output_ms),
    },
    {
      key: "fast",
      header: "Fast",
      render: (call) => call.fast == null ? "-" : call.fast ? t("是") : t("否"),
    },
    {
      key: "call_kind",
      header: t("调用类型"),
      render: (call) =>
        call.call_kind === "cursor_official" ? t("Cursor 官方") : "LLM",
    },
    {
      key: "route",
      header: t("路由"),
      render: (call) =>
        call.route === "cursor_official" ? t("Cursor 官方") : call.route === "external_api" ? "External API" : "BYOK",
    },
    {
      key: "finish_reason",
      header: "Finish Reason",
      render: (call) => value(call.finish_reason),
    },
    { key: "http", header: "HTTP", render: (call) => value(call.http_status) },
    {
      key: "message_count",
      header: t("消息数"),
      render: (call) => call.message_count,
    },
    {
      key: "tool_count",
      header: t("工具数"),
      render: (call) => call.tool_count,
    },
    {
      key: "detailed",
      header: t("详细记录"),
      render: (call) => (call.detailed ? t("是") : t("否")),
    },
    {
      key: "error_kind",
      header: "Error Kind",
      render: (call) => value(call.error_kind),
      title: (call) => call.error_kind ?? undefined,
    },
    {
      key: "error_message",
      header: "Error Message",
      render: (call) => value(call.error_message),
      title: (call) => call.error_message ?? undefined,
    },
    {
      key: "call_id",
      header: "Call ID",
      render: (call) => call.call_id,
      title: (call) => call.call_id,
    },
    {
      key: "run_id",
      header: "Run ID",
      render: (call) => call.run_id,
      title: (call) => call.run_id,
    },
    {
      key: "conversation_id",
      header: "Conversation ID",
      render: (call) => call.conversation_id,
      title: (call) => call.conversation_id,
    },
    {
      key: "call_index",
      header: "Call Index",
      render: (call) => call.provider_call_index,
    },
    {
      key: "actions",
      header: t("操作"),
      sticky: "right",
      render: (call) => (
        <TooltipTrigger label={t("查看详情")}>
          <button
            className={controls.iconButton}
            aria-label={t("查看详情")}
            onClick={() => onDetails(call)}
          >
            <Icon icon={eyeIcon} size="1.1em" />
          </button>
        </TooltipTrigger>
      ),
    },
  ];
  return <DataTable
    rows={calls}
    columns={columns}
    rowKey={(call) => call.call_id}
    rowClassName={() => styles.updateRow}
    rowRef={rowRef}
    minWidth={4340}
    serverPagination={serverPagination}
    loading={loading}
    emptyText={emptyText}
  />;
}
