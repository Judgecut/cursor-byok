import type { ModelConnectivityResult } from "../../shared/api";
import { Icon } from "../../shared/ui/Icon";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { informationOutlineIcon } from "../../shared/ui/icons";
import {
  formatGeneration,
  formatSpeed,
  generationSpeedTooltip,
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
function testDetail(result: ModelConnectivityResult)
{
  const lines = [generationSpeedTooltip({ overall_tokens_per_second: result.overall_tokens_per_second, overall_reason: result.overall_reason, tokens_per_second: result.tokens_per_second, speed_status: result.speed_status, reason: result.speed_reason, first_output_ms: result.first_output_ms, generation_ms: result.generation_ms })];
  lines.push(t("总耗时：{value}", { value: formatGeneration(result.duration_ms) }));
  lines.push(t("单次测试结果；不同模型的 Token 划分不同，横向比较请结合总耗时"));
  lines.push(
    t("输出：{tokens} tokens", { tokens: result.output_tokens ?? "--" }),
  );
  lines.push(t("返回：{output}", { output: result.output || "--" }));
  return lines.join("\n");
}
