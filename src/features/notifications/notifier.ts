// The window's one notifier: the engine with the real clock and the OS notification service, the clicks on its
// notifications (open the object, or the problems screen of a summary) and their "Mute for 1 hour" button.
import { api, toApiError, updateSettings, type ClusterId, type NotificationAction, type ObjectRef } from "../../api";
import { useAppStore } from "../../app/store";
import { i18n } from "../../i18n";
import { selectCluster, stateOf, useClustersStore } from "../clusters/clustersStore";
import { PROBLEMS_PAGE_ID } from "../problems/constants";
import { ACTION_TYPE, MUTE_ACTION, NotificationEngine } from "./engine";
import { muteForHour } from "./prefs";

let names: (clusterId: ClusterId) => string = (clusterId) => clusterId;

/** How notifications name a cluster (its display name); set by the host, which reads the settings. */
export function setClusterNames(fn: (clusterId: ClusterId) => string): void {
  names = fn;
}

export const notifier = new NotificationEngine({
  now: () => Date.now(),
  show: (notification) => {
    void api.notifications.show(notification).catch(() => undefined);
  },
  schedule: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
  clusterName: (clusterId) => names(clusterId),
});

/** Brings the cluster forward and opens the object (or, for a summary, the problems screen). */
export function openTarget(clusterId: ClusterId, object: ObjectRef | null): void {
  if (!useClustersStore.getState().clusters.some((c) => c.id === clusterId)) return;
  const app = useAppStore.getState();
  if (stateOf(clusterId).state !== "connected") {
    // Disconnected since: connect it again; the object is opened from its screen.
    selectCluster(clusterId);
    return;
  }
  if (app.activeClusterId !== clusterId) app.setActiveCluster(clusterId);
  if (object) useAppStore.getState().openDetails(object);
  else {
    useAppStore.getState().closeDetails();
    useAppStore.getState().setView(clusterId, PROBLEMS_PAGE_ID);
  }
}

function isObjectRef(value: unknown): value is ObjectRef {
  const v = value as Partial<ObjectRef> | null;
  return (
    !!v &&
    typeof v === "object" &&
    typeof v.name === "string" &&
    !!v.kind &&
    typeof v.kind.kind === "string" &&
    // A kubeconfig context (expiring credentials, #150) is not an object of the cluster: nothing to open but the cluster.
    v.kind.group !== LOCAL_GROUP
  );
}

/** The group of the pseudo-kinds of notifications about things outside the cluster (a kubeconfig context). */
export const LOCAL_GROUP = "local.sextant.dev";

/** What a click on a notification or its button does. */
export function handleAction(action: NotificationAction, now = Date.now()): void {
  if (action.actionId === MUTE_ACTION) {
    // A failed save is shown with the notification history: the user believes they are muted.
    updateSettings(muteForHour(now)).then(
      () => notifier.setFailure(null),
      (err: unknown) => notifier.setFailure(i18n.t("notifications:muteFailed", { message: toApiError(err).message })),
    );
    return;
  }
  if (action.actionId !== "tap") return;
  const clusterId = action.extra?.clusterId;
  if (typeof clusterId !== "string") return;
  const object = action.extra?.object;
  openTarget(clusterId, isObjectRef(object) ? object : null);
}

let wired: Promise<void> | undefined;

/** Registers the notifications' button and hears the clicks, once per page. */
export function wireNotificationActions(): Promise<void> {
  wired ??= (async () => {
    await api.notifications
      .registerActionTypes([{ id: ACTION_TYPE, actions: [{ id: MUTE_ACTION, title: i18n.t("notifications:muteHour") }] }])
      .catch(() => undefined);
    await api.notifications.onAction((action) => handleAction(action)).catch(() => undefined);
  })();
  return wired;
}

/** Forgets the wiring and the engine's state (tests). */
export function resetNotifier(): void {
  wired = undefined;
  names = (clusterId) => clusterId;
  notifier.reset();
}
