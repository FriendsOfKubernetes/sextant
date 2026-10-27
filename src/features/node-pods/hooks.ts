// The node's pods and their usage. The pods come from one watch by `spec.nodeName` — the same list the tables of the
// two tabs and the resource map's "Related" tab ask for, so the shared watch registry holds it once (ADR-0091). Their
// usage is the metrics poll of their namespaces (the selected namespaces' poll when it covers them, the poll of every
// namespace when another view holds it), asked only while a source of current values is there — at most
// `MAX_USAGE_NAMESPACES` namespaces by name, never cluster-wide on its own (`usePodUsageOfMany`).
import { useMemo } from "react";
import { useWatch, type ClusterId, type KubeObject, type NodeUsage, type WatchState } from "../../api";
import { usageUnavailable, useMetricsStatus, useNodeUsage, type Polled } from "../metrics";
import { usePodUsageOfMany, type ManyPodUsage } from "../metrics/hooks";
import { namespacesOf, nodePodsSpec } from "./model";

/** The pods' usage is asked for at most this many namespaces by name; above it for the first ones only (`partial`). */
export const MAX_USAGE_NAMESPACES = 40;

export function useNodePods(clusterId: ClusterId, node: string): { pods: KubeObject[]; watch: WatchState } {
  const spec = useMemo(() => nodePodsSpec(node), [node]);
  const watch = useWatch(clusterId, spec);
  const pods = useMemo(() => [...watch.items.values()], [watch.items]);
  return { pods, watch };
}

export interface NodePodUsage {
  pods: ManyPodUsage;
  node: Polled<Map<string, NodeUsage>>;
  /** No source of current values, or the last request failed: usage cells say "n/a". */
  unavailable: boolean;
  /** Still waiting for the first status or answer. */
  loading: boolean;
}

/** Current usage of `pods` (and of every node) from the cluster's source of current values. */
export function useNodePodUsage(clusterId: ClusterId, pods: readonly KubeObject[]): NodePodUsage {
  const status = useMetricsStatus(clusterId);
  const live = status.data !== null && status.data.effectiveUsageSource !== null;
  const namespaces = useMemo(() => namespacesOf(pods), [pods]);
  const podUsage = usePodUsageOfMany(clusterId, namespaces, MAX_USAGE_NAMESPACES, live && pods.length > 0);
  const nodeUsage = useNodeUsage(clusterId, live);
  return {
    pods: podUsage,
    node: nodeUsage,
    unavailable: usageUnavailable(status, podUsage),
    loading: status.loading || (live && podUsage.loading && pods.length > 0),
  };
}
