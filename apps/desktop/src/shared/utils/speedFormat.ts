// Single source for speed and first-output text so calls, model tests, and the
// model breakdown render the same numbers the same way.
import type {
  CallPerformance,
  SpeedAggregate,
  SpeedStatus,
  SpeedUnavailableReason,
} from "../api";

/**
 * Formats a rate: whole numbers at or above 1, one decimal below, and an unknown
 * rate as an em dash. `estimated` adds the `≈` prefix.
 */
export function formatSpeed(value: number | null, status: SpeedStatus = "measured"): string {
  if (value == null || !Number.isFinite(value) || value < 0) return "—";
  const text = value >= 1 ? value.toFixed(0) : value.toFixed(1);
  return status === "estimated" ? `≈${text}` : text;
}

/** Formats a first-output wait in seconds with one decimal, or an em dash. */
export function formatFirstOutput(value: number | null): string {
  if (value == null || !Number.isFinite(value) || value < 0) return "—";
  return `${(value / 1000).toFixed(1)}s`;
}

/** Shows milliseconds for sub-second generation windows. */
export function formatGeneration(value: number | null): string {
  if (value == null || !Number.isFinite(value) || value < 0) return "—";
  if (value < 1000)
  {
    return `${value}ms`;
  }
  return `${(value / 1000).toFixed(1)}s`;
}

export function speedUnavailableText(reason: SpeedUnavailableReason | null): string {
  switch (reason) {
    case "not_completed":
      return t("调用未成功完成");
    case "not_streaming":
      return t("非流式调用，无法计量生成时间");
    case "missing_output_tokens":
      return t("上游未返回输出 Token 数");
    case "missing_first_output":
      return t("未观察到实际输出");
    case "missing_visible_output_tokens":
      return t("上游未区分思考与可见输出 Token，无法计算生成速度");
    case "insufficient_output_events":
      return t("缺少多段可见流式输出，无法计算生成速度");
    case "missing_generation":
      return t("缺少生成结束时间");
    case "missing_duration":
      return t("缺少调用总耗时");
    case "short_output":
      return t("无有效可见输出，无法计算速度");
    case "short_generation":
      return t("生成时间少于 200ms，样本不足");
    default:
      return t("无可用速度样本");
  }
}

/** Explains one call's generation rate first and keeps the end-to-end rate as secondary info. */
export function generationSpeedTooltip(performance: CallPerformance): string {
  const lines: string[] = [];
  if (performance.tokens_per_second == null) {
    lines.push(t("生成速度：不可用（{reason}）", {
      reason: speedUnavailableText(performance.reason),
    }));
  } else {
    lines.push(
      t("生成速度：{speed} tok/s（首末可见输出之间）", {
        speed: formatSpeed(performance.tokens_per_second, performance.speed_status),
      }),
    );
  }
  lines.push(
    t("首次输出：{value}", { value: formatFirstOutput(performance.first_output_ms) }),
  );
  lines.push(
    t("生成时间：{value}", { value: formatGeneration(performance.generation_ms) }),
  );
  if (performance.overall_tokens_per_second == null) {
    lines.push(t("整体端到端速度：不可用（{reason}）", {
      reason: speedUnavailableText(performance.overall_reason),
    }));
  } else {
    lines.push(
      t("整体端到端速度：{speed} tok/s（含首次输出等待）", {
        speed: formatSpeed(performance.overall_tokens_per_second),
      }),
    );
  }
  if (performance.speed_status === "estimated") {
    lines.push(t("按可见输出 Token 与客户端接收时间估算；首批可能包含多个 Token，分块方式会影响结果"));
  }
  return lines.join("\n");
}

/** Explains an aggregated generation rate and the totals behind it. */
export function aggregateTooltip(speed: SpeedAggregate): string {
  const lines: string[] = [];
  if (speed.average_tokens_per_second == null) {
    lines.push(t("无可用的速度样本"));
  } else {
    lines.push(
      t("生成速度：{speed} tok/s（首末可见输出之间）", {
        speed: formatSpeed(speed.average_tokens_per_second, "estimated"),
      }),
    );
  }
  lines.push(t("按首个 Token 之后的可见输出总数 ÷ 首末可见输出间隔汇总"));
  if (speed.average_tokens_per_second != null)
  {
    lines.push(t("按可见输出 Token 与客户端接收时间估算；首批可能包含多个 Token，分块方式会影响结果"));
  }
  lines.push(
    t("样本：{samples} 次调用 · {tokens} Token · {time}", {
      samples: speed.samples,
      tokens: speed.output_tokens,
      time: formatGeneration(speed.generation_ms),
    }),
  );
  lines.push(
    t("首次输出中位数：{value}", { value: formatFirstOutput(speed.first_output_median_ms) }),
  );
  return lines.join("\n");
}
