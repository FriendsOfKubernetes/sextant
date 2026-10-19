// What a screen reader hears from a log view (#158). The view itself is `role="log"` with `aria-live="off"`: reading
// every line aloud would drown everything else. Instead, while the focus is in the log tab, this region says how many
// lines came, at most once every ANNOUNCE_EVERY_MS; the stream's state (connecting, ended) is in its own status.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export const ANNOUNCE_EVERY_MS = 15_000;
/** The live region is empty this long before each announcement. */
export const ANNOUNCE_GAP_MS = 100;

/** `total`: lines received so far (kept and dropped ones), so a full buffer still counts new lines. */
export function LogAnnouncer({ total }: { total: number }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLSpanElement>(null);
  const totalRef = useRef(total);
  totalRef.current = total;
  const said = useRef(total);
  const [text, setText] = useState("");

  useEffect(() => {
    let say: ReturnType<typeof setTimeout> | undefined;
    const timer = setInterval(() => {
      const now = totalRef.current;
      const fresh = now - said.current;
      said.current = now;
      const view = ref.current?.closest(".logs");
      const focused = view?.contains(document.activeElement) ?? false;
      // Emptied first, so the same text as last time ("1 new line") is a change and is read again.
      setText("");
      if (focused && fresh > 0) {
        const message = t("a11y:logs.newLines", { count: fresh });
        say = setTimeout(() => setText(message), ANNOUNCE_GAP_MS);
      }
    }, ANNOUNCE_EVERY_MS);
    return () => {
      clearInterval(timer);
      clearTimeout(say);
    };
  }, [t]);

  return (
    <span ref={ref} className="visually-hidden" aria-live="polite" data-testid="logs-announce">
      {text}
    </span>
  );
}
