// Health colours of the map and the "Related" view, read with the problems screen's rules (`problems/model.ts`), so a
// red node here is red there too:
//   problem — an active problem;  pending — a problem still in its grace period;  ok — judged and fine;
//   neutral — a kind the rules do not judge (a Service, a ConfigMap);  missing — referred to but not there;
//   unknown — only referred to, its kind not listed.
import type { KindRef } from "../../api";
import { categoryOf, isActive, resolve } from "../problems/model";
import type { GraphNode } from "./relations";

export type MapHealth = "problem" | "pending" | "missing" | "ok" | "neutral" | "unknown";

/** Worst first: what a group of nodes shows. */
export const HEALTH_ORDER: readonly MapHealth[] = ["problem", "missing", "pending", "ok", "neutral", "unknown"];

export function nodeHealth(node: GraphNode, now: number): MapHealth {
  if (node.missing) return "missing";
  if (!node.obj || !node.kind) return "unknown";
  const kind: KindRef = node.kind;
  if (!categoryOf(kind)) return "neutral";
  const problems = resolve(kind, node.obj, now);
  if (problems.length === 0) return "ok";
  return problems.some((p) => isActive(p, now)) ? "problem" : "pending";
}

export function worstHealth(values: Iterable<MapHealth>): MapHealth {
  let worst: MapHealth = "unknown";
  let rank = HEALTH_ORDER.length;
  for (const value of values) {
    const r = HEALTH_ORDER.indexOf(value);
    if (r < rank) {
      rank = r;
      worst = value;
    }
  }
  return worst;
}
