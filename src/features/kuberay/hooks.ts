// What a RayCluster's details read beyond the object: its pods, selected on the API server by KubeRay's label
// `ray.io/cluster=<name>` in the cluster's one namespace, through the shared watch registry (`useWatch`), keeping at
// most `MAX_RAY_PODS` (the view says when the list is cut), closed when the details close.
import type { ClusterId, KindRef, KubeObject } from "../../api";
import { isCapped, useWatch } from "../../api";
import { CLUSTER_LABEL } from "./model";

export const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
/** Pods one RayCluster's watch keeps (a large cluster can have thousands of workers). */
export const MAX_RAY_PODS = 2000;
const POD_WATCH_OPTIONS = { progressive: false, maxObjects: MAX_RAY_PODS } as const;

export interface RayPods {
  pods: KubeObject[];
  loading: boolean;
  /** The list could not be read (no permission, an error). */
  error: boolean;
  /** More pods match than the watch keeps. */
  truncated: boolean;
}

/** The pods of the RayCluster `name` in `namespace`, sorted by name. */
export function useRayPods(clusterId: ClusterId, namespace: string | null | undefined, name: string | undefined): RayPods {
  const spec = namespace && name ? { kind: POD, namespaces: [namespace], labelSelector: `${CLUSTER_LABEL}=${name}`, fieldSelector: null } : null;
  const state = useWatch(clusterId, spec, POD_WATCH_OPTIONS);
  const pods = [...state.items.values()].sort((a, b) => (a.metadata?.name ?? "").localeCompare(b.metadata?.name ?? ""));
  return {
    pods,
    loading: spec !== null && state.status === "loading",
    error: Boolean(state.error) || (state.forbidden ?? []).length > 0,
    truncated: spec !== null && isCapped(state),
  };
}
