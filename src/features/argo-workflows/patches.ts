// The patches of the Workflow actions, built as Argo Workflows builds them (ADR-0097, amended for #238;
// workflow/util/util.go `SuspendWorkflow`, `ResumeWorkflow`, `StopWorkflow`, `TerminateWorkflow`,
// `patchShutdownStrategy`, `OverrideOutputParametersWithDefault`, `AddParamToGlobalScope`; workflow/creator/creator.go).
// A Workflow has no status subresource (`subresources: {}` in the CRD; the controller and `argo resume` write its nodes
// through the object), so every change is one JSON merge patch of the object, sent once (ADR-0055):
//
//   suspend    {"metadata":{"resourceVersion":rv,…},"spec":{"suspend":true}}       refused for a completed Workflow
//   resume     {"metadata":{"resourceVersion":rv,…},"spec":{"suspend":null},
//               "status":{"nodes":{<id>:{"phase":"Succeeded","finishedAt":now,…}},…}}  each part only where it applies
//   stop       {"spec":{"shutdown":"Stop"}}                                            refused for a finished Workflow
//   terminate  {"spec":{"shutdown":"Terminate"}}                                       refused for a finished Workflow
//
// Suspend and resume are an `Update` of the whole object in util.go, so they carry the resourceVersion read right before
// sending: the API server refuses them (a conflict) when the Workflow changed in between, and Sextant does not retry.
// Stop and terminate are a merge patch without one in util.go, and here. Sextant has no Argo identity (no claims, as
// a client without a user), so as `creator.LabelActor` does then, suspend and resume remove the actor and action labels
// (only those present are named) and the resume message names no user; stop and terminate add no labels.
// Resume marks every running Suspend node Succeeded at the time of sending, with an output parameter the user was to
// supply (`valueFrom.supplied`) set to its `valueFrom.default` (refused without one, as util.go refuses) and its global
// outputs exported. Nodes that are
// compressed or offloaded to the controller's database cannot be read here: resume is then refused.
// Retry is not offered: util.go's `FormulateRetryWorkflow` rebuilds the node tree and deletes pods (ADR-0097).
import type { KubeObject } from "../../api";
import { status } from "../../resources";

const { arr, get, labelsOf, record, str } = status;

export type WorkflowAction = "suspend" | "resume" | "stop" | "terminate";

/** The label the controller sets to "true" on a completed Workflow (`IsWorkflowCompleted`). */
export const COMPLETED_LABEL = "workflows.argoproj.io/completed";
/** The labels `creator.LabelActor` removes when the client has no claims. */
export const ACTOR_LABELS = [
  "workflows.argoproj.io/actor",
  "workflows.argoproj.io/actor-email",
  "workflows.argoproj.io/actor-preferred-username",
  "workflows.argoproj.io/action",
] as const;

export type Refusal =
  | { reason: "completed" }
  | { reason: "finished" }
  | { reason: "nodesElsewhere" }
  | { reason: "noDefault"; step: string; parameter: string };

export interface WorkflowPlan {
  /** The merge patch to the object, without the resourceVersion; `undefined` when nothing would change. */
  patch?: Record<string, unknown>;
  /** Sent with the resourceVersion read right before sending (an `Update` in util.go). */
  versioned: boolean;
  /** Nodes whose `finishedAt` is the time of sending. */
  stamped: string[];
  refusal?: Refusal;
}

const FINISHED = new Set(["Succeeded", "Failed", "Error"]);

export const isCompleted = (wf: KubeObject): boolean => labelsOf(wf)[COMPLETED_LABEL] === "true";
/** `WorkflowStatus.Fulfilled`: the phase is Succeeded, Failed or Error. */
export const isFinished = (wf: KubeObject): boolean => FINISHED.has(str(get(wf, "status", "phase")) ?? "");
export const isSuspended = (wf: KubeObject): boolean => get(wf, "spec", "suspend") === true;
export const shutdownOf = (wf: KubeObject): string | undefined => str(get(wf, "spec", "shutdown"));

/** `NodeStatus.IsActiveSuspendNode`: a Suspend node that is Running. */
export function activeSuspendNodes(wf: KubeObject): [string, Record<string, unknown>][] {
  return Object.entries(record(get(wf, "status", "nodes")))
    .map(([id, node]) => [id, record(node)] as [string, Record<string, unknown>])
    .filter(([, node]) => node.type === "Suspend" && node.phase === "Running");
}

/** The nodes are not in the object: offloaded to the controller's database or compressed (what `Hydrate` reads). */
export const nodesHidden = (wf: KubeObject): boolean =>
  Boolean(str(get(wf, "status", "offloadNodeStatusVersion")) || str(get(wf, "status", "compressedNodes")));

/** The actor labels present on the Workflow, each set to null (`labels.UnLabel`). */
function unlabel(wf: KubeObject): Record<string, null> | undefined {
  const labels = labelsOf(wf);
  const present = ACTOR_LABELS.filter((key) => key in labels);
  return present.length > 0 ? Object.fromEntries(present.map((key) => [key, null])) : undefined;
}

