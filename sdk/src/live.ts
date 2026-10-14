// Keeps the objects of a watch up to date: a snapshot replaces them, a delta changes and removes them (by uid).
import type { KubeObject, WatchUpdate } from "./api";

/** The key Sextant's watch deletes objects by: `metadata.uid` (else `namespace/name`). */
export function objectKey(object: KubeObject): string {
  const meta = object.metadata ?? { name: "" };
  return meta.uid ?? `${meta.namespace ?? ""}/${meta.name}`;
}

/**
 * Returns an update handler for `resources.watch` that keeps the current objects and calls `onChange` with them
 * (sorted by namespace and name) after every snapshot or delta. Other updates (reconnecting, error, forbidden) are
 * passed to `onOther`.
 */
export function trackObjects<T extends KubeObject = KubeObject>(
  onChange: (objects: T[]) => void,
  onOther?: (update: Exclude<WatchUpdate, { type: "snapshot" } | { type: "delta" }>) => void,
): (update: WatchUpdate) => void {
  const objects = new Map<string, T>();
  const emit = () => {
    const list = [...objects.values()].sort((a, b) => {
      const ns = (a.metadata.namespace ?? "").localeCompare(b.metadata.namespace ?? "");
      return ns !== 0 ? ns : a.metadata.name.localeCompare(b.metadata.name);
    });
    onChange(list);
  };
  return (update) => {
    switch (update.type) {
      case "snapshot":
        objects.clear();
        for (const item of update.items as unknown as T[]) objects.set(objectKey(item), item);
        emit();
        return;
      case "delta":
        for (const item of update.upserted as unknown as T[]) objects.set(objectKey(item), item);
        for (const uid of update.deleted) objects.delete(uid);
        emit();
        return;
      default:
        onOther?.(update);
    }
  };
}
