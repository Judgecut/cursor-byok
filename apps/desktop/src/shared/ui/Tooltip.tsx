import { autoUpdate, computePosition, flip, offset, shift, size, type Placement, type VirtualElement } from "@floating-ui/dom";
import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import styles from "./Tooltip.module.scss";

export type TooltipAnchor = VirtualElement;

type TooltipContextValue = {
  show: (anchor: TooltipAnchor, id: string | undefined, content: ReactNode, placement?: Placement) => void;
  hide: (id?: string) => void;
};

const TooltipContext = createContext<TooltipContextValue | null>(null);

export function useTooltip() {
  const context = useContext(TooltipContext);
  if (!context) throw new Error("useTooltip must be used within TooltipProvider");
  return context;
}

export function TooltipProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<{ anchor: TooltipAnchor; id?: string; content: ReactNode; placement?: Placement } | null>(null);
  const activeId = useRef<string | undefined>(undefined);
  const hideTimer = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const clearHide = () => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };
  const context = useMemo(() => ({
    show: (anchor: TooltipAnchor, id: string | undefined, content: ReactNode, placement?: Placement) => {
      clearHide();
      activeId.current = id;
      setActive({ anchor, id, content, placement });
    },
    hide: (id?: string) =>
    {
      if (id !== undefined && activeId.current !== id)
      {
        return;
      }
      clearHide();
      hideTimer.current = window.setTimeout(() => {
        activeId.current = undefined;
        setActive(null);
        hideTimer.current = null;
      }, 150);
    },
  }), []);

  return <TooltipContext.Provider value={context}>
    {children}
    <Tooltip
      id={active?.id}
      anchor={active?.anchor ?? null}
      placement={active?.placement}
      onPointerEnter={clearHide}
      onPointerLeave={() => context.hide()}
    >{active?.content}</Tooltip>
  </TooltipContext.Provider>;
}

export function Tooltip({ id, anchor, placement = "top", children, onPointerEnter, onPointerLeave }: {
  id?: string;
  anchor: TooltipAnchor | null;
  placement?: Placement;
  children: ReactNode;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [availableHeight, setAvailableHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    if (!anchor || !tooltip) {
      setPosition(null);
      setAvailableHeight(null);
      return;
    }

    setPosition(null);
    setAvailableHeight(null);
    const updatePosition = () => {
      void computePosition(anchor, tooltip, {
        placement,
        middleware: [
          offset(8),
          flip({ padding: 12 }),
          shift({ padding: 12 }),
          size({
            padding: 12,
            apply({ availableHeight }) {
              setAvailableHeight((current) => current === availableHeight ? current : availableHeight);
            },
          }),
        ],
      }).then(({ x, y }) => setPosition({ left: x, top: y }));
    };

    return autoUpdate(anchor, tooltip, updatePosition);
  }, [anchor, placement]);

  if (!anchor) return null;

  // Tooltip overlays always live under body, outside the trigger's layout and stacking context.
  return createPortal(
    <div
      ref={tooltipRef}
      id={id}
      className={styles.root}
      role="tooltip"
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        maxHeight: availableHeight ? `${availableHeight}px` : undefined,
        visibility: position ? "visible" : "hidden",
      }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {children}
    </div>,
    document.body,
  );
}
