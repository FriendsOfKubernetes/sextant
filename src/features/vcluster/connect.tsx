// "Connect" on a vcluster, only on the user's click and after a short confirmation that says what will happen: the
// backend reads the Secret `vc-<name>` with the user's credentials, forwards a local port through the host cluster and
// adds the virtual cluster to the cluster list (Sextant's own `vcluster.yaml`). While Sextant forwards for it: "Open"
// (switches to it, connecting it like any other cluster) and "Disconnect" (stops the forward, which removes the entry).
// The window never sees the kubeconfig: only names and the local port.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toApiError, type ClusterId } from "../../api";
import { Button, ConfirmDialog } from "../../components";
import { selectCluster, useClustersStore } from "../clusters/clustersStore";
import { connectVcluster, disconnectVcluster, useLinkOf } from "./links";
import { contextName, secretName } from "./model";

export function ConnectControls({ clusterId, namespace, name }: { clusterId: ClusterId; namespace: string; name: string }) {
  const { t } = useTranslation();
  const link = useLinkOf(clusterId, namespace, name);
  const hostContext = useClustersStore((s) => s.clusters.find((c) => c.id === clusterId)?.context ?? "");
  const listed = useClustersStore((s) => (link ? s.clusters.some((c) => c.id === link.clusterId) : false));
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(toApiError(err).toCoreError().message);
    } finally {
      setBusy(false);
    }
  };
  const connect = () => {
    setAsking(false);
    void run(() => connectVcluster(clusterId, namespace, name));
  };

  return (
    <span className="vc-connect">
      {link ? (
        <>
          <span className="vc-muted">{t("vcluster:connect.forwarded", { port: link.localPort })}</span>
          <Button
            size="compact"
            variant="primary"
            disabled={!listed}
            aria-label={t("vcluster:connect.openNamed", { context: link.context })}
            onClick={() => selectCluster(link.clusterId)}
          >
            {t("vcluster:connect.open")}
          </Button>
          <Button
            size="compact"
            disabled={busy}
            aria-label={t("vcluster:connect.disconnectNamed", { name })}
            onClick={() => void run(() => disconnectVcluster(link.clusterId))}
          >
            {t("vcluster:connect.disconnect")}
          </Button>
        </>
      ) : (
        <Button
          size="compact"
          disabled={busy}
          aria-label={t("vcluster:connect.buttonNamed", { name })}
          onClick={() => setAsking(true)}
        >
          {busy ? t("vcluster:connect.connecting") : t("vcluster:connect.button")}
        </Button>
      )}
      {error && (
        <span className="vc-error" role="alert">
          {t("vcluster:connect.failed", { message: error })}
        </span>
      )}
      <ConfirmDialog
        open={asking}
        title={t("vcluster:connect.title", { name })}
        confirmLabel={t("vcluster:connect.confirm")}
        onConfirm={connect}
        onCancel={() => setAsking(false)}
      >
        <p>{t("vcluster:connect.reads", { secret: secretName(name), namespace })}</p>
        <p>{t("vcluster:connect.forwards", { host: hostContext })}</p>
        <p>{t("vcluster:connect.adds", { context: contextName(name, namespace, hostContext) })}</p>
        <p>{t("vcluster:connect.lasts", { host: hostContext })}</p>
      </ConfirmDialog>
    </span>
  );
}
