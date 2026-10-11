// Opening a log tab for a pod.
import type { ClusterId, KindRef, KubeObject } from "../../api";
import { useAppStore } from "../../app/store";
import { refOf } from "../../resources/refs";
import type { LogContainer, LogsPayload } from "./LogsTab";

export const POD_KIND: KindRef = { group: "", version: "v1", kind: "Pod" };

const DEFAULT_CONTAINER_ANNOTATION = "kubectl.kubernetes.io/default-container";

interface ContainerSpec {
  name?: string;
}

function names(value: unknown): string[] {
  return Array.isArray(value) ? (value as ContainerSpec[]).flatMap((c) => (c.name ? [c.name] : [])) : [];
}

/** The containers of a pod object: init containers first, then the regular ones (ephemeral ones included). */
export function containersOf(pod: KubeObject): LogContainer[] {
  const spec = (pod as { spec?: Record<string, unknown> }).spec ?? {};
  return [
    ...names(spec.initContainers).map((name) => ({ name, init: true })),
    ...names(spec.containers).map((name) => ({ name, init: false })),
    ...names(spec.ephemeralContainers).map((name) => ({ name, init: false })),
  ];
}

/** Opens (or re-activates) the dock tab with the logs of `pod`. */
export function openLogsTab(clusterId: ClusterId, pod: KubeObject): string {
  const ref = refOf(pod, POD_KIND);
  const annotations = pod.metadata?.annotations as Record<string, string> | undefined;
  const containers = containersOf(pod);
  const fallback = annotations?.[DEFAULT_CONTAINER_ANNOTATION];
  const container = fallback && containers.some((c) => c.name === fallback) ? fallback : undefined;
  const payload: LogsPayload = { clusterId, pod: ref, containers, ...(container ? { container } : {}) };
  return useAppStore.getState().openDockTab({
    id: `logs:${clusterId}:${ref.namespace ?? ""}/${ref.name}`,
    type: "logs",
    title: ref.name,
    payload,
  });
}
