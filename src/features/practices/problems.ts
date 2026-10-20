// Best-practice findings as problems of the opt-in category `practices` (#207): one problem per workload and check
// that is on, outside the excluded namespaces. Only High and Medium findings notify (and count on the sidebar badge);
// Low ones are listed on the problems screen. Pure.
import type { KindRef } from "../../api";
import type { Problem } from "../problems/model";
import { enabledFindings, type PracticesConfig } from "./config";
import type { CheckId, PracticeFinding, PracticeKind, Severity, WorkloadInfo } from "./model";

/** The reason a problem of each check shows (machine-readable, like the reasons of other problems). */
export const REASONS: Record<CheckId, string> = {
  readinessProbe: "NoReadinessProbe",
  livenessProbe: "NoLivenessProbe",
  mutableImage: "MutableImageTag",
  pullAlwaysDigest: "PullAlwaysOnDigest",
  singleReplica: "SingleReplica",
  noPdb: "NoPodDisruptionBudget",
  pdbBlocksDisruption: "DisruptionsBlocked",
  sameNode: "ReplicasOnOneNode",
  noRequests: "NoResourceRequests",
  noMemoryLimit: "NoMemoryLimit",
  limitsAboveRecommendation: "LimitsAboveRecommendation",
  hpaMinEqualsMax: "FixedAutoscaling",
};

export const KIND_REFS: Record<PracticeKind, KindRef> = {
  Deployment: { group: "apps", version: "v1", kind: "Deployment" },
  StatefulSet: { group: "apps", version: "v1", kind: "StatefulSet" },
  DaemonSet: { group: "apps", version: "v1", kind: "DaemonSet" },
  Job: { group: "batch", version: "v1", kind: "Job" },
  CronJob: { group: "batch", version: "v1", kind: "CronJob" },
};

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** At most this many workloads with findings become problems (the problems store keeps as many per source). */
export const MAX_PRACTICE_OBJECTS = 2000;

/**
 * The problems of the findings (`findings` by workload uid); `firstSeen` keeps when each was first seen, across calls.
 * `truncated`: workloads were left out to stay under `MAX_PRACTICE_OBJECTS`.
 */
export function practiceProblems(
  workloads: readonly WorkloadInfo[],
  findings: ReadonlyMap<string, readonly PracticeFinding[]>,
  config: PracticesConfig,
  firstSeen: Map<string, number>,
  now: number,
): { problems: Problem[]; truncated: boolean } {
  const problems: Problem[] = [];
  const keys = new Set<string>();
  let objects = 0;
  let truncated = false;
  for (const w of workloads) {
    if (config.excluded.has(w.namespace)) continue;
    const found = enabledFindings(findings.get(w.uid) ?? [], config);
    if (found.length === 0) continue;
    if (++objects > MAX_PRACTICE_OBJECTS) {
      truncated = true;
      break;
    }
    const byCheck = new Map<CheckId, PracticeFinding[]>();
    for (const f of found) byCheck.set(f.check, [...(byCheck.get(f.check) ?? []), f]);
    for (const [check, list] of byCheck) {
      const severity = list.reduce<Severity>((worst, f) => (RANK[f.severity] < RANK[worst] ? f.severity : worst), "low");
      const reason = REASONS[check];
      const key = `${w.uid}|${reason}`;
      keys.add(key);
      const first = firstSeen.get(key) ?? now;
      firstSeen.set(key, first);
      problems.push({
        key,
        notifyKey: key,
        category: "practices",
        uid: w.uid,
        object: { kind: KIND_REFS[w.kind], namespace: w.namespace, name: w.name },
        reason,
        group: `practices:${check}`,
        messageKey: "messages.practice",
        messageParams: { check },
        notify: severity !== "low",
        firstSeen: first,
        activeAt: first,
      });
    }
  }
  for (const key of [...firstSeen.keys()]) if (!keys.has(key)) firstSeen.delete(key);
  return { problems, truncated };
}
