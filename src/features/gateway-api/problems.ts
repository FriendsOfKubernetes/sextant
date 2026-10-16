// The problem counter of the Gateway API section: how many GatewayClasses, Gateways, routes and BackendTLSPolicies of
// the cluster are not `ok` (`isProblem`). It watches every served kind of the section in all namespaces; kinds the
// cluster does not serve are not watched, and nothing is watched before discovery comes.
import { useWatch, type ClusterId, type KindRef, type WatchSpec } from "../../api";
import { findKind, useClusterKinds } from "../../resources";
import {
  BACKEND_TLS_POLICY,
  GATEWAY,
  GATEWAY_CLASS,
  GRPC_ROUTE,
  HTTP_ROUTE,
  problemCount,
  TCP_ROUTE,
  TLS_ROUTE,
  UDP_ROUTE,
} from "./model";

/** The kinds that have a status worth counting (ReferenceGrants have none). */
export const COUNTED_KINDS: KindRef[] = [
  GATEWAY_CLASS,
  GATEWAY,
  HTTP_ROUTE,
  GRPC_ROUTE,
  TLS_ROUTE,
  TCP_ROUTE,
  UDP_ROUTE,
  BACKEND_TLS_POLICY,
];

export interface GatewayProblems {
  /** Objects not `ok` among those listed so far. */
  count: number;
  /** Discovery or a list has not come yet. */
  loading: boolean;
}

/** Problems of the Gateway API section in `clusterId` (0 where the cluster serves none of its kinds). */
export function useGatewayProblems(clusterId: ClusterId): GatewayProblems {
  const { kinds, error } = useClusterKinds(clusterId);
  const served = COUNTED_KINDS.map((kind) => (kinds ? (findKind(kinds, kind)?.kindRef ?? null) : error ? null : undefined));
  const spec = (i: number): WatchSpec | null => {
    const kind = served[i];
    return kind ? { kind, namespaces: null, labelSelector: null, fieldSelector: null } : null;
  };
  // One watch per kind, always called in the same order.
  const watches = [
    useWatch(clusterId, spec(0)),
    useWatch(clusterId, spec(1)),
    useWatch(clusterId, spec(2)),
    useWatch(clusterId, spec(3)),
    useWatch(clusterId, spec(4)),
    useWatch(clusterId, spec(5)),
    useWatch(clusterId, spec(6)),
    useWatch(clusterId, spec(7)),
  ];
  let count = 0;
  let loading = false;
  COUNTED_KINDS.forEach((kind, i) => {
    const watch = watches[i];
    if (served[i] === undefined) loading = true;
    if (!served[i] || !watch) return;
    if (watch.status === "loading") loading = true;
    count += problemCount(watch.items.values(), kind);
  });
  return { count, loading };
}

/** The section counter's hook (`registerSectionBadge`): the number of problems. */
export function useGatewayProblemCount(clusterId: ClusterId): number {
  return useGatewayProblems(clusterId).count;
}
