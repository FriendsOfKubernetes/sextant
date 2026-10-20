// The objects a claim's or composite's chain names, read for the details panel (#213): each one once with
// `resource_get` (Secret values never reach the window anyway), at most `MAX_CHAIN` of them and `CONCURRENCY` at a
// time, read again when the object shown changes (a composite's status changes when its resources do). No watch per
// named object: a composite can name dozens of managed resources of as many kinds.
import { useEffect, useState } from "react";
import { api, toApiError, type ApiError, type ClusterId, type KubeObject, type ObjectRef } from "../../api";

export const MAX_CHAIN = 30;
export const CONCURRENCY = 4;

export type Fetched = { obj: KubeObject } | { error: ApiError };

export const refKey = (ref: ObjectRef) => `${ref.kind.group}/${ref.kind.kind}/${ref.namespace ?? ""}/${ref.name}`;

export interface ChainObjects {
  byKey: Map<string, Fetched>;
  loading: boolean;
}

/** Reads `refs` (the first `MAX_CHAIN`); `stamp` changing reads them again. */
export function useChainObjects(clusterId: ClusterId, refs: readonly ObjectRef[], stamp: string): ChainObjects {
  const wanted = refs.slice(0, MAX_CHAIN);
  const key = JSON.stringify([clusterId, wanted, stamp]);
  const [state, setState] = useState<{ key: string; byKey: Map<string, Fetched>; done: boolean }>({ key: "", byKey: new Map(), done: false });
  useEffect(() => {
    let cancelled = false;
    const [cluster, list] = JSON.parse(key) as [ClusterId, ObjectRef[], string];
    const found = new Map<string, Fetched>();
    let next = 0;
    const worker = async () => {
      while (!cancelled && next < list.length) {
        const ref = list[next++]!;
        try {
          found.set(refKey(ref), { obj: await api.resources.get(cluster, ref) });
        } catch (err) {
          found.set(refKey(ref), { error: toApiError(err) });
        }
        if (!cancelled) setState({ key, byKey: new Map(found), done: found.size === list.length });
      }
    };
    if (list.length === 0) setState({ key, byKey: found, done: true });
    else for (let i = 0; i < Math.min(CONCURRENCY, list.length); i++) void worker();
    return () => {
      cancelled = true;
    };
  }, [key]);
  // Until the new reading lands, the previous one stays (no flicker when the object changes).
  return { byKey: state.byKey, loading: state.key !== key || !state.done };
}
