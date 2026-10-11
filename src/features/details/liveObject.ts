// Live source of the details panel: one watch of the opened object (`metadata.name` field selector in its
// namespace), so every section follows changes without a refresh. When the object disappears the panel gets
// `obj: null` and `useDetailsLife()` says "deleted" (or "notFound" when it never existed), which the summary
// section shows instead of failing.
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useWatch, type ClusterId, type KubeObject, type ObjectRef, type WatchSpec } from "../../api";
import type { DetailsObject, DetailsObjectSource } from "../../layout/details/registry";

/** What the panel knows about the opened object. */
export type DetailsLife = "loading" | "live" | "deleted" | "notFound" | "error";

function refKey(clusterId: ClusterId, ref: ObjectRef): string {
  return JSON.stringify([clusterId, ref.kind.group, ref.kind.kind, ref.namespace ?? null, ref.name]);
}

// One details panel is open at a time; the map still keeps panels apart by object.
const lives = new Map<string, DetailsLife>();
const listeners = new Set<() => void>();

function setLife(key: string, life: DetailsLife): void {
  if (lives.get(key) === life) return;
  lives.set(key, life);
  for (const fn of listeners) fn();
}

/** The state of the object shown in the details panel for `ref`. */
export function useDetailsLife(clusterId: ClusterId, ref: ObjectRef): DetailsLife {
  const key = refKey(clusterId, ref);
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => lives.get(key) ?? "loading",
    () => lives.get(key) ?? "loading",
  );
}

/** The watch spec of exactly one object. */
export function objectWatchSpec(ref: ObjectRef): WatchSpec {
  return {
    kind: ref.kind,
    namespaces: ref.namespace ? [ref.namespace] : null,
    labelSelector: null,
    fieldSelector: `metadata.name=${ref.name}`,
  };
}

function matches(obj: KubeObject, ref: ObjectRef): boolean {
  return obj.metadata?.name === ref.name && (obj.metadata?.namespace ?? null) === (ref.namespace ?? null);
}

/** `DetailsObjectSource` backed by a watch of the object. */
export const useLiveDetailsObject: DetailsObjectSource = (clusterId, ref) => {
  const key = refKey(clusterId, ref);
  // Equal refs (by value) keep the same watch: `key` stands for `ref`.
  const spec = useMemo(() => objectWatchSpec(ref), [key]);
  const watch = useWatch(clusterId, spec);
  const seen = useRef<string | null>(null);

  const obj = useMemo(() => [...watch.items.values()].find((o) => matches(o, ref)) ?? null, [watch.items, key]);

  let life: DetailsLife;
  if (watch.status === "error") life = "error";
  else if (watch.status === "loading") life = "loading";
  else if (obj) life = "live";
  else life = seen.current === key ? "deleted" : "notFound";

  useEffect(() => {
    if (obj) seen.current = key;
  }, [obj, key]);
  useEffect(() => setLife(key, life), [key, life]);
  useEffect(() => () => void lives.delete(key), [key]);

  return useMemo<DetailsObject>(
    () => ({
      obj: life === "live" ? obj : null,
      loading: life === "loading",
      error: life === "error" ? (watch.error ?? null) : null,
    }),
    [life, obj, watch.error],
  );
};
