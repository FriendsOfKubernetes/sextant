// The watches the VPA views open while they are shown, all shared and released when the view closes:
//   - the VPAs and HPAs of one namespace (a VPA's or a workload's), through the autoscaling views' shared namespace
//     lists (`useSharedList`), only where the cluster serves the kind;
//   - a VPA's target by its name (`useObject`), at the version discovery serves for its group and kind;
//   - the components: Deployments of the manifests' three names in kube-system and the charts' Deployments by their
//     `app.kubernetes.io/name`, each listed by the API server's own selector (components.ts).
import { useMemo } from "react";
import type { ClusterId, KubeObject, WatchSpec, WatchState } from "../../api";
import { useObject, useServed, useSharedList } from "../autoscaling/hooks";
import { useSharedWatches } from "../resource-map/watches";
import { CHART_SELECTOR, COMPONENTS, groupComponents, MANIFEST_NAMES, MANIFEST_NAMESPACE, type Component, type FoundComponent } from "./components";
import { DEPLOYMENT, HPA, VPA, type TargetRef } from "./model";

const failed = (s: WatchState | undefined) => s?.status === "error" || (s?.forbidden ?? []).length > 0;

export interface NamespaceList {
  items: KubeObject[];
  /** `undefined` while loading or before discovery; `false` where the kind is not served. */
  served: boolean | undefined;
  loading: boolean;
  /** The list could not be read: "none" is not known. */
  error: boolean;
}

function useList(clusterId: ClusterId, kind: typeof VPA, namespace: string | null | undefined, enabled: boolean): NamespaceList {
  const list = useSharedList(clusterId, kind, namespace ?? null, enabled && Boolean(namespace));
  return {
    items: list.items,
    served: list.served,
    loading: list.served === undefined || (list.served === true && (!list.state || list.state.status === "loading")),
    error: failed(list.state),
  };
}

/** The VPAs of a namespace. */
export const useNamespaceVpas = (clusterId: ClusterId, namespace: string | null | undefined, enabled = true) => useList(clusterId, VPA, namespace, enabled);

/** The HPAs of a namespace. */
export const useNamespaceHpas = (clusterId: ClusterId, namespace: string | null | undefined, enabled = true) => useList(clusterId, HPA, namespace, enabled);

export interface Target {
  /** The object; `undefined` while loading or when it is not found. */
  obj: KubeObject | undefined;
  /** The cluster does not serve the target's kind. */
  notServed: boolean;
}

/** A VPA's target, by name in the VPA's namespace. */
export function useTarget(clusterId: ClusterId, namespace: string | null, ref: TargetRef | undefined): Target {
  const served = useServed(clusterId, { group: ref?.group ?? "", kind: ref?.kind ?? "" });
  const obj = useObject(clusterId, ref ? served : null, namespace, ref?.name);
  return { obj, notServed: Boolean(ref) && served === null };
}

const COMPONENT_SPECS: WatchSpec[] = [
  ...COMPONENTS.map(
    (c): WatchSpec => ({ kind: DEPLOYMENT, namespaces: [MANIFEST_NAMESPACE], labelSelector: null, fieldSelector: `metadata.name=${MANIFEST_NAMES[c]}` }),
  ),
  { kind: DEPLOYMENT, namespaces: null, labelSelector: CHART_SELECTOR, fieldSelector: null },
];
const NO_SPECS: WatchSpec[] = [];

export interface Components {
  /** By component; `undefined` while loading. */
  found: Record<Component, FoundComponent[]> | undefined;
  /** One of the lists could not be read: "not found" is not known. */
  error: boolean;
}

/** The VPA components found in the cluster, while `enabled`. */
export function useComponents(clusterId: ClusterId, enabled = true): Components {
  const states = useSharedWatches(clusterId, enabled ? COMPONENT_SPECS : NO_SPECS);
  return useMemo(() => {
    const error = states.some(failed);
    const readable = states.filter((s) => !failed(s));
    if (states.length === 0 || readable.some((s) => s.status === "loading")) return { found: undefined, error };
    return { found: groupComponents(readable.flatMap((s) => [...s.items.values()])), error };
  }, [states]);
}
