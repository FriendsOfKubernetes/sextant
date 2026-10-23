// What the Cluster API details read beyond the object shown, all bounded:
//   - objects a reference names (a control plane, an infrastructure or bootstrap object, a Machine's Cluster): each
//     read once by name with `resource_get`, at most `MAX_READS` of them and `CONCURRENCY` at a time, again when the
//     object shown changes; a kind the cluster does not serve is not asked for;
//   - the Machines, MachineSets and MachineDeployments of one Cluster or of one owner: watches of served kinds only,
//     in the one namespace of the object shown, selected by label on the API server, through the shared watch
//     registry (`useWatch`), each keeping at most `MAX_CHAIN_OBJECTS` (the views say when a list is cut), closed when
//     the details close.
import { useEffect, useState } from "react";
import { api, toApiError, useWatch, type ApiError, type ClusterId, type KindRef, type KubeObject, type ObjectRef } from "../../api";
import { isCapped } from "../../api/watchState";
import { findKind, useClusterKinds } from "../../resources";
import { MAX_SOURCE_OBJECTS } from "../problems/sources";
import type { CapiRef } from "./model";

export const MAX_READS = 50;
export const CONCURRENCY = 4;
/** Machines (and owners) listed in one details view. */
export const MAX_LISTED = 50;
/** Objects one chain watch keeps at most (a management cluster can hold thousands of Machines). */
export const MAX_CHAIN_OBJECTS = MAX_SOURCE_OBJECTS;
const CHAIN_WATCH_OPTIONS = { progressive: false, maxObjects: MAX_CHAIN_OBJECTS } as const;

export type Fetched = { obj: KubeObject } | { error: ApiError } | { notServed: true };

export const refKey = (ref: CapiRef) => `${ref.group}/${ref.kind}/${ref.namespace ?? ""}/${ref.name}`;

/** The served version of `kind`; `null` when not served; `undefined` while discovery is coming. */
export function useServed(clusterId: ClusterId, kind: Pick<KindRef, "group" | "kind">): KindRef | null | undefined {
  const kinds = useClusterKinds(clusterId);
  if (kinds.kinds) return findKind(kinds.kinds, kind)?.kindRef ?? null;
  return kinds.error ? null : undefined;
}

/** The ObjectRef to read or open for a reference: the version discovery serves, else the one it names. */
export function objectRefOf(ref: CapiRef, served: KindRef | undefined): ObjectRef {
  return { kind: served ?? { group: ref.group, version: ref.version ?? "v1beta2", kind: ref.kind }, namespace: ref.namespace, name: ref.name };
}

export interface RefObjects {
  byKey: Map<string, Fetched>;
  loading: boolean;
}

/** Reads `refs` (the first `MAX_READS`); `stamp` changing reads them again. */
export function useRefObjects(clusterId: ClusterId, refs: readonly CapiRef[], stamp: string): RefObjects {
  const kinds = useClusterKinds(clusterId);
  const wanted = refs.slice(0, MAX_READS).map((ref) => {
    const served = kinds.kinds ? findKind(kinds.kinds, ref)?.kindRef : undefined;
    return { key: refKey(ref), served: kinds.kinds ? Boolean(served) : undefined, target: objectRefOf(ref, served) };
  });
  // Nothing is read before discovery has said which kinds are served.
  const ready = kinds.kinds !== null || Boolean(kinds.error);
  const key = ready ? JSON.stringify([clusterId, wanted, stamp]) : "";
  const [state, setState] = useState<{ key: string; byKey: Map<string, Fetched>; done: boolean }>({ key: "", byKey: new Map(), done: false });
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const [cluster, list] = JSON.parse(key) as [ClusterId, typeof wanted, string];
    const found = new Map<string, Fetched>();
    for (const item of list) if (item.served === false) found.set(item.key, { notServed: true });
    const queue = list.filter((item) => item.served !== false);
    let next = 0;
    const publish = () => {
      if (!cancelled) setState({ key, byKey: new Map(found), done: found.size === list.length });
    };
    const worker = async () => {
      while (!cancelled && next < queue.length) {
        const item = queue[next++]!;
        try {
          found.set(item.key, { obj: await api.resources.get(cluster, item.target) });
        } catch (err) {
          found.set(item.key, { error: toApiError(err) });
        }
        publish();
      }
    };
    if (queue.length === 0) publish();
    else for (let i = 0; i < Math.min(CONCURRENCY, queue.length); i++) void worker();
    return () => {
      cancelled = true;
    };
  }, [key]);
  // Until the new reading lands, the previous one stays (no flicker when the object changes).
  return { byKey: state.byKey, loading: !key || state.key !== key || !state.done };
}

export interface Listed {
  items: KubeObject[];
  loading: boolean;
  /** The kind is not served, or the list could not be read. */
  unavailable: boolean;
  /** More objects match than the watch keeps (`MAX_CHAIN_OBJECTS`): the list is incomplete. */
  truncated: boolean;
}

/** Objects of a served Cluster API kind in one namespace, selected by `labelSelector`; nothing without a selector. */
export function useListed(clusterId: ClusterId, kind: KindRef, namespace: string | null, labelSelector: string | undefined): Listed {
  const served = useServed(clusterId, kind);
  const spec = served && namespace && labelSelector ? { kind: served, namespaces: [namespace], labelSelector, fieldSelector: null } : null;
  const state = useWatch(clusterId, spec, CHAIN_WATCH_OPTIONS);
  const items = [...state.items.values()].sort((a, b) => (a.metadata?.name ?? "").localeCompare(b.metadata?.name ?? ""));
  return {
    items,
    loading: served === undefined || (spec !== null && state.status === "loading"),
    unavailable: served === null || Boolean(state.error),
    truncated: spec !== null && isCapped(state),
  };
}
