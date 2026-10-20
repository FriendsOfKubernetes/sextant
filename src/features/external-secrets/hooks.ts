// One named object of a kind the cluster may serve (an ExternalSecret's store), from the shared watches
// (src/features/resource-map/watches.ts): a watch of that one name, opened only once discovery says the kind is served
// and released when the details close.
import { useMemo } from "react";
import type { ClusterId, KindRef, KubeObject, WatchSpec } from "../../api";
import { findKind, useClusterKinds } from "../../resources";
import { useSharedWatches } from "../resource-map/watches";

export interface NamedObject {
  /** `undefined` while it loads or the kind is not served; `null` when there is no such object. */
  obj: KubeObject | null | undefined;
  /** The cluster does not serve the kind (or discovery failed). */
  notServed: boolean;
}

export function useNamedObject(
  clusterId: ClusterId,
  kind: Pick<KindRef, "group" | "kind">,
  namespace: string | null,
  name: string | undefined,
): NamedObject {
  const { kinds, error } = useClusterKinds(clusterId);
  const served = kinds ? findKind(kinds, kind) : undefined;
  const specs = useMemo((): WatchSpec[] => {
    if (!served || !name) return [];
    return [
      {
        kind: served.kindRef,
        namespaces: served.namespaced && namespace ? [namespace] : null,
        labelSelector: null,
        fieldSelector: `metadata.name=${name}`,
      },
    ];
  }, [served, namespace, name]);
  const [state] = useSharedWatches(clusterId, specs);
  if (!kinds) return { obj: undefined, notServed: error !== null };
  if (!served) return { obj: undefined, notServed: true };
  if (!state || state.status === "loading") return { obj: undefined, notServed: false };
  return { obj: [...state.items.values()][0] ?? null, notServed: false };
}
