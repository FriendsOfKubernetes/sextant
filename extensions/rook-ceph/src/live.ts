// Several watches kept as lists, with one render after any of them changes. A kind the cluster does not serve is
// never watched (see `servedKinds`): its list stays empty and `served` says so.
import { trackObjects, type KubeObject, type Sextant, type Watch, type WatchParams } from "@sextant/extension-sdk";
import { errorText } from "./dom";
import { i18n, t } from "./i18n";

export interface LiveList<T extends KubeObject = KubeObject> {
  items: T[];
  /** The first snapshot came (or the kind is not served, or the watch failed). */
  ready: boolean;
  /** The cluster serves the kind. */
  served: boolean;
  /** Why the list is not whole: the watch failed or the cluster refused some namespaces. */
  error: string | null;
}

/** The kinds (`group/Kind`) the cluster serves, of those the extension's permissions name. */
export async function servedKinds(sextant: Sextant): Promise<Set<string>> {
  const kinds = await sextant.kinds();
  return new Set(kinds.map((k) => `${k.kindRef.group}/${k.kindRef.kind}`));
}

export const kindKey = (kind: { group?: string; kind: string }) => `${kind.group ?? ""}/${kind.kind}`;

/**
 * Watches each of `specs` (by name) that the cluster serves and calls `render` with every list after a change,
 * at most once per task. Returns the function that stops them all.
 */
export function watchLists<K extends string>(
  sextant: Sextant,
  served: Set<string>,
  specs: Record<K, Omit<WatchParams, "clusterId">>,
  render: (lists: Record<K, LiveList>) => void,
): () => void {
  const lists = {} as Record<K, LiveList>;
  const watches: Watch[] = [];
  let stopped = false;
  let scheduled = false;
  const schedule = () => {
    if (scheduled || stopped) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!stopped) render(lists);
    });
  };
  for (const name of Object.keys(specs) as K[]) {
    const spec = specs[name];
    const isServed = served.has(kindKey(spec.kind));
    const list: LiveList = { items: [], ready: !isServed, served: isServed, error: null };
    lists[name] = list;
    if (!isServed) continue;
    const watch = sextant.resources.watch(spec, {
      onUpdate: trackObjects(
        (items) => {
          list.items = items;
          list.ready = true;
          schedule();
        },
        (other) => {
          if (other.type === "forbidden") list.error = t("error.refusedList", { kind: spec.kind.kind, namespaces: i18n().formatList(other.namespaces) });
          else if (other.type === "error") list.error = other.message;
          else return;
          list.ready = true;
          schedule();
        },
      ),
      onError: (err) => {
        list.error = errorText(err);
        list.ready = true;
        schedule();
      },
    });
    watch.started.catch(() => undefined);
    watches.push(watch);
  }
  schedule();
  return () => {
    stopped = true;
    for (const watch of watches) void watch.unwatch().catch(() => undefined);
  };
}
