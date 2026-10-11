// Dialogs the actions open. Nothing reaches the cluster before the user presses the confirm button; a refusal
// (403, 409, 422, a disruption budget…) is shown inside the dialog with the translated text for its code and the
// server's own message.
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, type ApiError, type ClusterId, type KindRef, type ObjectRef } from "../../api";
import { useAppStore } from "../../app/store";
import { Dialog, ErrorState } from "../../components";

/** "demo/web" for a namespaced object, "node-1" otherwise. */
export function displayName(r: ObjectRef): string {
  return r.namespace ? `${r.namespace}/${r.name}` : r.name;
}

export interface ConfirmActionProps {
  /** Translated texts. */
  title: string;
  confirmLabel: string;
  danger?: boolean;
  close: () => void;
  /** What is about to happen. */
  children?: ReactNode;
  /** Runs on confirm. Resolving to a text keeps the dialog open to show it; otherwise the dialog closes. */
  onConfirm: () => Promise<string | void>;
  /** Replaces the generic title of an error (translated); `undefined` keeps the text for the error code. */
  errorTitle?: (error: ApiError) => string | undefined;
  /** False disables the confirm button (e.g. invalid input). */
  canConfirm?: boolean;
}

/** A confirmation dialog that runs the action, shows its progress and keeps itself open on failure. */
export function ConfirmAction({
  title,
  confirmLabel,
  danger,
  close,
  children,
  onConfirm,
  errorTitle,
  canConfirm = true,
}: ConfirmActionProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const text = await onConfirm();
      if (typeof text === "string") setResult(text);
      else close();
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const footer = result ? (
    <button type="button" className="btn btn--primary" onClick={close}>
      {t("actions:dialog.close")}
    </button>
  ) : (
    <>
      <button type="button" className="btn" onClick={close}>
        {t("common:actions.cancel")}
      </button>
      <button
        type="button"
        className={danger ? "btn btn--danger" : "btn btn--primary"}
        disabled={busy || !canConfirm}
        onClick={() => void confirm()}
      >
        {busy ? t("actions:dialog.working") : confirmLabel}
      </button>
    </>
  );

  return (
    <Dialog open title={title} onClose={close} footer={footer}>
      {result ? <p className="action-dialog__result">{result}</p> : children}
      {error && <ErrorState error={error} title={errorTitle?.(error)} />}
    </Dialog>
  );
}

interface Failure {
  ref: ObjectRef;
  error: ApiError;
}

/** Lists every object to delete; deletes them one by one after confirmation and reports each failure. */
export function DeleteDialog({
  clusterId,
  kind,
  refs,
  close,
}: {
  clusterId: ClusterId;
  kind: KindRef;
  refs: ObjectRef[];
  close: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<Failure[] | null>(null);
  const count = refs.length;

  const confirm = async () => {
    setBusy(true);
    const failed: Failure[] = [];
    const deleted: ObjectRef[] = [];
    for (const ref of refs) {
      try {
        await api.resources.delete(clusterId, ref);
        deleted.push(ref);
      } catch (err) {
        failed.push({ ref, error: toApiError(err) });
      }
    }
    closeDetailsOf(deleted);
    setBusy(false);
    if (failed.length === 0) close();
    else setFailures(failed);
  };

  if (failures) {
    return (
      <Dialog
        open
        title={t("actions:delete.title", { count, kind: kind.kind })}
        onClose={close}
        footer={
          <button type="button" className="btn btn--primary" onClick={close}>
            {t("actions:dialog.close")}
          </button>
        }
      >
        <p>{t("actions:delete.partial", { done: count - failures.length, total: count })}</p>
        {failures.map(({ ref, error }) => (
          <ErrorState
            key={displayName(ref)}
            error={error}
            title={`${t("actions:delete.failed", { name: displayName(ref) })} — ${t(`errors:${error.code}`)}`}
          />
        ))}
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      title={t("actions:delete.title", { count, kind: kind.kind })}
      onClose={close}
      footer={
        <>
          <button type="button" className="btn" onClick={close}>
            {t("common:actions.cancel")}
          </button>
          <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void confirm()}>
            {busy ? t("actions:dialog.working") : t("actions:delete.confirm")}
          </button>
        </>
      }
    >
      <p>{t("actions:delete.text", { count, kind: kind.kind })}</p>
      <ul className="action-dialog__names">
        {refs.map((ref) => (
          <li key={displayName(ref)}>{displayName(ref)}</li>
        ))}
      </ul>
    </Dialog>
  );
}

/** The details panel must not keep showing an object that is gone. */
function closeDetailsOf(deleted: ObjectRef[]): void {
  const { details, closeDetails } = useAppStore.getState();
  if (!details) return;
  const same = (r: ObjectRef) =>
    r.name === details.name &&
    (r.namespace ?? null) === (details.namespace ?? null) &&
    r.kind.group === details.kind.group &&
    r.kind.kind === details.kind.kind;
  if (deleted.some(same)) closeDetails();
}

/** Asks for the new number of replicas, starting from `current`. */
export function ScaleDialog({
  clusterId,
  ref,
  current,
  close,
}: {
  clusterId: ClusterId;
  ref: ObjectRef;
  current: number;
  close: () => void;
}) {
  const { t } = useTranslation();
  const inputId = useId();
  const [value, setValue] = useState(String(current));
  const valid = /^\d+$/.test(value.trim()) && Number(value) <= 2_147_483_647;

  return (
    <ConfirmAction
      title={t("actions:scale.title", { kind: ref.kind.kind, name: ref.name })}
      confirmLabel={t("actions:scale.confirm")}
      close={close}
      canConfirm={valid}
      onConfirm={() => api.actions.scale(clusterId, ref, Number(value))}
    >
      <div className="action-dialog__field">
        <label htmlFor={inputId}>{t("actions:scale.replicas")}</label>
        <input
          id={inputId}
          type="number"
          min={0}
          step={1}
          value={value}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
        />
        <span className="action-dialog__hint">
          {valid ? t("actions:scale.current", { count: current }) : t("actions:scale.invalid")}
        </span>
      </div>
    </ConfirmAction>
  );
}
