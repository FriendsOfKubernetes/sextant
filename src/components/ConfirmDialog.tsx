import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "./Dialog";

export interface ConfirmDialogProps {
  open: boolean;
  /** Already translated. */
  title: string;
  /** What is about to happen, e.g. the list of objects to delete. */
  children?: ReactNode;
  /** Already translated; defaults to "Confirm". */
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Nothing happens until the user presses the confirm button. */
export function ConfirmDialog({ open, title, children, confirmLabel, danger, onConfirm, onCancel }: ConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            {t("common:actions.cancel")}
          </button>
          <button type="button" className={danger ? "btn btn--danger" : "btn btn--primary"} onClick={onConfirm}>
            {confirmLabel ?? t("common:actions.confirm")}
          </button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
