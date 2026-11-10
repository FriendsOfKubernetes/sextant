// Adding kubeconfig files or pasted text, and the list of kubeconfig sources with "Remove" for added ones; the
// "From cloud" tab adds EKS/GKE/AKS clusters through the cloud CLIs (CloudClusters).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, type ApiError, type CoreError, type KubeconfigSource } from "../../api";
import { Checkbox, ConfirmDialog, Dialog, ErrorState, Tabs, type TabItem } from "../../components";
import { CloudClusters } from "./CloudClusters";
import {
  addKubeconfigFile,
  addKubeconfigFolder,
  addPastedKubeconfig,
  removeKubeconfigSource,
  setFolderWorkspaces,
  useClustersStore,
} from "./clustersStore";
import { isRemovableSource, removeConfirmKey, sourceKindLabelKey } from "./sources";
import { checkKubeconfig, hasProblems, ValidationDialog } from "./kubeconfig/ValidationDialog";
import type { KubeconfigInput, KubeconfigValidation } from "../../api";

/** A failed kubeconfig change or a source that cannot be read, shown compactly inside a form, list or dialog. */
export function SourceError({ error }: { error: ApiError | CoreError }) {
  return <ErrorState error={error} className="clusters-error" />;
}

export function AddFileButton({ className = "btn" }: { className?: string }) {
  const { t } = useTranslation();
  const [error, setError] = useState<ApiError | null>(null);
  const [checked, setChecked] = useState<{ input: KubeconfigInput; path: string; validation: KubeconfigValidation } | null>(
    null,
  );
  const add = async (path: string) => {
    try {
      await addKubeconfigFile(path);
      setError(null);
    } catch (err) {
      setError(toApiError(err));
    }
  };
  const pick = async () => {
    const path = await api.dialog.openFile({ title: t("clusters:add.fileDialogTitle") });
    if (!path) return;
    // Checked first, offline: problems are shown before the file is added.
    const input: KubeconfigInput = { type: "file", path };
    const validation = await checkKubeconfig(input);
    if (hasProblems(validation)) setChecked({ input, path, validation });
    else await add(path);
  };
  return (
    <>
      <button type="button" className={className} onClick={() => void pick()}>
        {t("clusters:add.file")}
      </button>
      {error && <SourceError error={error} />}
      {checked && (
        <ValidationDialog
          input={checked.input}
          validation={checked.validation}
          onClose={() => setChecked(null)}
          onAdd={() => {
            const { path } = checked;
            setChecked(null);
            void add(path);
          }}
        />
      )}
    </>
  );
}

/** "Add kubeconfig folder": every kubeconfig file in it and in its subfolders one level down (ADR-0148). */
export function AddFolderButton({ className = "btn" }: { className?: string }) {
  const { t } = useTranslation();
  const [error, setError] = useState<ApiError | null>(null);
  const pick = async () => {
    const path = await api.dialog.openFile({ title: t("clusters:add.folderDialogTitle"), directory: true });
    if (!path) return;
    try {
      await addKubeconfigFolder(path);
      setError(null);
    } catch (err) {
      setError(toApiError(err));
    }
  };
  return (
    <>
      <button type="button" className={className} onClick={() => void pick()}>
        {t("clusters:add.folder")}
      </button>
      {error && <SourceError error={error} />}
    </>
  );
}

/** The sources a list shows: a folder's files are shown under the folder (`FolderDetails`), not one by one. */
export function listedSources(sources: readonly KubeconfigSource[]): KubeconfigSource[] {
  return sources.filter((s) => s.kind !== "folderFile");
}

/** Under a folder source: how many kubeconfig files it has, the ones that cannot be read, and its workspaces switch. */
export function FolderDetails({ source, sources }: { source: KubeconfigSource; sources: readonly KubeconfigSource[] }) {
  const { t } = useTranslation();
  const files = sources.filter((s) => s.kind === "folderFile" && s.folder?.sourceId === source.id);
  const broken = files.filter((s) => s.error);
  return (
    <div className="clusters-folder">
      <span className="clusters-hint">{t("clusters:sources.folderFiles", { count: files.length })}</span>
      <label className="settings__choice">
        <Checkbox
          checked={source.workspaces !== false}
          onChange={(e) => void setFolderWorkspaces(source.id, e.target.checked)}
        />
        {t("clusters:sources.folderWorkspaces")}
      </label>
      {broken.map((file) => (
        <div key={file.id} className="clusters-folder__broken">
          <span className="clusters-sources__path">{file.path}</span>
          {file.error && <SourceError error={file.error} />}
        </div>
      ))}
    </div>
  );
}

