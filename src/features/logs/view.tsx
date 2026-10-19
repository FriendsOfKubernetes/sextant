// Pieces shared by the one-pod and the several-pod logs tabs: the "Lines" and "Colours" toolbar controls, and
// following the end of a virtual list whose rows may be measured (wrapped lines have their own heights).
import type { Virtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useRef, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox } from "../../components";
import type { LogView } from "./viewSettings";

/** How close to the end (px) still counts as "at the end" for following. */
export const BOTTOM_SLACK = 24;

const WRAP = "wrap";
const ONE_LINE = "oneLine";

/** The toolbar's "Lines" choice (wrapped / one line per entry) and the "Colours" switch. */
export function LogViewControls({ view }: { view: LogView }) {
  const { t } = useTranslation();
  return (
    <>
      <label className="logs__field">
        <span>{t("logs:toolbar.lines")}</span>
        <select
          aria-label={t("logs:toolbar.lines")}
          value={view.wrap ? WRAP : ONE_LINE}
          onChange={(e) => view.set({ wrap: e.target.value === WRAP })}
        >
          <option value={WRAP}>{t("logs:toolbar.wrap")}</option>
          <option value={ONE_LINE}>{t("logs:toolbar.oneLine")}</option>
        </select>
      </label>
      <label className="logs__check" title={t("logs:toolbar.coloursHint")}>
        <Checkbox checked={view.colours} onChange={(e) => view.set({ colours: e.target.checked })} />
        <span>{t("logs:toolbar.colours")}</span>
      </label>
    </>
  );
}

export interface FollowOptions {
  /** Keep the end in view while lines arrive (and the reader has not scrolled up). */
  follow: boolean;
  active: boolean;
  count: number;
  wrap: boolean;
  colours: boolean;
  /** Changes when the text starts over (a new stream or session): the measured heights are dropped. */
  generation?: unknown;
}

/**
 * Following the end of the list. `atBottom` turns off only when the reader scrolls up (or a caller sets it), never
 * because rows grew when measured; the list is scrolled to the end again whenever its height changes, so wrapped
 * rows measured after a scroll do not leave the newest lines below the fold. The measured heights are dropped when
 * wrapping or colours change (bold text is wider) and when the text starts over.
 */
export function useFollowScroll(
  virtualizer: Virtualizer<HTMLDivElement, Element>,
  scrollRef: RefObject<HTMLDivElement | null>,
  { follow, active, count, wrap, colours, generation }: FollowOptions,
) {
  const atBottom = useRef(true);
  const lastTop = useRef(0);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    if (el.scrollHeight - top - el.clientHeight <= BOTTOM_SLACK) atBottom.current = true;
    else if (top < lastTop.current) atBottom.current = false;
    lastTop.current = top;
  }, [scrollRef]);

  const restarted = count === 0;
  const first = useRef(true);
  useEffect(() => {
    // Nothing is measured before the first render.
    if (first.current) {
      first.current = false;
      return;
    }
    virtualizer.measure();
  }, [wrap, colours, generation, restarted, virtualizer]);

  const total = virtualizer.getTotalSize();
  useEffect(() => {
    if (count === 0) atBottom.current = true; // a fresh stream starts at the end
    if (follow && active && atBottom.current && count > 0) virtualizer.scrollToIndex(count - 1, { align: "end" });
  }, [follow, active, count, total, virtualizer]);

  return { atBottom, onScroll };
}
