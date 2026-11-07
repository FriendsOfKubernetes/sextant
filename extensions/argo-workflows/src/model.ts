// What Argo Workflows objects say, read the way the Argo Workflows UI reads them (ADR-0097): the phase, progress and
// duration of a Workflow, the node that failed and its message, the node tree (bounded), the pod of a pod node (named
// as ui/src/shared/pod-name.ts and workflow/util/pod_name.go name it, by `workflows.argoproj.io/pod-name-format`), and
// a CronWorkflow's schedule, last run and active Workflows. Ported from Sextant's former built-in view
// (src/features/argo-workflows); no DOM here. The patches of the actions are in ./patches.ts.
import type { KubeObject, UiTone } from "@sextant/extension-sdk";

export const WORKFLOWS_GROUP = "argoproj.io";
export const WORKFLOW = { group: WORKFLOWS_GROUP, kind: "Workflow" } as const;
export const CRON_WORKFLOW = { group: WORKFLOWS_GROUP, kind: "CronWorkflow" } as const;
export const WORKFLOW_TEMPLATE = { group: WORKFLOWS_GROUP, kind: "WorkflowTemplate" } as const;
export const CLUSTER_WORKFLOW_TEMPLATE = { group: WORKFLOWS_GROUP, kind: "ClusterWorkflowTemplate" } as const;
export const POD = { group: "", kind: "Pod" } as const;

/** The label the controller keeps equal to `status.phase` (server-side selectable, unlike the status). */
export const PHASE_LABEL = "workflows.argoproj.io/phase";
/** The label linking a Workflow to the CronWorkflow that started it. */
export const CRON_WORKFLOW_LABEL = "workflows.argoproj.io/cron-workflow";
/** How the controller named the Workflow's pods: `v1` (the node id) or `v2` (the default). */
export const POD_NAME_FORMAT_ANNOTATION = "workflows.argoproj.io/pod-name-format";

/** The tone of a status word, as the SDK's UI kit colours it (`ui.status`). */
export type Tone = UiTone;

// ---------- Reading fields ----------

