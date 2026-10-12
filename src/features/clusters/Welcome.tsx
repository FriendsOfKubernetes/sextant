// The main area while no cluster is open: "No clusters found" with the checked paths, the progress or error of
// the cluster being connected, or a hint to pick one.
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { errorKey, useSettings, type ClusterInfo, type CoreError } from "../../api";
import { EmptyState } from "../../components";
import { useElapsedSeconds, SLOW_AFTER_S } from "../../components/Table";
import { AddFileButton, PasteButton, SourceError } from "./AddClusterDialog";
import { displayNameOf } from "./clusterSettings";
import { connectCluster, disconnectCluster, openClusterSettings, useClustersStore } from "./clustersStore";
import { useClusters, useClusterState } from "./hooks";

export function Welcome() {
  const { t } = useTranslation();
  const { clusters, sources, loaded, error } = useClusters();
  const pendingId = useClustersStore((s) => s.pendingId);
  const pending = clusters.find((c) => c.id === pendingId);

  if (pending) return <Connection cluster={pending} />;
  if (!loaded) return <EmptyState title={t("clusters:welcome.loading")} />;
  if (clusters.length === 0) {
    return (
      <div className="clusters-welcome">
        <h1 className="clusters-welcome__title">{t("clusters:welcome.noClusters")}</h1>
        <p>{t("clusters:welcome.checked")}</p>
        <ul className="clusters-welcome__paths" aria-label={t("clusters:welcome.checkedPaths")}>
          {sources.map((s) => (
            <li key={s.id}>
              {s.path}
              {s.error && <SourceError error={s.error} />}
            </li>
          ))}
        </ul>
        {error && <SourceError error={error} />}
        <div className="clusters-buttons">
          <AddFileButton className="btn btn--primary" />
          <PasteButton />
        </div>
      </div>
    );
  }
  return <EmptyState title={t("clusters:welcome.title")} text={t("clusters:welcome.pick")} />;
}

/** "Connecting to … 7 s" (after 5 s: the cluster is slow) or the connection error with Reconnect. */
function Connection({ cluster }: { cluster: ClusterInfo }) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const state = useClusterState(cluster.id);
  const name = displayNameOf(cluster, settings);
  const seconds = useElapsedSeconds(state.state === "connecting");

  if (state.state === "error") {
    const { code, message } = state;
    return (
      <div className="clusters-welcome" role="alert" data-code={code}>
        <h1 className="clusters-welcome__title clusters-welcome__title--error">
          {t("clusters:connection.failed", { name })}
        </h1>
        <p>{connectionErrorText(t, { code, message })}</p>
        {message && <p className="clusters-error__details">{t("common:error.details", { message })}</p>}
        <div className="clusters-buttons">
          <button type="button" className="btn btn--primary" onClick={() => void connectCluster(cluster.id)}>
            {t("clusters:connection.reconnect")}
          </button>
          <button type="button" className="btn" onClick={() => openClusterSettings(cluster.id)}>
            {t("clusters:menu.settings")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="clusters-welcome" role="status">
      <div className="clusters-spinner" aria-hidden="true" />
      <h1 className="clusters-welcome__title">
        <span>{t("clusters:connection.connecting", { name })}</span>
        {seconds >= 1 && (
          <span className="clusters-elapsed">{t("clusters:connection.seconds", { seconds })}</span>
        )}
      </h1>
      {seconds >= SLOW_AFTER_S && <p className="clusters-slow">{t("clusters:connection.slow")}</p>}
      <p className="clusters-hint">{cluster.server}</p>
      <div className="clusters-buttons">
        <button type="button" className="btn" onClick={() => void disconnectCluster(cluster.id)}>
          {t("common:actions.cancel")}
        </button>
      </div>
    </div>
  );
}

/** Words for a connection error; a rejected server certificate gets its own text. */
export function connectionErrorText(t: TFunction, error: CoreError): string {
  if (error.code === "unreachable" && /certificate|x509|UnknownIssuer|BadSignature/i.test(error.message)) {
    return t("clusters:connection.certificate");
  }
  return t(errorKey(error.code));
}