/** "Paste kubeconfig": the text is checked by the backend and saved in the app data directory. */
export function PasteKubeconfigDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setText("");
    setError(null);
    setChecked(null);
    onClose();
  };
  const [checked, setChecked] = useState<KubeconfigValidation | null>(null);
  const input: KubeconfigInput = { type: "text", text };
  const submit = async (skipCheck = false) => {
    setBusy(true);
    try {
      if (!skipCheck) {
        // Checked first, offline: problems are shown before the text is saved.
        const validation = await checkKubeconfig(input);
        if (hasProblems(validation)) {
          setChecked(validation);
          return;
        }
      }
      await addPastedKubeconfig(text);
      close();
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      title={t("clusters:paste.title")}
      onClose={close}
      footer={
        <>
          <button type="button" className="btn" onClick={close}>
            {t("common:actions.cancel")}
          </button>
          <button type="button" className="btn btn--primary" disabled={busy || !text.trim()} onClick={() => void submit()}>
            {t("clusters:paste.submit")}
          </button>
        </>
      }
    >
      <p className="clusters-hint">{t("clusters:paste.hint")}</p>
      <textarea
        className="clusters-paste"
        aria-label={t("clusters:paste.label")}
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={14}
      />
      {error && <SourceError error={error} />}
      {checked && (
        <ValidationDialog
          input={input}
          validation={checked}
          onClose={() => setChecked(null)}
          onAdd={() => {
            setChecked(null);
            void submit(true);
          }}
        />
      )}
    </Dialog>
  );
}

export function PasteButton({ className = "btn" }: { className?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        {t("clusters:add.paste")}
      </button>
      <PasteKubeconfigDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

type AddTab = "kubeconfig" | "cloud";

export function AddClusterDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const sources = useClustersStore((s) => s.sources);
  const [removing, setRemoving] = useState<KubeconfigSource | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [tab, setTab] = useState<AddTab>("kubeconfig");
  const addTabs: Array<TabItem<AddTab>> = [
    { id: "kubeconfig", label: t("clusters:add.kubeconfigTab") },
    { id: "cloud", label: t("clusters:add.cloudTab") },
  ];

  const remove = async (source: KubeconfigSource) => {
    setRemoving(null);
    try {
      await removeKubeconfigSource(source.id);
      setError(null);
    } catch (err) {
      setError(toApiError(err));
    }
  };

  return (
    <>
      <Dialog
        open={open}
        title={t("clusters:add.title")}
        onClose={onClose}
        footer={
          <button type="button" className="btn" onClick={onClose}>
            {t("common:actions.close")}
          </button>
        }
      >
        <Tabs
          label={t("clusters:add.tabs")}
          tabs={addTabs}
          selected={tab}
          onSelect={setTab}
          className="clusters-add-tabs"
        >
          {tab === "cloud" ? (
            <CloudClusters onTerminalOpened={onClose} />
          ) : (
            <div className="clusters-buttons">
              <AddFileButton className="btn btn--primary" />
              <AddFolderButton />
              <PasteButton />
            </div>
          )}
        </Tabs>
        <h3 className="clusters-subtitle">{t("clusters:sources.title")}</h3>
        <ul className="clusters-sources" aria-label={t("clusters:sources.title")}>
          {listedSources(sources).map((source) => (
            <li key={source.id} className="clusters-sources__item">
              <span className="clusters-sources__path">{source.path}</span>
              <span className="clusters-sources__kind">{t(sourceKindLabelKey(source.kind))}</span>
              {source.kind === "folder" && <FolderDetails source={source} sources={sources} />}
              {isRemovableSource(source.kind) && (
                <button
                  type="button"
                  className="btn"
                  aria-label={t("clusters:sources.removeNamed", { path: source.path })}
                  onClick={() => setRemoving(source)}
                >
                  {t("clusters:sources.remove")}
                </button>
              )}
            </li>
          ))}
        </ul>
        {error && <SourceError error={error} />}
      </Dialog>
      <ConfirmDialog
        open={removing !== null}
        title={t("clusters:sources.confirmTitle")}
        confirmLabel={t("clusters:sources.remove")}
        danger
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && void remove(removing)}
      >
        <p>{t(removeConfirmKey(removing?.kind))}</p>
        <p className="clusters-sources__path">{removing?.path}</p>
      </ConfirmDialog>
    </>
  );
}
