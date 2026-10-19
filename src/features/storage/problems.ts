// The source of the opt-in problems category "disk almost full" (#152): while the problems store holds it (the
// category is on and a problems screen, the Cluster counter or the notifications look at the cluster), the cluster's
// fill levels are polled (shared with the PVC table and the details, usageStore.ts) and each claim at or over a
// threshold becomes a problem of its PersistentVolumeClaim. A new answer, a changed threshold and the clock (every
// 30 s) make it look again; nothing is kept once the source is released.
import { getSettingsSnapshot } from "../../api/settings";
import { formatNumber } from "../../i18n";
import { formatBytes } from "../metrics/format";
import { registerProblemProvider } from "../problems/store";
import { diskProblems, thresholdsOf, type Thresholds } from "./usage";
import { acquireVolumeUsage, getVolumeUsage, subscribeVolumeUsage } from "./usageStore";

/** How often the thresholds in the settings are read again without a new answer. */
export const LOOK_AGAIN_MS = 30_000;

const thresholdListeners = new Set<() => void>();

/** The thresholds as saved now (the defaults before the settings are loaded). */
export function currentThresholds(): Thresholds {
  return thresholdsOf(getSettingsSnapshot()?.notifications);
}

/** Tells the sources that the thresholds were saved, so held problems follow at once. */
export function thresholdsChanged(): void {
  for (const fn of [...thresholdListeners]) fn();
}

export const DISK_FORMAT = {
  percent: (value: number) => `${formatNumber(value, value % 1 === 0 ? 0 : 1)}%`,
  bytes: formatBytes,
  count: (value: number) => formatNumber(value),
};

registerProblemProvider("disk", (clusterId, set) => {
  const firstSeen = new Map<string, number>();
  const look = () => {
    const state = getVolumeUsage(clusterId);
    if (!state || state.loading) {
      set({ status: "loading", problems: [] });
      return;
    }
    if (state.error) {
      set({ status: "error", error: state.error, problems: [] });
      return;
    }
    const volumes = state.report?.volumes ?? [];
    set({
      status: "ready",
      problems: diskProblems(volumes, currentThresholds(), firstSeen, Date.now(), DISK_FORMAT),
      truncated: state.report?.truncated ?? false,
    });
  };
  const release = acquireVolumeUsage(clusterId);
  const unsubscribe = subscribeVolumeUsage(look);
  thresholdListeners.add(look);
  const timer = setInterval(look, LOOK_AGAIN_MS);
  look();
  return () => {
    clearInterval(timer);
    thresholdListeners.delete(look);
    unsubscribe();
    release();
  };
});
