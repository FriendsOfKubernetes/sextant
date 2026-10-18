// Change timeline (#145), the React side: the recorded changes of a cluster, the partial history the cluster keeps
// (asked when shown, and again on Refresh), and the signals of the problem sources the window already watches.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  api,
  toApiError,
  useSettings,
  type ApiError,
  type ClusterId,
  type KindRef,
  type ObjectRef,
  type PartialHistory,
} from "../../api";
import { findKind, useClusterKinds } from "../../resources";
import { PROBLEM_CATEGORIES } from "../problems/model";
import { useCategoriesOn, useProblemSources } from "../problems/hooks";
import { signalsOf, type Signal } from "./correlate";
import { getTimeline, subscribeTimeline, timelineSaveError, timelineVersion, type ChangeEntry } from "./recorder";

/** The recorded changes of the cluster, oldest first. */
export function useTimeline(clusterId: ClusterId): readonly ChangeEntry[] {
  const version = useSyncExternalStore(subscribeTimeline, timelineVersion, timelineVersion);
  return useMemo(() => {
    void version;
    return getTimeline(clusterId);
  }, [clusterId, version]);
}

/** Why the last save of a timeline failed, `null` when it worked. */
export function useSaveError(): ApiError | null {
  const version = useSyncExternalStore(subscribeTimeline, timelineVersion, timelineVersion);
  return useMemo(() => {
    void version;
    return timelineSaveError();
  }, [version]);
}

/** Whether recorded changes are kept between runs (`settings.timeline.persist`). */
export function usePersist(): boolean {
  return useSettings().settings?.timeline?.persist === true;
}

/** Problems and Warning events of the sources the window watches (shared with the problems screen). */
export function useSignals(clusterId: ClusterId): Signal[] {
  const sources = useProblemSources(clusterId, useCategoriesOn(PROBLEM_CATEGORIES));
  return useMemo(() => signalsOf(sources), [sources]);
}

const k = (group: string, version: string, kind: string): KindRef => ({ group, version, kind });

/** Built-in kinds whose last changes the partial history lists (a ReplicaSet gives its revision). */
export const HISTORY_KINDS: readonly KindRef[] = [
  k("apps", "v1", "Deployment"),
  k("apps", "v1", "StatefulSet"),
  k("apps", "v1", "DaemonSet"),
  k("apps", "v1", "ReplicaSet"),
  k("apps", "v1", "ControllerRevision"),
  k("batch", "v1", "CronJob"),
  k("", "v1", "ConfigMap"),
  k("", "v1", "Secret"),
  k("", "v1", "Service"),
  k("", "v1", "ServiceAccount"),
  k("", "v1", "PersistentVolumeClaim"),
  k("networking.k8s.io", "v1", "Ingress"),
  k("networking.k8s.io", "v1", "NetworkPolicy"),
  k("autoscaling", "v2", "HorizontalPodAutoscaler"),
  k("policy", "v1", "PodDisruptionBudget"),
  k("rbac.authorization.k8s.io", "v1", "Role"),
  k("rbac.authorization.k8s.io", "v1", "RoleBinding"),
];

/** Kinds of installed tools, listed only when the cluster serves them. */
const TOOL_KINDS: readonly Pick<KindRef, "group" | "kind">[] = [
  { group: "kustomize.toolkit.fluxcd.io", kind: "Kustomization" },
  { group: "helm.toolkit.fluxcd.io", kind: "HelmRelease" },
  { group: "argoproj.io", kind: "Application" },
  { group: "gateway.networking.k8s.io", kind: "Gateway" },
  { group: "gateway.networking.k8s.io", kind: "HTTPRoute" },
  { group: "cert-manager.io", kind: "Certificate" },
];

/** Namespaces the partial history reads at once. */
export const MAX_HISTORY_NAMESPACES = 10;

export interface PartialState {
  data: PartialHistory | null;
  loading: boolean;
  error: ApiError | null;
  refresh: () => void;
}

function usePartial(load: (() => Promise<PartialHistory>) | null, key: string): PartialState {
  const [state, setState] = useState<{ key: string; data: PartialHistory | null; loading: boolean; error: ApiError | null }>({
    key,
    data: null,
    loading: load !== null,
    error: null,
  });
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!load) return;
    let cancelled = false;
    setState((s) => ({ key, data: s.key === key ? s.data : null, loading: true, error: null }));
    load().then(
      (data) => !cancelled && setState({ key, data, loading: false, error: null }),
      (err: unknown) => !cancelled && setState({ key, data: null, loading: false, error: toApiError(err) }),
    );
    return () => {
      cancelled = true;
    };
    // `key` stands for `load` by value.
  }, [key, round]);
  const refresh = useCallback(() => setRound((n) => n + 1), []);
  const current = state.key === key ? state : { data: null, loading: load !== null, error: null };
  return { data: current.data, loading: current.loading, error: current.error, refresh };
}

/** The partial history of the namespaces (the first `MAX_HISTORY_NAMESPACES`); nothing while `null` or disabled. */
export function usePartialHistory(clusterId: ClusterId, namespaces: readonly string[] | null, enabled: boolean): PartialState {
  const discovery = useClusterKinds(clusterId);
  const kinds = useMemo(() => {
    const tools = TOOL_KINDS.flatMap((ref) => {
      const served = discovery.kinds ? findKind(discovery.kinds, ref)?.kindRef : undefined;
      return served ? [served] : [];
    });
    return [...HISTORY_KINDS, ...tools];
  }, [discovery.kinds]);
  const chosen = namespaces?.slice(0, MAX_HISTORY_NAMESPACES) ?? null;
  // Nothing before discovery: a tool's kinds are asked for only when the cluster serves them.
  const ready = enabled && chosen !== null && chosen.length > 0 && (discovery.kinds !== null || discovery.error !== null);
  const key = JSON.stringify([clusterId, ready ? chosen : null, ready ? kinds : null]);
  const load = ready ? () => api.timeline.history(clusterId, chosen, kinds, true) : null;
  return usePartial(load, key);
}

/** The partial history of one object. */
export function useObjectHistory(clusterId: ClusterId, object: ObjectRef): PartialState {
  const key = JSON.stringify([clusterId, object]);
  return usePartial(() => api.timeline.objectHistory(clusterId, object), key);
}
