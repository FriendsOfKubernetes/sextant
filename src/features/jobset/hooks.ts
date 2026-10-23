// What a JobSet's details watch while open, through the shared watch registry, in the JobSet's namespace only,
// selected on the API server by the label the controller puts on its Jobs and (through their templates) their pods:
// `jobset.sigs.k8s.io/jobset-name=<name>`. Each list keeps at most `MAX_CHILDREN` objects (a TPU multislice JobSet can
// run thousands of pods); the view says when a list is cut. Closed when the details close.
import { useMemo } from "react";
import { useWatch, type ClusterId, type KindRef, type KubeObject, type WatchSpec } from "../../api";
import { isCapped } from "../../api/watchState";
import { JOBSET_NAME_LABEL } from "./model";

export const MAX_CHILDREN = 500;
const OPTIONS = { progressive: false, maxObjects: MAX_CHILDREN } as const;
const JOB: KindRef = { group: "batch", version: "v1", kind: "Job" };
const POD: KindRef = { group: "", version: "v1", kind: "Pod" };

export interface Children {
  items: KubeObject[];
  loading: boolean;
  failed: boolean;
  truncated: boolean;
}

function useChildren(clusterId: ClusterId, kind: KindRef, js: KubeObject | null): Children {
  const ns = js?.metadata?.namespace;
  const name = js?.metadata?.name;
  const spec = useMemo<WatchSpec | null>(
    () => (ns && name ? { kind, namespaces: [ns], labelSelector: `${JOBSET_NAME_LABEL}=${name}`, fieldSelector: null } : null),
    [kind, ns, name],
  );
  const state = useWatch(clusterId, spec, OPTIONS);
  return useMemo(() => {
    const items = [...state.items.values()].sort((a, b) => (a.metadata?.name ?? "").localeCompare(b.metadata?.name ?? ""));
    return {
      items,
      loading: spec !== null && state.status === "loading",
      failed: Boolean(state.error) || state.status === "error",
      truncated: spec !== null && isCapped(state),
    };
  }, [state, spec]);
}

/** The JobSet's Jobs. */
export const useJobSetJobs = (clusterId: ClusterId, js: KubeObject | null) => useChildren(clusterId, JOB, js);
/** The pods of the JobSet's Jobs. */
export const useJobSetPods = (clusterId: ClusterId, js: KubeObject | null) => useChildren(clusterId, POD, js);
