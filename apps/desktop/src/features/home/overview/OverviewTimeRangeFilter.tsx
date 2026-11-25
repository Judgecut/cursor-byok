import { autoUpdate, computePosition, flip, offset, shift, size } from "@floating-ui/dom";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { quickPresetRange, type CustomRange, type OverviewRangePreset, type QuickPreset } from "../../../shared/utils/timeRange";
import type { ModelSelectOption } from "../../../shared/ui/ModelSelect";
import { CustomRangePanel, currentMinuteDate } from "./CustomRangePanel";
import styles from "./OverviewTimeRangeFilter.module.scss";

export type { OverviewRangePreset, QuickPreset };

export function OverviewTimeRangeFilter({
  value,
  allowAll = false,
  allSelected = false,
  quick,
  customRange,
  customOpen,
  modelOptions,
  selectedModels,
  onSelectAll,
  onSelect,
  onQuickSelect,
  onCustomOpenChange,
  onSelectedModelsChange,
  onCustomApply,
}: {
  value: OverviewRangePreset | "all";
  allowAll?: boolean;
  allSelected?: boolean;
  quick: QuickPreset | null;
  customRange: CustomRange | null;
  customOpen: boolean;
  modelOptions?: ModelSelectOption[];
  selectedModels?: string[];
  onSelectAll?: () => void;
  onSelect: (value: Exclude<OverviewRangePreset, "custom">) => void;
  onQuickSelect: (quick: QuickPreset) => void;
  onCustomOpenChange: (open: boolean) => void;
  onSelectedModelsChange?: (value: string[]) => void;
  onCustomApply: (range: CustomRange) => void;
}) {
  const presets: Array<{ value: Exclude<OverviewRangePreset, "custom">; label: string }> = [
    { value: "hour", label: t("近1小时") },
    { value: "today", label: t("近1自然日") },
    { value: "ten-minutes", label: t("近10分钟") },
    { value: "week", label: t("近一周") },
    { value: "month", label: t("近一个月") },
  ];
  const customButton = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const popoverId = useId();
  const [position, setPosition] = useState({ left: 0, top: 0, maxWidth: 640, maxHeight: 480 });

  useLayoutEffect(() => {
    if (!customOpen || !customButton.current || !popover.current) return;
    return autoUpdate(customButton.current, popover.current, () => void computePosition(customButton.current!, popover.current!, {
      placement: "bottom-end",
      middleware: [offset(5), flip({ padding: 10 }), shift({ padding: 10 }), size({
        padding: 10,
        apply: ({ availableWidth, availableHeight }) => setPosition((current) => ({
          ...current,
          maxWidth: Math.max(320, availableWidth),
          maxHeight: Math.max(240, availableHeight),
        })),
      })],
    }).then(({ x, y }) => setPosition((current) => ({ ...current, left: x, top: y }))));
  }, [customOpen]);

  useEffect(() => {
    if (!customOpen) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!customButton.current?.contains(target) && !popover.current?.contains(target)) onCustomOpenChange(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [customOpen, onCustomOpenChange]);

  const initialRange = (): CustomRange => {
    if (value === "custom" && customRange) return customRange;
    const now = currentMinuteDate();
    if (value === "custom" && quick) return { ...quickPresetRange(quick, now), endFollowsNow: false };
    const nowMs = now.getTime();
    return { startMs: nowMs, endMs: nowMs, endFollowsNow: false };
  };

  return <div className={styles.root} aria-label={t("时间范围筛选")} onKeyDown={(event) =>
  {
    if (!customOpen || event.defaultPrevented || event.key !== "Escape") return;
    event.preventDefault();
    onCustomOpenChange(false);
    customButton.current?.focus();
  }}>
    <div className={styles.presets}>
      {allowAll && onSelectAll && <button
        type="button"
        aria-pressed={allSelected || value === "all"}
        onClick={onSelectAll}
      >{t("全部")}</button>}
      {presets.map((preset) => <button
        key={preset.value}
        type="button"
        aria-pressed={!allSelected && value === preset.value}
        onClick={() => onSelect(preset.value)}
      >{preset.label}</button>)}
      <button
        ref={customButton}
        type="button"
        aria-haspopup="dialog"
        aria-controls={customOpen ? popoverId : undefined}
        aria-expanded={customOpen}
        aria-pressed={!allSelected && value === "custom"}
        onClick={() => onCustomOpenChange(!customOpen)}
      >{t("自定义")}</button>
    </div>
    {customOpen && createPortal(<div
      id={popoverId}
      ref={popover}
      className={styles.popover}
      role="dialog"
      aria-label={t("自定义时间与筛选")}
      style={position}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <CustomRangePanel
        initialRange={initialRange()}
        quick={value === "custom" ? quick : null}
        modelOptions={modelOptions}
        selectedModels={selectedModels}
        onQuickSelect={onQuickSelect}
        onSelectedModelsChange={onSelectedModelsChange}
        onCancel={() => onCustomOpenChange(false)}
        onApply={onCustomApply}
      />
    </div>, document.body)}
  </div>;
}
