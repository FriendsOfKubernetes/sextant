// The source of the opt-in problems category `practices` (#207): while the problems store holds it (the category is on
// and a problems screen, the Cluster counter or the notifications look at a cluster), the provider taps the store's
// cluster-wide watches instead of opening its own: the workloads and Jobs (shared with the `workloads` and `jobs`
// categories), the Pods and Nodes (shared with `pods` and `nodes`: which node each replica runs on, which nodes take
// pods), and — only while this category is held — CronJobs, HPAs, PodDisruptionBudgets and LimitRanges. Every update
// is reduced to compact rows at once (model.ts); no object is kept. The right-sizing check needs Prometheus history and
// is shown on the page and in the details only. Nothing is kept once the source is released.
import { getSettingsSnapshot, subscribeSettings } from "../../api/settings";
import type { ClusterId, KindRef, KubeObject } from "../../api";
import { CATEGORY_SOURCES, type SourceDef } from "../problems/sources";
import { acquireRows, getRows, registerProblemProvider, subscribeSources, type RowsState, type RowTap } from "../problems/store";
import { sourceKey } from "../problems/sources";
import { evaluateAll, indexLimits, indexPlacements, type Context } from "./checks";
import { practicesConfigOf } from "./config";
import { hpaInfo, limitDefaults, pdbInfo, placementOf, workloadInfo, type HpaInfo, type LimitDefaults, type PdbInfo, type Placement, type WorkloadInfo } from "./model";
import { practiceProblems } from "./problems";
import { NODE_SOURCE, NODE_TAP_DEF, type SchedulingNode } from "./taps";

/** Updates of the shared watches come in bursts (every pod's status): the findings are looked at again at most this often. */
export const LOOK_MS = 500;
export const MAX_WORKLOAD_ROWS = 20_000;
export const MAX_POD_ROWS = 50_000;
export const MAX_OTHER_ROWS = 10_000;

const own = (kind: KindRef): SourceDef => ({ category: "practices", kind, fieldSelector: null, discovered: false });
export const CRONJOB_SOURCE = own({ group: "batch", version: "v1", kind: "CronJob" });
export const HPA_SOURCE = own({ group: "autoscaling", version: "v2", kind: "HorizontalPodAutoscaler" });
export const PDB_SOURCE = own({ group: "policy", version: "v1", kind: "PodDisruptionBudget" });
export const LIMIT_RANGE_SOURCE = own({ group: "", version: "v1", kind: "LimitRange" });

interface Tapped<R> {
  def: SourceDef;
  tap: RowTap<R>;
}

const tapped = <R>(def: SourceDef, id: string, toRow: (obj: KubeObject) => R, max: number): Tapped<R> => ({
  def,
  tap: { id: `practices:${id}`, toRow, max },
});

const WORKLOAD_TAPS: Tapped<WorkloadInfo | null>[] = [
  ...CATEGORY_SOURCES.workloads.map((def) => tapped(def, def.kind.kind, (o) => workloadInfo(def.kind.kind, o), MAX_WORKLOAD_ROWS)),
  ...CATEGORY_SOURCES.jobs.map((def) => tapped(def, def.kind.kind, (o) => workloadInfo(def.kind.kind, o), MAX_WORKLOAD_ROWS)),
  tapped(CRONJOB_SOURCE, "CronJob", (o) => workloadInfo("CronJob", o), MAX_WORKLOAD_ROWS),
];
const HPA_TAP = tapped<HpaInfo>(HPA_SOURCE, "hpas", hpaInfo, MAX_OTHER_ROWS);
const PDB_TAP = tapped<PdbInfo>(PDB_SOURCE, "pdbs", pdbInfo, MAX_OTHER_ROWS);
const LIMIT_TAP = tapped<LimitDefaults>(LIMIT_RANGE_SOURCE, "limitRanges", limitDefaults, MAX_OTHER_ROWS);
const POD_TAP = tapped<Placement | null>(CATEGORY_SOURCES.pods[0]!, "placements", placementOf, MAX_POD_ROWS);
const NODE_TAP: Tapped<SchedulingNode | null> = { def: NODE_SOURCE, tap: NODE_TAP_DEF };

const ALL: Tapped<unknown>[] = [...WORKLOAD_TAPS, HPA_TAP, PDB_TAP, LIMIT_TAP, POD_TAP, NODE_TAP] as Tapped<unknown>[];

/** The rows of a tap when it has listed its kind in full; `undefined` when unknown (loading, failed, truncated). */
function known<R>(state: RowsState<R> | undefined): Iterable<R> | undefined {
  return state && state.status !== "loading" && state.status !== "error" && !state.truncated ? state.rows.values() : undefined;
}

/** What surrounds the workloads, from the taps' rows. */
export function contextOf(states: ReadonlyMap<string, RowsState<unknown> | undefined>): Context {
  const rows = <R>(t: Tapped<R>) => known(states.get(t.tap.id) as RowsState<R> | undefined);
  const hpas = rows(HPA_TAP);
  const pdbs = rows(PDB_TAP);
  const limits = rows(LIMIT_TAP);
  const pods = rows(POD_TAP);
  const nodes = rows(NODE_TAP);
  return {
    hpas: hpas && [...hpas],
    pdbs: pdbs && [...pdbs],
    limits: limits && indexLimits(limits),
    nodes: pods && indexPlacements(pods),
    schedulableNodes: nodes && [...nodes].filter((n): n is SchedulingNode => n !== null),
  };
}

registerProblemProvider("practices", (clusterId: ClusterId, set) => {
  const firstSeen = new Map<string, number>();
  const releases = ALL.map((t) => acquireRows(clusterId, t.def, t.tap as RowTap));
  let seen: (RowsState<unknown> | undefined)[] = [];
  let settings = getSettingsSnapshot();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let live = true;

  const states = () => ALL.map((t) => getRows(sourceKey(clusterId, t.def), t.tap.id));
  const look = () => {
    timer = undefined;
    if (!live) return;
    const now = states();
    seen = now;
    const workloadStates = now.slice(0, WORKLOAD_TAPS.length);
    const failed = workloadStates.find((s) => s?.status === "error");
    if (workloadStates.some((s) => !s || s.status === "loading")) {
      set({ status: failed ? "error" : "loading", error: failed?.error, problems: [] });
      return;
    }
    const workloads: WorkloadInfo[] = [];
    for (const s of workloadStates) for (const row of s!.rows.values()) if (row) workloads.push(row as WorkloadInfo);
    const ctx = contextOf(new Map(ALL.map((t, i) => [t.tap.id, now[i]])));
    const { problems, truncated } = practiceProblems(workloads, evaluateAll(workloads, ctx), practicesConfigOf(settings), firstSeen, Date.now());
    set({
      status: failed ? "error" : "ready",
      error: failed?.error,
      problems,
      truncated: truncated || workloadStates.some((s) => s!.truncated),
    });
  };
  const schedule = () => {
    if (live && !timer) timer = setTimeout(look, LOOK_MS);
  };
  // Every source's update wakes the store: look again only when one of the taps changed.
  const unsubscribe = subscribeSources(() => {
    const now = states();
    if (now.some((s, i) => s !== seen[i])) schedule();
  });
  const unfollow = subscribeSettings(() => {
    const next = getSettingsSnapshot();
    if (next?.practices === settings?.practices && !!next === !!settings) return;
    settings = next;
    schedule();
  });
  look();
  return () => {
    live = false;
    if (timer) clearTimeout(timer);
    unsubscribe();
    unfollow();
    for (const release of releases) release();
  };
});