const withLabels = (wf: KubeObject, patch: Record<string, unknown>): Record<string, unknown> => {
  const labels = unlabel(wf);
  return labels ? { metadata: { labels }, ...patch } : patch;
};

/** The patch of `action` for the Workflow as it is now. */
export function planFor(action: WorkflowAction, wf: KubeObject): WorkflowPlan {
  switch (action) {
    case "suspend":
      if (isCompleted(wf)) return { versioned: true, stamped: [], refusal: { reason: "completed" } };
      if (isSuspended(wf)) return { versioned: true, stamped: [] };
      return { versioned: true, stamped: [], patch: withLabels(wf, { spec: { suspend: true } }) };
    case "resume":
      return resumePlan(wf);
    case "stop":
    case "terminate": {
      if (isFinished(wf)) return { versioned: false, stamped: [], refusal: { reason: "finished" } };
      const strategy = action === "stop" ? "Stop" : "Terminate";
      if (shutdownOf(wf) === strategy) return { versioned: false, stamped: [] };
      return { versioned: false, stamped: [], patch: { spec: { shutdown: strategy } } };
    }
  }
}

type Fields = Record<string, unknown>;
const isSet = (value: unknown): boolean => value !== undefined && value !== null;

/** `ResumeWorkflow` without a node selector: lift `spec.suspend` and fulfil every running Suspend node. */
function resumePlan(wf: KubeObject): WorkflowPlan {
  const base: WorkflowPlan = { versioned: true, stamped: [] };
  if (nodesHidden(wf)) return { ...base, refusal: { reason: "nodesElsewhere" } };
  const patch: Fields = {};
  if (isSuspended(wf)) patch.spec = { suspend: null };
  // A working copy of the global outputs, as `AddParamToGlobalScope` changes them node after node.
  const globals: Fields[] = arr(get(wf, "status", "outputs", "parameters")).map((p) => ({ ...record(p) }));
  let globalsChanged = false;
  const nodes: Record<string, Fields> = {};
  const stamped: string[] = [];
  for (const [id, node] of activeSuspendNodes(wf)) {
    const params: Fields[] = arr(get(node, "outputs", "parameters")).map((p) => ({ ...record(p) }));
    let overridden = false;
    // util.go `OverrideOutputParametersWithDefault`: a parameter with `valueFrom.supplied` takes
    // `valueFrom.default` (`param.ValueFrom.Default`, not the parameter's own `default`) as its value, `valueFrom`
    // kept; without it the resume is refused.
    for (const param of params) {
      if (!isSet(get(param, "valueFrom", "supplied"))) continue;
      const fallback = get(param, "valueFrom", "default");
      if (!isSet(fallback)) {
        return { ...base, refusal: { reason: "noDefault", step: str(node.displayName) ?? id, parameter: str(param.name) ?? "" } };
      }
      param.value = fallback;
      overridden = true;
    }
    for (const param of params) globalsChanged = addToGlobalScope(globals, param) || globalsChanged;
    const message = str(node.message);
    nodes[id] = {
      phase: "Succeeded",
      ...(message ? { message: `${message}; ` } : {}),
      ...(overridden ? { outputs: { parameters: params } } : {}),
    };
    stamped.push(id);
  }
  if (stamped.length > 0) patch.status = { nodes, ...(globalsChanged ? { outputs: { parameters: globals } } : {}) };
  if (Object.keys(patch).length === 0) return base;
  return { ...base, stamped, patch: withLabels(wf, patch) };
}

/** `AddParamToGlobalScope`: a parameter with a `globalName` sets (or adds) the Workflow's output of that name. */
function addToGlobalScope(globals: Fields[], param: Fields): boolean {
  const name = str(param.globalName);
  if (!name) return false;
  const value = param.value;
  const existing = globals.find((g) => g.name === name);
  if (!existing) {
    globals.push(isSet(value) ? { name, value } : { name });
    return true;
  }
  if (!isSet(existing.value) || (isSet(value) && existing.value !== value)) {
    if (isSet(value)) existing.value = value;
    else delete existing.value;
    return true;
  }
  return false;
}

/** metav1.Time as the API sends it: RFC 3339 in UTC, whole seconds. */
export const nowStamp = (now: Date = new Date()): string => now.toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * The patch as it is sent: the plan's patch with the resourceVersion of the Workflow read right before (when the plan
 * is versioned) and `finishedAt` of each fulfilled node at `stamp`.
 */
export function patchToSend(plan: WorkflowPlan, resourceVersion: string | undefined, stamp: string): Fields | undefined {
  if (!plan.patch) return undefined;
  const patch = structuredClone(plan.patch);
  if (plan.versioned && resourceVersion) {
    patch.metadata = { resourceVersion, ...record(patch.metadata) };
  }
  for (const id of plan.stamped) {
    const node = record(get(patch, "status", "nodes", id));
    node.finishedAt = stamp;
  }
  // `metadata` first, as the dialog reads best.
  const { metadata, ...rest } = patch;
  return metadata ? { metadata, ...rest } : rest;
}
