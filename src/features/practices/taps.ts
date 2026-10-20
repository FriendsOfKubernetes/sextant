// The tap on the problems store's cluster-wide Node watch that tells which nodes take pods, shared by the problems
// category (provider.ts) and the views (hooks.ts): one tap id, so both hold the same rows.
import type { KubeObject } from "../../api";
import { status } from "../../resources";
import type { Taint } from "../autoscaling/scheduling";
import { NODE } from "../problems/model";
import type { SourceDef } from "../problems/sources";
import type { RowTap } from "../problems/store";

const { arr, get, record, str } = status;

/** The `nodes` category's source (the same key, so its watch is shared). */
export const NODE_SOURCE: SourceDef = { category: "nodes", kind: NODE, fieldSelector: null, discovered: false };

/** A node that takes new pods: what decides whether a pod template may land on it. */
export interface SchedulingNode {
  name: string;
  labels: Record<string, string>;
  /** Only the taints that keep pods off (`NoSchedule`, `NoExecute`); `PreferNoSchedule` does not. */
  taints: Taint[];
}

/** A node as the "replicas on one node" check sees it; `null` when it is cordoned. */
export function schedulingNode(node: KubeObject): SchedulingNode | null {
  if (get(node, "spec", "unschedulable") === true) return null;
  const taints: Taint[] = [];
  for (const t of arr(get(node, "spec", "taints"))) {
    const effect = str(get(t, "effect")) ?? "";
    if (effect !== "NoSchedule" && effect !== "NoExecute") continue;
    const taint: Taint = { key: str(get(t, "key")) ?? "", effect };
    const value = str(get(t, "value"));
    if (value) taint.value = value;
    taints.push(taint);
  }
  return {
    name: node.metadata?.name ?? "",
    labels: Object.fromEntries(Object.entries(record(node.metadata?.labels)).map(([k, v]) => [k, String(v)])),
    taints,
  };
}

/** A node takes new pods unless it is cordoned; its labels and taints say which pods. */
export const NODE_TAP_DEF: RowTap<SchedulingNode | null> = {
  id: "practices:nodes",
  toRow: schedulingNode,
  max: 10_000,
};
