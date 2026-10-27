// The ClusterServiceVersion source of the problems category `olm` (#268). OLM copies every CSV into each target
// namespace of its OperatorGroup (an AllNamespaces operator: into every namespace of the cluster), with the whole spec
// and the original's status (operator-lifecycle-manager, pkg/controller/operators/olm/operatorgroup.go
// `csvCopyPrototype`), and marks the copy with the label `olm.copiedFrom`. A watch of every CSV would hold one full
// copy per namespace and operator, icons and descriptions included, and count each failure once per namespace. So
// while the problems store holds this source, one watch lists the originals only — the API server drops the copies by
// the label selector `!olm.copiedFrom` — at most `MAX_SOURCE_OBJECTS`, and each CSV is judged by the shared rules
// (`resolve` → `olmProblems`, which also skips a copy OLM's `IsCopied` recognises by its reason or annotation).
// Nothing is kept once the source is released. A user who may not list Namespaces (#285) gets the watch of the
// accessible namespaces (`restrictedScope`) instead of a cluster-wide one the API server refuses; when that scope
// moves, the problems store starts its sources again, this one with them.
import type { ClusterId, WatchSpec } from "../../api";
import { acquireWatch, subscribeWatchKey, watchKey, watchStateByKey } from "../../api/watchRegistry";
import { isCapped } from "../../api/watchState";
import { findKind } from "../../resources";
import { knownClusterKinds } from "../../resources/useKinds";
import { restrictedScope } from "../namespaces/accessStore";
import { resolve, type Problem } from "../problems/model";
import { MAX_SOURCE_OBJECTS } from "../problems/sources";
import { registerProblemProvider, type ProvidedProblems } from "../problems/store";
import { CSV, NOT_COPIED_SELECTOR } from "./model";

const uidOf = (obj: { metadata?: { uid?: string; namespace?: string; name?: string } }) =>
  obj.metadata?.uid ?? `${obj.metadata?.namespace ?? ""}/${obj.metadata?.name ?? ""}`;

/** Provides the category's problems of one cluster through `set`; returns the function that stops it. */
export function provideOlm(clusterId: ClusterId, set: (update: ProvidedProblems) => void): () => void {
  const served = findKind(knownClusterKinds(clusterId), CSV)?.kindRef;
  if (!served) {
    set({ status: "ready", problems: [] });
    return () => undefined;
  }
  const spec: WatchSpec = {
    kind: served,
    namespaces: restrictedScope(clusterId),
    labelSelector: NOT_COPIED_SELECTOR,
    fieldSelector: null,
  };
  const key = watchKey(clusterId, spec);
  // The problems of the last look, by object: when each was first seen is kept across updates.
  let before = new Map<string, Problem[]>();
  const look = () => {
    const state = watchStateByKey(key);
    if (state.status === "loading") set({ status: "loading", problems: [] });
    else if (state.status === "error") set({ status: "error", error: state.error, problems: [] });
    else {
      const now = Date.now();
      const next = new Map<string, Problem[]>();
      for (const csv of state.items.values()) {
        const uid = uidOf(csv);
        const found = resolve(served, csv, now, before.get(uid));
        if (found.length > 0) next.set(uid, found);
      }
      before = next;
      set({ status: state.status, problems: [...next.values()].flat(), truncated: isCapped(state) });
    }
  };
  const release = acquireWatch(clusterId, spec, { watch: { progressive: false, maxObjects: MAX_SOURCE_OBJECTS } });
  const unsubscribe = subscribeWatchKey(key, look);
  look();
  return () => {
    unsubscribe();
    release();
  };
}

registerProblemProvider("olm", provideOlm);
