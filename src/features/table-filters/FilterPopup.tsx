import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePopup, usePopupPosition } from "../../components";
import type { PopupRect } from "../../components/placePopup";

export function FilterPopup({ anchor, title, onClose, children }: {
  anchor: PopupRect; title: string; onClose: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  usePopup(ref, onClose);
  usePopupPosition(ref, anchor, { gap: 4 });
  useEffect(() => {
    const popup = ref.current;
    (popup?.querySelector<HTMLElement>("[data-autofocus]") ?? popup?.querySelector<HTMLElement>("input, select") ?? popup?.querySelector<HTMLElement>("button"))?.focus();
  }, []);
  return createPortal(<div ref={ref} className="tf-popup" role="dialog" aria-label={title}>{children}</div>, document.body);
}
