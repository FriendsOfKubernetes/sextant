// What an InferenceService's details read beyond the object, all through the shared watch registry (`useWatch`),
// only for kinds the cluster serves, closed when the details close:
//   - the ServingRuntimes of its namespace and the ClusterServingRuntimes (whole objects: the choice reads their
//     formats, protocols and flags), each keeping at most `MAX_RUNTIMES`;
//   - what KServe created for it: Knative Services, Deployments and Services of its namespace selected on the API
//     server by `serving.kserve.io/inferenceservice=<name>`, metadata only (names and the `component` label).
import type { ClusterId, KindRef, KubeObject, WatchSpec } from "../../api";
import { isCapped, useWatch } from "../../api";
import { findKind, useClusterKinds } from "../../resources";
import { KSERVICE } from "../knative/model";
import { CLUSTER_SERVING_RUNTIME, ISVC_LABEL, SERVING_RUNTIME } from "./model";

/** Runtimes one list keeps (a cluster has a handful; a cap all the same). */
export const MAX_RUNTIMES = 500;
/** Objects of one kind KServe made for one InferenceService (a few per component). */
export const MAX_UNDERLYING = 100;
const RUNTIME_OPTIONS = { progressive: false, maxObjects: MAX_RUNTIMES } as const;
const UNDERLYING_OPTIONS = { progressive: false, maxObjects: MAX_UNDERLYING } as const;

export const DEPLOYMENT: KindRef = { group: "apps", version: "v1", kind: "Deployment" };
export const SERVICE: KindRef = { group: "", version: "v1", kind: "Service" };

/** The served version of `kind`; `null` when not served; `undefined` while discovery is coming. */
export function useServed(clusterId: ClusterId, kind: Pick<KindRef, "group" | "kind">): KindRef | null | undefined {
  const kinds = useClusterKinds(clusterId);
  if (kinds.kinds) return findKind(kinds.kinds, kind)?.kindRef ?? null;
  return kinds.error ? null : undefined;
}

export interface Listed {
  items: KubeObject[];
  /** `undefined` while loading. */
  loaded: boolean;
  /** Not served (`notServed`) or not readable (`error`): "none" is not known. */
  notServed: boolean;
  error: boolean;
  truncated: boolean;
}

function listed(state: ReturnType<typeof useWatch>, spec: WatchSpec | null, served: KindRef | null | undefined): Listed {
  const items = [...state.items.values()].sort((a, b) => (a.metadata?.name ?? "").localeCompare(b.metadata?.name ?? ""));
  return {
    items,
    loaded: served === null || (spec !== null && state.status !== "loading"),
    notServed: served === null,
    error: Boolean(state.error) || (state.forbidden ?? []).length > 0,
    truncated: spec !== null && isCapped(state),
  };
}

/** The ServingRuntimes of `namespace` and the ClusterServingRuntimes. */
export function useRuntimes(clusterId: ClusterId, namespace: string | null): { namespaced: Listed; clusterWide: Listed } {
  const nsKind = useServed(clusterId, SERVING_RUNTIME);
  const clusterKind = useServed(clusterId, CLUSTER_SERVING_RUNTIME);
  const nsSpec: WatchSpec | null = nsKind && namespace ? { kind: nsKind, namespaces: [namespace], labelSelector: null, fieldSelector: null } : null;
  const clusterSpec: WatchSpec | null = clusterKind ? { kind: clusterKind, namespaces: null, labelSelector: null, fieldSelector: null } : null;
  const nsState = useWatch(clusterId, nsSpec, RUNTIME_OPTIONS);
  const clusterState = useWatch(clusterId, clusterSpec, RUNTIME_OPTIONS);
  return { namespaced: listed(nsState, nsSpec, nsKind), clusterWide: listed(clusterState, clusterSpec, clusterKind) };
}

/** One kind of what KServe made for the InferenceService `name` (metadata only). */
function useMade(clusterId: ClusterId, kind: KindRef, namespace: string | null, name: string | undefined): Listed {
  const served = useServed(clusterId, kind);
  const spec: WatchSpec | null =
    served && namespace && name ? { kind: served, namespaces: [namespace], labelSelector: `${ISVC_LABEL}=${name}`, fieldSelector: null, metadataOnly: true } : null;
  return listed(useWatch(clusterId, spec, UNDERLYING_OPTIONS), spec, served);
}

export interface Underlying {
  knative: Listed;
  deployments: Listed;
  services: Listed;
}

export function useUnderlying(clusterId: ClusterId, namespace: string | null, name: string | undefined): Underlying {
  return {
    knative: useMade(clusterId, KSERVICE, namespace, name),
    deployments: useMade(clusterId, DEPLOYMENT, namespace, name),
    services: useMade(clusterId, SERVICE, namespace, name),
  };
}
