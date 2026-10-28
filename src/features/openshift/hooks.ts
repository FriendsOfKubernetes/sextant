// What the OpenShift details read beyond the object, each through the shared watch registry (`useWatch`), in the
// object's own namespace only, closed when the details close: a DeploymentConfig's ReplicationControllers (by the
// `openshift.io/deployment-config.name` label), a BuildConfig's Builds (by `openshift.io/build-config.name`), one pod by
// name (a build's pod, for its logs), and a Route's Services and the namespace's pods (for its backends).
import type { ClusterId, KindRef, KubeObject, WatchSpec } from "../../api";
import { isCapped, useWatch } from "../../api";
import { BC_LABEL, BUILD, DC_NAME_LABEL, labelValue, REPLICATION_CONTROLLER } from "./model";

export const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
export const SERVICE: KindRef = { group: "", version: "v1", kind: "Service" };
/** ReplicationControllers one DeploymentConfig's watch keeps (`revisionHistoryLimit` is 10 by default). */
export const MAX_RCS = 200;
/** Builds one BuildConfig's watch keeps (the history limits keep 5 + 5 by default). */
export const MAX_BUILDS = 500;
const RC_OPTIONS = { progressive: false, maxObjects: MAX_RCS } as const;
const BUILD_OPTIONS = { progressive: false, maxObjects: MAX_BUILDS } as const;

export interface Listed {
  items: KubeObject[];
  loading: boolean;
  /** The list could not be read (no permission, an error). */
  error: boolean;
  /** More match than the watch keeps. */
  truncated: boolean;
}

const selected = (kind: KindRef, namespace: string | null | undefined, selector: string | null, field: string | null = null): WatchSpec | null =>
  namespace ? { kind, namespaces: [namespace], labelSelector: selector, fieldSelector: field } : null;

function useListed(clusterId: ClusterId, spec: WatchSpec | null, options?: typeof RC_OPTIONS | typeof BUILD_OPTIONS): Listed {
  const state = useWatch(clusterId, spec, options);
  return {
    items: [...state.items.values()],
    loading: spec !== null && state.status === "loading",
    error: Boolean(state.error) || (state.forbidden ?? []).length > 0,
    truncated: spec !== null && isCapped(state),
  };
}

/** The ReplicationControllers labelled with the DeploymentConfig's name. */
export function useDcControllers(clusterId: ClusterId, dc: KubeObject | null): Listed {
  const name = dc?.metadata?.name;
  return useListed(clusterId, name ? selected(REPLICATION_CONTROLLER, dc?.metadata?.namespace, `${DC_NAME_LABEL}=${labelValue(name)}`) : null, RC_OPTIONS);
}

/** The Builds labelled with the BuildConfig's name (cut as the build controller cuts it). */
export function useConfigBuilds(clusterId: ClusterId, bc: KubeObject | null, build: KindRef = BUILD): Listed {
  const name = bc?.metadata?.name;
  return useListed(clusterId, name ? selected(build, bc?.metadata?.namespace, `${BC_LABEL}=${labelValue(name)}`) : null, BUILD_OPTIONS);
}

/** One pod by name. */
export function usePod(clusterId: ClusterId, namespace: string | null | undefined, name: string | undefined): { pod?: KubeObject; loading: boolean } {
  const listed = useListed(clusterId, name ? selected(POD, namespace, null, `metadata.name=${name}`) : null);
  return { pod: listed.items.find((p) => p.metadata?.name === name), loading: listed.loading };
}

/** The Services and pods of a namespace (the lists the traffic diagnosis watches too). */
export function useNamespaceBackends(clusterId: ClusterId, namespace: string | null | undefined): { services: Listed; pods: Listed } {
  return { services: useListed(clusterId, selected(SERVICE, namespace, null)), pods: useListed(clusterId, selected(POD, namespace, null)) };
}
