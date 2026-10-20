// The source of the problems category `workflows` (#213): while the problems store holds it (the problems screen, the
// Argo Workflows counter or the notifications look at a cluster that serves Workflows), one watch lists the failed and
// errored Workflows only — by the phase label the controller keeps (`workflows.argoproj.io/phase in (Failed,Error)`),
// metadata only (a Workflow's status holds every node; a failed one can be megabytes), at most `MAX_FAILED_WORKFLOWS`
// (the API server lists in namespace/name order, so a capped list is reported truncated).
//
// When did it fail? Metadata carries no finish time (`status.finishedAt` is not in a metadata-only list, and Sextant's
// watches drop `managedFields`), so a failure counts from the latest time known: the moment this source saw the
// Workflow enter the failed list while watching (the controller sets the phase label as it fails; a long-running
// Workflow failing now is a problem now), else its creation. A Workflow already failed at the first look counts from
// its creation. Each one counts until `RECENT_FAILURE_MS` after that time (`until`), at most `MAX_WORKFLOW_PROBLEMS`,
// the most recent first; the failed node and its message are in the Workflow's details. Nothing is kept once the
// source is released.
import type { ClusterId, KubeObject, WatchSpec } from "../../api";
import { acquireWatch, subscribeWatchKey, watchKey, watchStateByKey } from "../../api/watchRegistry";
import { findKind } from "../../resources";
import { knownClusterKinds } from "../../resources/useKinds";
import type { Problem } from "../problems/model";
import { registerProblemProvider } from "../problems/store";
import { FAILED_SELECTOR, MAX_FAILED_WORKFLOWS, MAX_WORKFLOW_PROBLEMS, PHASE_LABEL, RECENT_FAILURE_MS, WORKFLOW } from "./model";

/** What the source remembers of the failed Workflows it has seen: when, and whether after its first look. */
export interface FailedSeen {
  /** The first look has been taken: a Workflow new to the list now has just failed. */
  primed: boolean;
  /** By problem key: when it was first seen, and whether that was its failure (seen entering the list). */
  seen: Map<string, { at: number; entered: boolean }>;
}

export const newFailedSeen = (): FailedSeen => ({ primed: false, seen: new Map() });

/**
 * The problems of the failed Workflows `items` (metadata only) whose failure is within `RECENT_FAILURE_MS` of `now`,
 * the most recent first, at most `MAX_WORKFLOW_PROBLEMS` (`truncated` when more counted).
 */
export function workflowProblems(items: Iterable<KubeObject>, now: number, memory: FailedSeen): { problems: Problem[]; truncated: boolean } {
  const out: Problem[] = [];
  const keys = new Set<string>();
  for (const wf of items) {
    const phase = (wf.metadata?.labels as Record<string, string> | undefined)?.[PHASE_LABEL];
    if (phase !== "Failed" && phase !== "Error") continue;
    const uid = wf.metadata?.uid ?? `${wf.metadata?.namespace ?? ""}/${wf.metadata?.name ?? ""}`;
    const key = `${uid}|${phase}`;
    keys.add(key);
    const seen = memory.seen.get(key) ?? { at: now, entered: memory.primed };
    memory.seen.set(key, seen);
    const created = Date.parse(String(wf.metadata?.creationTimestamp ?? ""));
    const failedAt = Math.max(Number.isNaN(created) ? -Infinity : created, seen.entered ? seen.at : -Infinity);
    if (!Number.isFinite(failedAt) || failedAt + RECENT_FAILURE_MS <= now) continue;
    out.push({
      key,
      // A CronWorkflow's runs notify as one: the identity is the CronWorkflow when the Workflow names one.
      notifyKey: `${cronIdentity(wf) ?? uid}|failed`,
      category: "workflows",
      uid,
      object: { kind: WORKFLOW, namespace: wf.metadata?.namespace ?? null, name: wf.metadata?.name ?? "" },
      reason: phase,
      group: "failed",
      since: new Date(failedAt).toISOString(),
      until: failedAt + RECENT_FAILURE_MS,
      notify: true,
      firstSeen: seen.at,
      activeAt: seen.at,
    });
  }
  memory.primed = true;
  for (const key of [...memory.seen.keys()]) if (!keys.has(key)) memory.seen.delete(key);
  out.sort((a, b) => (b.until ?? 0) - (a.until ?? 0));
  return { problems: out.slice(0, MAX_WORKFLOW_PROBLEMS), truncated: out.length > MAX_WORKFLOW_PROBLEMS };
}

function cronIdentity(wf: KubeObject): string | undefined {
  const cron = (wf.metadata?.labels as Record<string, string> | undefined)?.["workflows.argoproj.io/cron-workflow"];
  return cron ? `CronWorkflow/${wf.metadata?.namespace ?? ""}/${cron}` : undefined;
}

registerProblemProvider("workflows", (clusterId: ClusterId, set) => {
  const served = findKind(knownClusterKinds(clusterId), WORKFLOW)?.kindRef;
  if (!served) {
    set({ status: "ready", problems: [] });
    return () => undefined;
  }
  const spec: WatchSpec = { kind: served, namespaces: null, labelSelector: FAILED_SELECTOR, fieldSelector: null, metadataOnly: true };
  const key = watchKey(clusterId, spec);
  const memory = newFailedSeen();
  const look = () => {
    const state = watchStateByKey(key);
    if (state.status === "loading") set({ status: "loading", problems: [] });
    else if (state.status === "error") set({ status: "error", error: state.error, problems: [] });
    else {
      const capped = state.total !== undefined && state.total > state.items.size;
      const { problems, truncated } = workflowProblems(state.items.values(), Date.now(), memory);
      set({ status: state.status, problems, truncated: capped || truncated });
    }
  };
  const release = acquireWatch(clusterId, spec, { watch: { progressive: false, maxObjects: MAX_FAILED_WORKFLOWS } });
  const unsubscribe = subscribeWatchKey(key, look);
  // A problem stops counting by `until` without an update; looking again now and then drops it from the list too.
  const timer = setInterval(look, 60_000);
  look();
  return () => {
    clearInterval(timer);
    unsubscribe();
    release();
  };
});
