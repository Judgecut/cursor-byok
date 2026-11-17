import { useState } from "react";
import { Checkbox } from "../../../shared/ui/Checkbox";
import controls from "../../../shared/ui/Controls.module.scss";
import { ModelSelect, type ModelSelectOption } from "../../../shared/ui/ModelSelect";
import { MonthCalendar, toCalendarDay, type CalendarDay } from "../../../shared/ui/MonthCalendar";
import { customRangeBounds, type CustomRange, type QuickPreset } from "../../../shared/utils/timeRange";
import styles from "./CustomRangePanel.module.scss";

type Field = "start" | "end";

/** Popover body for choosing a custom start/end time; the draft is local until Apply. */
export function CustomRangePanel({
  initialRange,
  quick,
  modelOptions,
  selectedModels,
  onQuickSelect,
  onSelectedModelsChange,
  onCancel,
  onApply,
}: {
  initialRange: CustomRange;
  quick: QuickPreset | null;
  modelOptions?: ModelSelectOption[];
  selectedModels?: string[];
  onQuickSelect: (quick: QuickPreset) => void;
  onSelectedModelsChange?: (value: string[]) => void;
  onCancel: () => void;
  onApply: (range: CustomRange) => void;
}) {
  const quickPresets: Array<{ value: QuickPreset; label: string }> = [
    { value: "four-hours", label: t("近4小时") },
    { value: "twenty-four-hours", label: t("近24小时") },
  ];
  const [draft, setDraft] = useState(initialRange);
  const [activeField, setActiveField] = useState<Field>("start");
  const now = currentMinuteDate();
  const bounds = customRangeBounds(draft, now);
  const valid = bounds.startMs <= bounds.endMs;
  const field: Field = draft.endFollowsNow ? "start" : activeField;
  const fieldMs = (target: Field) => target === "start" ? bounds.startMs : bounds.endMs;
  const setFieldMs = (target: Field, ms: number) => setDraft((current) => (
    target === "start" ? { ...current, startMs: ms } : { ...current, endMs: ms }
  ));

  const selectDay = (day: CalendarDay) => {
    setFieldMs(field, withDate(fieldMs(field), day));
  };

  const renderField = (target: Field, labels: { field: string; date: string; time: string }) => {
    const ms = fieldMs(target);
    const disabled = target === "end" && draft.endFollowsNow;
    return <div
      className={styles.field}
      data-active={field === target || undefined}
      aria-disabled={disabled || undefined}
      onPointerDown={() => { if (!disabled) setActiveField(target); }}
    >
      <span className={styles.fieldLabel}>{labels.field}</span>
      <div className={styles.fieldInputs}>
        <input
          type="date"
          aria-label={labels.date}
          value={toCalendarDay(new Date(ms))}
          disabled={disabled}
          required
          onFocus={() => setActiveField(target)}
          onChange={(event) => { if (event.target.value) setFieldMs(target, withDate(ms, event.target.value)); }}
        />
        <input
          type="time"
          aria-label={labels.time}
          value={toTimeValue(new Date(ms))}
          disabled={disabled}
          required
          onFocus={() => setActiveField(target)}
          onChange={(event) => { if (event.target.value) setFieldMs(target, withTime(ms, event.target.value)); }}
        />
      </div>
    </div>;
  };

  return <div className={styles.root}>
    <div className={styles.quickPresets} aria-label={t("快捷时间范围")}>
      {quickPresets.map((preset) => <button
        key={preset.value}
        type="button"
        aria-pressed={quick === preset.value}
        onClick={() => onQuickSelect(preset.value)}
      >{preset.label}</button>)}
    </div>
    <div className={styles.body}>
      <div className={styles.form}>
        {renderField("start", { field: t("开始时间"), date: t("开始日期"), time: t("开始时刻") })}
        {renderField("end", { field: t("结束时间"), date: t("结束日期"), time: t("结束时刻") })}
        <Checkbox
          checked={draft.endFollowsNow}
          label={t("结束时间跟随当前时刻")}
          onChange={(endFollowsNow) => setDraft((current) => ({
            ...current,
            endFollowsNow,
            endMs: endFollowsNow ? current.endMs : currentMinuteDate().getTime(),
          }))}
        />
        {modelOptions && selectedModels && onSelectedModelsChange && (
          <ModelSelect mode="multiple" label={t("模型")} value={selectedModels} options={modelOptions} onChange={onSelectedModelsChange} />
        )}
        {!valid && <span className={styles.error} role="alert">{t("开始时间不能晚于结束时间")}</span>}
        <div className={styles.actions}>
          <button type="button" className={controls.secondary} onClick={onCancel}>{t("取消")}</button>
          <button type="button" className={controls.primary} disabled={!valid} onClick={() => onApply(draft)}>{t("应用")}</button>
        </div>
      </div>
      <div className={styles.calendar}>
        <MonthCalendar
          selected={toCalendarDay(new Date(fieldMs(field)))}
          rangeStart={toCalendarDay(new Date(bounds.startMs))}
          rangeEnd={toCalendarDay(new Date(bounds.endMs))}
          onSelect={selectDay}
        />
      </div>
    </div>
  </div>;
}

export function currentMinuteDate(now = new Date()): Date {
  const date = new Date(now);
  date.setSeconds(0, 0);
  return date;
}

function toTimeValue(date: Date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function withDate(ms: number, day: CalendarDay) {
  const [year, month, date] = day.split("-").map(Number);
  const next = new Date(ms);
  next.setFullYear(year, month - 1, date);
  next.setSeconds(0, 0);
  return next.getTime();
}

function withTime(ms: number, time: string) {
  const [hours, minutes] = time.split(":").map(Number);
  const next = new Date(ms);
  next.setHours(hours, minutes, 0, 0);
  return next.getTime();
}
