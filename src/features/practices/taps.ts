// The tap on the problems store's cluster-wide Node watch that tells how many nodes take pods, shared by the problems
// category (provider.ts) and the views (hooks.ts): one tap id, so both hold the same rows.
import type { KubeObject } from "../../api";
import { NODE } from "../problems/model";
import type { SourceDef } from "../problems/sources";
import type { RowTap } from "../problems/store";

/** The `nodes` category's source (the same key, so its watch is shared). */
export const NODE_SOURCE: SourceDef = { category: "nodes", kind: NODE, fieldSelector: null, discovered: false };

/** A node takes new pods unless it is cordoned. */
export const NODE_TAP_DEF: RowTap<boolean> = {
  id: "practices:nodes",
  toRow: (node: KubeObject) => (node.spec as { unschedulable?: unknown } | undefined)?.unschedulable !== true,
  max: 10_000,
};
