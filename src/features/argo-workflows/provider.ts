// The source of the problems category `workflows` (#213): while the problems store holds it (the problems screen, the
// Argo Workflows counter or the notifications look at a cluster that serves Workflows), one watch lists the failed and
// errored Workflows only — by the phase label the controller keeps (`workflows.argoproj.io/phase in (Failed,Error)`),
// metadata only (a Workflow's status holds every node; a failed one can be megabytes), at most `MAX_FAILED_WORKFLOWS`.
// Each one created within `RECENT_FAILURE_MS` is a problem until that time has passed (`until`); the failed node and
// its message are in the Workflow's details. Nothing is kept once the source is released.
import type { ClusterId, KubeObject, WatchSpec } from "../../api";
import { acquireWatch, subscribeWatchKey, watchKey, watchStateByKey } from "../../api/watchRegistry";
import { findKind } from "../../resources";
import { knownClusterKinds } from "../../resources/useKinds";
import type { Problem } from "../problems/model";
import { registerProblemProvider } from "../problems/store";
import { FAILED_SELECTOR, MAX_FAILED_WORKFLOWS, PHASE_LABEL, RECENT_FAILURE_MS, WORKFLOW } from "./model";

/** The problems of the failed Workflows `items` (metadata only) that count after `now - RECENT_FAILURE_MS`. */
export function workflowProblems(items: Iterable<KubeObject>, now: number, firstSeen: Map<string, number>): Problem[] {
  const out: Problem[] = [];
  const keys = new Set<string>();
  for (const wf of items) {
    const phase = (wf.metadata?.labels as Record<string, string> | undefined)?.[PHASE_LABEL];
    if (phase !== "Failed" && phase !== "Error") continue;
    const created = Date.parse(String(wf.metadata?.creationTimestamp ?? ""));
    if (Number.isNaN(created) || created + RECENT_FAILURE_MS <= now) continue;
    const uid = wf.metadata?.uid ?? `${wf.metadata?.namespace ?? ""}/${wf.metadata?.name ?? ""}`;
    const key = `${uid}|${phase}`;
    keys.add(key);
    const first = firstSeen.get(key) ?? now;
    firstSeen.set(key, first);
    out.push({
      key,
      // A CronWorkflow's runs notify as one: the identity is the CronWorkflow when the Workflow names one.
      notifyKey: `${cronIdentity(wf) ?? uid}|failed`,
      category: "workflows",
      uid,
      object: { kind: WORKFLOW, namespace: wf.metadata?.namespace ?? null, name: wf.metadata?.name ?? "" },
      reason: phase,
      group: "failed",
      since: new Date(created).toISOString(),
      until: created + RECENT_FAILURE_MS,
      notify: true,
      firstSeen: first,
      activeAt: first,
    });
  }
  for (const key of [...firstSeen.keys()]) if (!keys.has(key)) firstSeen.delete(key);
  return out;
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
  const firstSeen = new Map<string, number>();
  const look = () => {
    const state = watchStateByKey(key);
    if (state.status === "loading") set({ status: "loading", problems: [] });
    else if (state.status === "error") set({ status: "error", error: state.error, problems: [] });
    else {
      const truncated = state.total !== undefined && state.total > state.items.size;
      set({ status: state.status, problems: workflowProblems(state.items.values(), Date.now(), firstSeen), truncated });
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
