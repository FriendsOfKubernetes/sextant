import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { errorKey, toApiError, type CoreError } from "../api";

export interface ErrorStateProps {
  /** An `ApiError`, a `CoreError` or anything thrown. */
  error: unknown;
  /** Replaces the generic text for the code, e.g. a table's "You don't have permission to list Secrets". */
  title?: string;
  onRetry?: () => void;
  /** More buttons shown next to Retry, e.g. the editor's "Reload". */
  actions?: ReactNode;
  /** Extra class for the container (a compact variant inside a form or dialog). */
  className?: string;
}

/** Shows the translated text for the error code (`errors:<code>`) and the original message. */
export function ErrorState({ error, title, onRetry, actions, className }: ErrorStateProps) {
  const { t } = useTranslation();
  const err: CoreError = toApiError(error).toCoreError();
  return (
    <div className={className ? `error-state ${className}` : "error-state"} role="alert" data-code={err.code}>
      <div className="error-state__title">{title ?? t(errorKey(err.code))}</div>
      {err.message && <div className="error-state__message">{t("common:error.details", { message: err.message })}</div>}
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          {t("common:actions.retry")}
        </button>
      )}
      {actions}
    </div>
  );
}
