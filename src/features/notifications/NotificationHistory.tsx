// The last notifications (`HISTORY_LIMIT`) of every cluster, newest first, with "Mute for 1 hour" — also where a
// notification muted or folded into a summary can still be read. Shown on the problems screen of a cluster
// (`clusterId`): there only that cluster's notifications by default, every cluster's (with the cluster column) under
// "All clusters". "Clear" forgets what is listed; the mute is app-wide, and says so on a cluster's screen.
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { toApiError, useSettings, type ClusterId } from "../../api";
import { Age, Badge, Button, Checkbox } from "../../components";
import { displayNameOf } from "../clusters/clusterSettings";
import { useClustersStore } from "../clusters/clustersStore";
import { useNow } from "../problems/hooks";
import { messageText, type HistoryEntry } from "./engine";
import { notifier, openTarget } from "./notifier";
import { muteForHour, mutedNow, prefsOf, unmute } from "./prefs";
import { formatTime } from "../../i18n";

const subscribe = (fn: () => void) => notifier.subscribe(fn);
const snapshot = () => notifier.history();
const failureSnapshot = () => notifier.lastFailure();

export function useNotificationHistory(): readonly HistoryEntry[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function NotificationHistory({ clusterId }: { clusterId?: ClusterId } = {}) {
  const { t } = useTranslation();
  const all = useNotificationHistory();
  const [everyCluster, setEveryCluster] = useState(false);
  /** The cluster the list is narrowed to; `undefined`: every cluster. */
  const only = clusterId !== undefined && !everyCluster ? clusterId : undefined;
  const entries = only === undefined ? all : all.filter((e) => e.clusterId === only);
  const failure = useSyncExternalStore(subscribe, failureSnapshot, failureSnapshot);
  const save = (change: Parameters<typeof update>[0]) =>
    update(change).then(
      () => notifier.setFailure(null),
      (err: unknown) => notifier.setFailure(t("notifications:muteFailed", { message: toApiError(err).message })),
    );
  const { settings, update } = useSettings();
  const clusters = useClustersStore((s) => s.clusters);
  const now = useNow(10_000);
  const prefs = prefsOf(settings);
  const muted = prefs ? mutedNow(prefs, now) : false;
  const nameOf = (id: string) => {
    const cluster = clusters.find((c) => c.id === id);
    return cluster ? displayNameOf(cluster, settings) : id;
  };

  return (
    <section className="problems__history" aria-label={t("notifications:history.title")}>
      <div className="problems__history-head">
        <h3 className="problems__heading">{t("notifications:history.title")}</h3>
        {muted && prefs?.mutedUntil ? (
          <>
            <span className="problems__muted" role="status">
              {t(clusterId === undefined ? "notifications:settings.mutedUntil" : "notifications:history.mutedAllUntil", {
                time: formatTime(prefs.mutedUntil),
              })}
            </span>
            <Button size="compact" onClick={() => void save(unmute())}>
              {t("notifications:unmute")}
            </Button>
          </>
        ) : (
          <Button
            size="compact"
            disabled={!prefs?.enabled}
            onClick={() => void save(muteForHour(Date.now()))}
          >
            {t(clusterId === undefined ? "notifications:muteHour" : "notifications:history.muteAll")}
          </Button>
        )}
        {entries.length > 0 && (
          <Button size="compact" onClick={() => notifier.clearHistory(only)}>
            {t("notifications:history.clear")}
          </Button>
        )}
        {clusterId !== undefined && (
          <label className="problems__choice">
            <Checkbox checked={everyCluster} onChange={(e) => setEveryCluster(e.target.checked)} />
            {t("notifications:history.allClusters")}
          </label>
        )}
      </div>
      {failure && (
        <p className="problems__failure" role="alert">
          {failure}
        </p>
      )}
      {prefs && !prefs.enabled && <p className="problems__hint">{t("notifications:history.off")}</p>}
      {entries.length === 0 ? (
        <p className="problems__hint">
          {t(only === undefined ? "notifications:history.empty" : "notifications:history.emptyCluster")}
        </p>
      ) : (
        <ul className={`problems__history-list${only === undefined ? "" : " problems__history-list--cluster"}`}>
          {entries.map((entry) => {
            const object = entry.object;
            const where = object.namespace ? `${object.namespace}/${object.name}` : object.name;
            return (
              <li key={entry.id} className="problems__history-item" data-delivery={entry.delivery}>
                <span className="problems__history-time">
                  <Age timestamp={new Date(entry.at).toISOString()} now={now} />
                </span>
                {only === undefined && <span className="problems__history-cluster">{nameOf(entry.clusterId)}</span>}
                <Badge tone="danger">{entry.reason}</Badge>
                <button
                  type="button"
                  className="rt-link"
                  aria-label={t("resources:table.openObject", { kind: object.kind.kind, name: object.name })}
                  onClick={() => openTarget(entry.clusterId, object)}
                >
                  {`${object.kind.kind}: ${where}`}
                </button>
                {entry.delivery !== "shown" && (
                  <span className="problems__history-delivery">{t(`notifications:history.delivery.${entry.delivery}`)}</span>
                )}
                <span className="problems__history-message">{messageText(entry)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
