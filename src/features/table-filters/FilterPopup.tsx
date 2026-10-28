import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { isTopModal, useFocusTrap, usePopupPosition } from "../../components";
import type { PopupRect } from "../../components/placePopup";

/** Marks the "Filters" button: a press on it while the popup is open closes it (its click), not close-and-reopen. */
export const FILTER_TOGGLE_ATTRIBUTE = "data-tf-toggle";

/**
 * A filter editor beside the table, on the modal stack (ADR-0092): Tab stays inside, Escape and a press outside close
 * it only while it is the top modal, so a dialog opened over it keeps its own Escape. Focus goes back to the opener.
 */
export function FilterPopup({ anchor, title, onClose, children }: {
  anchor: PopupRect; title: string; onClose: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useFocusTrap(ref, true);
  usePopupPosition(ref, anchor, { gap: 4 });
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const popup = ref.current;
      const target = e.target as Element | null;
      if (!popup || !isTopModal(popup) || popup.contains(target)) return;
      if (target?.closest?.(`[${FILTER_TOGGLE_ATTRIBUTE}]`)) return;
      close.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || !isTopModal(ref.current)) return;
      e.preventDefault();
      close.current();
    };
    window.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  return createPortal(<div ref={ref} className="tf-popup" role="dialog" aria-label={title} tabIndex={-1}>{children}</div>, document.body);
}
