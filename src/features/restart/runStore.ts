// The state of each restart dialog's run, kept outside React (#255, ADR-0112 amendment). The action dialog host
// lives in the main view, which unmounts when the user switches to "All clusters" or to no cluster; the dialog entry
// stays and renders again later. Kept in a component, the run went on unseen and the remount offered a fresh
// "Restart" that could start a second loop beside it (two deletions at once). Here the run belongs to the dialog
// entry's id: a remount shows the live run with Stop, a second start of the same entry is refused, and a cluster
// that disconnects stops the run (the request in flight finishes, nothing more starts).
import type { ClusterId } from "../../api";
import { useClustersStore } from "../clusters/clustersStore";
import type { RestartStep } from "./model";
import { runRestart, type Progress, type RunControl, type StepOutcome } from "./run";

export type RunPhase = "confirm" | "running" | "result";

export interface RunSnapshot {
  phase: RunPhase;
  progress: Progress | null;
  stopRequested: boolean;
  /** The cluster's connection went away while it ran. */
  disconnected: boolean;
  outcomes: StepOutcome[];
}

export interface RestartRun {
  readonly id: string;
  readonly clusterId: ClusterId;
  readonly steps: readonly RestartStep[];
  snapshot: () => RunSnapshot;
  subscribe: (fn: () => void) => () => void;
  /**
   * Starts the run once; a second call (another mount of the same dialog entry) gets the running promise and starts
   * nothing. `onDone` is told the outcomes even when no dialog is mounted.
   */
  start: (control: Omit<RunControl, "stopped" | "onProgress">, onDone?: (outcomes: StepOutcome[]) => void) => Promise<StepOutcome[]>;
  stop: () => void;
}

const runs = new Map<string, RestartRun>();
let counter = 0;

/** A new id for a restart dialog entry. */
export function newRestartRunId(): string {
  return `restart-${++counter}`;
}

function createRun(id: string, clusterId: ClusterId, steps: readonly RestartStep[]): RestartRun {
  let state: RunSnapshot = { phase: "confirm", progress: null, stopRequested: false, disconnected: false, outcomes: [] };
  let stopped = false;
  let running: Promise<StepOutcome[]> | null = null;
  const listeners = new Set<() => void>();
  const set = (next: Partial<RunSnapshot>) => {
    state = { ...state, ...next };
    for (const fn of [...listeners]) fn();
  };
  const stop = () => {
    stopped = true;
    if (!state.stopRequested) set({ stopRequested: true });
  };
  return {
    id,
    clusterId,
    steps,
    snapshot: () => state,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    stop,
    start: (control, onDone) => {
      if (running) return running;
      set({ phase: "running" });
      let was = useClustersStore.getState().states[clusterId]?.state;
      const unfollow = useClustersStore.subscribe((s) => {
        const now = s.states[clusterId]?.state;
        if (now === was) return;
        was = now;
        if (now !== "connected") {
          if (!state.disconnected) set({ disconnected: true });
          stop();
        }
      });
      running = runRestart(clusterId, steps, { ...control, stopped: () => stopped, onProgress: (progress) => set({ progress }) })
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

/** The run of the dialog entry `id`, created on first use. */
export function restartRunOf(id: string, clusterId: ClusterId, steps: readonly RestartStep[]): RestartRun {
  let run = runs.get(id);
  if (!run) {
    run = createRun(id, clusterId, steps);
    runs.set(id, run);
  }
  return run;
}

/** Forgets the run of a closed dialog entry (a run still going is kept until it ends). */
export function forgetRestartRun(id: string): void {
  const run = runs.get(id);
  if (run && run.snapshot().phase !== "running") runs.delete(id);
}

/** Forgets every run (tests). */
export function resetRestartRuns(): void {
  runs.clear();
}
