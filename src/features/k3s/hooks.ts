// What the k3s / RKE2 views read beyond the object shown, through the shared watch registry (`useWatch`), closed when
// the view closes, each bounded: the nodes (≤ `MAX_NODES`, the "Distribution" page and nothing else), kube-system's
// Deployments and DaemonSets (≤ `MAX_KUBE_SYSTEM`), its Addons (≤ `MAX_ADDONS`), every HelmChart (≤ `MAX_CHARTS`) and
// the Jobs labelled `helmcharts.helm.cattle.io/chart` (a label selector on the API server, ≤ `MAX_JOBS`), the Jobs
// of one chart, and one HelmChart or HelmChartConfig by name. Kinds of helm-controller and k3s are watched only at the
// version discovery serves, and only once it has come.
import type { ClusterId, KindRef, KubeObject, WatchSpec } from "../../api";
import { useWatch } from "../../api";
import { isCapped } from "../../api/watchState";
import { findKind, useClusterKinds } from "../../resources";
import { ADDON, CHART_LABEL, DAEMONSET, DEPLOYMENT, HELM_CHART, JOB, KUBE_SYSTEM, NODE } from "./model";
import { MAX_CHARTS, MAX_JOBS } from "./provider";

export { MAX_CHARTS, MAX_JOBS };
export const MAX_NODES = 1000;
export const MAX_KUBE_SYSTEM = 1000;
export const MAX_ADDONS = 500;
export const MAX_CHART_JOBS = 20;

export interface Listed {
  items: KubeObject[];
  loading: boolean;
  unavailable: boolean;
  truncated: boolean;
}

/** The served version of `kind`; `null` when not served; `undefined` while discovery is coming. */
export function useServed(clusterId: ClusterId, kind: Pick<KindRef, "group" | "kind">): KindRef | null | undefined {
  const kinds = useClusterKinds(clusterId);
  if (kinds.kinds) return findKind(kinds.kinds, kind)?.kindRef ?? null;
  return kinds.error ? null : undefined;
}

function useListed(clusterId: ClusterId, spec: WatchSpec | null, maxObjects: number): Listed {
  const state = useWatch(clusterId, spec, { progressive: false, maxObjects });
  return {
    items: [...state.items.values()],
    loading: spec !== null && state.status === "loading",
    unavailable: spec === null || Boolean(state.error) || (state.forbidden ?? []).length > 0,
    truncated: spec !== null && isCapped(state),
  };
}

const spec = (kind: KindRef, namespaces: string[] | null, labelSelector: string | null = null, fieldSelector: string | null = null): WatchSpec => ({
  kind,
  namespaces,
  labelSelector,
  fieldSelector,
});

export const useNodes = (clusterId: ClusterId): Listed => useListed(clusterId, spec(NODE, null), MAX_NODES);

export const useKubeSystemDeployments = (clusterId: ClusterId): Listed => useListed(clusterId, spec(DEPLOYMENT, [KUBE_SYSTEM]), MAX_KUBE_SYSTEM);

export const useKubeSystemDaemonSets = (clusterId: ClusterId): Listed => useListed(clusterId, spec(DAEMONSET, [KUBE_SYSTEM]), MAX_KUBE_SYSTEM);

export function useAddons(clusterId: ClusterId): Listed {
  const kind = useServed(clusterId, ADDON);
  return useListed(clusterId, kind ? spec(kind, [KUBE_SYSTEM]) : null, MAX_ADDONS);
}

export function useHelmCharts(clusterId: ClusterId): Listed {
  const kind = useServed(clusterId, HELM_CHART);
  return useListed(clusterId, kind ? spec(kind, null) : null, MAX_CHARTS);
}

/** Every Job helm-controller runs (the same list the problems read). */
export const useChartJobs = (clusterId: ClusterId): Listed => useListed(clusterId, spec(JOB, null, CHART_LABEL), MAX_JOBS);

/** The Jobs of one HelmChart, in its namespace. */
export const useJobsOfChart = (clusterId: ClusterId, namespace: string | undefined, chart: string | undefined): Listed =>
  useListed(clusterId, namespace && chart ? spec(JOB, [namespace], `${CHART_LABEL}=${chart}`) : null, MAX_CHART_JOBS);

/** One object by name (a HelmChart's HelmChartConfig, a HelmChartConfig's HelmChart), of a served kind. */
export function useNamed(clusterId: ClusterId, kind: Pick<KindRef, "group" | "kind">, namespace: string | undefined, name: string | undefined): { obj?: KubeObject; loading: boolean; notServed: boolean } {
  const served = useServed(clusterId, kind);
  const listed = useListed(clusterId, served && namespace && name ? spec(served, [namespace], null, `metadata.name=${name}`) : null, 1);
  return { ...(listed.items[0] ? { obj: listed.items[0] } : {}), loading: served === undefined || listed.loading, notServed: served === null };
}
