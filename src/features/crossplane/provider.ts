// The source of the problems category "Crossplane" (#213): while the problems store holds it (the problems screen, a
// counter or the notifications look at a cluster that serves XRDs), the cluster's claims and composites are held
// (store.ts) and each one that is not Synced, or not Ready for another reason than being created or deleted, is a
// problem; one still being created counts after `CREATING_GRACE_MS` (cloud resources take minutes). A composite a
// claim stands for is told through its claim. Nothing is kept once the source is released.
import type { Problem } from "../problems/model";
import { registerProblemProvider } from "../problems/store";
import { acquireCrossplane, getCrossplane, subscribeCrossplane, type Row } from "./store";

/** A failure the next reconcile fixes passes quietly. */
export const FAILURE_GRACE_MS = 2 * 60_000;
/** Still being created after this long: worth a look (a managed database can take a quarter of an hour). */
export const CREATING_GRACE_MS = 30 * 60_000;

function time(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

/** The problems of the rows; `firstSeen` keeps when each was first seen. */
export function toProblems(rows: readonly Row[], firstSeen: Map<string, number>, now: number): Problem[] {
  const keys = new Set<string>();
  const out: Problem[] = [];
  for (const row of rows) {
    if (row.claimed || row.health === "ready" || row.health === "unknown") continue;
    const creating = row.health === "progressing";
    // Deleting is the user's own doing: never a problem.
    if (creating && row.failing?.reason === "Deleting") continue;
    const condition = row.failing;
    const reason = condition?.reason ?? (creating ? "Creating" : `${condition?.type ?? "Ready"}=False`);
    const key = `${row.uid}|${reason}`;
    keys.add(key);
    const first = firstSeen.get(key) ?? now;
    firstSeen.set(key, first);
    const start = time(condition?.lastTransitionTime) ?? first;
    out.push({
      key,
      notifyKey: `${row.uid}|notReady`,
      category: "crossplane",
      uid: row.uid,
      object: row.ref,
      reason,
      message: condition?.message,
      since: condition?.lastTransitionTime,
      notify: true,
      firstSeen: first,
      activeAt: start + (creating ? CREATING_GRACE_MS : FAILURE_GRACE_MS),
    });
  }
  for (const key of [...firstSeen.keys()]) if (!keys.has(key)) firstSeen.delete(key);
  return out;
}

registerProblemProvider("crossplane", (clusterId, set) => {
  const firstSeen = new Map<string, number>();
  const release = acquireCrossplane(clusterId);
  let last: unknown;
  const look = () => {
    const state = getCrossplane(clusterId);
    if (state === last) return;
    last = state;
    if (state.loading) set({ status: "loading", problems: [] });
    else set({ status: "ready", problems: toProblems(state.rows, firstSeen, Date.now()), truncated: state.rowsTruncated || state.xrdsTruncated });
  };
  const unsubscribe = subscribeCrossplane(look);
  look();
  return () => {
    unsubscribe();
    release();
  };
});
