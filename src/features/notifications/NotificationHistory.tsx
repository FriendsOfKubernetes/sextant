// The last notifications (`HISTORY_LIMIT`) of every cluster, newest first, with "Mute for 1 hour" — also where a
// notification muted or folded into a summary can still be read. Shown on the problems screen.
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { toApiError, useSettings } from "../../api";
import { Age, Badge, Button } from "../../components";
import { displayNameOf } from "../clusters/clusterSettings";
import { useClustersStore } from "../clusters/clustersStore";
import { useNow } from "../problems/hooks";
import { messageText, type HistoryEntry } from "./engine";
import { notifier, openTarget } from "./notifier";
import { muteForHour, mutedNow, prefsOf, unmute } from "./prefs";

const subscribe = (fn: () => void) => notifier.subscribe(fn);
const snapshot = () => notifier.history();
const failureSnapshot = () => notifier.lastFailure();

export function useNotificationHistory(): readonly HistoryEntry[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function NotificationHistory() {
  const { t } = useTranslation();
  const entries = useNotificationHistory();
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
              {t("notifications:settings.mutedUntil", { time: new Date(prefs.mutedUntil).toLocaleTimeString() })}
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
            {t("notifications:muteHour")}
          </Button>
        )}
        {entries.length > 0 && (
          <Button size="compact" onClick={() => notifier.clearHistory()}>
            {t("notifications:history.clear")}
          </Button>
        )}
      </div>
      {failure && (
        <p className="problems__failure" role="alert">
          {failure}
        </p>
      )}
      {prefs && !prefs.enabled && <p className="problems__hint">{t("notifications:history.off")}</p>}
      {entries.length === 0 ? (
        <p className="problems__hint">{t("notifications:history.empty")}</p>
      ) : (
        <ul className="problems__history-list">
          {entries.map((entry) => {
            const object = entry.object;
            const where = object.namespace ? `${object.namespace}/${object.name}` : object.name;
            return (
              <li key={entry.id} className="problems__history-item" data-delivery={entry.delivery}>
                <span className="problems__history-time">
                  <Age timestamp={new Date(entry.at).toISOString()} now={now} />
                </span>
                <span className="problems__history-cluster">{nameOf(entry.clusterId)}</span>
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
