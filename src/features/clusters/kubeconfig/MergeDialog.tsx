// "Merge files…": kubeconfig files the user chooses are copied into Sextant's own `merged.yaml` (a new source on the
// first merge). The preview lists every entry and the names given to taken ones; the chosen files are not changed.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, type ApiError, type EditPreview } from "../../../api";
import { Button, Dialog } from "../../../components";
import { applyKubeconfigEdit, openMerge, useContextEditStore } from "./apply";
import { EditError } from "./ContextEditDialog";
import { PreviewView } from "./Preview";

export function MergeButton() {
  const { t } = useTranslation();
  return <Button onClick={() => openMerge(true)}>{t("kubeconfig:merge.button")}</Button>;
}

export function MergeDialog() {
  const open = useContextEditStore((s) => s.mergeOpen);
  if (!open) return null;
  return <MergeForm />;
}

function MergeForm() {
  const { t } = useTranslation();
  const [paths, setPaths] = useState<string[]>([]);
  const [preview, setPreview] = useState<EditPreview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const close = () => openMerge(false);

  useEffect(() => setPreview(null), [paths]);

  const choose = async () => {
    const path = await api.dialog.openFile({ title: t("kubeconfig:merge.dialogTitle") }).catch(() => null);
    if (path && !paths.includes(path)) setPaths([...paths, path]);
  };
  const runPreview = async () => {
    setBusy(true);
    try {
      setPreview(await api.kubeconfig.editPreview({ type: "merge", paths }));
      setError(null);
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  };
  const write = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      await applyKubeconfigEdit({ type: "merge", paths }, preview.base);
      setError(null);
      setDone(true);
    } catch (err) {
      const e = toApiError(err);
      setError(e);
      if (e.code === "conflict") setPreview(await api.kubeconfig.editPreview({ type: "merge", paths }).catch(() => null));
    } finally {
      setBusy(false);
    }
  };

  const footer = done ? (
    <Button variant="primary" onClick={close}>
      {t("common:actions.close")}
    </Button>
  ) : (
    <>
      <Button onClick={close}>{t("common:actions.cancel")}</Button>
      {preview && !preview.unchanged ? (
        <Button variant="primary" disabled={busy} onClick={() => void write()}>
          {t("kubeconfig:edit.apply")}
        </Button>
      ) : (
        <Button variant="primary" disabled={busy || paths.length === 0} onClick={() => void runPreview()}>
          {t("kubeconfig:edit.preview")}
        </Button>
      )}
    </>
  );

  return (
    <Dialog open title={t("kubeconfig:merge.title")} onClose={close} footer={footer}>
      {done ? (
        <p role="status">{t("kubeconfig:edit.writtenNew")}</p>
      ) : (
        <>
          <p className="clusters-hint">{t("kubeconfig:merge.hint")}</p>
          {paths.length === 0 ? (
            <p className="clusters-hint">{t("kubeconfig:merge.empty")}</p>
          ) : (
            <ul className="clusters-sources">
              {paths.map((path) => (
                <li key={path} className="clusters-sources__item">
                  <span className="clusters-sources__path">{path}</span>
                  <Button
                    size="compact"
                    aria-label={t("kubeconfig:merge.removeNamed", { path })}
                    onClick={() => setPaths(paths.filter((p) => p !== path))}
                  >
                    {t("kubeconfig:merge.remove")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="clusters-buttons">
            <Button onClick={() => void choose()}>{t("kubeconfig:merge.choose")}</Button>
          </div>
          {preview && <PreviewView preview={preview} />}
        </>
      )}
      {error && <EditError error={error} />}
    </Dialog>
  );
}
