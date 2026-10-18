// What to watch to relate objects, and the live graph built from it. Bounded by design: a namespaced object needs only
// its namespace's lists (`NAMESPACE_KINDS`), a cluster-scoped one only the few lists that can name it (the pods of a
// Node by field selector, the PersistentVolumes of a StorageClass, …); kinds the cluster does not serve are never
// watched and nothing is watched before discovery comes. Every spec is per (kind, namespace), so the map and the
// "Related" tab of an object in the same namespace share the same watches (`watches.ts`).
import { useMemo, useRef } from "react";
import type { ClusterId, KindRef, WatchSpec, WatchState } from "../../api";
import { findKind, useClusterKinds } from "../../resources";
import { servedKind } from "../gateway-api/hooks";
import { GATEWAY, GATEWAY_CLASS } from "../gateway-api/model";
import {
  INGRESS,
  INGRESS_CLASS,
  isClusterScoped,
  knownKind,
  NAMESPACE_KINDS,
  NODE,
  POD,
  PV,
  same,
  STORAGE_CLASS,
} from "./kinds";
import { buildGraph, type Graph, type GraphInput, type NodeRef } from "./relations";
import { useSharedWatches } from "./watches";

/** One list to watch: a kind in one namespace (or everywhere), optionally narrowed by a field selector. */
export interface PlanItem {
  kind: Pick<KindRef, "group" | "kind">;
  /** `null`: every namespace (or a cluster-scoped kind). */
  namespace: string | null;
  fieldSelector: string | null;
}

/** The lists of the namespaces in view. */
export function namespacePlan(namespaces: readonly string[]): PlanItem[] {
  return namespaces.flatMap((namespace) => NAMESPACE_KINDS.map((kind) => ({ kind, namespace, fieldSelector: null })));
}

const byName = (ref: NodeRef): PlanItem => ({
  kind: ref,
  namespace: ref.namespace,
  fieldSelector: `metadata.name=${ref.name}`,
});

/** What to watch to show `ref`'s relations one hop both ways. */
export function nodePlan(ref: NodeRef): PlanItem[] {
  if (ref.namespace !== null) {
    const plan = namespacePlan([ref.namespace]);
    // A kind the namespace lists do not cover (a ConfigMap, a custom resource): itself, for what it names.
    return NAMESPACE_KINDS.some((k) => same(k, ref)) ? plan : [...plan, byName(ref)];
  }
  const everywhere = (kind: KindRef, fieldSelector: string | null = null): PlanItem => ({ kind, namespace: null, fieldSelector });
  const self = byName(ref);
  if (same(ref, NODE)) return [self, everywhere(POD, `spec.nodeName=${ref.name}`)];
  if (same(ref, STORAGE_CLASS)) return [self, everywhere(PV)];
  if (same(ref, INGRESS_CLASS)) return [self, everywhere(INGRESS)];
  if (same(ref, GATEWAY_CLASS)) return [self, everywhere(GATEWAY)];
  return [self];
}

export const planKey = (item: PlanItem) =>
  `${item.kind.group}/${item.kind.kind}|${item.namespace ?? ""}|${item.fieldSelector ?? ""}`;

/** The plans together, each list once, in a stable order. */
export function mergePlans(items: readonly PlanItem[]): PlanItem[] {
  const unique = new Map<string, PlanItem>();
  for (const item of items) unique.set(planKey(item), item);
  return [...unique.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, item]) => item);
}

/** The namespaces a plan reads (for the cap on namespaces open at once). */
export function planNamespaces(items: readonly PlanItem[]): string[] {
  return [...new Set(items.flatMap((i) => (i.namespace === null ? [] : [i.namespace])))].sort();
}

/** The kind the cluster serves for `ref`: `null` not served, `undefined` while discovery is coming. */
export function resolveKind(kinds: ReturnType<typeof useClusterKinds>, ref: Pick<KindRef, "group" | "kind">): KindRef | null | undefined {
  const known = knownKind(ref);
  if (known) return servedKind(kinds, known);
  if (kinds.kinds) return findKind(kinds.kinds, ref)?.kindRef ?? null;
  return kinds.error ? null : undefined;
}

export interface RelationGraph {
  graph: Graph;
  /** A list has not come yet (or discovery has not). */
  loading: boolean;
  /** Lists that could not be read (no permission, an error), by kind. */
  failed: string[];
  /** The plan item of each watched list, for `covers`. */
  watched: { item: PlanItem; kind: KindRef; state: WatchState }[];
}

/** Keeps the previous array while every element is the same object, so memos keyed on it hold. */
function useStable<T>(values: readonly T[]): readonly T[] {
  const ref = useRef<readonly T[]>(values);
  const prev = ref.current;
  if (prev.length !== values.length || prev.some((v, i) => v !== values[i])) ref.current = values;
  return ref.current;
}

/** Whether the lists cover `ref`'s kind in its namespace completely (a ready, unfiltered list). */
export function covers(watched: RelationGraph["watched"], ref: Pick<NodeRef, "group" | "kind" | "namespace">): boolean {
  return watched.some(
    ({ item, state }) =>
      same(item.kind, ref) &&
      item.fieldSelector === null &&
      (item.namespace === null || item.namespace === ref.namespace) &&
      (isClusterScoped(ref) ? item.namespace === null : ref.namespace !== null) &&
      state.status === "ready" &&
      !(ref.namespace !== null && state.forbidden?.includes(ref.namespace)),
  );
}

/** The live graph of what `plan` watches, plus `extra` objects already at hand (the opened object). */
export function useRelationGraph(
  clusterId: ClusterId,
  plan: readonly PlanItem[],
  extra: readonly GraphInput[] = [],
): RelationGraph {
  const kinds = useClusterKinds(clusterId);
  const resolved = plan.map((item) => ({ item, kind: resolveKind(kinds, item.kind) }));
  const discovering = resolved.some((r) => r.kind === undefined);
  const active = resolved.filter((r): r is { item: PlanItem; kind: KindRef } => Boolean(r.kind));
  const specs: WatchSpec[] = discovering
    ? []
    : active.map(({ item, kind }) => ({
        kind,
        namespaces: item.namespace === null ? null : [item.namespace],
        labelSelector: null,
        fieldSelector: item.fieldSelector,
      }));
  const states = useSharedWatches(clusterId, specs);
  const watched = discovering ? [] : active.map((a, i) => ({ ...a, state: states[i]! }));
  const items = useStable(watched.map((w) => w.state.items));
  const stableExtra = useStable(extra);
  const statusKey = watched.map((w) => `${w.state.status}:${(w.state.forbidden ?? []).join(",")}`).join("|");

  const graph = useMemo(
    () =>
      buildGraph(
        [...stableExtra, ...watched.map((w) => ({ kind: w.kind, items: w.state.items.values() }))],
        { complete: (ref) => covers(watched, ref) },
      ),
    // `items` and `statusKey` stand for `watched` by value.
    [items, stableExtra, statusKey],
  );
  const failed = [
    ...new Set(
      watched.filter((w) => w.state.status === "error" || (w.state.forbidden?.length ?? 0) > 0).map((w) => w.kind.kind),
    ),
  ];
  return {
    graph,
    loading: discovering || watched.some((w) => w.state.status === "loading"),
    failed,
    watched,
  };
}
