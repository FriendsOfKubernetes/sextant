// "Rename context…", "Set default namespace…", "Duplicate with namespace…", "Delete context…" from the cluster menu:
// the form, then the preview of the change in the file, then "Write to the file". Nothing is written before that click;
// a file that changed after the preview is refused by the backend (`conflict`) and previewed again.
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, type ApiError, type ClusterInfo, type EditPreview, type KubeconfigEdit } from "../../../api";
import { Button, Dialog } from "../../../components";
import { openSettings } from "../../settings/store";
import { SourceError } from "../AddClusterDialog";
import { applyKubeconfigEdit, closeContextEdit, useContextEditStore, type ContextEditKind } from "./apply";
import { PreviewView } from "./Preview";

const TITLES: Record<ContextEditKind, string> = {
  rename: "kubeconfig:edit.renameTitle",
  namespace: "kubeconfig:edit.namespaceTitle",
  duplicate: "kubeconfig:edit.duplicateTitle",
  delete: "kubeconfig:edit.deleteTitle",
};

/** The change the form describes; `null` while it is incomplete. */
export function editOf(kind: ContextEditKind, cluster: ClusterInfo, name: string, namespace: string): KubeconfigEdit | null {
  const clusterId = cluster.id;
  switch (kind) {
    case "rename":
      return name.trim() ? { type: "renameContext", clusterId, newName: name.trim() } : null;
    case "namespace":
      return { type: "setNamespace", clusterId, namespace: namespace.trim() || null };
    case "duplicate":
      return name.trim() && namespace.trim()
        ? { type: "duplicateContext", clusterId, newName: name.trim(), namespace: namespace.trim() }
        : null;
    case "delete":
      return { type: "deleteContext", clusterId };
  }
}

/** An error of a kubeconfig change; "not allowed" also offers the settings where it is allowed. */
export function EditError({ error }: { error: ApiError }) {
  const { t } = useTranslation();
  if (error.code === "denied") {
    return (
      <div className="kc-error" role="alert">
        <p>{t("kubeconfig:edit.notWritable")}</p>
        <Button size="compact" onClick={() => openSettings({ tab: "clusters" })}>
          {t("kubeconfig:edit.openSettings")}
        </Button>
      </div>
    );
  }
  if (error.code === "conflict") {
    return (
      <p className="kc-error" role="alert">
        {t("kubeconfig:edit.conflict")}
      </p>
    );
  }
  return <SourceError error={error} />;
}

export function ContextEditDialog() {
  const request = useContextEditStore((s) => s.request);
  if (!request) return null;
  return <EditForm key={`${request.kind}:${request.cluster.id}`} kind={request.kind} cluster={request.cluster} />;
}

function EditForm({ kind, cluster }: { kind: ContextEditKind; cluster: ClusterInfo }) {
  const { t } = useTranslation();
  const nameId = useId();
  const nsId = useId();
  const [name, setName] = useState(kind === "duplicate" ? `${cluster.context}-copy` : cluster.context);
  const [namespace, setNamespace] = useState(cluster.namespace ?? "");
  const [preview, setPreview] = useState<EditPreview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const edit = editOf(kind, cluster, name, namespace);

  // A change of the form drops the preview: what is written is always what was shown.
  useEffect(() => setPreview(null), [name, namespace]);

  const runPreview = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      setPreview(await api.kubeconfig.editPreview(edit));
      setError(null);
    } catch (err) {
      setPreview(null);
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const write = async () => {
    if (!edit || !preview) return;
    setBusy(true);
    try {
      const outcome = await applyKubeconfigEdit(edit, preview.base);
      setError(null);
      setDone(
        outcome.backupPath
          ? t("kubeconfig:edit.written", { path: outcome.backupPath })
          : t("kubeconfig:edit.writtenNew"),
      );
    } catch (err) {
      const e = toApiError(err);
      setError(e);
      if (e.code === "conflict") {
        // The file changed: show the change as it would be now.
        setPreview(await api.kubeconfig.editPreview(edit).catch(() => null));
      }
    } finally {
      setBusy(false);
    }
  };

  const footer = done ? (
    <Button variant="primary" onClick={closeContextEdit}>
      {t("common:actions.close")}
    </Button>
  ) : (
    <>
      <Button onClick={closeContextEdit}>{t("common:actions.cancel")}</Button>
      {preview && !preview.unchanged ? (
        <Button variant={kind === "delete" ? "danger" : "primary"} disabled={busy} onClick={() => void write()}>
          {t("kubeconfig:edit.apply")}
        </Button>
      ) : (
        <Button variant="primary" disabled={busy || !edit} onClick={() => void runPreview()}>
          {t("kubeconfig:edit.preview")}
        </Button>
      )}
    </>
  );

  return (
    <Dialog open title={t(TITLES[kind])} onClose={closeContextEdit} footer={footer}>
      {done ? (
        <div role="status">
          <p>{done}</p>
          {preview && (preview.renamed.length > 0 || preview.removed.length > 0) && (
            <p className="clusters-hint">{t("kubeconfig:edit.disconnected")}</p>
          )}
        </div>
      ) : (
        <form
          className="kc-form"
          onSubmit={(e) => {
            e.preventDefault();
            void (preview && !preview.unchanged ? write() : runPreview());
          }}
        >
          {kind === "delete" && <p>{t("kubeconfig:edit.deleteHint", { context: cluster.context })}</p>}
          {(kind === "rename" || kind === "duplicate") && (
            <div className="kc-form__field">
              <label htmlFor={nameId}>{t("kubeconfig:edit.newName")}</label>
              <input
                id={nameId}
                className="settings__input"
                value={name}
                spellCheck={false}
                autoFocus
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          )}
          {(kind === "namespace" || kind === "duplicate") && (
            <div className="kc-form__field">
              <label htmlFor={nsId}>{t("kubeconfig:edit.namespace")}</label>
              <input
                id={nsId}
                className="settings__input"
                value={namespace}
                spellCheck={false}
                autoFocus={kind === "namespace"}
                onChange={(e) => setNamespace(e.target.value)}
              />
              {kind === "namespace" && <p className="clusters-hint">{t("kubeconfig:edit.namespaceHint")}</p>}
            </div>
          )}
        </form>
      )}
      {!done && preview && <PreviewView preview={preview} />}
      {error && <EditError error={error} />}
    </Dialog>
  );
}