/** The value at `path` of `value`, or `undefined` where a step is missing. */
export function get(value: unknown, ...path: string[]): unknown {
  let at = value;
  for (const key of path) {
    if (at === null || typeof at !== "object" || Array.isArray(at)) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

export const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
export const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
export const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
export const labelsOf = (obj: KubeObject): Record<string, unknown> => record(obj.metadata?.labels);

/** Whether `kind` is `of` (Argo CD, Argo Rollouts and Argo Workflows share the group: by group and kind). */
export const isKind = (kind: { group: string; kind: string }, of: { group: string; kind: string }): boolean =>
  kind.group === of.group && kind.kind === of.kind;

// ---------- Phase, progress, duration ----------

export const PHASE_TONE: Record<string, Tone> = {
  Pending: "neutral",
  Running: "neutral",
  Succeeded: "success",
  Skipped: "muted",
  Omitted: "muted",
  Failed: "danger",
  Error: "danger",
};

export const phaseTone = (phase: string | undefined): Tone => (phase ? (PHASE_TONE[phase] ?? "neutral") : "neutral");
export const workflowPhase = (wf: KubeObject): string | undefined => str(get(wf, "status", "phase"));
export const isFailedPhase = (phase: string | undefined): boolean => phase === "Failed" || phase === "Error";

/** `status.progress` ("3/5": pods done of all); counted from the pod nodes for an old controller without it. */
export function progressOf(wf: KubeObject): string | undefined {
  const progress = str(get(wf, "status", "progress"));
  if (progress) return progress;
  const pods = Object.values(record(get(wf, "status", "nodes"))).filter((n) => get(n, "type") === "Pod");
  if (pods.length === 0) return undefined;
  const done = pods.filter((n) => ["Succeeded", "Skipped", "Omitted"].includes(str(get(n, "phase")) ?? "")).length;
  return `${done}/${pods.length}`;
}

const time = (value: unknown): number | undefined => {
  const parsed = Date.parse(str(value) ?? "");
  return Number.isNaN(parsed) ? undefined : parsed;
};

/** Milliseconds from `startedAt` to `finishedAt` (to `now` while running); `undefined` before it starts. */
export function durationOf(obj: unknown, now: number): number | undefined {
  const started = time(get(obj, "startedAt"));
  if (started === undefined) return undefined;
  return Math.max(0, (time(get(obj, "finishedAt")) ?? now) - started);
}

export const workflowDuration = (wf: KubeObject, now: number) => durationOf(get(wf, "status"), now);

/** A duration in the largest whole unit, as Sextant shows ages (its `ageParts`): the unit and the count. */
export function durationParts(ms: number): { unit: "seconds" | "minutes" | "hours" | "days" | "years"; count: number } {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return { unit: "seconds", count: s };
  const m = Math.floor(s / 60);
  if (m < 60) return { unit: "minutes", count: m };
  const h = Math.floor(m / 60);
  if (h < 24) return { unit: "hours", count: h };
  const d = Math.floor(h / 24);
  if (d < 365) return { unit: "days", count: d };
  return { unit: "years", count: Math.floor(d / 365) };
}

// ---------- Nodes ----------

export interface WorkflowNode {
  id: string;
  name: string;
  displayName: string;
  type: string;
  phase?: string;
  message?: string;
  templateName?: string;
  startedAt?: string;
  finishedAt?: string;
  children: string[];
  boundaryID?: string;
  raw: Record<string, unknown>;
}

/** Nodes drawn in a Workflow's tree; the rest is counted, not drawn. */
export const MAX_TREE_NODES = 500;

export function nodesOf(wf: KubeObject): Map<string, WorkflowNode> {
  const out = new Map<string, WorkflowNode>();
  for (const [key, value] of Object.entries(record(get(wf, "status", "nodes")))) {
    const n = record(value);
    const id = str(n.id) ?? key;
    out.set(id, {
      id,
      name: str(n.name) ?? id,
      displayName: str(n.displayName) ?? str(n.name) ?? id,
      type: str(n.type) ?? "",
      phase: str(n.phase),
      message: str(n.message),
      templateName: str(n.templateName),
      startedAt: str(n.startedAt),
      finishedAt: str(n.finishedAt),
      children: arr(n.children).filter((c): c is string => typeof c === "string"),
      boundaryID: str(n.boundaryID),
      raw: n,
    });
  }
  return out;
}

/** Why the nodes are not in the object: offloaded to the controller's database, or compressed (`compressedNodes`). */
export function nodesElsewhere(wf: KubeObject): "offloaded" | "compressed" | undefined {
  if (Object.keys(record(get(wf, "status", "nodes"))).length > 0) return undefined;
  if (str(get(wf, "status", "offloadNodeStatusVersion"))) return "offloaded";
  if (str(get(wf, "status", "compressedNodes"))) return "compressed";
  return undefined;
}

/** The root node: the one named as the Workflow, else a node no other node lists as a child. */
export function rootOf(wf: KubeObject, nodes: Map<string, WorkflowNode>): WorkflowNode | undefined {
  const name = wf.metadata?.name ?? "";
  if (nodes.has(name)) return nodes.get(name);
  const children = new Set([...nodes.values()].flatMap((n) => n.children));
  return [...nodes.values()].find((n) => !children.has(n.id));
}

export interface TreeRow {
  node: WorkflowNode;
  depth: number;
  hasChildren: boolean;
}

/**
 * The tree as rows, depth first from the root, showing the children only of `expanded` nodes; a node reached twice
 * (a DAG task with two parents) is shown under its first parent only. At most `MAX_TREE_NODES` rows.
 */
export function treeRows(wf: KubeObject, nodes: Map<string, WorkflowNode>, expanded: ReadonlySet<string>): TreeRow[] {
  const root = rootOf(wf, nodes);
  if (!root) return [];
  const rows: TreeRow[] = [];
  const seen = new Set<string>();
  const visit = (node: WorkflowNode, depth: number) => {
    if (rows.length >= MAX_TREE_NODES || seen.has(node.id)) return;
    seen.add(node.id);
    const children = node.children.map((id) => nodes.get(id)).filter((n): n is WorkflowNode => Boolean(n));
    rows.push({ node, depth, hasChildren: children.length > 0 });
    if (!expanded.has(node.id)) return;
    for (const child of children) visit(child, depth + 1);
  };
  visit(root, 0);
  return rows;
}

/** The ids on the way from the root to `id` (both included), to open the tree down to a node. */
export function pathTo(wf: KubeObject, nodes: Map<string, WorkflowNode>, id: string): string[] {
  const parent = new Map<string, string>();
  for (const n of nodes.values()) for (const c of n.children) if (!parent.has(c)) parent.set(c, n.id);
  const path = [id];
  let cur = parent.get(id);
  while (cur && !path.includes(cur) && path.length <= nodes.size) {
    path.unshift(cur);
    cur = parent.get(cur);
  }
  return rootOf(wf, nodes)?.id === path[0] ? path : [];
}

const POD_TYPES = new Set(["Pod", "Container"]);

/**
 * The node that made the Workflow fail: the first failed or errored pod (or container) node to finish, else the
 * first failed node other than the root; `undefined` when none failed.
 */
export function failedNode(wf: KubeObject, nodes: Map<string, WorkflowNode> = nodesOf(wf)): WorkflowNode | undefined {
  const rootId = rootOf(wf, nodes)?.id;
  const failed = [...nodes.values()].filter((n) => isFailedPhase(n.phase) && n.id !== rootId);
  const finished = (n: WorkflowNode) => Date.parse(n.finishedAt ?? "") || Number.MAX_SAFE_INTEGER;
  failed.sort((a, b) => finished(a) - finished(b));
  return failed.find((n) => POD_TYPES.has(n.type)) ?? failed[0];
}

/** The failure in one line: the failed node's message, else the Workflow's `status.message`. */
export function failureMessage(wf: KubeObject, node: WorkflowNode | undefined): string | undefined {
  return node?.message ?? str(get(wf, "status", "message"));
}

/** "step: message" of the node that failed (or the Workflow's message), for a failed or errored Workflow only. */
export function failedStepText(wf: KubeObject, join: (step: string, message: string) => string): string | undefined {
  if (!isFailedPhase(workflowPhase(wf))) return undefined;
  const node = failedNode(wf);
  const message = failureMessage(wf, node);
  if (node && message) return join(node.displayName, message);
  return node?.displayName ?? message;
}

// ---------- Pod names ----------

const MAX_NAME = 253;
const HASH_LENGTH = 10;
const MAX_PREFIX = MAX_NAME - HASH_LENGTH;

/** 32-bit FNV-1a of the UTF-8 bytes, as Go's `hash/fnv` `New32a` (and the UI's `createFNVHash`). */
export function fnv32a(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The pod of a pod node, as the controller names it (`GeneratePodName` in workflow/util/pod_name.go): `v1` is the
 * node id; `v2` (the default, also without the annotation) is `<workflow>-<template>-<hash>`, the hash taken from the
 * node id (the workflow name followed by the hash of the node name) or computed from the node name, the prefix cut to
 * fit 253 characters. A container-set container (`Container` node) runs in the pod of its boundary node: the
 * controller creates each container node with the template's Pod node as `boundaryID` and names the pod after that
 * node (container_set_template.go), so the id, the name and the template are the boundary node's — from `nodes` when
 * it is there, else the container node's own template (the controller gives it the pod's). `undefined` for a node
 * that has no pod.
 */
export function podNameOf(wf: KubeObject, node: WorkflowNode, nodes?: ReadonlyMap<string, WorkflowNode>): string | undefined {
  if (!POD_TYPES.has(node.type)) return undefined;
  const boundary = node.type === "Container" && node.boundaryID ? nodes?.get(node.boundaryID) : undefined;
  const podNode = boundary ?? node;
  const podNodeId = (node.type === "Container" ? node.boundaryID : node.id) ?? node.id;
  const version = str(record(wf.metadata?.annotations)[POD_NAME_FORMAT_ANNOTATION]);
  if (version === "v1") return podNodeId;
  const workflowName = wf.metadata?.name ?? "";
  if (workflowName === podNodeId) return workflowName;
  const templateName = podNode.templateName || str(get(podNode.raw, "templateRef", "template")) || node.templateName || "";
  let prefix = templateName ? `${workflowName}-${templateName}` : workflowName;
  if (prefix.length > MAX_PREFIX - 1) prefix = prefix.substring(0, MAX_PREFIX - 1);
  const idPrefix = `${workflowName}-`;
  // The node name the hash falls back to is the pod node's: a container node's own is `<pod node>.<container>`.
  const nameForHash = boundary ? boundary.name : node.type === "Container" ? node.name.replace(/\.[^.]*$/, "") : node.name;
  const hash = podNodeId.startsWith(idPrefix) ? podNodeId.substring(idPrefix.length) : String(fnv32a(nameForHash));
  const excess = prefix.length + 1 + hash.length - MAX_NAME;
  if (excess > 0) prefix = prefix.substring(0, prefix.length - excess);
  return `${prefix}-${hash}`;
}

// ---------- Where a Workflow came from ----------

/** The CronWorkflow that started a Workflow (its label). */
export const cronOf = (wf: KubeObject): string | undefined => str(labelsOf(wf)[CRON_WORKFLOW_LABEL]);

/** The WorkflowTemplate (or ClusterWorkflowTemplate) a Workflow was made from. */
export const templateRefOf = (wf: KubeObject): { name: string; cluster: boolean } | undefined => {
  const name = str(get(wf, "spec", "workflowTemplateRef", "name"));
  return name ? { name, cluster: get(wf, "spec", "workflowTemplateRef", "clusterScope") === true } : undefined;
};

// ---------- CronWorkflow ----------

/** `spec.schedules` (Argo 3.6+), else the one `spec.schedule`. */
export function schedulesOf(cron: KubeObject): string[] {
  const many = arr(get(cron, "spec", "schedules")).filter((s): s is string => typeof s === "string");
  const one = str(get(cron, "spec", "schedule"));
  return many.length > 0 ? many : one ? [one] : [];
}

export const cronSuspended = (cron: KubeObject): boolean => get(cron, "spec", "suspend") === true;
export const lastScheduled = (cron: KubeObject): string | undefined => str(get(cron, "status", "lastScheduledTime"));

/** The Workflows the CronWorkflow is running now (`status.active`). */
export function activeWorkflows(cron: KubeObject): { name: string; namespace?: string }[] {
  return arr(get(cron, "status", "active")).flatMap((a) => {
    const name = str(get(a, "name"));
    return name ? [{ name, namespace: str(get(a, "namespace")) }] : [];
  });
}

/** `status.succeeded` / `status.failed` counts (Argo 3.6+). */
export function cronCounts(cron: KubeObject): { succeeded?: number; failed?: number } {
  return { succeeded: num(get(cron, "status", "succeeded")), failed: num(get(cron, "status", "failed")) };
}

/** The entry template and the number of templates of a Workflow, WorkflowTemplate or ClusterWorkflowTemplate. */
export function templateSummary(obj: KubeObject): { entrypoint?: string; templates: string[] } {
  const spec = obj.kind === CRON_WORKFLOW.kind ? get(obj, "spec", "workflowSpec") : get(obj, "spec");
  return {
    entrypoint: str(get(spec, "entrypoint")),
    templates: arr(get(spec, "templates")).flatMap((t) => (str(get(t, "name")) ? [str(get(t, "name")) as string] : [])),
  };
}

// ---------- Problems ----------

/** How long a failed Workflow counts as a problem after it failed (or, when that time is unknown, was created). */
export const RECENT_FAILURE_MS = 24 * 3600_000;
/** The label selector of the problems source: failed and errored Workflows only. */
export const FAILED_SELECTOR = `${PHASE_LABEL} in (Failed,Error)`;

/**
 * When a failed Workflow (metadata only) failed, as the built-in problems source read it: the moment the source saw it
 * enter the failed list while watching (`enteredAt`), else its creation; it counts until `RECENT_FAILURE_MS` after.
 * `undefined` when the phase label is not Failed or Error, or no time is known.
 */
export function failedAt(wf: KubeObject, enteredAt?: number): { since: number; until: number } | undefined {
  const phase = str(labelsOf(wf)[PHASE_LABEL]);
  if (!isFailedPhase(phase)) return undefined;
  const created = Date.parse(String(wf.metadata?.creationTimestamp ?? ""));
  const since = Math.max(Number.isNaN(created) ? -Infinity : created, enteredAt ?? -Infinity);
  return Number.isFinite(since) ? { since, until: since + RECENT_FAILURE_MS } : undefined;
}
