// Single source for speed and first-output text so calls, model tests, and the
// model breakdown render the same numbers the same way.
import type {
  CallPerformance,
  SpeedAggregate,
  SpeedSampleCounts,
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

/** Formats a generation window in seconds with one decimal, or an em dash. */
export function formatGeneration(value: number | null): string {
  if (value == null || !Number.isFinite(value) || value < 0) return "—";
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
    case "missing_generation":
      return t("缺少生成结束时间");
    case "short_output":
      return t("输出少于 100 Token，样本不足");
    case "short_generation":
      return t("生成时间少于 100ms，样本不足");
    default:
      return t("无可用速度样本");
  }
}

/** Explains one call's rate: why it is unavailable, or how it was measured. */
export function performanceTooltip(performance: CallPerformance): string {
  const lines: string[] = [];
  if (performance.tokens_per_second == null) {
    lines.push(speedUnavailableText(performance.reason));
  } else {
    lines.push(
      t("平均速度：{speed} tok/s", {
        speed: formatSpeed(performance.tokens_per_second, performance.speed_status),
      }),
    );
  }
  lines.push(
    t("首 Token：{value}", { value: formatFirstOutput(performance.first_output_ms) }),
  );
  lines.push(
    t("生成时间：{value}", { value: formatGeneration(performance.generation_ms) }),
  );
  if (performance.speed_status === "estimated") {
    lines.push(t("Token 或计时口径为估算值"));
  }
  return lines.join("\n");
}

function sampleText(counts: SpeedSampleCounts): string {
  return t("{samples} 次调用 · {tokens} Token · {time}", {
    samples: counts.samples,
    tokens: counts.output_tokens,
    time: formatGeneration(counts.generation_ms),
  });
}

/** Explains an aggregated rate, including the measured/estimated sample split. */
export function aggregateTooltip(speed: SpeedAggregate): string {
  const lines: string[] = [];
  if (speed.average_tokens_per_second == null) {
    lines.push(t("无可用的速度样本"));
  } else {
    lines.push(
      t("平均速度：{speed} tok/s", {
        speed: formatSpeed(speed.average_tokens_per_second, speed.status),
      }),
    );
  }
  lines.push(t("按总输出 ÷ 总生成时间汇总，不平均每次调用速度"));
  lines.push(t("实测样本：{detail}", { detail: sampleText(speed.measured) }));
  lines.push(t("估算样本：{detail}", { detail: sampleText(speed.estimated) }));
  if (speed.status === "estimated") {
    lines.push(t("当前展示的是估算样本，缺少实测样本"));
  }
  lines.push(
    t("首 Token 中位数：{value}", { value: formatFirstOutput(speed.first_output_median_ms) }),
  );
  return lines.join("\n");
}
