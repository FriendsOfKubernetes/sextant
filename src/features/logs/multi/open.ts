// Opening a merged logs tab: the pods a label selector matches in a namespace (followed as they come and go), or a
// fixed set of pods (rows selected in the pods table).
import type { ClusterId, ObjectRef } from "../../../api";
import { useAppStore } from "../../../app/store";
import { i18n } from "../../../i18n";

/** `DockTab.payload` of a merged logs tab (the dock tab type is "logs", like a single pod's). */
export interface MultiLogsPayload {
  multi: true;
  clusterId: ClusterId;
  /** The pods of this label selector in `namespace`, followed as pods appear and go. */
  selector?: { namespace: string; labelSelector: string };
  /** A fixed set of pods; each one's stream ends when the pod is deleted. */
  pods?: ObjectRef[];
}

export function isMultiLogsPayload(payload: unknown): payload is MultiLogsPayload {
  return typeof payload === "object" && payload !== null && (payload as { multi?: unknown }).multi === true;
}

/**
 * Opens (or re-activates) the merged logs of the pods `labelSelector` matches in `namespace`. `title` names the
 * source as shown on the tab (`deployment/web`).
 */
export function openSelectorLogsTab(clusterId: ClusterId, namespace: string, labelSelector: string, title: string): string {
  const payload: MultiLogsPayload = { multi: true, clusterId, selector: { namespace, labelSelector } };
  return useAppStore.getState().openDockTab({
    id: `logs:${clusterId}:selector:${namespace}:${labelSelector}`,
    type: "logs",
    title,
    payload,
  });
}

/** Opens (or re-activates) the merged logs of the pods `pods`. */
export function openPodsLogsTab(clusterId: ClusterId, pods: ObjectRef[]): string {
  const sorted = [...pods].sort((a, b) =>
    `${a.namespace ?? ""}/${a.name}`.localeCompare(`${b.namespace ?? ""}/${b.name}`),
  );
  const payload: MultiLogsPayload = { multi: true, clusterId, pods: sorted };
  return useAppStore.getState().openDockTab({
    id: `logs:${clusterId}:pods:${sorted.map((p) => `${p.namespace ?? ""}/${p.name}`).join(",")}`,
    type: "logs",
    title: i18n.t("logs:multi.podsTitle", { count: sorted.length }),
    payload,
  });
}
