// Pure evaluation of an upgrade-readiness scan (#142) against the built-in table for a chosen target version: which
// objects use an API version that is removed or deprecated by then, which deprecated versions the cluster still
// serves, and the filters of the page.
import type { ApiUsage, KindRef, UpgradeScan, UsageOrigin } from "../../api";
import { apiVersionOf, findDeprecation, replacementAt, type Deprecation, type Minor } from "./table";

export type FindingStatus = "removed" | "deprecated";

/** Where a usage was seen, as the page filters it. */
export type SourceType = "live" | "helm" | "argoCd" | "flux";

export const SOURCE_TYPES: readonly SourceType[] = ["live", "helm", "argoCd", "flux"];

export function sourceTypeOf(origin: UsageOrigin): SourceType {
  switch (origin.type) {
    case "lastApplied":
    case "managedFields":
      return "live";
    case "helm":
      return "helm";
    case "argoCd":
      return "argoCd";
    case "flux":
      return "flux";
  }
}

/** One object (or manifest document) in one deprecated API version, with every place it was seen. */
export interface Finding {
  key: string;
  kind: string;
  /** The API version used. */
  apiVersion: string;
  namespace: string | null;
  name: string;
  deprecation: Deprecation;
  status: FindingStatus;
  /** The current cluster no longer serves it either. */
  alreadyRemoved: boolean;
  /** Seen only in what live objects record (field managers, last applied) of a version the cluster no longer
   * serves: a trace of an old write, not something that breaks the upgrade. */
  historyOnly: boolean;
  replacement: string | null;
  note?: string;
  origins: UsageOrigin[];
  sources: SourceType[];
}

/** A deprecated API version the cluster serves. */
export interface ServedFinding {
  api: KindRef;
  apiVersion: string;
  deprecation: Deprecation;
  status: FindingStatus;
  replacement: string | null;
  note?: string;
}

/** `removed` when no longer served at `target`, `deprecated` when deprecated by then, otherwise `null`. */
export function statusAt(dep: Deprecation, target: Minor): FindingStatus | null {
  if (dep.removedIn <= target) return "removed";
  if (dep.deprecatedIn <= target) return "deprecated";
  return null;
}

function originKey(origin: UsageOrigin): string {
  return JSON.stringify(origin);
}

/** The scan's usages that matter at `target`, one row per object and API version, removed first. `current` is the
 * cluster's minor version (`null` when unknown). */
export function evaluate(scan: UpgradeScan, current: Minor | null, target: Minor): Finding[] {
  const rows = new Map<string, Finding>();
  const seen = new Set<string>();
  for (const usage of scan.usages as ApiUsage[]) {
    const { group, version, kind } = usage.api;
    const dep = findDeprecation(group, version, kind);
    if (!dep) continue;
    const status = statusAt(dep, target);
    if (!status) continue;
    const apiVersion = apiVersionOf(group, version);
    const key = `${apiVersion}|${kind}|${usage.namespace ?? ""}|${usage.name}`;
    let row = rows.get(key);
    if (!row) {
      const replacement = replacementAt(dep, target);
      row = {
        key,
        kind,
        apiVersion,
        namespace: usage.namespace ?? null,
        name: usage.name,
        deprecation: dep,
        status,
        alreadyRemoved: current !== null && dep.removedIn <= current,
        historyOnly: false,
        replacement: replacement.apiVersion,
        ...(replacement.note ? { note: replacement.note } : {}),
        origins: [],
        sources: [],
      };
      rows.set(key, row);
    }
    const originId = `${key}|${originKey(usage.origin)}`;
    if (seen.has(originId)) continue;
    seen.add(originId);
    row.origins.push(usage.origin);
    const source = sourceTypeOf(usage.origin);
    if (!row.sources.includes(source)) row.sources.push(source);
  }
  const out = [...rows.values()];
  for (const row of out) row.historyOnly = row.alreadyRemoved && row.sources.every((s) => s === "live");
  return out.sort(
    (a, b) =>
      (a.status === b.status ? 0 : a.status === "removed" ? -1 : 1) ||
      a.deprecation.removedIn - b.deprecation.removedIn ||
      a.kind.localeCompare(b.kind) ||
      (a.namespace ?? "").localeCompare(b.namespace ?? "") ||
      a.name.localeCompare(b.name) ||
      a.apiVersion.localeCompare(b.apiVersion),
  );
}

/** The deprecated API versions the cluster serves that matter at `target`, removed first. */
export function servedFindings(scan: UpgradeScan, target: Minor): ServedFinding[] {
  const out: ServedFinding[] = [];
  for (const api of scan.served) {
    const dep = findDeprecation(api.group, api.version, api.kind);
    if (!dep) continue;
    const status = statusAt(dep, target);
    if (!status) continue;
    const replacement = replacementAt(dep, target);
    out.push({
      api,
      apiVersion: apiVersionOf(api.group, api.version),
      deprecation: dep,
      status,
      replacement: replacement.apiVersion,
      ...(replacement.note ? { note: replacement.note } : {}),
    });
  }
  return out.sort(
    (a, b) =>
      (a.status === b.status ? 0 : a.status === "removed" ? -1 : 1) ||
      a.apiVersion.localeCompare(b.apiVersion) ||
      a.api.kind.localeCompare(b.api.kind),
  );
}

export interface FindingFilter {
  /** Source types to show; a finding seen in any of them is shown. */
  sources: ReadonlySet<SourceType>;
  /** Namespaces to show (cluster-scoped findings always are); `null` = all. */
  namespaces: readonly string[] | null;
  /** Show findings that are only traces of old writes (`historyOnly`). */
  history: boolean;
}

export function filterFindings(findings: readonly Finding[], filter: FindingFilter): Finding[] {
  const namespaces = filter.namespaces && filter.namespaces.length > 0 ? new Set(filter.namespaces) : null;
  return findings.filter(
    (f) =>
      (filter.history || !f.historyOnly) &&
      f.sources.some((s) => filter.sources.has(s)) &&
      (namespaces === null || f.namespace === null || namespaces.has(f.namespace)),
  );
}

export function countByStatus(findings: readonly { status: FindingStatus }[]): Record<FindingStatus, number> {
  const counts: Record<FindingStatus, number> = { removed: 0, deprecated: 0 };
  for (const f of findings) counts[f.status] += 1;
  return counts;
}

/** Target versions to offer: from the current minor up to the later of four releases ahead and one past the table's
 * review; without a current version, the table's range. */
export function targetChoices(current: Minor | null, reviewedFor: Minor): Minor[] {
  const first = current ?? reviewedFor - 4;
  const last = Math.max(first + 4, reviewedFor + 1);
  const out: Minor[] = [];
  for (let m = Math.max(first, 16); m <= last; m++) out.push(m);
  return out;
}

/** The default target: the next minor after the cluster's, or the table's newest reviewed release. */
export function defaultTarget(current: Minor | null, reviewedFor: Minor): Minor {
  return current === null ? reviewedFor : current + 1;
}
