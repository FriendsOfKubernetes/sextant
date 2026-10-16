// What the request check matches against, watched only while its page is open: Gateways, HTTPRoutes, GRPCRoutes and
// ReferenceGrants of the versions the cluster serves (none for a kind it does not serve), Services and EndpointSlices,
// all in every namespace, and the Namespaces' metadata only (their labels decide `allowedRoutes.namespaces.from:
// Selector`). A list that is still coming, failed or left namespaces out is not given to the engine, so
// it never reports a backend missing for lack of data.
import { useMemo } from "react";
import { useWatch, type ClusterId, type KindRef, type KubeObject, type WatchSpec, type WatchState } from "../../api";
import { useClusterKinds } from "../../resources";
import { ENDPOINT_SLICE, everywhere, SERVICE, servedKind } from "./hooks";
import type { ClusterSnapshot } from "./matching";
import { GATEWAY, GRPC_ROUTE, HTTP_ROUTE, REFERENCE_GRANT } from "./model";

export interface CheckData {
  snapshot: ClusterSnapshot;
  /** Discovery or a list has not come yet. */
  loading: boolean;
  /** Discovery came and the cluster serves no Gateway. */
  notServed: boolean;
}

const NAMESPACE: KindRef = { group: "", version: "v1", kind: "Namespace" };

/** Namespaces with their labels: metadata only, no spec or status. */
const NAMESPACE_LABELS: WatchSpec = { kind: NAMESPACE, namespaces: null, labelSelector: null, fieldSelector: null, metadataOnly: true };

const list = (w: WatchState): KubeObject[] => [...w.items.values()];

/** Every item, only once the list is complete (ready, no namespace left out). */
const complete = (w: WatchState): KubeObject[] | undefined =>
  w.status === "ready" && !(w.forbidden && w.forbidden.length > 0) ? list(w) : undefined;

export function useCheckData(clusterId: ClusterId): CheckData {
  const kinds = useClusterKinds(clusterId);
  const known = kinds.kinds !== null || kinds.error !== null;
  const gatewayKind = servedKind(kinds, GATEWAY);
  const httpKind = servedKind(kinds, HTTP_ROUTE);
  const grpcKind = servedKind(kinds, GRPC_ROUTE);
  const grantKind = servedKind(kinds, REFERENCE_GRANT);
  const gateways = useWatch(clusterId, everywhere(gatewayKind));
  const httpRoutes = useWatch(clusterId, everywhere(httpKind));
  const grpcRoutes = useWatch(clusterId, everywhere(grpcKind));
  const grants = useWatch(clusterId, everywhere(grantKind));
  const services = useWatch(clusterId, everywhere(known ? SERVICE : undefined));
  const slices = useWatch(clusterId, everywhere(known ? ENDPOINT_SLICE : undefined));
  const namespaces = useWatch(clusterId, known ? NAMESPACE_LABELS : null);

  const snapshot = useMemo<ClusterSnapshot>(
    () => ({
      gateways: list(gateways),
      httpRoutes: list(httpRoutes),
      grpcRoutes: list(grpcRoutes),
      services: complete(services),
      endpointSlices: complete(slices),
      referenceGrants: grantKind === null ? [] : complete(grants),
      namespaces: complete(namespaces),
    }),
    [gateways, httpRoutes, grpcRoutes, grants, services, slices, namespaces, grantKind],
  );
  const pending = (kind: unknown, w: WatchState) => kind === undefined || (kind !== null && w.status === "loading");
  const loading =
    pending(gatewayKind, gateways) ||
    pending(httpKind, httpRoutes) ||
    pending(grpcKind, grpcRoutes) ||
    pending(grantKind, grants) ||
    !known ||
    services.status === "loading" ||
    slices.status === "loading" ||
    namespaces.status === "loading";
  return { snapshot, loading, notServed: gatewayKind === null };
}
