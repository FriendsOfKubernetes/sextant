// What the install dialog knows about a running install, from the events of its stream (`InstallEvent`).
import { ApiError, type InstallEvent, type WorkloadState } from "../../api";

export type Outcome = "done" | "timedOut" | "stopped" | "error";

export interface RunState {
  total: number;
  /** Objects applied, in order. */
  applied: { kind: string; name: string }[];
  /** The object whose failure ended the apply. */
  failed: { kind: string; name: string; error: string } | null;
  /** The controllers' states once everything is applied (`null` before). */
  workloads: WorkloadState[] | null;
  /** The user pressed Stop; the install ends after the object being applied. */
  stopping: boolean;
  /** `null` while the install runs. */
  outcome: Outcome | null;
  /** How many objects were applied when it stopped. */
  stoppedAfter: number | null;
  /** Why it failed (an apply failure names the object and how many were applied before it). */
  error: ApiError | null;
}

export const initialRun: RunState = {
  total: 0,
  applied: [],
  failed: null,
  workloads: null,
  stopping: false,
  outcome: null,
  stoppedAfter: null,
  error: null,
};

export type RunAction =
  | { type: "start"; total: number }
  | { type: "event"; event: InstallEvent }
  | { type: "stopping" }
  | { type: "startFailed"; error: ApiError };

export function reduceRun(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case "start":
      return { ...initialRun, total: action.total };
    case "stopping":
      return state.outcome === null ? { ...state, stopping: true } : state;
    case "startFailed":
      return { ...state, outcome: "error", error: action.error };
    case "event": {
      if (state.outcome !== null) return state;
      const event = action.event;
      switch (event.type) {
        case "applied":
          return { ...state, applied: [...state.applied, { kind: event.kind, name: event.name }] };
        case "failed":
          return { ...state, failed: { kind: event.kind, name: event.name, error: event.error } };
        case "waiting":
          return { ...state, workloads: event.workloads };
        case "done":
          return { ...state, workloads: event.workloads, outcome: "done" };
        case "timedOut":
          return { ...state, workloads: event.workloads, outcome: "timedOut" };
        case "stopped":
          return { ...state, outcome: "stopped", stoppedAfter: event.applied };
        case "error":
          return { ...state, outcome: "error", error: new ApiError("other", event.message) };
      }
    }
  }
}
