// Objects read one by one by name (moved here from the former built-in Cluster API view, ADR-0113, when it became
// Sextant's own extension; k3s's ServiceLB table reads its Services this way): each read once with `resource_get`, at
// most `MAX_READS` of them and `CONCURRENCY` at a time, again when the stamp changes; a kind the cluster does not serve
// is not asked for, and nothing is read before discovery has said which kinds are served.
import { useEffect, useState } from "react";
import { api, toApiError, type ApiError, type ClusterId, type KindRef, type ObjectRef, type KubeObject } from "../api";
import { findKind, useClusterKinds } from "./useKinds";

export const MAX_READS = 50;
export const CONCURRENCY = 4;

/** An object named by group, kind, namespace and name; the version only when the reference names one. */
export interface NamedRef {
  group: string;
  /** Without one the version discovery serves is read (else `v1beta2`, the newest Cluster API version). */
  version?: string;
  kind: string;
  name: string;
  namespace: string | null;
}

export type Fetched = { obj: KubeObject } | { error: ApiError } | { notServed: true };

export const refKey = (ref: NamedRef) => `${ref.group}/${ref.kind}/${ref.namespace ?? ""}/${ref.name}`;

/** The ObjectRef to read or open for a reference: the version discovery serves, else the one it names. */
export function objectRefOf(ref: NamedRef, served: KindRef | undefined): ObjectRef {
  return { kind: served ?? { group: ref.group, version: ref.version ?? "v1beta2", kind: ref.kind }, namespace: ref.namespace, name: ref.name };
}

export interface RefObjects {
  byKey: Map<string, Fetched>;
  loading: boolean;
}

/** Reads `refs` (the first `MAX_READS`); `stamp` changing reads them again. */
export function useRefObjects(clusterId: ClusterId, refs: readonly NamedRef[], stamp: string): RefObjects {
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
