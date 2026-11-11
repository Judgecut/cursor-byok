import { autoUpdate, computePosition, flip, offset, shift, size } from "@floating-ui/dom";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { VirtualList } from "../virtual/VirtualList";
import type { VirtualListApi } from "../virtual/virtualTypes";
import { Icon, type IconProps } from "./Icon";
import { checkIcon, chevronDownIcon, windowCloseIcon } from "./icons";
import styles from "./SupplierFilter.module.scss";

export type SupplierFilterOption = {
  value: string;
  label: string;
  endpointKey: string;
  active: boolean;
  icon?: IconProps["icon"];
  iconSrc?: string;
};

export function SupplierFilter({
  value,
  options,
  disabled,
  label = t("供应商"),
  onChange,
}: {
  value: string[];
  options: SupplierFilterOption[];
  disabled?: boolean;
  label?: string;
  onChange: (value: string[]) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const listApi = useRef<VirtualListApi | null>(null);
  const optionRefs = useRef(new Map<number, HTMLLabelElement>());
  const pendingFocusIndex = useRef<number | null>(null);
  const pendingScrollIndex = useRef<number | null>(null);
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 280, maxHeight: 320 });

  const selected = useMemo(() => new Set(value), [value]);
  const optionByValue = useMemo(
    () => new Map(options.map((option) => [option.value, option])),
    [options],
  );
  const clampedActiveIndex = options.length === 0
    ? -1
    : Math.max(0, Math.min(activeIndex, options.length - 1));

  useLayoutEffect(() => {
    if (!open || !root.current || !menu.current) return;
    return autoUpdate(root.current, menu.current, () => void computePosition(root.current!, menu.current!, {
      placement: "bottom-end",
      middleware: [offset(5), flip({ padding: 10 }), shift({ padding: 10 }), size({
        padding: 10,
        apply: ({ rects, availableHeight }) => setPosition((current) => ({
          ...current,
          width: Math.max(280, Math.min(360, Math.max(rects.reference.width, 280))),
          maxHeight: Math.max(140, availableHeight),
        })),
      })],
    }).then(({ x, y }) => setPosition((current) => ({ ...current, left: x, top: y }))));
  }, [open, options.length]);

  const close = useCallback(() => {
    pendingFocusIndex.current = null;
    pendingScrollIndex.current = null;
    setOpen(false);
    trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) {
      listApi.current = null;
      pendingFocusIndex.current = null;
      pendingScrollIndex.current = null;
      return;
    }
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !menu.current?.contains(target)) close();
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [close, open]);

  const handleListReady = useCallback((api: VirtualListApi) => {
    listApi.current = api;
    if (pendingScrollIndex.current !== null) {
      const target = pendingScrollIndex.current;
      pendingScrollIndex.current = null;
      api.scrollToIndex(target, "auto");
    }
  }, []);

  const setOptionRef = useCallback((index: number, node: HTMLLabelElement | null) => {
    if (node) {
      optionRefs.current.set(index, node);
      if (pendingFocusIndex.current === index) {
        pendingFocusIndex.current = null;
        node.focus({ preventScroll: true });
      }
    } else {
      optionRefs.current.delete(index);
    }
  }, []);

  const focusOptionAt = useCallback((index: number) => {
    if (options.length === 0) return;
    const target = ((index % options.length) + options.length) % options.length;
    pendingFocusIndex.current = target;
    pendingScrollIndex.current = null;
    setActiveIndex(target);
    listApi.current?.scrollToIndex(target, "auto");
    const targetNode = optionRefs.current.get(target);
    if (targetNode) {
      pendingFocusIndex.current = null;
      targetNode.focus({ preventScroll: true });
    }
  }, [options.length]);

  const summary = value.length === 0
    ? t("全部")
    : value.length === 1
      ? (optionByValue.get(value[0])?.label ?? value[0])
      : t("已选 {count} 家", { count: value.length });

  const toggleOption = (optionValue: string) => {
    onChange(
      selected.has(optionValue)
        ? value.filter((item) => item !== optionValue)
        : [...value, optionValue],
    );
  };

  const openMenu = (preferredIndex?: number) => {
    if (disabled) return;
    const width = root.current?.getBoundingClientRect().width ?? 0;
    setPosition((current) => ({ ...current, width: Math.max(280, width) }));
    if (options.length > 0) {
      const selectedIndex = options.findIndex((option) => selected.has(option.value));
      const initial = preferredIndex ?? (selectedIndex >= 0 ? selectedIndex : 0);
      const clamped = Math.max(0, Math.min(initial, options.length - 1));
      pendingFocusIndex.current = clamped;
      pendingScrollIndex.current = clamped;
      setActiveIndex(clamped);
    } else {
      pendingFocusIndex.current = null;
      pendingScrollIndex.current = null;
      setActiveIndex(0);
    }
    setOpen(true);
  };

  return <>
    <div ref={root} className={styles.target} data-open={open || undefined} data-disabled={disabled || undefined}>
      <button
        ref={trigger}
        type="button"
        className={styles.trigger}
        disabled={disabled}
        aria-label={t("筛选供应商：{summary}", { summary })}
        aria-haspopup="listbox"
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        onClick={() => { if (open) close(); else openMenu(); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            openMenu();
          } else if (event.key === "ArrowUp" && options.length > 0) {
            event.preventDefault();
            openMenu(options.length - 1);
          }
        }}
      >
        <span className={styles.triggerLabel}>{label}</span>
        <span className={styles.summary} aria-hidden="true">{summary}</span>
        <Icon icon={chevronDownIcon} size="1.05em" />
      </button>
      {value.length > 0 && <button
        type="button"
        className={styles.clear}
        aria-label={t("清除供应商筛选")}
        onClick={() => onChange([])}
      >
        <Icon icon={windowCloseIcon} size="1em" />
      </button>}
    </div>
    {open && createPortal(<div
      id={menuId}
      ref={menu}
      className={styles.menu}
      aria-label={label}
      style={{ left: position.left, top: position.top, width: position.width }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
      }}
    >
      <div
        className={styles.listFrame}
        role="listbox"
        aria-label={label}
        aria-multiselectable="true"
        style={{ height: Math.max(46, Math.min(options.length * 46, Math.max(46, position.maxHeight - 46))) }}
        onKeyDown={(event) => {
          if (options.length === 0) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            focusOptionAt(clampedActiveIndex + 1);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            focusOptionAt(clampedActiveIndex - 1);
          } else if (event.key === "Home") {
            event.preventDefault();
            focusOptionAt(0);
          } else if (event.key === "End") {
            event.preventDefault();
            focusOptionAt(options.length - 1);
          } else if (event.key === "PageDown") {
            event.preventDefault();
            focusOptionAt(Math.min(options.length - 1, clampedActiveIndex + 6));
          } else if (event.key === "PageUp") {
            event.preventDefault();
            focusOptionAt(Math.max(0, clampedActiveIndex - 6));
          }
        }}
      >
        <VirtualList
          items={options}
          itemKey="value"
          className={styles.list}
          style={{ height: "100%" }}
          estimatedItemHeight={46}
          overscan={4}
          onReady={handleListReady}
          empty={<div className={styles.empty}>{t("暂无可选供应商")}</div>}
        >
          {(option, index) => <label
            ref={(node) => setOptionRef(index, node)}
            className={styles.optionRow}
            role="option"
            aria-selected={selected.has(option.value)}
            data-active={index === clampedActiveIndex || undefined}
            tabIndex={index === clampedActiveIndex ? 0 : -1}
            onMouseEnter={() => setActiveIndex(index)}
            onKeyDown={(event) => {
              if (event.target instanceof HTMLInputElement && event.key === " ") return;
              if (event.key === " " || event.key === "Enter") {
                event.preventDefault();
                setActiveIndex(index);
                toggleOption(option.value);
              }
            }}
          >
            <input
              type="checkbox"
              checked={selected.has(option.value)}
              tabIndex={-1}
              onChange={() => {
                setActiveIndex(index);
                toggleOption(option.value);
              }}
            />
            <span className={styles.checkbox} aria-hidden="true">
              {selected.has(option.value) && <Icon icon={checkIcon} size="0.875em" />}
            </span>
            <span className={styles.option}>
              <span className={styles.optionMain}>
                {(option.icon || option.iconSrc) && <Icon icon={option.icon} src={option.iconSrc} size="1em" />}
                <span className={styles.optionLabel}>{option.label}</span>
                {!option.active && <span className={styles.historyBadge}>{t("历史")}</span>}
              </span>
              <span className={styles.endpoint} title={option.endpointKey}>{option.endpointKey}</span>
            </span>
          </label>}
        </VirtualList>
      </div>
      {options.length > 0 && <div className={styles.footer}>
        <button type="button" onClick={() => onChange(options.map((option) => option.value))}>{t("全选")}</button>
        <button type="button" onClick={() => onChange([])}>{t("全部（清空）")}</button>
      </div>}
    </div>, document.body)}
  </>;
}
