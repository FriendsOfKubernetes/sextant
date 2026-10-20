// Opening an end of an edge: the sources name a workload by its name only (and Istio a Service by name), so the
// object is looked up on a click — a Deployment, a StatefulSet, then a DaemonSet of that name in its namespace, or the
// Service — with at most three reads, never a watch. What a lookup found is kept per cluster (a few hundred at most)
// while the window lives.
import { api, toApiError, type ClusterId, type KindRef, type ObjectRef, type TrafficPeer } from "../../../api";
import { useAppStore } from "../../../app/store";
import { revealRequestHealth } from "../../request-health/hooks";

export const WORKLOAD_KINDS: readonly KindRef[] = [
  { group: "apps", version: "v1", kind: "Deployment" },
  { group: "apps", version: "v1", kind: "StatefulSet" },
  { group: "apps", version: "v1", kind: "DaemonSet" },
];
export const SERVICE_KIND: KindRef = { group: "", version: "v1", kind: "Service" };
/** Lookups kept; the oldest goes first. */
export const MAX_RESOLVED = 300;

const resolved = new Map<string, ObjectRef | null>();

/** Forgets every lookup (tests). */
export function resetResolved(): void {
  resolved.clear();
}

/** The object an end names, or `null` when none of its kinds has an object of that name (or it is unknown). */
export async function resolvePeer(clusterId: ClusterId, peer: TrafficPeer): Promise<ObjectRef | null> {
  const { namespace, name } = peer;
  if (peer.kind === "unknown" || !namespace || !name) return null;
  const key = `${clusterId}|${peer.kind}|${namespace}|${name}`;
  if (resolved.has(key)) return resolved.get(key)!;
  const kinds = peer.kind === "service" ? [SERVICE_KIND] : WORKLOAD_KINDS;
  let found: ObjectRef | null = null;
  for (const kind of kinds) {
    const ref: ObjectRef = { kind, namespace, name };
    try {
      await api.resources.get(clusterId, ref);
      found = ref;
      break;
    } catch (err) {
      // Not this kind; anything else (no permission, no connection) is not remembered.
      if (toApiError(err).code !== "notFound") throw err;
    }
  }
  resolved.set(key, found);
  for (const oldest of resolved.keys()) {
    if (resolved.size <= MAX_RESOLVED) break;
    resolved.delete(oldest);
  }
  return found;
}

/** How many animation frames the "Requests" section is looked for after the details open. */
const REVEAL_FRAMES = 30;

/** Opens the object's details and brings its "Requests" section (#212) into view once it is drawn. */
export function openRequestsOf(ref: ObjectRef): void {
  useAppStore.getState().openDetails(ref);
  let frames = 0;
  const look = () => {
    const section = document.querySelector('[data-details-section="requestHealth"]');
    if (section) {
      revealRequestHealth(section.firstElementChild ?? section);
      return;
    }
    if (++frames < REVEAL_FRAMES) requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}
