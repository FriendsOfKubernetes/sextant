// The pods of a Deployment, StatefulSet or DaemonSet for the sections of its details (right-sizing, cost): one shared
// watch (`resource-map/watches.ts`) per (cluster, namespace, selector) however many sections ask, closed a few
// seconds after the last lets go. The selector is the workload's `spec.selector` (matchLabels and matchExpressions);
// without one the namespace's pods are watched — the same spec the resource map uses, so that watch is shared too —
// and the workload's own pods are picked by their owners either way.
import { useMemo } from "react";
import type { ClusterId, KubeObject, ObjectRef, WatchSpec, WatchStatus } from "../../api";
import { useSharedWatches } from "../resource-map/watches";
import { selectorOf } from "../rollouts/model";
import { workloadOf } from "./group";

const POD = { group: "", version: "v1", kind: "Pod" };

/** The watch of a workload's pods; `null` before the workload is loaded or without a namespace. */
export function workloadPodsSpec(namespace: string, obj: KubeObject | null): WatchSpec | null {
  if (!namespace || !obj) return null;
  return { kind: POD, namespaces: [namespace], labelSelector: selectorOf(obj), fieldSelector: null };
}

const NO_SPECS: WatchSpec[] = [];

/** The pods `ref` (a workload) controls, and the watch's status. */
export function useWorkloadPods(
  clusterId: ClusterId,
  ref: ObjectRef,
  obj: KubeObject | null,
  enabled = true,
): { pods: KubeObject[]; status: WatchStatus } {
  const spec = enabled ? workloadPodsSpec(ref.namespace ?? "", obj) : null;
  const specs = useMemo(() => (spec ? [spec] : NO_SPECS), [JSON.stringify(spec)]);
  const [state] = useSharedWatches(clusterId, specs);
  const items = state?.items;
  const kind = ref.kind.kind;
  const pods = useMemo(
    () =>
      items
        ? [...items.values()].filter((p) => {
            const w = workloadOf(p);
            return w.kind === kind && w.name === ref.name;
          })
        : [],
    [items, kind, ref.name],
  );
  return { pods, status: state?.status ?? "loading" };
}
