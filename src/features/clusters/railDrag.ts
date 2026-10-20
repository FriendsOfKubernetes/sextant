// Dragging a cluster to another place in the rail, with pointer events and pointer capture (not the HTML drag and
// drop API, which WebKitGTK handles unreliably).
//
// A press becomes a drag only after the pointer moved `DRAG_THRESHOLD_PX`, so a click still opens the cluster; the
// click that ends a drag (or a cancelled one) is ignored. While dragging, the gap the cluster would drop into is
// tracked from the items' boxes (`gap`: 0 = before the first item, n = after the last), the rail scrolls when the
// pointer is near its top or bottom edge, and Escape (or a lost capture) cancels without moving anything.
import { useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import type { ClusterId } from "../../api";

/** How far (px) the pointer moves before a press becomes a drag. */
export const DRAG_THRESHOLD_PX = 5;
/** Distance (px) from the scrolling rail's top or bottom edge at which it scrolls during a drag. */
export const EDGE_SCROLL_PX = 32;
/** Fastest auto-scroll, in px per frame (at the very edge). */
export const EDGE_SCROLL_MAX_STEP = 12;

/** How far to scroll the rail this frame for a pointer at `y` over a scroller spanning `top`–`bottom` (negative: up). */
export function edgeScrollStep(y: number, top: number, bottom: number): number {
  const fromTop = y - top;
  const fromBottom = bottom - y;
  if (fromTop < EDGE_SCROLL_PX) return -Math.ceil(EDGE_SCROLL_MAX_STEP * Math.min(1, (EDGE_SCROLL_PX - fromTop) / EDGE_SCROLL_PX));
  if (fromBottom < EDGE_SCROLL_PX)
    return Math.ceil(EDGE_SCROLL_MAX_STEP * Math.min(1, (EDGE_SCROLL_PX - fromBottom) / EDGE_SCROLL_PX));
  return 0;
}

/** The gap a pointer at `y` points to, from the vertical boxes of the items (in order). */
export function gapAt(y: number, boxes: readonly { top: number; height: number }[]): number {
  const index = boxes.findIndex((box) => y < box.top + box.height / 2);
  return index < 0 ? boxes.length : index;
}

/** The nearest ancestor of `el` that scrolls vertically. */
function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

export interface RailDragState {
  id: ClusterId;
  /** The gap the cluster would drop into. */
  gap: number;
}

interface Press {
  id: ClusterId;
  pointerId: number;
  target: HTMLElement;
  startX: number;
  startY: number;
  y: number;
  state: "pressed" | "dragging" | "cancelled";
  scroller: HTMLElement | null;
  frame: number;
}

export interface RailDrag {
  /** The cluster being dragged and where it would drop; `null` when nothing is dragged. */
  dragging: RailDragState | null;
  /** Pointer handlers of the item of cluster `id`. */
  handlers: (id: ClusterId) => {
    onPointerDown: (e: PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: PointerEvent<HTMLElement>) => void;
    onPointerUp: (e: PointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: PointerEvent<HTMLElement>) => void;
    onLostPointerCapture: (e: PointerEvent<HTMLElement>) => void;
  };
  /** `true` (once) for the click that ends a drag or a cancelled drag: the caller ignores it. */
  consumeClick: () => boolean;
}

/**
 * Drag to reorder the items (`<li>`s) of the list `listRef`; `onDrop(id, gap)` is called when a drag ends, with the gap
 * among the visible items (including the dragged one) at the pointer's height.
 */
export function useRailDrag(listRef: RefObject<HTMLElement | null>, onDrop: (id: ClusterId, gap: number) => void): RailDrag {
  const [dragging, setDragging] = useState<RailDragState | null>(null);
  const press = useRef<Press | null>(null);
  const ignoreClick = useRef(false);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  const boxes = () =>
    Array.from(listRef.current?.children ?? []).map((li) => {
      const rect = li.getBoundingClientRect();
      return { top: rect.top, height: rect.height };
    });

  const track = (p: Press) => {
    const gap = gapAt(p.y, boxes());
    setDragging((prev) => (prev && prev.id === p.id && prev.gap === gap ? prev : { id: p.id, gap }));
  };

  const scrollFrame = () => {
    const p = press.current;
    if (!p || p.state !== "dragging" || !p.scroller) return;
    const rect = p.scroller.getBoundingClientRect();
    const step = edgeScrollStep(p.y, rect.top, rect.bottom);
    p.frame = 0;
    if (step === 0) return;
    const before = p.scroller.scrollTop;
    p.scroller.scrollTop = before + step;
    if (p.scroller.scrollTop === before) return;
    track(p);
    p.frame = requestAnimationFrame(scrollFrame);
  };

  const finish = (p: Press, release: boolean) => {
    if (p.frame !== 0) cancelAnimationFrame(p.frame);
    p.frame = 0;
    if (release && p.target.hasPointerCapture?.(p.pointerId)) p.target.releasePointerCapture(p.pointerId);
    setDragging(null);
  };

  /** Ends a drag without moving anything. The capture stays until the release, whose click is then ignored. */
  const cancel = () => {
    const p = press.current;
    if (!p || p.state !== "dragging") return;
    p.state = "cancelled";
    finish(p, false);
  };

  // Escape cancels a drag (and nothing else hears that Escape). `cancel` only reads refs: the first one is enough.
  const isDragging = dragging !== null;
  useEffect(() => {
    if (!isDragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [isDragging]);

  useEffect(
    () => () => {
      const p = press.current;
      if (p && p.frame !== 0) cancelAnimationFrame(p.frame);
    },
    [],
  );

  const abandon = (pointerId: number) => {
    const p = press.current;
    if (!p || p.pointerId !== pointerId) return;
    press.current = null;
    finish(p, true);
  };

  const handlers = (id: ClusterId) => ({
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const target = e.currentTarget;
      target.setPointerCapture?.(e.pointerId);
      press.current = {
        id,
        pointerId: e.pointerId,
        target,
        startX: e.clientX,
        startY: e.clientY,
        y: e.clientY,
        state: "pressed",
        scroller: null,
        frame: 0,
      };
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const p = press.current;
      if (!p || p.pointerId !== e.pointerId || p.state === "cancelled") return;
      p.y = e.clientY;
      if (p.state === "pressed") {
        if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) < DRAG_THRESHOLD_PX) return;
        p.state = "dragging";
        p.scroller = scrollerOf(listRef.current);
      }
      e.preventDefault();
      track(p);
      if (p.frame === 0 && p.scroller && typeof requestAnimationFrame === "function") {
        p.frame = requestAnimationFrame(scrollFrame);
      }
    },
    onPointerUp: (e: PointerEvent<HTMLElement>) => {
      const p = press.current;
      if (!p || p.pointerId !== e.pointerId) return;
      press.current = null;
      if (p.state === "pressed") {
        finish(p, true);
        return;
      }
      ignoreClick.current = true;
      // The click of this release (if the browser sends one) comes in this task; a later click is the user's again.
      setTimeout(() => {
        ignoreClick.current = false;
      }, 0);
      if (p.state === "cancelled") {
        finish(p, true);
        return;
      }
      p.y = e.clientY;
      const gap = gapAt(p.y, boxes());
      finish(p, true);
      onDropRef.current(p.id, gap);
    },
    // The browser took the pointer away (a touch scroll, a lost capture; after a normal release `press` is already
    // gone): give up without moving anything.
    onPointerCancel: (e: PointerEvent<HTMLElement>) => abandon(e.pointerId),
    onLostPointerCapture: (e: PointerEvent<HTMLElement>) => abandon(e.pointerId),
  });

  const consumeClick = () => {
    if (!ignoreClick.current) return false;
    ignoreClick.current = false;
    return true;
  };

  return { dragging, handlers, consumeClick };
}
