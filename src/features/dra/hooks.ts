// What the DRA views read beyond the object shown, all through the shared watch registry (`useWatch`), only for
// kinds the cluster serves, closed when the view closes:
//   - the ResourceClaims of one namespace (a pod's or a claim's), at most `MAX_NAMESPACE_CLAIMS`;
//   - the Pending pods of one namespace (`status.phase=Pending` on the API server), for the pods a claim waits for;
//   - the ResourceSlices of one node (`spec.nodeName=<node>` on the API server), or every slice for the devices page,
//     at most `MAX_SLICES` (the issue's bound: slices of the nodes in view);
//   - every ResourceClaim, at most `MAX_ALL_CLAIMS`, only to mark which devices of the slices shown are allocated.
import type { ClusterId, KindRef, KubeObject, WatchSpec } from "../../api";
import { useWatch } from "../../api";
import { isCapped } from "../../api/watchState";
import { findKind, useClusterKinds } from "../../resources";
import { allocatedDevicesOf, deviceKey, POD, RESOURCE_CLAIM, RESOURCE_SLICE } from "./model";

export const MAX_NAMESPACE_CLAIMS = 1000;
export const MAX_SLICES = 500;
export const MAX_ALL_CLAIMS = 5000;
export const MAX_NAMESPACE_PENDING = 500;

/** The served version of `kind`; `null` when not served; `undefined` while discovery is coming. */
export function useServed(clusterId: ClusterId, kind: Pick<KindRef, "group" | "kind">): KindRef | null | undefined {
  const kinds = useClusterKinds(clusterId);
  if (kinds.kinds) return findKind(kinds.kinds, kind)?.kindRef ?? null;
  return kinds.error ? null : undefined;
}

export interface Listed {
  items: KubeObject[];
  loading: boolean;
  /** Not served, forbidden or failed: nothing can be said from the list. */
  unavailable: boolean;
  truncated: boolean;
}

function useList(clusterId: ClusterId, kind: KindRef | null | undefined, spec: Omit<WatchSpec, "kind"> | null, max: number): Listed {
  const full = kind && spec ? { ...spec, kind } : null;
  const state = useWatch(clusterId, full, { progressive: false, maxObjects: max });
  return {
    items: [...state.items.values()],
    loading: kind === undefined || (full !== null && state.status === "loading"),
    unavailable: kind === null || Boolean(state.error) || (full !== null && (state.forbidden ?? []).length > 0),
    truncated: full !== null && isCapped(state),
  };
}

/** The ResourceClaims of `namespace` (nothing without one). */
export function useNamespaceClaims(clusterId: ClusterId, namespace: string | null, enabled = true): Listed {
  const kind = useServed(clusterId, RESOURCE_CLAIM);
  const spec = enabled && namespace ? { namespaces: [namespace], labelSelector: null, fieldSelector: null } : null;
  return useList(clusterId, kind, spec, MAX_NAMESPACE_CLAIMS);
}

/** The Pending pods of `namespace` (nothing without one, or when not `enabled`). */
export function useNamespacePendingPods(clusterId: ClusterId, namespace: string | null, enabled: boolean): Listed {
  const spec = enabled && namespace ? { namespaces: [namespace], labelSelector: null, fieldSelector: "status.phase=Pending" } : null;
  return useList(clusterId, POD, spec, MAX_NAMESPACE_PENDING);
}

/** The ResourceSlices of one node, or every slice (`node` null). */
export function useSlices(clusterId: ClusterId, node: string | null, enabled = true): Listed {
  const kind = useServed(clusterId, RESOURCE_SLICE);
  const spec = enabled ? { namespaces: null, labelSelector: null, fieldSelector: node ? `spec.nodeName=${node}` : null } : null;
  return useList(clusterId, kind, spec, MAX_SLICES);
}

/** Every ResourceClaim (only when `enabled`). */
export function useAllClaims(clusterId: ClusterId, enabled: boolean): Listed {
  const kind = useServed(clusterId, RESOURCE_CLAIM);
  return useList(clusterId, kind, enabled ? { namespaces: null, labelSelector: null, fieldSelector: null } : null, MAX_ALL_CLAIMS);
}

export interface Allocation {
  namespace: string;
  claim: string;
  request: string;
  /** The claim's apiVersion, for its link. */
  apiVersion: string;
}

/** Which claim holds each device (`driver/pool/device`); a device shared by several claims keeps them all. */
export function allocationIndex(claims: readonly KubeObject[]): Map<string, Allocation[]> {
  const out = new Map<string, Allocation[]>();
  for (const claim of claims) {
    for (const d of allocatedDevicesOf(claim)) {
      const key = deviceKey(d);
      const list = out.get(key) ?? [];
      list.push({
        namespace: claim.metadata?.namespace ?? "",
        claim: claim.metadata?.name ?? "",
        request: d.request,
        apiVersion: claim.apiVersion ?? "resource.k8s.io/v1",
      });
      out.set(key, list);
    }
  }
  return out;
}
