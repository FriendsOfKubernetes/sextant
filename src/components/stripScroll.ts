// A strip that scrolls sideways (a row of tabs) without a scrollbar: GTK draws its overlay scrollbar across the tab
// labels, so the strips hide it (`scrollbar-width: none` and `::-webkit-scrollbar` in their CSS) and stay scrollable
// another way: the mouse wheel scrolls them sideways, the selected tab is brought into view, and `data-fade`
// ("start" | "end" | "both", absent without overflow) tells the CSS which edge has more tabs behind it.
import { useEffect, type RefObject } from "react";

/** Room kept beside a revealed tab, so it is not under the fade of the edge. */
const EDGE = 24;
/** Pixels per wheel line (`deltaMode` 1), as browsers scroll a line. */
const LINE = 16;

/** Marks which edges of `strip` have content scrolled out of sight (`data-fade`). */
function markFade(strip: HTMLElement): void {
  const max = strip.scrollWidth - strip.clientWidth;
  const start = strip.scrollLeft > 1;
  const end = max - strip.scrollLeft > 1;
  const fade = start && end ? "both" : start ? "start" : end ? "end" : null;
  if (fade) strip.dataset.fade = fade;
  else delete strip.dataset.fade;
}

/** Scrolls `strip` (only it, not the page) so the range from `first` to `last` (default `first`) is in view. */
export function revealInStrip(strip: HTMLElement | null, first: HTMLElement | null | undefined, last?: HTMLElement | null): void {
  if (!strip || !first) return;
  const box = strip.getBoundingClientRect();
  const left = first.getBoundingClientRect().left - box.left + strip.scrollLeft;
  const right = (last ?? first).getBoundingClientRect().right - box.left + strip.scrollLeft;
  const view = strip.clientWidth;
  if (left - EDGE < strip.scrollLeft) strip.scrollLeft = Math.max(0, left - EDGE);
  else if (right + EDGE > strip.scrollLeft + view) strip.scrollLeft = Math.min(left - EDGE, right + EDGE - view);
  markFade(strip);
}

/** Wheel and fade handling of a sideways-scrolling strip; `deps` re-check the overflow (tabs added or removed). */
export function useStripScroll(ref: RefObject<HTMLElement | null>, deps: readonly unknown[] = []): void {
  useEffect(() => {
    const strip = ref.current;
    if (!strip) return;
    const onWheel = (event: WheelEvent) => {
      if (strip.scrollWidth <= strip.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const unit = event.deltaMode === 1 ? LINE : event.deltaMode === 2 ? strip.clientWidth : 1;
      const before = strip.scrollLeft;
      strip.scrollLeft = before + event.deltaY * unit;
      // Only a wheel that moved the strip is kept from scrolling what is around it.
      if (strip.scrollLeft !== before) event.preventDefault();
    };
    const onScroll = () => markFade(strip);
    strip.addEventListener("wheel", onWheel, { passive: false });
    strip.addEventListener("scroll", onScroll, { passive: true });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onScroll);
    resize?.observe(strip);
    if (strip.firstElementChild) resize?.observe(strip.firstElementChild);
    markFade(strip);
    return () => {
      strip.removeEventListener("wheel", onWheel);
      strip.removeEventListener("scroll", onScroll);
      resize?.disconnect();
    };
    // `deps` are the caller's: what changes the overflow (tabs added or removed).
  }, [ref, ...deps]);
}
