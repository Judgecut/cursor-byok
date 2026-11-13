import type { ModelConnectivityResult } from "../../shared/api";
import { Icon } from "../../shared/ui/Icon";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { informationOutlineIcon } from "../../shared/ui/icons";
import {
  formatFirstOutput,
  formatGeneration,
  formatSpeed,
  speedUnavailableText,
} from "../../shared/utils/speedFormat";
import styles from "./CursorModelTestResult.module.scss";

export type CursorModelTestState =
  | { status: "success"; result: ModelConnectivityResult }
  | { status: "error"; error: string }
  | { status: "cancelled" };

export function CursorModelTestResult({ state, testing = false, compact = false }: {
  state?: CursorModelTestState;
  testing?: boolean;
  /** 列表行内的紧凑徽标形态:未测试时不渲染,详情放入悬浮提示。 */
  compact?: boolean;
}) {
  if (testing) {
    return compact
      ? <span className={`${styles.compact} ${styles.testing}`}>{t("测试中…")}</span>
      : <div className={`${styles.root} ${styles.testing}`}><span className={styles.summary}>{t("测试中…")}</span></div>;
  }
  if (!state) {
    return compact ? null : <div className={`${styles.root} ${styles.idle}`}><span className={styles.summary}>{t("未测试")}</span></div>;
  }
  if (state.status === "cancelled") {
    return compact
      ? <span className={`${styles.compact} ${styles.idle}`}>{t("测试已取消")}</span>
      : <div className={`${styles.root} ${styles.idle}`}><span className={styles.summary}>{t("测试已取消")}</span></div>;
  }

  if (state.status === "error") {
    const failure = t("测试失败：{error}", { error: state.error });
    return compact
      ? <TooltipTrigger label={failure}>
        <span className={`${styles.compact} ${styles.error}`}>{t("测试失败")}<Icon icon={informationOutlineIcon} size="1em" /></span>
      </TooltipTrigger>
      : <div className={`${styles.root} ${styles.error}`}>
        <span className={styles.summary}>{t("错误：{error}", { error: state.error })}</span>
        <TooltipTrigger label={failure}><button type="button" className={styles.details}>{t("查看详情")}<Icon icon={informationOutlineIcon} size="1.1em" /></button></TooltipTrigger>
      </div>;
  }

  const { result } = state;
  // A passed test with too short an output has no rate; the connection itself
  // still succeeded, so the summary reports the measurement gap instead.
  const hasSpeed = result.tokens_per_second != null;
  const speedText = hasSpeed
    ? t("生成速度 {speed} tok/s", {
        speed: formatSpeed(result.tokens_per_second, result.speed_status),
      })
    : null;
  const detail = testDetail(result);

  if (compact) {
    return <TooltipTrigger label={detail}>
      <span className={`${styles.compact} ${styles.success}`}>
        {speedText ?? t("测试通过")}
        <Icon icon={informationOutlineIcon} size="1em" />
      </span>
    </TooltipTrigger>;
  }

  return <div className={`${styles.root} ${styles.success}`}>
    <span className={styles.summary}>{speedText ?? t("测试通过 · 速度样本不足")}</span>
    <TooltipTrigger label={detail}><button type="button" className={styles.details}>{t("查看详情")}<Icon icon={informationOutlineIcon} size="1.1em" /></button></TooltipTrigger>
  </div>;
}

/** Lists every measurement behind a passed test, including why a rate is absent. */
function testDetail(result: ModelConnectivityResult) {
  const lines: string[] = [];
  if (result.tokens_per_second == null) {
    lines.push(speedUnavailableText(result.speed_reason));
  } else {
    lines.push(
      t("生成速度：{speed} tok/s（不含首 Token 等待）", {
        speed: formatSpeed(result.tokens_per_second, result.speed_status),
      }),
    );
    if (result.speed_status === "estimated") lines.push(t("Token 或计时口径为估算值"));
  }
  lines.push(t("首 Token：{value}", { value: formatFirstOutput(result.first_output_ms) }));
  lines.push(t("生成时间：{value}", { value: formatGeneration(result.generation_ms) }));
  lines.push(t("总耗时：{value}", { value: formatGeneration(result.duration_ms) }));
  lines.push(
    t("输出：{tokens} tokens{estimated}", {
      tokens: result.output_tokens,
      estimated: result.tokens_estimated ? t("（估算）") : "",
    }),
  );
  lines.push(t("返回：{output}", { output: result.output || "--" }));
  return lines.join("\n");
}
