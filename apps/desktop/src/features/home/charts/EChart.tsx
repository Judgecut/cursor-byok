import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import { getInstanceByDom, init, use, type EChartsCoreOption } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef, type MouseEventHandler } from "react";
import styles from "./EChart.module.scss";

use([BarChart, LineChart, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent, CanvasRenderer]);

type TooltipSize = {
  contentSize: [number, number];
  viewSize: [number, number];
};

type TooltipConfig = Record<string, unknown>;

const TOOLTIP_OVERLAY_CSS = "max-width: min(360px, calc(100vw - 24px)); max-height: calc(100vh - 24px); overflow-y: auto; white-space: normal; word-break: normal; overflow-wrap: anywhere; box-sizing: border-box; z-index: 15000;";

function isTooltipConfig(value: unknown): value is TooltipConfig {
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

function resolveChartOption(option: EChartsCoreOption, node: HTMLDivElement): EChartsCoreOption {
  const rawTooltip = (option as { tooltip?: unknown }).tooltip;
  if (!isTooltipConfig(rawTooltip) || rawTooltip.show === false) {
    return option;
  }

  const callerCss = typeof rawTooltip.extraCssText === "string" ? rawTooltip.extraCssText.trim() : "";
  const extraCssText = callerCss
    ? `${callerCss.endsWith(";") ? callerCss : `${callerCss};`} ${TOOLTIP_OVERLAY_CSS}`
    : TOOLTIP_OVERLAY_CSS;

  return {
    ...option,
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
  className?: string;
  onMouseEnter?: MouseEventHandler<HTMLDivElement>;
  onMouseLeave?: MouseEventHandler<HTMLDivElement>;
};

export function EChart({ option, className = styles.root, onMouseEnter, onMouseLeave }: EChartProps) {
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
    };
  }, []);

  useEffect(() => {
    const node = element.current;
    if (node) getInstanceByDom(node)?.setOption(resolveChartOption(option, node), { notMerge: true });
  }, [option]);

  return <div ref={element} className={className} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} />;
}
