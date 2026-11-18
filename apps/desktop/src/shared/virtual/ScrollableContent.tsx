import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { ScrollArea } from "../scrollable/ScrollArea";
import styles from "./ScrollableContent.module.scss";

type ScrollableContentProps = {
  children: ReactNode;
  className?: string;
  viewportClassName?: string;
  contentClassName?: string;
  viewportRef?: Ref<HTMLDivElement>;
  scrollbarInsetTop?: string;
  horizontal?: boolean;
  alwaysShowVertical?: boolean;
};

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (!ref) return;
  if (typeof ref === "function") ref(value);
  else ref.current = value;
}

export function ScrollableContent({ children, className, viewportClassName, contentClassName, viewportRef, scrollbarInsetTop, horizontal = false, alwaysShowVertical = false }: ScrollableContentProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const horizontalDragOffset = useRef<number | null>(null);
  const preservedScrollLeftRef = useRef(0);
  const wasHorizontalHiddenRef = useRef(false);
  const [metrics, setMetrics] = useState({ visible: false, left: 0, width: 0 });
  const setViewportRef = useCallback((node: HTMLDivElement | null) => {
    viewport.current = node;
    assignRef(viewportRef, node);
  }, [viewportRef]);
  useEffect(() => {
    if (!horizontal || !viewport.current || !content.current || !track.current) return;
    const viewportNode = viewport.current;
    const contentNode = content.current;
    const updateMetrics = () => {
      const maximum = Math.max(0, viewportNode.scrollWidth - viewportNode.clientWidth);
      const trackWidth = track.current?.clientWidth ?? 0;
      const width = maximum > 0 ? Math.max(20, trackWidth * viewportNode.clientWidth / viewportNode.scrollWidth) : 0;
      setMetrics({ visible: maximum > 0, left: maximum > 0 ? viewportNode.scrollLeft / maximum * Math.max(0, trackWidth - width) : 0, width });
    };
    const handleHorizontalScroll = () => {
      if (viewportNode.isConnected && viewportNode.clientWidth > 0) {
        wasHorizontalHiddenRef.current = false;
        preservedScrollLeftRef.current = viewportNode.scrollLeft;
      }
      updateMetrics();
    };
    const handleHorizontalResize = () => {
      if (!viewportNode.isConnected || viewportNode.clientWidth <= 0) {
        wasHorizontalHiddenRef.current = true;
        return;
      }
      const maximum = Math.max(0, viewportNode.scrollWidth - viewportNode.clientWidth);
      if (maximum <= 0) {
        wasHorizontalHiddenRef.current = false;
        preservedScrollLeftRef.current = 0;
      } else if ((wasHorizontalHiddenRef.current || viewportNode.scrollLeft === 0) && preservedScrollLeftRef.current > 0) {
        wasHorizontalHiddenRef.current = false;
        viewportNode.scrollLeft = Math.min(preservedScrollLeftRef.current, maximum);
        preservedScrollLeftRef.current = viewportNode.scrollLeft;
      } else {
        wasHorizontalHiddenRef.current = false;
        preservedScrollLeftRef.current = viewportNode.scrollLeft;
      }
      updateMetrics();
    };
    const observer = new ResizeObserver(handleHorizontalResize);
    observer.observe(viewportNode);
    observer.observe(contentNode);
    viewportNode.addEventListener("scroll", handleHorizontalScroll, { passive: true });
    handleHorizontalResize();
    return () => {
      wasHorizontalHiddenRef.current = true;
      observer.disconnect();
      viewportNode.removeEventListener("scroll", handleHorizontalScroll);
    };
  }, [horizontal]);
  const moveHorizontal = (clientX: number, thumbOffset: number) => {
    const viewportNode = viewport.current;
    const trackNode = track.current;
    if (!viewportNode || !trackNode) return;
    const rect = trackNode.getBoundingClientRect();
    const maximum = viewportNode.scrollWidth - viewportNode.clientWidth;
    const maximumThumb = rect.width - metrics.width;
    if (maximum <= 0 || maximumThumb <= 0) return;
    viewportNode.scrollLeft = Math.max(0, Math.min(maximumThumb, clientX - rect.left - thumbOffset)) / maximumThumb * maximum;
  };
  return <div className={[styles.root, horizontal && styles.horizontal, className].filter(Boolean).join(" ")}>
    <ScrollArea className={styles.scrollArea} viewportClassName={[horizontal && styles.horizontalViewport, viewportClassName].filter(Boolean).join(" ")} contentClassName={contentClassName} viewportRef={setViewportRef} contentRef={content} scrollbarSize={7} scrollbarInsetTop={scrollbarInsetTop} scrollbarVisibility={alwaysShowVertical ? "always" : "auto"}>{children}</ScrollArea>
    {horizontal && <div
      ref={track}
      className={[styles.horizontalTrack, metrics.visible && styles.visible].filter(Boolean).join(" ")}
      onPointerDown={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        moveHorizontal(event.clientX, metrics.width / 2);
      }}
    ><div
      className={styles.horizontalThumb}
      style={{ width: metrics.width, transform: `translateX(${metrics.left}px)` }}
      onPointerDown={(event) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        horizontalDragOffset.current = event.clientX - event.currentTarget.getBoundingClientRect().left;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (horizontalDragOffset.current === null || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        event.preventDefault();
        moveHorizontal(event.clientX, horizontalDragOffset.current);
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        horizontalDragOffset.current = null;
      }}
      onPointerCancel={() => { horizontalDragOffset.current = null; }}
      onLostPointerCapture={() => { horizontalDragOffset.current = null; }}
    /></div>}
  </div>;
}
