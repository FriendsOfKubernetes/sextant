// Cluster Autoscaler as the autoscaling views read it — pure, no React: its status ConfigMap
// (`kube-system/cluster-autoscaler-status`, key `status`; YAML since 1.30, the older indented text before), its events
// on pods (TriggeredScaleUp, NotTriggerScaleUp with the reasons per node group) and the marks it puts on nodes it
// removes (the ToBeDeletedByClusterAutoscaler and DeletionCandidateOfClusterAutoscaler taints) or must keep (the
// scale-down-disabled annotation).
import { parse } from "yaml";
import type { KubeObject } from "../../api";
import { status } from "../../resources";
import { phrase, type EventRow, type Phrase } from "./model";
import { parseReasonList, type MessageReason } from "./scheduling";

const { arr, get, num, record, str } = status;

export const STATUS_NAMESPACE = "kube-system";
export const STATUS_NAME = "cluster-autoscaler-status";
export const TO_BE_DELETED = "ToBeDeletedByClusterAutoscaler";
export const DELETION_CANDIDATE = "DeletionCandidateOfClusterAutoscaler";
export const SCALE_DOWN_DISABLED = "cluster-autoscaler.kubernetes.io/scale-down-disabled";

export interface CaGroup {
  name: string;
  health?: string;
  scaleUp?: string;
  scaleDown?: string;
  ready?: number;
  registered?: number;
  target?: number;
  min?: number;
  max?: number;
}

export interface CaStatus {
  time?: string;
  /** Running / Initializing (YAML format only). */
  autoscalerStatus?: string;
  health?: string;
  scaleUp?: string;
  scaleDown?: string;
  ready?: number;
  registered?: number;
  groups: CaGroup[];
}

function set<T extends object, K extends keyof T>(obj: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined && value !== null && value !== "") obj[key] = value;
}

function fromYaml(doc: unknown): CaStatus {
  const out: CaStatus = { groups: [] };
  set(out, "time", str(get(doc, "time")));
  set(out, "autoscalerStatus", str(get(doc, "autoscalerStatus")));
  const wide = get(doc, "clusterWide");
  set(out, "health", str(get(wide, "health", "status")));
  set(out, "scaleUp", str(get(wide, "scaleUp", "status")));
  set(out, "scaleDown", str(get(wide, "scaleDown", "status")));
  set(out, "ready", num(get(wide, "health", "nodeCounts", "registered", "ready")));
  set(out, "registered", num(get(wide, "health", "nodeCounts", "registered", "total")));
  for (const g of arr(get(doc, "nodeGroups"))) {
    const group: CaGroup = { name: str(get(g, "name")) ?? "" };
    set(group, "health", str(get(g, "health", "status")));
    set(group, "scaleUp", str(get(g, "scaleUp", "status")));
    set(group, "scaleDown", str(get(g, "scaleDown", "status")));
    set(group, "ready", num(get(g, "health", "nodeCounts", "registered", "ready")));
    set(group, "registered", num(get(g, "health", "nodeCounts", "registered", "total")));
    set(group, "target", num(get(g, "health", "cloudProviderTarget")));
    set(group, "min", num(get(g, "health", "minSize")));
    set(group, "max", num(get(g, "health", "maxSize")));
    out.groups.push(group);
  }
  return out;
}

/** "Healthy (ready=3 unready=0 … cloudProviderTarget=3 (minSize=1, maxSize=10))" → its word and numbers. */
function textLine(value: string): { word: string; numbers: Record<string, number> } {
  const word = /^(\S+)/.exec(value)?.[1] ?? "";
  const numbers: Record<string, number> = {};
  for (const m of value.matchAll(/(\w+)=(\d+)/g)) numbers[m[1]!] = Number(m[2]);
  return { word, numbers };
}

function fromText(text: string): CaStatus {
  const out: CaStatus = { groups: [] };
  set(out, "time", /status at (.+?):\s*$/m.exec(text)?.[1]?.trim());
  let group: CaGroup | undefined;
  let wide = true;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^NodeGroups:/.test(line)) wide = false;
    const m = /^(Name|Health|ScaleUp|ScaleDown):\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, field, value] = m as unknown as [string, string, string];
    if (field === "Name") {
      group = { name: value.trim() };
      out.groups.push(group);
      continue;
    }
    const { word, numbers } = textLine(value);
    if (wide) {
      if (field === "Health") {
        set(out, "health", word);
        set(out, "ready", numbers.ready);
        set(out, "registered", numbers.registered);
      } else if (field === "ScaleUp") set(out, "scaleUp", word);
      else set(out, "scaleDown", word);
    } else if (group) {
      if (field === "Health") {
        set(group, "health", word);
        set(group, "ready", numbers.ready);
        set(group, "registered", numbers.registered);
        set(group, "target", numbers.cloudProviderTarget);
        set(group, "min", numbers.minSize);
        set(group, "max", numbers.maxSize);
      } else if (field === "ScaleUp") set(group, "scaleUp", word);
      else set(group, "scaleDown", word);
    }
  }
  return out;
}

/** The status ConfigMap read; `undefined` without a `status` text. */
export function parseCaStatus(configMap: KubeObject | undefined): CaStatus | undefined {
  const text = str(get(configMap, "data", "status"));
  if (!text) return undefined;
  if (/^\s*(time|autoscalerStatus|clusterWide):/m.test(text)) {
    try {
      return fromYaml(parse(text));
    } catch {
      return undefined;
    }
  }
  return fromText(text);
}

export function isCaStatusMap(obj: KubeObject | null): boolean {
  return obj?.metadata?.name === STATUS_NAME;
}

// ---------- Events ----------

export function isCaEvent(e: EventRow): boolean {
  return /cluster-autoscaler/i.test(e.source) || e.reason === "TriggeredScaleUp" || e.reason === "NotTriggerScaleUp";
}

export interface ScaleUpGroup {
  group: string;
  from: number;
  to: number;
  max?: number;
}

/** "pod triggered scale-up: [{ng-1 1->2 (max: 10)} {ng-2 0->1 (max: 3)}]" → the groups. */
export function triggeredGroups(message: string): ScaleUpGroup[] {
  return [...message.matchAll(/\{(\S+)\s+(\d+)->(\d+)(?:\s+\(max:\s*(\d+)\))?\}/g)].map((m) => {
    const group: ScaleUpGroup = { group: m[1]!, from: Number(m[2]), to: Number(m[3]) };
    if (m[4]) group.max = Number(m[4]);
    return group;
  });
}

/** "pod didn't trigger scale-up: 2 max node group size reached, 1 node(s) didn't match …" → the reasons. */
export function notTriggeredReasons(message: string): MessageReason[] {
  const at = message.indexOf(":");
  return at < 0 ? [] : parseReasonList(message.slice(at + 1));
}

// ---------- Nodes ----------

/** Cluster Autoscaler's marks on a node, in plain words. */
export function caNodeMarks(node: KubeObject): Phrase[] {
  const out: Phrase[] = [];
  const taints = arr(get(node, "spec", "taints")).map((t) => str(get(t, "key")));
  if (taints.includes(TO_BE_DELETED)) out.push(phrase("ca.toBeDeleted", undefined, "warning"));
  else if (taints.includes(DELETION_CANDIDATE)) out.push(phrase("ca.candidate", undefined, "neutral"));
  if (str(record(node.metadata?.annotations)[SCALE_DOWN_DISABLED]) === "true") {
    out.push(phrase("ca.scaleDownDisabled", { annotation: SCALE_DOWN_DISABLED }, "neutral"));
  }
  return out;
}
