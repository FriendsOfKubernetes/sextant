// The state of each Delete dialog's run, kept outside React (ADR-0126), as Restart keeps its own (ADR-0112
// amendment): the action dialog host lives in the main view, which unmounts when the user switches to "All clusters"
// or to no cluster, while the dialog entry stays. Kept in a component, a deletion went on unseen and the remount
// offered a fresh "Delete" that could start a second loop beside it. Here the run belongs to the dialog entry's id: a
// remount shows the live run with Stop, a second start of the same entry gets the running promise, and a cluster that
// disconnects stops the run (the request in flight finishes, nothing more starts).
import type { ClusterId } from "../../api";
import { useClustersStore } from "../clusters/clustersStore";
import { deleteItems, type DeleteItem, type DeleteOutcome } from "./deleteRun";

export interface DeleteSnapshot {
  phase: "confirm" | "running" | "result";
  /** The index of the object being deleted. */
  current: number;
  stopRequested: boolean;
  outcomes: DeleteOutcome[];
}

export interface DeleteRun {
  readonly id: string;
  readonly items: readonly DeleteItem[];
  snapshot: () => DeleteSnapshot;
  subscribe: (fn: () => void) => () => void;
  /** Starts the run once; `onDone` is told the outcomes even when no dialog is mounted. */
  start: (onDone?: (outcomes: DeleteOutcome[]) => void) => Promise<DeleteOutcome[]>;
  stop: () => void;
}

const runs = new Map<string, DeleteRun>();
let counter = 0;

/** A new id for a Delete dialog entry. */
export function newDeleteRunId(): string {
  return `delete-${++counter}`;
}

function createRun(id: string, clusterId: ClusterId, items: readonly DeleteItem[]): DeleteRun {
  let state: DeleteSnapshot = { phase: "confirm", current: 0, stopRequested: false, outcomes: [] };
  let stopped = false;
  let running: Promise<DeleteOutcome[]> | null = null;
  const listeners = new Set<() => void>();
  const set = (next: Partial<DeleteSnapshot>) => {
    state = { ...state, ...next };
    for (const fn of [...listeners]) fn();
  };
  const stop = () => {
    stopped = true;
    if (!state.stopRequested) set({ stopRequested: true });
  };
  return {
    id,
    items,
    snapshot: () => state,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    stop,
    start: (onDone) => {
      if (running) return running;
      set({ phase: "running" });
      let was = useClustersStore.getState().states[clusterId]?.state;
      const unfollow = useClustersStore.subscribe((s) => {
        const now = s.states[clusterId]?.state;
        if (now === was) return;
        was = now;
        if (now !== "connected") stop();
      });
      running = deleteItems(clusterId, items, { onStart: (current) => set({ current }), shouldStop: () => stopped })
        .then((outcomes) => {
          set({ phase: "result", outcomes });
          onDone?.(outcomes);
          return outcomes;
        })
        .finally(unfollow);
      return running;
    },
  };
}

/** The run of the dialog entry `id`, created on first use with `items()`. */
export function deleteRunOf(id: string, clusterId: ClusterId, items: () => DeleteItem[]): DeleteRun {
  let run = runs.get(id);
  if (!run) {
    run = createRun(id, clusterId, items());
    runs.set(id, run);
  }
  return run;
}

/** Forgets the run of a closed dialog entry (a run still going is kept until it ends). */
export function forgetDeleteRun(id: string): void {
  const run = runs.get(id);
  if (run && run.snapshot().phase !== "running") runs.delete(id);
}
