// Live lists the Gateway API views share: the version of a kind the cluster serves, routes of every served kind,
// ReferenceGrants of some namespaces and the Services and EndpointSlices behind backends. A kind the cluster does not
// serve is never watched, and nothing is watched before discovery comes; lists of namespaces stay bounded to the
// namespaces asked for. Every watch ends when the component using it unmounts (`useWatch`).
import { useWatch, type ClusterId, type KindRef, type KubeObject, type WatchSpec, type WatchState } from "../../api";
import { findKind, useClusterKinds } from "../../resources";
import { GRPC_ROUTE, HTTP_ROUTE, REFERENCE_GRANT, serviceReadiness, TCP_ROUTE, TLS_ROUTE, UDP_ROUTE, type BackendRef } from "./model";

export const SERVICE: KindRef = { group: "", version: "v1", kind: "Service" };
export const ENDPOINT_SLICE: KindRef = { group: "discovery.k8s.io", version: "v1", kind: "EndpointSlice" };
export const INGRESS: KindRef = { group: "networking.k8s.io", version: "v1", kind: "Ingress" };

/**
 * The version to watch `kind` in: the one the cluster serves; `null` when it does not serve the kind; `undefined`
 * while discovery is coming (the registered version when discovery failed).
 */
export function servedKind(kinds: ReturnType<typeof useClusterKinds>, kind: KindRef): KindRef | null | undefined {
  if (kinds.kinds) return findKind(kinds.kinds, kind)?.kindRef ?? null;
  return kinds.error ? kind : undefined;
}

/** A watch of `kind` in all namespaces; none for a kind not served (or not known yet). */
export function everywhere(kind: KindRef | null | undefined): WatchSpec | null {
  return kind ? { kind, namespaces: null, labelSelector: null, fieldSelector: null } : null;
}

/** A watch of `kind` in `namespaces` only; none for no namespaces or a kind not served. */
export function inNamespaces(kind: KindRef | null | undefined, namespaces: readonly string[]): WatchSpec | null {
  return kind && namespaces.length > 0
    ? { kind, namespaces: [...new Set(namespaces)].sort(), labelSelector: null, fieldSelector: null }
    : null;
}

/** The route kinds, in the order the views list them. */
export const ROUTE_KINDS_ORDER: KindRef[] = [HTTP_ROUTE, GRPC_ROUTE, TLS_ROUTE, TCP_ROUTE, UDP_ROUTE];

export interface ServedRoutes {
  /** The routes of each served kind (the registered kind, for the model), in `ROUTE_KINDS_ORDER`. */
  routes: { kind: KindRef; items: KubeObject[] }[];
  /** Discovery or a list has not come yet. */
  loading: boolean;
  failed?: boolean;
}

/** Routes of every served kind in all namespaces (`enabled` false watches nothing). */
export function useServedRoutes(clusterId: ClusterId, enabled = true): ServedRoutes {
  const kinds = useClusterKinds(clusterId);
  const served = ROUTE_KINDS_ORDER.map((kind) => (enabled ? servedKind(kinds, kind) : null));
  // One watch per route kind, always called in the same order.
  const watches: WatchState[] = [
    useWatch(clusterId, everywhere(served[0])),
    useWatch(clusterId, everywhere(served[1])),
    useWatch(clusterId, everywhere(served[2])),
    useWatch(clusterId, everywhere(served[3])),
    useWatch(clusterId, everywhere(served[4])),
  ];
  const loading = served.some((kind, i) => kind === undefined || (kind !== null && watches[i]?.status === "loading"));
  const routes = ROUTE_KINDS_ORDER.flatMap((kind, i) =>
    served[i] ? [{ kind, items: [...(watches[i]?.items.values() ?? [])] }] : [],
  );
  const failed = Boolean(kinds.error) || served.some((kind, i) => kind && (watches[i]?.status === "error" || (watches[i]?.forbidden?.length ?? 0) > 0));
  return { routes, loading, failed };
}

/**
 * The ReferenceGrants of `namespaces` (watched only while there are some): `grantsIn(ns)` is the list of a namespace,
 * `[]` when the cluster serves no ReferenceGrant, `undefined` while unknown (loading, failed, no permission there).
 */
export function useGrants(clusterId: ClusterId, namespaces: string[]) {
  const kinds = useClusterKinds(clusterId);
  const served = servedKind(kinds, REFERENCE_GRANT);
  const grants = useWatch(clusterId, inNamespaces(served, namespaces));
  return (namespace: string): readonly KubeObject[] | undefined => {
    if (served === null) return [];
    if (!served || grants.status !== "ready" || grants.forbidden?.includes(namespace)) return undefined;
    return [...grants.items.values()].filter((g) => g.metadata?.namespace === namespace);
  };
}

/**
 * Services and EndpointSlices of the namespaces backends are in: which backends exist and how many of their pods are
 * ready. A list that fails (no permission) leaves its namespace unknown.
 */
export function useBackendState(clusterId: ClusterId, namespaces: string[]) {
  const services = useWatch(clusterId, inNamespaces(SERVICE, namespaces));
  const slices = useWatch(clusterId, inNamespaces(ENDPOINT_SLICE, namespaces));
  const servicesIn = (namespace: string): ReadonlySet<string> | undefined => {
    if (services.status !== "ready" || services.forbidden?.includes(namespace)) return undefined;
    return new Set(
      [...services.items.values()].filter((s) => s.metadata?.namespace === namespace).map((s) => s.metadata?.name ?? ""),
    );
  };
  const readiness = (b: BackendRef) =>
    slices.status === "ready" && b.namespace && !slices.forbidden?.includes(b.namespace)
      ? serviceReadiness(slices.items.values(), { namespace: b.namespace, name: b.name })
      : undefined;
  return { servicesIn, readiness };
}
