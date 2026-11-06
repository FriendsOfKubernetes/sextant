// The lists a Rollout's details need, watched only while its section is shown: the ReplicaSets and AnalysisRuns of its
// namespace (AnalysisRuns only where the cluster serves them). A Rollout's own objects are picked from them by owner
// uid (model.ts), as the built-in view did.
import { trackObjects, type KubeObject, type Sextant, type Watch } from "@sextant/extension-sdk";
import { errorText } from "./dom";
import { i18n, t } from "./i18n";
import { ANALYSIS_RUN, REPLICA_SET } from "./model";

export interface LiveList {
  items: KubeObject[];
  /** The first snapshot came (or the kind is not served, or the watch failed). */
  ready: boolean;
  /** Why the list is not whole. */
  error: string | null;
}

export interface RolloutLists {
  replicaSets: LiveList;
  analysisRuns: LiveList;
}

/** Whether the cluster serves AnalysisRuns (of the kinds the extension may use). */
async function servesAnalysisRuns(sextant: Sextant): Promise<boolean> {
  const kinds = await sextant.kinds();
  return kinds.some((k) => k.kindRef.group === ANALYSIS_RUN.group && k.kindRef.kind === ANALYSIS_RUN.kind);
}

/** Watches the namespace's lists and calls `render` after any change, at most once per task; returns the stop. */
export function watchRolloutLists(sextant: Sextant, namespace: string, render: (lists: RolloutLists) => void): () => void {
  const lists: RolloutLists = {
    replicaSets: { items: [], ready: false, error: null },
    analysisRuns: { items: [], ready: false, error: null },
  };
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
  const follow = (list: LiveList, kind: { group: string; kind: string }) => {
    const watch = sextant.resources.watch(
      { kind, namespaces: [namespace] },
      {
        onUpdate: trackObjects(
          (items) => {
            list.items = items;
            list.ready = true;
            schedule();
          },
          (other) => {
            if (other.type === "forbidden") list.error = t("error.refusedList", { kind: kind.kind, namespaces: i18n().formatList(other.namespaces) });
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
      },
    );
    watch.started.catch(() => undefined);
    if (stopped) void watch.unwatch().catch(() => undefined);
    else watches.push(watch);
  };
  follow(lists.replicaSets, REPLICA_SET);
  void servesAnalysisRuns(sextant)
    .catch(() => false)
    .then((served) => {
      if (stopped) return;
      if (served) follow(lists.analysisRuns, ANALYSIS_RUN);
      else {
        lists.analysisRuns.ready = true;
        schedule();
      }
    });
  schedule();
  return () => {
    stopped = true;
    for (const watch of watches) void watch.unwatch().catch(() => undefined);
  };
}
