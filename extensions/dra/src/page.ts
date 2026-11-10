// The "Devices" page of the section: every device the cluster's ResourceSlices publish, by node, with the claim that
// holds each one, and the totals — from a watch of every ResourceSlice (at most 500) and every ResourceClaim (at most
// 5000) while it shows, as the built-in page read them.
import type { Sextant } from "@sextant/extension-sdk";
import { flat } from "./dom";
import { Watches } from "./live";
import { PAGE_WATCHES, pageView } from "./views";

export function startPage(sextant: Sextant, root: HTMLElement): () => void {
  let stopped = false;
  let scheduled = false;
  root.classList.add("dra-page");
  const render = () => {
    if (stopped) return;
    const related = watches.want(PAGE_WATCHES);
    root.replaceChildren(...flat(pageView(sextant, related.slices, related.claims)));
  };
  const schedule = () => {
    if (scheduled || stopped) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      render();
    });
  };
  const watches = new Watches(sextant, schedule);
  render();
  return () => {
    stopped = true;
    watches.stop();
  };
}
