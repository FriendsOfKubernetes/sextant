// Adding kubeconfig files or pasted text, and the list of kubeconfig sources with "Remove" for added ones; the
// "From cloud" tab adds EKS/GKE/AKS clusters through the cloud CLIs (CloudClusters).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, type ApiError, type CoreError, type KubeconfigSource } from "../../api";
import { ConfirmDialog, Dialog, ErrorState, Tabs, type TabItem } from "../../components";
import { CloudClusters } from "./CloudClusters";
import { addKubeconfigFile, addPastedKubeconfig, removeKubeconfigSource, useClustersStore } from "./clustersStore";

/** Opens the system file dialog and adds the chosen kubeconfig. Resolves to an error to show, if any. */
export async function pickKubeconfigFile(title: string): Promise<ApiError | null> {
  const path = await api.dialog.openFile({ title });
  if (!path) return null;
  try {
    await addKubeconfigFile(path);
    return null;
  } catch (err) {
    return toApiError(err);
  }
}

/** A failed kubeconfig change or a source that cannot be read, shown compactly inside a form, list or dialog. */
export function SourceError({ error }: { error: ApiError | CoreError }) {
  return <ErrorState error={error} className="clusters-error" />;
}

export function AddFileButton({ className = "btn" }: { className?: string }) {
  const { t } = useTranslation();
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <>
      <button
        type="button"
        className={className}
        onClick={async () => setError(await pickKubeconfigFile(t("clusters:add.fileDialogTitle")))}
      >
        {t("clusters:add.file")}
      </button>
      {error && <SourceError error={error} />}
    </>
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
    onClose();
  };
  const submit = async () => {
    setBusy(true);
    try {
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
          <button type="button" className="btn btn--primary" disabled={busy || !text.trim()} onClick={submit}>
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

const REMOVABLE: ReadonlySet<KubeconfigSource["kind"]> = new Set(["addedFile", "pasted", "cloud"]);

/** What removing a source does to its file: an added file stays on disk, Sextant's own copies are deleted. */
function removeTextKey(kind: KubeconfigSource["kind"] | undefined): string {
  if (kind === "pasted") return "clusters:sources.confirmPasted";
  if (kind === "cloud") return "clusters:sources.confirmCloud";
  return "clusters:sources.confirmFile";
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
              <PasteButton />
            </div>
          )}
        </Tabs>
        <h3 className="clusters-subtitle">{t("clusters:sources.title")}</h3>
        <ul className="clusters-sources" aria-label={t("clusters:sources.title")}>
          {sources.map((source) => (
            <li key={source.id} className="clusters-sources__item">
              <span className="clusters-sources__path">{source.path}</span>
              <span className="clusters-sources__kind">{t(`clusters:sources.kind.${source.kind}`)}</span>
              {REMOVABLE.has(source.kind) && (
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
        <p>{t(removeTextKey(removing?.kind))}</p>
        <p className="clusters-sources__path">{removing?.path}</p>
      </ConfirmDialog>
    </>
  );
}
