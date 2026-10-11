import { useEffect, useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

export interface DialogProps {
  open: boolean;
  /** Already translated. */
  title: string;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
}

/** Modal dialog; Escape and the backdrop close it. */
export function Dialog({ open, title, onClose, children, footer }: DialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="dialog__header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" aria-label={t("common:actions.close")} onClick={onClose}>
            ×
          </button>
        </header>
        <div className="dialog__body">{children}</div>
        {footer && <footer className="dialog__footer">{footer}</footer>}
      </div>
    </div>
  );
}
