// The built-in table of deprecated and removed Kubernetes API versions (#142), kept in the repository as data
// (`deprecations.json`) and read by the "Upgrade readiness" page.
//
// Source: the Kubernetes Deprecated API Migration Guide,
// https://kubernetes.io/docs/reference/using-api/deprecation-guide/ — every API version it lists as no longer served
// from v1.16 on, with the replacement it names. `deprecatedIn` is the release from which the API server marks the
// version deprecated (its `Warning` header); for versions removed in v1.16 it is the release of the replacement.
// Only APIs a cluster serves by default are listed (alpha APIs and betas that are off by default are not).
//
// Keep it current: review the guide for every Kubernetes minor release, add its removals (sorted by `removedIn`,
// then group, version and kind — `table.test.ts` checks the order and the fields) and raise `reviewedFor` to that
// release. See `DEPRECATIONS.md` next to this file.
import type { KindRef, ScanApi } from "../../api";
import data from "./deprecations.json";

/** A Kubernetes 1.x minor version, e.g. 31 for 1.31. */
export type Minor = number;

export interface Deprecation {
  group: string;
  version: string;
  kind: string;
  /** Minor version from which it is deprecated. */
  deprecatedIn: Minor;
  /** Minor version from which it is no longer served. */
  removedIn: Minor;
  /** The `group/version` that replaces it (same kind); `null` when nothing does (see `note`). */
  replacement: string | null;
  /** Key of `upgrade:notes.*` with what to do instead. */
  note?: string;
}

interface RawEntry {
  group: string;
  version: string;
  kind: string;
  deprecatedIn: string;
  removedIn: string;
  replacement: string | null;
  note?: string;
}

interface RawTable {
  source: string;
  reviewedFor: string;
  apis: RawEntry[];
}

/** `1.25` → 25; `v1.31.4-eks-1` → 31; anything else (or a major other than 1) → `null`. */
export function parseMinor(text: string | null | undefined): Minor | null {
  const match = /^v?(\d+)\.(\d+)/.exec((text ?? "").trim());
  if (!match || match[1] !== "1") return null;
  return Number(match[2]);
}

/** 25 → `1.25`. */
export function minorText(minor: Minor): string {
  return `1.${minor}`;
}

/** `apps/v1` → `apps` and `v1`; `v1` → the core group (`""`) and `v1`. */
export function splitApiVersion(apiVersion: string): { group: string; version: string } {
  const slash = apiVersion.indexOf("/");
  return slash < 0 ? { group: "", version: apiVersion } : { group: apiVersion.slice(0, slash), version: apiVersion.slice(slash + 1) };
}

/** `group/version`, or `version` for the core group. */
export function apiVersionOf(group: string, version: string): string {
  return group ? `${group}/${version}` : version;
}

/** Problems of the raw table: a missing field, a version that does not parse, removal before deprecation, an order out
 * of place, a duplicate. Empty when it is fine. */
export function tableProblems(table: RawTable): string[] {
  const problems: string[] = [];
  if (!table.source.startsWith("https://kubernetes.io/")) problems.push("source is not the Kubernetes guide");
  if (parseMinor(table.reviewedFor) === null) problems.push(`reviewedFor ${table.reviewedFor} is not a version`);
  const seen = new Set<string>();
  let previous: [number, string, string, string] | null = null;
  for (const e of table.apis) {
    const id = `${apiVersionOf(e.group, e.version)} ${e.kind}`;
    if (!e.version || !e.kind || !/^[A-Z][A-Za-z]+$/.test(e.kind)) problems.push(`${id}: kind or version missing`);
    const deprecated = parseMinor(e.deprecatedIn);
    const removed = parseMinor(e.removedIn);
    if (deprecated === null || removed === null) problems.push(`${id}: versions do not parse`);
    else if (deprecated >= removed) problems.push(`${id}: removed before it is deprecated`);
    if (e.replacement === null ? !e.note : !/^([a-z0-9.-]+\/)?v[0-9a-z]+$/.test(e.replacement)) {
      problems.push(`${id}: replacement ${String(e.replacement)} is not a group/version (or a note)`);
    }
    if (e.replacement === apiVersionOf(e.group, e.version)) problems.push(`${id}: replaces itself`);
    if (seen.has(id)) problems.push(`${id}: listed twice`);
    seen.add(id);
    const key: [number, string, string, string] = [removed ?? 0, e.group, e.version, e.kind];
    if (previous && compareKeys(previous, key) > 0) problems.push(`${id}: out of order`);
    previous = key;
  }
  return problems;
}

function compareKeys(a: [number, string, string, string], b: [number, string, string, string]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  for (const i of [1, 2, 3] as const) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

const RAW = data as RawTable;

/** Where the table comes from. */
export const DEPRECATION_SOURCE = RAW.source;
/** The newest Kubernetes minor release the table was reviewed for. */
export const REVIEWED_FOR: Minor = parseMinor(RAW.reviewedFor) ?? 0;

export const DEPRECATIONS: readonly Deprecation[] = RAW.apis.map((e) => ({
  group: e.group,
  version: e.version,
  kind: e.kind,
  deprecatedIn: parseMinor(e.deprecatedIn) ?? 0,
  removedIn: parseMinor(e.removedIn) ?? 0,
  replacement: e.replacement,
  ...(e.note ? { note: e.note } : {}),
}));

const BY_KEY = new Map(DEPRECATIONS.map((d) => [`${d.group}|${d.version}|${d.kind}`, d]));

export function findDeprecation(group: string, version: string, kind: string): Deprecation | undefined {
  return BY_KEY.get(`${group}|${version}|${kind}`);
}

/** The `group/version` to move to for `target`: the table's replacement, followed further while that one is itself
 * removed by `target` (flowcontrol v1beta1 → v1beta2 → v1beta3 → v1). `null` when nothing replaces it; `note` then
 * names the advice. */
export function replacementAt(dep: Deprecation, target: Minor): { apiVersion: string | null; note?: string } {
  let current: Deprecation = dep;
  for (let hops = 0; hops < 10; hops++) {
    if (current.replacement === null) return { apiVersion: null, note: current.note };
    const { group, version } = splitApiVersion(current.replacement);
    const next = findDeprecation(group, version, current.kind);
    if (!next || next.removedIn > target) return { apiVersion: current.replacement };
    current = next;
  }
  return { apiVersion: current.replacement };
}

function kindRef(apiVersion: string, kind: string): KindRef {
  return { ...splitApiVersion(apiVersion), kind };
}

/** What the scan looks for: every API version of the table with its replacement. */
export function scanApis(): ScanApi[] {
  return DEPRECATIONS.map((d) => ({
    api: { group: d.group, version: d.version, kind: d.kind },
    replacement: d.replacement === null ? null : kindRef(d.replacement, d.kind),
  }));
}

/** Raw table, for its test. */
export const RAW_TABLE: RawTable = RAW;
