// Keeps popup menus inside the window (#176, the namespace filter was #168). Every popup (row action menu, context
// menu, cluster menu, Columns menu, workspace switcher, namespace filter, snippets) is placed by one rule: it opens on
// its preferred side of the anchor (an element, or the pointer for a context menu); where there is no room it flips
// to the other side (leftwards, upwards); where neither side has room it is shifted by the overflow; and when it is
// taller than the window it gets a max-height and scrolls. 8 px stay free at every window edge. The popup is measured
// after it renders (a layout effect, before paint) and placed again on window resize, on scroll and when its own
// size changes while open.
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/** Free space kept between a popup and the window edge. */
export const POPUP_MARGIN = 8;

export interface PopupRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PopupPlacementOptions {
  /** Where the popup opens: under the anchor (menus) or beside it, to its right (the rail's menus). Default "below". */
  side?: "below" | "right";
  /** Which edge of the anchor the popup lines up with: its start (left / top) or end (right / bottom). Default "start". */
  align?: "start" | "end";
  /** Gap between the anchor and the popup. Default 0. */
  gap?: number;
  /** Free space at the window edges. Default `POPUP_MARGIN`. */
  margin?: number;
}

export interface PopupPositionOptions extends PopupPlacementOptions {
  /** Placed while true. Default true. */
  open?: boolean;
  /** A part of the window the popup must stay in (the main area); the window when absent or null. */
  bounds?: () => PopupRect | null;
}

export interface PopupPlacement {
  left: number;
  top: number;
  /** Set when the popup is taller than the room it has: it then scrolls. */
  maxHeight?: number;
  /** Set when the popup is wider than the window. */
  maxWidth?: number;
}

interface Size {
  width: number;
  height: number;
}

/** A point (the pointer of a context menu) as an anchor. */
export function pointRect(x: number, y: number): PopupRect {
  return { left: x, top: y, right: x, bottom: y };
}

/** The window as the area a popup must stay in. */
export function windowRect(): PopupRect {
  return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
}

/**
 * Along the axis the popup opens on: after the anchor if it fits, else before it, else shifted by the overflow (and
 * capped to the area when it is longer than the area).
 */
function mainAxis(before: number, after: number, size: number, lo: number, hi: number, gap: number) {
  // An anchor that is itself within the margin (a pointer at the very edge) still leaves the popup inside the area.
  if (after + gap + size <= hi) return { start: Math.max(lo, after + gap) };
  if (before - gap - size >= lo) return { start: Math.min(hi - size, before - gap - size) };
  if (size <= hi - lo) return { start: Math.max(lo, hi - size) };
  return { start: lo, max: Math.max(0, hi - lo) };
}

/** Across: lined up with the anchor's start (or end); flipped to the other edge, else shifted by the overflow. */
function crossAxis(start: number, end: number, size: number, lo: number, hi: number, align: "start" | "end") {
  const fits = (pos: number) => pos >= lo && pos + size <= hi;
  const [first, second] = align === "start" ? [start, end - size] : [end - size, start];
  if (fits(first)) return { start: first };
  if (fits(second)) return { start: second };
  if (size <= hi - lo) return { start: Math.min(Math.max(first, lo), hi - size) };
  return { start: lo, max: Math.max(0, hi - lo) };
}

/**
 * Where a popup of `size` goes for `anchor` inside `area` (the window, or a part of it), all in window coordinates.
 * `margin` stays free at every edge of the area.
 */
export function placePopup(
  anchor: PopupRect,
  size: Size,
  area: PopupRect,
  options: PopupPlacementOptions = {},
): PopupPlacement {
  const { side = "below", align = "start", gap = 0, margin = POPUP_MARGIN } = options;
  const left = area.left + margin;
  const right = area.right - margin;
  const top = area.top + margin;
  const bottom = area.bottom - margin;
  if (side === "below") {
    const v = mainAxis(anchor.top, anchor.bottom, size.height, top, bottom, gap);
    const h = crossAxis(anchor.left, anchor.right, size.width, left, right, align);
    return withLimits(h.start, v.start, v.max, h.max);
  }
  const h = mainAxis(anchor.left, anchor.right, size.width, left, right, gap);
  const v = crossAxis(anchor.top, anchor.bottom, size.height, top, bottom, align);
  return withLimits(h.start, v.start, v.max, h.max);
}

