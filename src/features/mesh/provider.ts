// The source of the problems category "Service mesh" (#155): while the problems store holds it (the problems screen,
// the Cluster counter or the notifications look at a cluster that serves VirtualServices), the cluster's Istio
// configuration is held (store.ts) and each mistake `meshProblems` finds becomes a problem of the VirtualService or
// DestinationRule it is about. Nothing is kept once the source is released.
import { registerProblemProvider } from "../problems/store";
import type { Problem } from "../problems/model";
import type { MeshProblem } from "./problems";
import { acquireMesh, getMeshConfig, subscribeMesh } from "./store";

/** The store's problems of the mesh's findings; `firstSeen` keeps when each was first seen. */
export function toProblems(found: readonly MeshProblem[], firstSeen: Map<string, number>, now: number): Problem[] {
  const keys = new Set<string>();
  const out = found.map((p): Problem => {
    const detail = p.params.host ?? p.params.gateway ?? "";
    const key = `${p.uid}|${p.reason}|${detail}|${p.params.subset ?? ""}`;
    keys.add(key);
    const first = firstSeen.get(key) ?? now;
    firstSeen.set(key, first);
    return {
      key,
      notifyKey: key,
      category: "mesh",
      uid: p.uid,
      object: { kind: p.ref.kind, namespace: p.ref.namespace || null, name: p.ref.name },
      reason: p.reason,
      messageKey: `messages.mesh${p.reason}`,
      messageParams: p.params,
      notify: true,
      firstSeen: first,
      activeAt: first,
    };
  });
  for (const key of [...firstSeen.keys()]) if (!keys.has(key)) firstSeen.delete(key);
  return out;
}

registerProblemProvider("mesh", (clusterId, set) => {
  const firstSeen = new Map<string, number>();
  const release = acquireMesh(clusterId);
  let last: string | undefined;
  const look = () => {
    const config = getMeshConfig(clusterId);
    // Every shared watch's update wakes the store: hand in only what changed.
    const signature = config.loading ? "loading" : JSON.stringify(config.problems);
    if (signature === last) return;
    last = signature;
    if (config.loading) set({ status: "loading", problems: [] });
    else set({ status: "ready", problems: toProblems(config.problems, firstSeen, Date.now()) });
  };
  const unsubscribe = subscribeMesh(look);
  look();
  return () => {
    unsubscribe();
    release();
  };
});
