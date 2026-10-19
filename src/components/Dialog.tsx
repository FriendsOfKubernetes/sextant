import { useEffect, useId, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./icons";
import { isTopModal, useFocusTrap } from "./useFocusTrap";

export interface DialogProps {
  open: boolean;
  /** Already translated. */
  title: string;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
}

/**
 * Modal dialog; Escape and the backdrop close it. The focus goes in when it opens (an element with `data-autofocus`,
 * else the first field, else the first footer button), stays in it (Tab cycles) and returns to the opener on close.
 */
export function Dialog({ open, title, onClose, children, footer }: DialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Only the modal on top closes (a confirmation opened from this dialog takes Escape for itself).
      if (e.key === "Escape" && isTopModal(dialogRef.current)) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="dialog__header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" aria-label={t("common:actions.close")} onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="dialog__body">{children}</div>
        {footer && <footer className="dialog__footer">{footer}</footer>}
      </div>
    </div>
  );
}
