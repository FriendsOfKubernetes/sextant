// What OLM details watch while open, through the shared watch registry, each list in one namespace and bounded: a
// named object (a Subscription's InstallPlan and installed CSV, a copy's original CSV) by `metadata.name=`, the
// Deployments OLM made for a CSV by the labels it puts on them (`olm.owner=<csv>,olm.owner.kind=ClusterServiceVersion`,
// pkg/lib/ownerutil/util.go), and a namespace's Subscriptions (the one that installed a CSV). Closed with the details.
import { useMemo } from "react";
import { useWatch, type ClusterId, type KindRef, type KubeObject, type WatchSpec } from "../../api";
import { isCapped } from "../../api/watchState";
import { deploymentSelector, SUBSCRIPTION } from "./model";

/** Deployments of one CSV listed at most. */
export const MAX_DEPLOYMENTS = 50;
/** Subscriptions of one namespace listed at most. */
export const MAX_SUBSCRIPTIONS = 500;
const DEPLOYMENT: KindRef = { group: "apps", version: "v1", kind: "Deployment" };

export interface Listed {
  items: KubeObject[];
  loading: boolean;
  failed: boolean;
  truncated: boolean;
}

function useListed(clusterId: ClusterId, spec: WatchSpec | null, max: number): Listed {
  const state = useWatch(clusterId, spec, { progressive: false, maxObjects: max });
  return useMemo(() => {
    const items = [...state.items.values()].sort((a, b) => (a.metadata?.name ?? "").localeCompare(b.metadata?.name ?? ""));
    return {
      items,
      loading: spec !== null && state.status === "loading",
      failed: spec !== null && (Boolean(state.error) || state.status === "error"),
      truncated: spec !== null && isCapped(state),
    };
  }, [state, spec]);
}

/** One object by name in a namespace; `null` while unknown or when there is none. */
export function useNamed(clusterId: ClusterId, kind: KindRef, namespace: string | undefined, name: string | undefined): Listed {
  const spec = useMemo<WatchSpec | null>(
    () => (namespace && name ? { kind, namespaces: [namespace], labelSelector: null, fieldSelector: `metadata.name=${name}` } : null),
    [kind, namespace, name],
  );
  return useListed(clusterId, spec, 1);
}

/** The Deployments OLM made for the CSV, in its namespace. */
export function useCsvDeployments(clusterId: ClusterId, csv: KubeObject | null): Listed {
  const ns = csv?.metadata?.namespace;
  const selector = csv ? deploymentSelector(csv) : undefined;
  const spec = useMemo<WatchSpec | null>(
    () => (ns && selector ? { kind: DEPLOYMENT, namespaces: [ns], labelSelector: selector, fieldSelector: null } : null),
    [ns, selector],
  );
  return useListed(clusterId, spec, MAX_DEPLOYMENTS);
}

/** The Subscriptions of a namespace. */
export function useSubscriptions(clusterId: ClusterId, namespace: string | undefined): Listed {
  const spec = useMemo<WatchSpec | null>(
    () => (namespace ? { kind: SUBSCRIPTION, namespaces: [namespace], labelSelector: null, fieldSelector: null } : null),
    [namespace],
  );
  return useListed(clusterId, spec, MAX_SUBSCRIPTIONS);
}
