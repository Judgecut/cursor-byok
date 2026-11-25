import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import { getInstanceByDom, init, use, type EChartsCoreOption } from "echarts/core";
import { UniversalTransition } from "echarts/features";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef, useSyncExternalStore, type MouseEventHandler } from "react";
import styles from "./EChart.module.scss";

use([BarChart, LineChart, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent, CanvasRenderer, UniversalTransition]);

type TooltipSize = {
  contentSize: [number, number];
  viewSize: [number, number];
};

type OptionFields = Record<string, unknown>;

const TOOLTIP_OVERLAY_CSS = "max-width: min(360px, calc(100vw - 24px)); max-height: calc(100vh - 24px); overflow-y: auto; white-space: normal; word-break: normal; overflow-wrap: anywhere; box-sizing: border-box; z-index: 15000;";

function isOptionObject(value: unknown): value is OptionFields
{
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampTooltipPosition(
  node: HTMLDivElement,
  point: [number, number],
  _params: unknown,
  _el: unknown,
  _rect: unknown,
  size: TooltipSize,
): [number, number] {
  const chartRect = node.getBoundingClientRect();
  const [tipWidth, tipHeight] = size.contentSize;
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
  const padding = 12;
  const offset = 14;

  let left = chartRect.left + point[0] + offset;
  if (left + tipWidth > viewportWidth - padding) {
    left = chartRect.left + point[0] - tipWidth - offset;
  }
  left = Math.max(padding, Math.min(left, viewportWidth - tipWidth - padding));

  let top = chartRect.top + point[1] + offset;
  if (top + tipHeight > viewportHeight - padding) {
    top = chartRect.top + point[1] - tipHeight - offset;
  }
  top = Math.max(padding, Math.min(top, viewportHeight - tipHeight - padding));

  return [left - chartRect.left, top - chartRect.top];
}

function subscribeTheme(onChange: () => void)
{
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

function getTheme()
{
  return document.documentElement.dataset.theme;
}

function resolveChartOption(option: EChartsCoreOption, node: HTMLDivElement): EChartsCoreOption
{
  const color = getComputedStyle(node).getPropertyValue("--vscode-descriptionForeground").trim();
  const styleAxis = (axis: unknown) =>
  {
    if (!isOptionObject(axis)) return axis;
    const axisLabel = isOptionObject(axis.axisLabel) ? axis.axisLabel : {};
    return { ...axis, axisLabel: { color, ...axisLabel } };
  };
  const styled = { ...option, xAxis: Array.isArray(option.xAxis) ? option.xAxis.map(styleAxis) : styleAxis(option.xAxis), yAxis: Array.isArray(option.yAxis) ? option.yAxis.map(styleAxis) : styleAxis(option.yAxis) };
  const rawTooltip = (option as { tooltip?: unknown }).tooltip;
  if (!isOptionObject(rawTooltip) || rawTooltip.show === false) {
    return styled;
  }

  const callerCss = typeof rawTooltip.extraCssText === "string" ? rawTooltip.extraCssText.trim() : "";
  const extraCssText = callerCss
    ? `${callerCss.endsWith(";") ? callerCss : `${callerCss};`} ${TOOLTIP_OVERLAY_CSS}`
    : TOOLTIP_OVERLAY_CSS;

  return {
    ...styled,
    tooltip: {
      ...rawTooltip,
      appendTo: rawTooltip.appendTo ?? (() => document.body),
      confine: false,
      position: rawTooltip.position ?? ((
        point: [number, number],
        params: unknown,
        el: unknown,
        rect: unknown,
        size: TooltipSize,
      ) => clampTooltipPosition(node, point, params, el, rect, size)),
      extraCssText,
    },
  };
}

type EChartProps = {
  option: EChartsCoreOption;
  transition?: { viewKey: string; morphKey?: string; data: unknown; enabled: boolean };
  className?: string;
  onMouseEnter?: MouseEventHandler<HTMLDivElement>;
  onMouseLeave?: MouseEventHandler<HTMLDivElement>;
};

export function EChart({ option, transition, className = styles.root, onMouseEnter, onMouseLeave }: EChartProps) {
  const theme = useSyncExternalStore(subscribeTheme, getTheme);
  const previous = useRef<{
    viewKey: string;
    morphKey?: string;
    data: unknown;
    enabled: boolean;
    theme: string | undefined;
  } | undefined>(undefined);
  const viewKey = transition?.viewKey;
  const morphKey = transition?.morphKey;
  const data = transition?.data;
  const enabled = transition?.enabled;
  const element = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const chart = init(node, undefined, { renderer: "canvas" });
    const observer = new ResizeObserver(() => {
      if (node.clientWidth > 0 && node.clientHeight > 0) {
        chart.resize();
      }
    });
    observer.observe(node);
    const handleScroll = (event: Event) => {
      const target = event.target;
      if (target === document || (target instanceof Node && target.contains(node))) {
        chart.dispatchAction({ type: "hideTip" });
      }
    };
    window.addEventListener("scroll", handleScroll, { capture: true, passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll, { capture: true });
      observer.disconnect();
      chart.dispose();
      previous.current = undefined;
    };
  }, []);

  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const chart = getInstanceByDom(node);
    const resolved = resolveChartOption(option, node);
    if (viewKey === undefined)
    {
      chart?.setOption(resolved, { notMerge: true });
      return;
    }

    const last = previous.current;
    const isEnabled = Boolean(enabled);
    const sameView = Boolean(last && last.viewKey === viewKey && last.enabled === isEnabled);
    const sameMorph = sameView && last?.morphKey === morphKey;
    const dataChanged = last?.data !== data;
    const themeChanged = last?.theme !== theme;

    let animOption: EChartsCoreOption;
    if (!isEnabled)
    {
      animOption = {
        ...resolved,
        animation: false,
        animationDuration: 0,
        animationDurationUpdate: 0,
      };
    }
    else if (!sameView)
    {
      animOption = {
        ...resolved,
        animation: true,
        animationDuration: 520,
        animationEasing: "cubicOut",
        animationDelay: (idx: number) => Math.min(idx * 14, 180),
        animationDurationUpdate: 520,
        animationEasingUpdate: "cubicOut",
      };
    }
    else if (!sameMorph || dataChanged)
    {
      animOption = {
        ...resolved,
        animation: true,
        animationDuration: 460,
        animationEasing: "cubicOut",
        animationDurationUpdate: 540,
        animationEasingUpdate: "cubicOut",
      };
    }
    else if (themeChanged)
    {
      animOption = {
        ...resolved,
        animation: false,
        animationDuration: 0,
        animationDurationUpdate: 0,
      };
    }
    else
    {
      animOption = {
        ...resolved,
        animation: true,
        animationDuration: 0,
        animationDurationUpdate: 220,
        animationEasingUpdate: "cubicOut",
      };
    }

    chart?.setOption(animOption, sameView ? { replaceMerge: ["series"] } : { notMerge: true });
    previous.current = { viewKey, morphKey, data, enabled: isEnabled, theme };
  }, [data, enabled, morphKey, option, theme, viewKey]);

  return <div ref={element} className={className} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} />;
}
