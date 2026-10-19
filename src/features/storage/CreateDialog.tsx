// The two steps every storage action takes (#152): the form, then a confirmation that lists the one object to be
// created — kind, namespace, name, the fields that matter and its YAML — and creates exactly that with one POST
// (`resource_create`). An object of that name that already exists is never touched: the API server refuses the
// create (AlreadyExists), atomically. Nothing reaches the cluster before "Create" is pressed; a failure stays in
// the dialog and nothing is repeated.
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError, toApiError, type ClusterId, type KubeObject } from "../../api";
import { Button, Dialog, ErrorState } from "../../components";
import { toYaml } from "../details";

/** "VolumeSnapshot db/data-0-20261019-1432". */
export function describeObject(obj: KubeObject): string {
  const ns = obj.metadata?.namespace;
  return `${obj.kind ?? ""} ${ns ? `${ns}/` : ""}${obj.metadata?.name ?? ""}`;
}

/**
 * Creates `obj` with one POST (`resource_create`) and resolves to its description. An object of that name that
 * exists already — also one that appeared after the form was filled — makes the API server answer AlreadyExists
 * (`conflict`) and stays untouched; the error then names it. Never repeated.
 */
export async function createObject(clusterId: ClusterId, obj: KubeObject, exists: (what: string) => string): Promise<string> {
  try {
    await api.storage.create(clusterId, toYaml(obj));
  } catch (err) {
    const error = toApiError(err);
    if (error.code === "conflict") throw new ApiError("conflict", exists(describeObject(obj)));
    throw error;
  }
  return describeObject(obj);
}

export interface CreateDialogProps {
  clusterId: ClusterId;
  title: string;
  close: () => void;
  /** The form's fields. */
  form: ReactNode;
  /** The object the fields build; `null` while they are not valid. */
  object: KubeObject | null;
  /** What the confirmation says about the object (the fields that matter), above its YAML. */
  summary?: ReactNode;
  /** A warning shown on the confirmation (what the change does beyond the object). */
  note?: ReactNode;
}

export function CreateDialog({ clusterId, title, close, form, object, summary, note }: CreateDialogProps) {
  const { t } = useTranslation();
  /** The object being confirmed: frozen when "Review" is pressed, so what is listed is what is created. */
  const [confirming, setConfirming] = useState<KubeObject | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  const create = async (obj: KubeObject) => {
    setBusy(true);
    setError(null);
    try {
      const what = await createObject(clusterId, obj, (described) => t("storage:create.exists", { object: described }));
      setCreated(what);
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <Dialog
        open
        title={title}
        onClose={close}
        footer={
          <Button variant="primary" onClick={close}>
            {t("actions:dialog.close")}
          </Button>
        }
      >
        <p className="action-dialog__result" role="status">
          {t("storage:create.done", { object: created })}
        </p>
      </Dialog>
    );
  }

  if (confirming) {
    return (
      <Dialog
        open
        title={title}
        onClose={close}
        footer={
          <>
            <Button disabled={busy} onClick={() => (setConfirming(null), setError(null))}>
              {t("storage:create.back")}
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void create(confirming)}>
              {busy ? t("actions:dialog.working") : t("storage:create.confirm")}
            </Button>
          </>
        }
      >
        <p>{t("storage:create.willCreate")}</p>
        <ul className="action-dialog__names" aria-label={t("storage:create.objects")}>
          <li>{describeObject(confirming)}</li>
        </ul>
        {summary}
        {note && <p className="st-note">{note}</p>}
        <pre className="st-yaml" aria-label={t("storage:create.yaml")}>
          {toYaml(confirming)}
        </pre>
        {error && <ErrorState error={error} />}
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      title={title}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>{t("common:actions.cancel")}</Button>
          <Button variant="primary" disabled={!object} onClick={() => object && setConfirming(object)}>
            {t("storage:create.review")}
          </Button>
        </>
      }
    >
      <div className="st-form">{form}</div>
    </Dialog>
  );
}
