// The order of clusters in the rail (`AppSettings.clusterOrder`): pure functions over cluster ids.
//
// The saved list holds cluster ids in the user's order; an empty list is the default order (the kubeconfig sources
// and their contexts, as `clusters_list` returns them). Clusters not in the list follow the listed ones in the default
// order, so a new cluster shows up at the end. The order is global: a workspace (#149) shows its clusters in it, and a
// move inside a filtered rail is made relative to the visible neighbours, leaving hidden clusters where they are. A
// move saves the whole current order, which also drops the ids of clusters that are gone.
import type { ClusterId } from "../../api";

/** The backend's cap (`settings/rail.rs`): more ids are left out when the file is read. */
export const MAX_CLUSTER_ORDER = 2000;

/** `clusters` in the saved order: the listed ones first, in its order, then the rest in their default order. */
export function orderClusters<T extends { id: ClusterId }>(clusters: readonly T[], order: readonly string[] | undefined): T[] {
  if (!order || order.length === 0) return [...clusters];
  const rank = new Map<string, number>();
  order.forEach((id, i) => {
    if (!rank.has(id)) rank.set(id, i);
  });
  const listed = clusters.filter((c) => rank.has(c.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  const rest = clusters.filter((c) => !rank.has(c.id));
  return [...listed, ...rest];
}

/**
 * The new order of every cluster after moving `id` so that it becomes the `to`-th of the visible clusters (counted
 * without `id` itself: 0 = first, `visible.length - 1` = last). `all` is every cluster in the current order, `visible`
 * the ones the rail shows (a subsequence of `all`). Hidden clusters keep their places. `null` when nothing changes.
 */
export function moveCluster(
  all: readonly ClusterId[],
  visible: readonly ClusterId[],
  id: ClusterId,
  to: number,
): ClusterId[] | null {
  const from = visible.indexOf(id);
  if (from < 0 || !all.includes(id)) return null;
  const others = visible.filter((v) => v !== id);
  const target = Math.max(0, Math.min(to, others.length));
  if (target === from) return null;
  const next = all.filter((c) => c !== id);
  if (target < others.length) {
    next.splice(next.indexOf(others[target]!), 0, id);
  } else {
    next.splice(next.indexOf(others[others.length - 1]!) + 1, 0, id);
  }
  return next.slice(0, MAX_CLUSTER_ORDER);
}

export type MoveStep = "up" | "down" | "top" | "bottom";

/** The visible position (as {@link moveCluster}'s `to`) a keyboard or menu move of the cluster at `from` goes to. */
export function stepTarget(step: MoveStep, from: number, count: number): number {
  switch (step) {
    case "up":
      return from - 1;
    case "down":
      return from + 1;
    case "top":
      return 0;
    case "bottom":
      return count - 1;
  }
}

/** The visible position a drop in gap `gap` (0 = before the first item, `count` = after the last) moves `from` to. */
export function gapTarget(gap: number, from: number): number {
  return gap > from ? gap - 1 : gap;
}
