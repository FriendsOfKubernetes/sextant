// The lists the event path of a details panel needs (#234): Brokers, Triggers, Subscriptions and the sources of one
// namespace — the hub's (`pathNeeds`) — and only those the path of the shown kind uses. A kind the cluster does not
// serve is never watched, nothing is watched before discovery, and every watch is shared through the watch registry
// and ends when the panel closes (`useWatch`).
import { useWatch, type ClusterId, type KindRef, type KubeObject, type WatchSpec, type WatchState } from "../../api";
import { findKind, useClusterKinds } from "../../resources";
import { BROKER, SOURCE_KINDS, SUBSCRIPTION, TRIGGER } from "./eventing";
import type { PathLists, PathNeeds } from "./eventingPath";

function spec(kinds: ReturnType<typeof useClusterKinds>, kind: KindRef, namespace: string | undefined): WatchSpec | null {
  if (namespace === undefined || !kinds.kinds) return null;
  const served = findKind(kinds.kinds, kind)?.kindRef;
  return served ? { kind: served, namespaces: [namespace], labelSelector: null, fieldSelector: null } : null;
}

const itemsOf = (w: WatchState, wanted: boolean, served: boolean): readonly KubeObject[] | undefined =>
  !wanted ? undefined : !served ? [] : w.status === "ready" ? [...w.items.values()] : undefined;

export interface PathListsState {
  lists: PathLists;
  loading: boolean;
}

export function usePathLists(clusterId: ClusterId, needs: PathNeeds | undefined): PathListsState {
  const kinds = useClusterKinds(clusterId);
  const ns = needs?.namespace;
  const want = (flag: boolean | undefined) => (flag ? ns : undefined);
  const brokerSpec = spec(kinds, BROKER, want(needs?.brokers));
  const triggerSpec = spec(kinds, TRIGGER, want(needs?.triggers));
  const subscriptionSpec = spec(kinds, SUBSCRIPTION, want(needs?.subscriptions));
  const sourceSpecs = SOURCE_KINDS.map((kind) => spec(kinds, kind, want(needs?.sources)));
  // Always the same number of watches, in the same order.
  const brokers = useWatch(clusterId, brokerSpec);
  const triggers = useWatch(clusterId, triggerSpec);
  const subscriptions = useWatch(clusterId, subscriptionSpec);
  const sources = [
    useWatch(clusterId, sourceSpecs[0] ?? null),
    useWatch(clusterId, sourceSpecs[1] ?? null),
    useWatch(clusterId, sourceSpecs[2] ?? null),
    useWatch(clusterId, sourceSpecs[3] ?? null),
    useWatch(clusterId, sourceSpecs[4] ?? null),
  ];
  const discovered = Boolean(kinds.kinds);
  const lists: PathLists = {
    brokers: itemsOf(brokers, Boolean(needs?.brokers) && discovered, Boolean(brokerSpec)),
    triggers: itemsOf(triggers, Boolean(needs?.triggers) && discovered, Boolean(triggerSpec)),
    subscriptions: itemsOf(subscriptions, Boolean(needs?.subscriptions) && discovered, Boolean(subscriptionSpec)),
    sources:
      needs?.sources && discovered && sources.every((w, i) => !sourceSpecs[i] || w.status === "ready")
        ? SOURCE_KINDS.map((kind, i) => ({ kind, items: sourceSpecs[i] ? [...sources[i]!.items.values()] : [] }))
        : undefined,
  };
  const all = [brokerSpec, triggerSpec, subscriptionSpec, ...sourceSpecs];
  const watches = [brokers, triggers, subscriptions, ...sources];
  const loading = Boolean(needs) && ((!discovered && !kinds.error) || all.some((s, i) => s && watches[i]?.status === "loading"));
  return { lists, loading };
}
