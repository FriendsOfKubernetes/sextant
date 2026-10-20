// Discovery for the Crossplane views: the served version of a kind, so a kind the cluster does not serve is never
// watched and nothing is watched before discovery.
import type { ClusterId, KindRef } from "../../api";
import { findKind, useClusterKinds } from "../../resources";

/** The served version of `kind`; `null` when not served; `undefined` while discovery is coming. */
export function useServed(clusterId: ClusterId, kind: KindRef): KindRef | null | undefined {
  const kinds = useClusterKinds(clusterId);
  if (kinds.kinds) return findKind(kinds.kinds, kind)?.kindRef ?? null;
  return kinds.error ? null : undefined;
}
