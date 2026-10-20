// Lists the details of the Prometheus Operator kinds read, from the shared watches (src/features/resource-map/watches.ts),
// opened only for kinds the cluster serves and released when the details close:
//   useMonitorTargets — the Services (Pods) a monitor selects: the selector goes to the API server as a label selector,
//                       so only the matching objects are listed, in the monitor's namespaces (at most
//                       `MAX_DETAIL_NAMESPACES`; a monitor of every namespace is listed cluster-wide by its selector,
//                       unless the selector is empty);
//   usePrometheuses   — the Prometheus and PrometheusAgent objects (all namespaces) and, only when one of them selects
//                       namespaces by labels, the Namespaces' labels (metadata only).
import { useMemo } from "react";
import type { ClusterId, KindRef, KubeObject, WatchSpec } from "../../api";
import { findKind, status, useClusterKinds } from "../../resources";
import { useSharedWatches } from "../resource-map/watches";
import type { Labels, Selector } from "../resource-map/selectors";
import { needsNamespaceLabels, PROMETHEUS, PROMETHEUS_AGENT, selectorText, type TargetNamespaces } from "./model";

export const MAX_DETAIL_NAMESPACES = 20;

export type Targets =
  | { status: "loading" }
  /** The selector cannot select anything (an operator the API does not define). */
  | { status: "nothing" }
  /** An empty selector in every namespace: everything, not listed. */
  | { status: "everything" }
  | { status: "tooManyNamespaces"; count: number }
  | { status: "error" }
  | { status: "ready"; objects: KubeObject[] };

export function useMonitorTargets(clusterId: ClusterId, kind: KindRef, where: TargetNamespaces, selector: Selector): Targets {
  const text = selectorText(selector);
  const tooMany = where.type === "list" && where.names.length > MAX_DETAIL_NAMESPACES;
  const everything = where.type === "any" && text === "";
  const key = JSON.stringify([kind, where, text]);
  const specs = useMemo((): WatchSpec[] => {
    if (text === null || tooMany || everything) return [];
    return [
      {
        kind,
        namespaces: where.type === "any" ? null : where.names,
        labelSelector: text || null,
        fieldSelector: null,
      },
    ];
    // `key` stands for kind, where and the selector text.
  }, [key]);
  const [state] = useSharedWatches(clusterId, specs);
  if (text === null) return { status: "nothing" };
  if (tooMany && where.type === "list") return { status: "tooManyNamespaces", count: where.names.length };
  if (everything) return { status: "everything" };
  if (!state || state.status === "loading") return { status: "loading" };
  if (state.status === "error") return { status: "error" };
  return { status: "ready", objects: [...state.items.values()] };
}

export interface Prometheuses {
  loading: boolean;
  /** Prometheus and PrometheusAgent objects. */
  servers: KubeObject[];
  namespaceLabels: (name: string) => Labels | undefined;
}

export function usePrometheuses(clusterId: ClusterId): Prometheuses {
  const { kinds } = useClusterKinds(clusterId);
  const served = useMemo(
    () => (kinds ? [PROMETHEUS, PROMETHEUS_AGENT].map((k) => findKind(kinds, k)?.kindRef).filter((k): k is KindRef => !!k) : []),
    [kinds],
  );
  const specs = useMemo(
    (): WatchSpec[] =>
      served.map((kind) => ({
        kind,
        namespaces: null,
        labelSelector: null,
        fieldSelector: null,
      })),
    [served],
  );
  const states = useSharedWatches(clusterId, specs);
  const servers = useMemo(() => states.flatMap((s) => [...s.items.values()]), [states]);
  const needLabels = needsNamespaceLabels(servers);
  const nsSpecs = useMemo(
    (): WatchSpec[] =>
      needLabels
        ? [
            {
              kind: { group: "", version: "v1", kind: "Namespace" },
              namespaces: null,
              labelSelector: null,
              fieldSelector: null,
              metadataOnly: true,
            },
          ]
        : [],
    [needLabels],
  );
  const [ns] = useSharedWatches(clusterId, nsSpecs);
  const labels = useMemo(() => {
    const map = new Map<string, Labels>();
    for (const n of ns?.items.values() ?? []) map.set(n.metadata?.name ?? "", status.labelsOf(n));
    return map;
  }, [ns]);
  const loading = !kinds || states.some((s) => s.status === "loading") || (needLabels && (!ns || ns.status === "loading"));
  return {
    loading,
    servers,
    namespaceLabels: (name) => (ns?.status === "ready" ? labels.get(name) : undefined),
  };
}
