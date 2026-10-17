// The problems screen's choices for the window's session (not saved): per cluster, the "seen" mark "Only new since…"
// compares with (set at the first visit and by "Mark all as seen") and whether that filter is on.
import { create } from "zustand";
import type { ClusterId } from "../../api";

interface ProblemsUiState {
  marks: Record<ClusterId, number>;
  onlyNew: Record<ClusterId, boolean>;
  /** Sets the mark of a cluster if it has none yet. */
  ensureMark: (clusterId: ClusterId, now: number) => void;
  markSeen: (clusterId: ClusterId, now: number) => void;
  setOnlyNew: (clusterId: ClusterId, on: boolean) => void;
}

export const useProblemsUi = create<ProblemsUiState>((set, get) => ({
  marks: {},
  onlyNew: {},
  ensureMark: (clusterId, now) => {
    if (get().marks[clusterId] === undefined) set((s) => ({ marks: { ...s.marks, [clusterId]: now } }));
  },
  markSeen: (clusterId, now) => set((s) => ({ marks: { ...s.marks, [clusterId]: now } })),
  setOnlyNew: (clusterId, on) => set((s) => ({ onlyNew: { ...s.onlyNew, [clusterId]: on } })),
}));

/** Back to a fresh start (tests). */
export function resetProblemsUi(): void {
  useProblemsUi.setState({ marks: {}, onlyNew: {} });
}