function withLimits(left: number, top: number, maxHeight?: number, maxWidth?: number): PopupPlacement {
  const placement: PopupPlacement = { left, top };
  if (maxHeight !== undefined) placement.maxHeight = maxHeight;
  if (maxWidth !== undefined) placement.maxWidth = maxWidth;
  return placement;
}

/** The part of `a` inside `b` (`a` itself when they do not overlap). */
function intersect(a: PopupRect, b: PopupRect): PopupRect {
  const r = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
  return r.left < r.right && r.top < r.bottom ? r : a;
}

/** The anchor: an element (the button that opened the popup) or a fixed rectangle / point. */
export type PopupAnchor = RefObject<HTMLElement | null> | PopupRect;

function anchorRect(anchor: PopupAnchor): PopupRect | null {
  if ("current" in anchor) {
    const el = anchor.current;
    return el ? el.getBoundingClientRect() : null;
  }
  return anchor;
}

/**
 * Places the popup in `ref` next to `anchor` while `open` (see `placePopup`). The popup becomes `position: fixed`; its
 * CSS keeps everything else (looks, a CSS max-height that is smaller than the window).
 */
export function usePopupPosition(
  ref: RefObject<HTMLElement | null>,
  anchor: PopupAnchor,
  options: PopupPositionOptions = {},
): void {
  const { open = true, bounds, ...placement } = options;
  const latest = useRef({ anchor, placement, bounds });
  latest.current = { anchor, placement, bounds };

  const place = useRef(() => {
    const popup = ref.current;
    if (!popup) return;
    const rect = anchorRect(latest.current.anchor);
    if (!rect) return;
    const view = windowRect();
    const within = latest.current.bounds?.();
    const area = within ? intersect(view, within) : view;
    const margin = latest.current.placement.margin ?? POPUP_MARGIN;
    const style = popup.style;
    const scrolled = popup.scrollTop;
    // Measure the popup as its CSS lays it out (no limits of an earlier pass), at most as wide as the window.
    style.position = "fixed";
    style.right = "auto";
    style.bottom = "auto";
    style.maxHeight = "";
    style.overflowY = "";
    style.maxWidth = `${Math.max(0, area.right - area.left - 2 * margin)}px`;
    const own = popup.getBoundingClientRect();
    const at = placePopup(rect, { width: own.width, height: own.height }, area, latest.current.placement);
    style.left = `${at.left}px`;
    style.top = `${at.top}px`;
    if (at.maxHeight !== undefined) {
      style.maxHeight = `${at.maxHeight}px`;
      style.overflowY = "auto";
    }
    // An ancestor with a transform (a sliding-in panel) moves fixed boxes too: correct by what it added.
    const placed = popup.getBoundingClientRect();
    const dx = placed.left - at.left;
    const dy = placed.top - at.top;
    if (dx !== 0 || dy !== 0) {
      style.left = `${at.left - dx}px`;
      style.top = `${at.top - dy}px`;
    }
    if (scrolled) popup.scrollTop = scrolled;
  });

  // Every render: the content (and with it the size) may have changed.
  useLayoutEffect(() => {
    if (open) place.current();
  });

  useEffect(() => {
    if (!open) return;
    const again = () => place.current();
    // Scrolling the popup's own list does not move it.
    const onScroll = (e: Event) => {
      if (!(e.target instanceof Node && ref.current?.contains(e.target))) again();
    };
    window.addEventListener("resize", again);
    window.addEventListener("scroll", onScroll, true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(again);
    if (observer && ref.current) observer.observe(ref.current);
    return () => {
      window.removeEventListener("resize", again);
      window.removeEventListener("scroll", onScroll, true);
      observer?.disconnect();
    };
  }, [ref, open]);
}
