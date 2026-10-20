// What Argo Workflows objects say, read the way the Argo Workflows UI reads them (ADR-0097): the phase, progress and
// duration of a Workflow, the node that failed and its message, the node tree (bounded), the pod of a pod node (named
// as ui/src/shared/pod-name.ts and workflow/util/pod_name.go name it, by `workflows.argoproj.io/pod-name-format`), and
// a CronWorkflow's schedule, last run and active Workflows. No React here.
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import type { Tone } from "../../resources/status";

const { arr, get, num, record, str } = status;

export const WORKFLOWS_GROUP = "argoproj.io";
const v1alpha1 = (kind: string): KindRef => ({ group: WORKFLOWS_GROUP, version: "v1alpha1", kind });

export const WORKFLOW = v1alpha1("Workflow");
export const CRON_WORKFLOW = v1alpha1("CronWorkflow");
export const WORKFLOW_TEMPLATE = v1alpha1("WorkflowTemplate");
export const CLUSTER_WORKFLOW_TEMPLATE = v1alpha1("ClusterWorkflowTemplate");

/** The kinds of the sidebar section, in its order. Argo CD's and Argo Rollouts' kinds share the group. */
export const WORKFLOWS_KINDS = [
  { kind: WORKFLOW, label: "workflows", order: 10, namespaced: true },
  { kind: CRON_WORKFLOW, label: "cronWorkflows", order: 20, namespaced: true },
  { kind: WORKFLOW_TEMPLATE, label: "workflowTemplates", order: 30, namespaced: true },
  { kind: CLUSTER_WORKFLOW_TEMPLATE, label: "clusterWorkflowTemplates", order: 40, namespaced: false },
] as const;

export const isKind = (kind: Pick<KindRef, "group" | "kind">, ...of: KindRef[]): boolean =>
  of.some((k) => k.group === kind.group && k.kind === kind.kind);

export const isWorkflowsKind = (kind: Pick<KindRef, "group" | "kind">): boolean =>
  WORKFLOWS_KINDS.some((d) => isKind(kind, d.kind));

/** The label the controller keeps equal to `status.phase` (server-side selectable, unlike the status). */
export const PHASE_LABEL = "workflows.argoproj.io/phase";
/** The label linking a Workflow to the CronWorkflow that started it. */
export const CRON_WORKFLOW_LABEL = "workflows.argoproj.io/cron-workflow";
/** How the controller named the Workflow's pods: `v1` (the node id) or `v2` (the default). */
export const POD_NAME_FORMAT_ANNOTATION = "workflows.argoproj.io/pod-name-format";

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
 * The pod of a pod node, as the controller names it (`GeneratePodName`): `v1` is the node id; `v2` (the default,
 * also without the annotation) is `<workflow>-<template>-<hash>`, the hash taken from the node id (the workflow name
 * followed by the hash of the node name) or computed from the node name, the prefix cut to fit 253 characters. A
 * container-set container runs in the pod of its boundary node. `undefined` for a node that has no pod.
 */
export function podNameOf(wf: KubeObject, node: WorkflowNode): string | undefined {
  if (!POD_TYPES.has(node.type)) return undefined;
  const podNodeId = (node.type === "Container" ? node.boundaryID : node.id) ?? node.id;
  const version = str(record(wf.metadata?.annotations)[POD_NAME_FORMAT_ANNOTATION]);
  if (version === "v1") return podNodeId;
  const workflowName = wf.metadata?.name ?? "";
  if (workflowName === podNodeId) return workflowName;
  const templateName = node.templateName || str(get(node.raw, "templateRef", "template")) || "";
  let prefix = templateName ? `${workflowName}-${templateName}` : workflowName;
  if (prefix.length > MAX_PREFIX - 1) prefix = prefix.substring(0, MAX_PREFIX - 1);
  const idPrefix = `${workflowName}-`;
  const hash = podNodeId.startsWith(idPrefix) ? podNodeId.substring(idPrefix.length) : String(fnv32a(node.name));
  const excess = prefix.length + 1 + hash.length - MAX_NAME;
  if (excess > 0) prefix = prefix.substring(0, prefix.length - excess);
  return `${prefix}-${hash}`;
}

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
  const spec = isKind({ group: WORKFLOWS_GROUP, kind: obj.kind ?? "" }, CRON_WORKFLOW) ? get(obj, "spec", "workflowSpec") : get(obj, "spec");
  return {
    entrypoint: str(get(spec, "entrypoint")),
    templates: arr(get(spec, "templates")).flatMap((t) => (str(get(t, "name")) ? [str(get(t, "name")) as string] : [])),
  };
}

// ---------- Problems ----------

/** How long a failed Workflow counts as a problem after it was created. */
export const RECENT_FAILURE_MS = 24 * 3600_000;
/** Failed Workflows the problems source keeps (metadata only). */
export const MAX_FAILED_WORKFLOWS = 500;
/** The label selector of the problems source: failed and errored Workflows only. */
export const FAILED_SELECTOR = `${PHASE_LABEL} in (Failed,Error)`;
