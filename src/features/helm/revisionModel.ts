// Pure model of the revision comparison (#209) and of newer chart versions: what each object of two revisions did,
// which revisions to compare by default, and which releases have a newer chart.
import type { ChartUpdate, HelmRelease, RevisionObject } from "../../api";
import { deepEqual, normalize, type NormalizeOptions } from "../compare/normalize";

export type RevisionObjectState = "added" | "removed" | "changed" | "same";

/** Revisions are compared as stored: no defaults hidden, no ignore paths. */
export const REVISION_NORMALIZE: NormalizeOptions = { hideDefaults: false, ignorePaths: [] };

/**
 * What happened to an object from the left revision to the right one. Both sides are normalized the way the compare
 * view does it; a Secret also counts as changed when a key or a value (by hash, compared in the backend) differs.
 */
export function revisionObjectState(o: RevisionObject, options: NormalizeOptions = REVISION_NORMALIZE): RevisionObjectState {
  if (o.left === null) return "added";
  if (o.right === null) return "removed";
  const secretChanged = (o.secretKeys ?? []).some((k) => !(k.onLeft && k.onRight && k.equal));
  if (secretChanged) return "changed";
  return deepEqual(normalize(o.left, o.object.kind, options), normalize(o.right, o.object.kind, options)) ? "same" : "changed";
}

/** The revisions that can be compared (readable ones), newest first. */
export function readableRevisions(history: readonly HelmRelease[]): number[] {
  return history
    .filter((h) => !h.unreadable)
    .map((h) => h.revision)
    .sort((a, b) => b - a);
}

/** "What changed in the last upgrade": the newest readable revision before `current`, and `current`. */
export function lastUpgradePair(history: readonly HelmRelease[], current: number): { left: number; right: number } | null {
  const previous = readableRevisions(history).find((r) => r < current);
  return previous === undefined ? null : { left: previous, right: current };
}

/** The key of a chart and version, as the update report and the release list share it. */
export function chartKey(chart: string, version: string): string {
  return `${chart}@${version}`;
}

/** The release has a newer chart in an added repository. */
export function hasUpdate(update: ChartUpdate | undefined): boolean {
  return update?.step != null;
}
