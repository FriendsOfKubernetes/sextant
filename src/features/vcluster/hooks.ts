// What the vcluster views watch, through the shared watch registry (`useWatch`), closed when the view closes. Every list
// is bounded: the control planes by the API server's own selector `app=vcluster` (StatefulSets and Deployments, at
// most `MAX_INSTANCES` each), in the namespaces of the filter or cluster-wide; their pods and Services by the same
// selector, and the Secrets (metadata only — no value reaches the window) only in the first `MAX_NAMESPACES`
// namespaces that hold an instance; the synced objects of one vcluster by `vcluster.loft.sh/managed-by=<name>` in its
// namespace, metadata only, at most `MAX_SYNCED` per kind.
import { useMemo } from "react";
import type { ClusterId, KindRef, KubeObject, WatchSpec, WatchState } from "../../api";
import { useWatch } from "../../api";
import { isCapped } from "../../api/watchState";
import {
  CONTROL_PLANE_SELECTOR,
  DEPLOYMENT,
  instancesOf,
  MANAGED_BY_LABEL,
  namespacesOf,
  POD,
  SECRET,
  SERVICE,
  STATEFUL_SET,
  type Instance,
} from "./model";

export const MAX_INSTANCES = 500;
export const MAX_NAMESPACES = 40;
export const MAX_PODS = 2000;
export const MAX_SECRETS = 5000;
export const MAX_SYNCED = 500;

export interface Listed {
  items: KubeObject[];
  loading: boolean;
  /** The list could not be read (an error, or a namespace without permission). */
  unavailable: boolean;
  truncated: boolean;
}

/** `watched`: a spec was asked for (without one nothing is loading or missing). */
const listed = (watched: boolean, state: WatchState): Listed => ({
  items: [...state.items.values()],
  loading: watched && state.status === "loading",
  unavailable: watched && (state.status === "error" || (state.forbidden ?? []).length > 0),
  truncated: watched && isCapped(state),
});

const spec = (kind: KindRef, namespaces: string[] | null, labelSelector: string | null, metadataOnly = false): WatchSpec => ({
  kind,
  namespaces,
  labelSelector,
  fieldSelector: null,
  ...(metadataOnly ? { metadataOnly: true } : {}),
});

export interface Instances {
  instances: Instance[];
  loading: boolean;
  unavailable: boolean;
  truncated: boolean;
}

/** The vcluster control planes of `namespaces` (`null`: every namespace; `undefined`: not yet known, nothing is watched). */
export function useInstances(clusterId: ClusterId, namespaces: string[] | null | undefined): Instances {
  const options = { progressive: false, maxObjects: MAX_INSTANCES };
  const watched = namespaces !== undefined;
  const sets = useWatch(clusterId, watched ? spec(STATEFUL_SET, namespaces, CONTROL_PLANE_SELECTOR) : null, options);
  const deployments = useWatch(clusterId, watched ? spec(DEPLOYMENT, namespaces, CONTROL_PLANE_SELECTOR) : null, options);
  return useMemo(() => {
    const a = listed(watched, sets);
    const b = listed(watched, deployments);
    return {
      instances: instancesOf([...a.items, ...b.items]),
      loading: !watched || a.loading || b.loading,
      unavailable: a.unavailable || b.unavailable,
      truncated: a.truncated || b.truncated,
    };
  }, [watched, sets, deployments]);
}

export interface Around {
  pods: Listed;
  services: Listed;
  secrets: Listed;
}

/** The control-plane pods, the vcluster Services and the Secrets (metadata only) of the instances' namespaces. */
export function useAround(clusterId: ClusterId, instances: readonly Instance[]): Around {
  const key = namespacesOf(instances, MAX_NAMESPACES).join(",");
  const namespaces = key ? key.split(",") : null;
  const podSpec = namespaces ? spec(POD, namespaces, CONTROL_PLANE_SELECTOR) : null;
  const serviceSpec = namespaces ? spec(SERVICE, namespaces, CONTROL_PLANE_SELECTOR, true) : null;
  const secretSpec = namespaces ? spec(SECRET, namespaces, null, true) : null;
  const pods = useWatch(clusterId, podSpec, { progressive: false, maxObjects: MAX_PODS });
  const services = useWatch(clusterId, serviceSpec, { progressive: false, maxObjects: MAX_INSTANCES });
  const secrets = useWatch(clusterId, secretSpec, { progressive: false, maxObjects: MAX_SECRETS });
  return {
    pods: listed(podSpec !== null, pods),
    services: listed(serviceSpec !== null, services),
    secrets: listed(secretSpec !== null, secrets),
  };
}

/** The kinds whose synced copies the details list (what the syncer copies to the host by default). */
export const SYNCED_KINDS: KindRef[] = [
  POD,
  SERVICE,
  { group: "", version: "v1", kind: "ConfigMap" },
  SECRET,
  { group: "", version: "v1", kind: "PersistentVolumeClaim" },
  { group: "", version: "v1", kind: "ServiceAccount" },
  { group: "networking.k8s.io", version: "v1", kind: "Ingress" },
];

/** The host objects of one kind the syncer copied from the vcluster `name` (metadata only). */
export function useSynced(clusterId: ClusterId, kind: KindRef, namespace: string, name: string, enabled = true): Listed {
  const watched = enabled ? spec(kind, [namespace], `${MANAGED_BY_LABEL}=${name}`, true) : null;
  return listed(enabled, useWatch(clusterId, watched, { progressive: false, maxObjects: MAX_SYNCED }));
}
