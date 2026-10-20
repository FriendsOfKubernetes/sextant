// "View kubeconfig" (#228), from the cluster menu and the cluster settings: the kubeconfig of this one context as a
// standalone file, every credential `<hidden>` (masked in the backend; the window never receives a credential).
// "Copy" puts the full working kubeconfig on the clipboard after a confirmation — written by the backend, so the
// credentials still never reach the window; "Copy without credentials" copies what is shown.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { api, toApiError, type ApiError, type ClusterInfo } from "../../../api";
import { Button, ConfirmDialog, Dialog } from "../../../components";
import { SourceError } from "../AddClusterDialog";
import type { ClusterSettingsSectionProps } from "../settingsRegistry";
import "./view.css";

const useViewStore = create<{ cluster: ClusterInfo | null }>()(() => ({ cluster: null }));

/** Opens the viewer for `cluster`. */
export function openKubeconfigView(cluster: ClusterInfo): void {
  useViewStore.setState({ cluster });
}

export function closeKubeconfigView(): void {
  useViewStore.setState({ cluster: null });
}

/** Mounted once; shows the viewer while one is open. */
export function KubeconfigViewDialog() {
  const cluster = useViewStore((s) => s.cluster);
  if (!cluster) return null;
  return <ViewDialog key={cluster.id} cluster={cluster} />;
}

type Copied = "full" | "masked";

function ViewDialog({ cluster }: { cluster: ClusterInfo }) {
  const { t } = useTranslation();
  const [yaml, setYaml] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState<Copied | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api.kubeconfig
      .view(cluster.id)
      .then((text) => alive && setYaml(text))
      .catch((err: unknown) => alive && setError(toApiError(err)));
    return () => {
      alive = false;
    };
  }, [cluster.id]);

  const copy = async (withCredentials: boolean) => {
    setConfirming(false);
    setBusy(true);
    setCopied(null);
    try {
      await api.kubeconfig.copy(cluster.id, withCredentials);
      setError(null);
      setCopied(withCredentials ? "full" : "masked");
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const footer = (
    <>
      <Button onClick={closeKubeconfigView}>{t("common:actions.close")}</Button>
      <Button disabled={busy || yaml === null} onClick={() => void copy(false)}>
        {t("kubeconfigview:copyMasked")}
      </Button>
      <Button variant="primary" disabled={busy || yaml === null} onClick={() => setConfirming(true)}>
        {t("kubeconfigview:copy")}
      </Button>
    </>
  );

  // The viewer steps aside while the confirmation is open: one modal at a time.
  return (
    <>
      <Dialog
        open={!confirming}
        title={t("kubeconfigview:title", { context: cluster.context })}
        onClose={closeKubeconfigView}
        footer={footer}
      >
        <p className="clusters-hint">{t("kubeconfigview:hint")}</p>
        {yaml === null && !error && <p role="status">{t("kubeconfigview:loading")}</p>}
        {yaml !== null && (
          <pre className="kc-view" tabIndex={0} aria-label={t("kubeconfigview:yamlLabel")}>
            {yaml}
          </pre>
        )}
        <p role="status" className="kc-view__status">
          {copied === "full" && t("kubeconfigview:copiedFull")}
          {copied === "masked" && t("kubeconfigview:copiedMasked")}
        </p>
        {error && <SourceError error={error} />}
      </Dialog>
      <ConfirmDialog
        open={confirming}
        title={t("kubeconfigview:confirmTitle")}
        confirmLabel={t("kubeconfigview:confirmCopy")}
        danger
        onConfirm={() => void copy(true)}
        onCancel={() => setConfirming(false)}
      >
        <p>{t("kubeconfigview:confirmText", { context: cluster.context })}</p>
      </ConfirmDialog>
    </>
  );
}

/** The cluster settings' entry to the viewer ("Connection" tab). */
export function KubeconfigViewSection({ cluster }: ClusterSettingsSectionProps) {
  const { t } = useTranslation();
  return (
    <div className="kc-view__section">
      <p className="clusters-hint">{t("kubeconfigview:settings.hint")}</p>
      <Button size="compact" onClick={() => openKubeconfigView(cluster)}>
        {t("kubeconfigview:settings.view")}
      </Button>
    </div>
  );
}
