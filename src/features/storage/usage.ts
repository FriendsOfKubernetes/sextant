// How full a claim is, and when that is a problem (#152). Pure: the fill level of a claim (bytes and inodes, from the
// kubelets or Prometheus) against the two thresholds of the opt-in category "disk almost full"
// (`notifications.volumeWarnPercent` / `volumeCriticalPercent`, 85 % and 95 % by default; inodes count the same).
import type { VolumeUsage } from "../../api";
import type { Problem } from "../problems/model";
import { PVC } from "./model";

export const DEFAULT_WARN_PERCENT = 85;
export const DEFAULT_CRITICAL_PERCENT = 95;
export const MIN_PERCENT = 50;
export const MAX_PERCENT = 99;

export interface Thresholds {
  warn: number;
  critical: number;
}

/** A percent setting within 50–99; anything unreadable is `fallback`. */
export function clampPercent(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(n)) return fallback;
  return Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, Math.round(n)));
}

/** The settings as the rule reads them: each clamped, the critical one never below the warning. */
export function thresholdsOf(notifications: { volumeWarnPercent?: number; volumeCriticalPercent?: number } | undefined): Thresholds {
  const warn = clampPercent(notifications?.volumeWarnPercent, DEFAULT_WARN_PERCENT);
  const critical = clampPercent(notifications?.volumeCriticalPercent, DEFAULT_CRITICAL_PERCENT);
  return { warn, critical: Math.max(warn, critical) };
}

/** `used` of `total` in percent (0–100, one decimal), `undefined` without both. */
export function percentUsed(used: number | null | undefined, total: number | null | undefined): number | undefined {
  if (used === null || used === undefined || !total || total <= 0) return undefined;
  return Math.min(100, Math.max(0, Math.round((used / total) * 1000) / 10));
}

/** The capacity: as the kubelet gives it, else used + available. */
export function bytesTotal(u: VolumeUsage): number | undefined {
  if (u.capacityBytes != null) return u.capacityBytes;
  return u.usedBytes != null && u.availableBytes != null ? u.usedBytes + u.availableBytes : undefined;
}

/**
 * The bytes that are not available any more: capacity − available when both are known, so a filesystem's reserved
 * blocks (ext4 keeps 5 % for root) count as used — a volume with nothing available reads 100 %, as Kubernetes'
 * own `KubePersistentVolumeFillingUp` alert sees it; else what the kubelet calls used.
 */
export function bytesUsed(u: VolumeUsage): number | undefined {
  if (u.capacityBytes != null && u.availableBytes != null) return Math.max(0, u.capacityBytes - u.availableBytes);
  return u.usedBytes ?? undefined;
}

export function bytesPercent(u: VolumeUsage): number | undefined {
  return percentUsed(bytesUsed(u), bytesTotal(u));
}

/** Inodes not free any more: total − free when both are known, else what the kubelet calls used. */
export function inodesUsedOf(u: VolumeUsage): number | undefined {
  if (u.inodes != null && u.inodesFree != null) return Math.max(0, u.inodes - u.inodesFree);
  return u.inodesUsed ?? undefined;
}

export function inodesPercent(u: VolumeUsage): number | undefined {
  return percentUsed(inodesUsedOf(u), u.inodes);
}

export type Level = "ok" | "warn" | "critical";

export function levelOf(percent: number | undefined, t: Thresholds): Level {
  if (percent === undefined) return "ok";
  if (percent >= t.critical) return "critical";
  if (percent >= t.warn) return "warn";
  return "ok";
}

/** The worse level of the bytes and the inodes of a claim. */
export function claimLevel(u: VolumeUsage, t: Thresholds): Level {
  const levels = [levelOf(bytesPercent(u), t), levelOf(inodesPercent(u), t)];
  return levels.includes("critical") ? "critical" : levels.includes("warn") ? "warn" : "ok";
}

/** `namespace/name` of a claim, as the usage report and the rows key it. */
export const claimKey = (namespace: string | null | undefined, name: string | null | undefined): string =>
  `${namespace ?? ""}/${name ?? ""}`;

/** The problems' pseudo-uid of a claim: the report names claims, not their uids. */
const uidOf = (u: VolumeUsage) => `claim:${claimKey(u.namespace, u.claim)}`;

/**
 * The problems of the category `disk`: a claim whose bytes or inodes are used at or over a threshold. Each level is a
 * state of its own (crossing the critical threshold notifies again); `firstSeen` (keyed by problem key, updated in
 * place) keeps when each was first seen across polls. `formatPercent` and `formatAmount` write the numbers of the
 * message in the UI language.
 */
export function diskProblems(
  report: readonly VolumeUsage[],
  thresholds: Thresholds,
  firstSeen: Map<string, number>,
  now: number,
  format: { percent: (value: number) => string; bytes: (value: number) => string; count: (value: number) => string },
): Problem[] {
  const out: Problem[] = [];
  const seen = new Set<string>();
  const add = (u: VolumeUsage, reason: string, group: string, messageKey: string, params: Record<string, string>) => {
    const uid = uidOf(u);
    const key = `${uid}|${reason}`;
    seen.add(key);
    const first = firstSeen.get(key) ?? now;
    firstSeen.set(key, first);
    out.push({
      key,
      notifyKey: `${uid}|${group}`,
      category: "disk",
      uid,
      object: { kind: PVC, namespace: u.namespace, name: u.claim },
      reason,
      group,
      messageKey,
      messageParams: params,
      notify: true,
      firstSeen: first,
      activeAt: first,
    });
  };
  for (const u of report) {
    const bytes = bytesPercent(u);
    const bytesLevel = levelOf(bytes, thresholds);
    if (bytes !== undefined && bytesLevel !== "ok") {
      add(u, bytesLevel === "critical" ? "CriticallyFull" : "AlmostFull", `disk-${bytesLevel}`, "messages.diskUsage", {
        percent: format.percent(bytes),
        used: format.bytes(bytesUsed(u) ?? 0),
        capacity: format.bytes(bytesTotal(u) ?? 0),
      });
    }
    const inodes = inodesPercent(u);
    const inodesLevel = levelOf(inodes, thresholds);
    if (inodes !== undefined && inodesLevel !== "ok") {
      add(u, inodesLevel === "critical" ? "InodesCriticallyFull" : "InodesAlmostFull", `inodes-${inodesLevel}`, "messages.inodeUsage", {
        percent: format.percent(inodes),
        used: format.count(inodesUsedOf(u) ?? 0),
        total: format.count(u.inodes ?? 0),
      });
    }
  }
  for (const key of [...firstSeen.keys()]) if (!seen.has(key)) firstSeen.delete(key);
  return out;
}

