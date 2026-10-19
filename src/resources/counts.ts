// How many objects of a kind there are (#157): the numbers next to the sidebar's entries and a table's check before
// it watches a kind in every namespace. No watch: one metadata-only request of one object per namespace
// (`api.resources.count`, the API server's `remainingItemCount`), cached for `COUNT_TTL_MS` per (cluster, kind,
// namespaces) and shared by everyone asking at once; a mounted user refreshes it once the cache is that old.
//
//   const { count, error } = useObjectCount(clusterId, { group: "", version: "v1", kind: "Pod" }, null);
//   formatCount(count)  // "42", or "999+" above SIDEBAR_COUNT_CAP or when the API server did not count them all
import { useEffect, useSyncExternalStore } from "react";
import { api, toApiError, type ApiError, type ClusterId, type KindRef, type ObjectCount } from "../api";

export const COUNT_TTL_MS = 60_000;
/**
 * Count requests per cluster in any minute for the sidebar (one per namespace counted); more wait for the next
 * minute. A table's check before it watches every namespace is not held back.
 */
export const COUNT_REQUESTS_PER_MINUTE = 20;
/** The sidebar shows larger numbers as "999+". */
export const SIDEBAR_COUNT_CAP = 999;

export interface CountState {
  count?: ObjectCount;
  error?: ApiError;
  loading: boolean;
}

interface Entry {
  state: CountState;
  at: number;
  inFlight: boolean;
}

const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
/** When each count request of a cluster was sent, for the last minute. */
const sent = new Map<ClusterId, number[]>();

/** Takes `cost` requests from the cluster's budget of the last minute; `false` when they do not fit. */
function takeBudget(clusterId: ClusterId, cost: number, essential: boolean): boolean {
  const now = Date.now();
  const recent = (sent.get(clusterId) ?? []).filter((at) => now - at < 60_000);
  if (!essential && recent.length + cost > COUNT_REQUESTS_PER_MINUTE) {
    sent.set(clusterId, recent);
    return false;
  }
  for (let i = 0; i < cost; i++) recent.push(now);
  sent.set(clusterId, recent);
  return true;
}

const NONE: CountState = Object.freeze({ loading: false }) as CountState;
const LOADING: CountState = Object.freeze({ loading: true }) as CountState;

function keyOf(clusterId: ClusterId, kind: KindRef, namespaces: readonly string[] | null): string {
  const ns = namespaces && namespaces.length > 0 ? [...namespaces].sort() : null;
  return JSON.stringify([clusterId, kind.group, kind.version, kind.kind, ns]);
}

function set(key: string, entry: Entry): void {
  entries.set(key, entry);
  for (const fn of [...(listeners.get(key) ?? [])]) fn();
}

/**
 * Asks the backend unless a fresh answer (younger than `COUNT_TTL_MS`) or a running request is there, or the
 * cluster's budget of the minute is spent (`essential`: a table's check, never held back).
 */
export function refreshCount(
  clusterId: ClusterId,
  kind: KindRef,
  namespaces: readonly string[] | null,
  essential = false,
): void {
  const key = keyOf(clusterId, kind, namespaces);
  const entry = entries.get(key);
  if (entry && (entry.inFlight || Date.now() - entry.at < COUNT_TTL_MS)) return;
  if (!takeBudget(clusterId, namespaces && namespaces.length > 0 ? namespaces.length : 1, essential)) return;
  set(key, { state: entry?.state.count ? { ...entry.state, loading: true } : LOADING, at: entry?.at ?? 0, inFlight: true });
  const ns = namespaces && namespaces.length > 0 ? [...namespaces] : null;
  api.resources.count(clusterId, kind, ns).then(
    (count) => set(key, { state: { count, loading: false }, at: Date.now(), inFlight: false }),
    (err: unknown) => set(key, { state: { error: toApiError(err), loading: false }, at: Date.now(), inFlight: false }),
  );
}

/** The cached count (`loading` when none is known yet). */
export function countOf(clusterId: ClusterId, kind: KindRef, namespaces: readonly string[] | null): CountState {
  return entries.get(keyOf(clusterId, kind, namespaces))?.state ?? LOADING;
}

/** The count of `kind` in `namespaces` (`null` = all), asked for while mounted; `clusterId: null` asks nothing. */
export function useObjectCount(
  clusterId: ClusterId | null,
  kind: KindRef | null,
  namespaces: readonly string[] | null,
  essential = false,
): CountState {
  const key = clusterId && kind ? keyOf(clusterId, kind, namespaces) : null;
  const state = useSyncExternalStore(
    (fn) => {
      if (!key) return () => undefined;
      const set = listeners.get(key) ?? new Set();
      set.add(fn);
      listeners.set(key, set);
      return () => set.delete(fn);
    },
    () => (key ? (entries.get(key)?.state ?? LOADING) : NONE),
  );
  useEffect(() => {
    if (!key) return;
    const [cluster, group, version, kindName, ns] = JSON.parse(key) as [ClusterId, string, string, string, string[] | null];
    const ask = () => refreshCount(cluster, { group, version, kind: kindName }, ns, essential);
    ask();
    // A count left out for the budget is asked again within the minute.
    const timer = setInterval(ask, COUNT_TTL_MS / 4);
    return () => clearInterval(timer);
  }, [key, essential]);
  return state;
}

/** A count as the sidebar writes it: the number, or "999+" (`SIDEBAR_COUNT_CAP`) above it or when not exact. */
export function formatCount(count: ObjectCount): { text: string; capped: boolean } {
  if (!count.exact || count.count > SIDEBAR_COUNT_CAP) return { text: `${SIDEBAR_COUNT_CAP}+`, capped: true };
  return { text: String(count.count), capped: false };
}

/** Forgets every count (tests). */
export function resetObjectCounts(): void {
  entries.clear();
  sent.clear();
}
