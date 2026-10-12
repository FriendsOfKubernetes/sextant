// Dialogs the actions open. Nothing reaches the cluster before the user presses the confirm button; a refusal
// (403, 409, 422, a disruption budget…) is shown inside the dialog with the translated text for its code and the
// server's own message.
import { useEffect, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  api,
  toApiError,
  type ApiError,
  type ClusterId,
  type DrainPreview,
  type KindRef,
  type ObjectRef,
  type PodRef,
} from "../../api";
import { useAppStore } from "../../app/store";
import { Dialog, ErrorState } from "../../components";
import { Checkbox } from "../../components/Table";

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

/**
 * Lists every object to delete; deletes them one by one after confirmation and reports each failure. Once started,
 * the deletion runs to the end.
 */
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

  // Deleting cannot be cancelled halfway: while it runs, Cancel is disabled and Escape / × / the backdrop do nothing,
  // so the dialog always ends with the full result (closed, or the list of what was not deleted).
  const closeUnlessBusy = () => {
    if (!busy) close();
  };
  return (
    <Dialog
      open
      title={t("actions:delete.title", { count, kind: kind.kind })}
      onClose={closeUnlessBusy}
      footer={
        <>
          <button type="button" className="btn" disabled={busy} onClick={close}>
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

/** One list of pods in the drain dialog, named by its heading. */
function PodList({ title, pods, children }: { title: string; pods: PodRef[]; children?: ReactNode }) {
  const headingId = useId();
  if (pods.length === 0) return null;
  return (
    <div className="drain-group">
      <h3 id={headingId} className="drain-group__title">
        {title}
      </h3>
      <ul className="action-dialog__names" aria-labelledby={headingId}>
        {pods.map((pod) => (
          <li key={`${pod.namespace}/${pod.name}`}>{`${pod.namespace}/${pod.name}`}</li>
        ))}
      </ul>
      {children}
    </div>
  );
}

/**
 * Drain like `kubectl drain`: first the pods of the node (`node_drain_preview`), then the drain with the options the
 * user ticked. Pods without a controller and pods with emptyDir data are evicted only with their option ticked (both
 * off by default); without it they stay on the node and the drain reports them. Nothing can be drained before the
 * list of pods is shown.
 */
export function DrainDialog({ clusterId, node, close }: { clusterId: ClusterId; node: string; close: () => void }) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<DrainPreview | null>(null);
  const [previewError, setPreviewError] = useState<ApiError | null>(null);
  const [force, setForce] = useState(false);
  const [deleteEmptyDirData, setDeleteEmptyDirData] = useState(false);

  useEffect(() => {
    let current = true;
    api.actions.drainPreview(clusterId, node).then(
      (result) => {
        if (current) setPreview(result);
      },
      (err: unknown) => {
        if (current) setPreviewError(toApiError(err));
      },
    );
    return () => {
      current = false;
    };
  }, [clusterId, node]);

  let content: ReactNode;
  if (previewError) {
    content = <ErrorState error={previewError} title={t("actions:drain.previewFailed")} />;
  } else if (!preview) {
    content = (
      <p className="action-dialog__hint" role="status">
        {t("actions:drain.loading")}
      </p>
    );
  } else {
    const nothing =
      preview.evict.length + preview.unmanaged.length + preview.emptyDir.length + preview.daemonSet.length === 0;
    content = (
      <>
        {nothing && <p className="action-dialog__hint">{t("actions:drain.noPods")}</p>}
        <PodList title={t("actions:drain.evict", { count: preview.evict.length })} pods={preview.evict} />
        <PodList title={t("actions:drain.unmanaged", { count: preview.unmanaged.length })} pods={preview.unmanaged}>
          <label className="drain-group__option">
            <Checkbox checked={force} onChange={(e) => setForce(e.target.checked)} />
            {t("actions:drain.force")}
          </label>
        </PodList>
        <PodList title={t("actions:drain.emptyDir", { count: preview.emptyDir.length })} pods={preview.emptyDir}>
          <label className="drain-group__option">
            <Checkbox checked={deleteEmptyDirData} onChange={(e) => setDeleteEmptyDirData(e.target.checked)} />
            {t("actions:drain.deleteEmptyDirData")}
          </label>
        </PodList>
        <PodList title={t("actions:drain.daemonSet", { count: preview.daemonSet.length })} pods={preview.daemonSet} />
      </>
    );
  }

  return (
    <ConfirmAction
      danger
      title={t("actions:drain.title", { name: node })}
      confirmLabel={t("actions:drain.confirm")}
      // Pods the node kept (a disruption budget, an option not ticked…) get their own title; a refused cordon (403)
      // keeps the generic text for its code.
      errorTitle={(error) => (error.message.includes("could not be evicted") ? t("actions:drain.failed") : undefined)}
      close={close}
      canConfirm={preview !== null}
      onConfirm={() => api.actions.drain(clusterId, node, { force, deleteEmptyDirData })}
    >
      <p>{t("actions:drain.text", { name: node })}</p>
      {content}
    </ConfirmAction>
  );
}
