// The one behaviour every popup menu shares (table context menu, cluster menu, namespace filter): a click outside
// closes it, and Escape closes it — only it. The Escape is taken in the capture phase and stopped there, so
// window-level Escape handlers (the details panel closes on Escape) do not also fire while a popup is open. When the
// popup closes with the focus inside it (or lost with it), the focus goes back to what opened it (#158).
import { useEffect, useRef, type RefObject } from "react";
import { openerOf, popupClosed, resolveOpener } from "./useFocusTrap";

/** Closes the popup in `ref` on a click outside it or on Escape, while `open`. */
export function usePopup(ref: RefObject<HTMLElement | null>, onClose: () => void, open = true): void {
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    const popup = ref.current;
    const opener = popup ? openerOf(popup) : null;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close.current();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
      // A dialog opened from the popup (a menu item) may take the focus first; it gives it back here later.
      if (popup) popupClosed(popup, opener);
      const now = document.activeElement;
      const lost = !now || now === document.body || (popup?.contains(now) ?? false);
      if (lost) resolveOpener(opener)?.focus({ preventScroll: true });
    };
  }, [ref, open]);
}
