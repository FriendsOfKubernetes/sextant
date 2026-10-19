// Pure comparison model (#156): field changes between two objects, drift (what a desired configuration sets that the
// live object no longer has), and the buckets of a namespace comparison.
import type { KindRef, KubeObject } from "../../api";
import { kindKey } from "../../resources/refs";
import { deepEqual, normalize, type NormalizeOptions } from "./normalize";
import { formatPath } from "./paths";

/** One field that differs: its path (`/spec/replicas`) and both values (`undefined`: not set on that side). */
export interface FieldChange {
  path: string;
  left: unknown;
  right: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every leaf that differs between two normalized objects, in path order; lists of different length as one change. */
export function fieldChanges(left: unknown, right: unknown, at: string[] = []): FieldChange[] {
  if (deepEqual(left, right)) return [];
  if (isRecord(left) && isRecord(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    return keys.flatMap((k) => fieldChanges(left[k], right[k], [...at, k]));
  }
  if (Array.isArray(left) && Array.isArray(right) && left.length === right.length) {
    return left.flatMap((item, i) => fieldChanges(item, right[i], [...at, String(i)]));
  }
  return [{ path: formatPath(at), left, right }];
}

/**
 * What `desired` (a Helm manifest's object or a last-applied configuration) sets that `live` does not have the same:
 * only the fields of `desired`, so what the API server added (defaults, status) is not drift. Lists are compared item
 * by item when both have the same length, else as a whole. `left` is the desired value, `right` the live one.
 */
export function driftChanges(desired: unknown, live: unknown, at: string[] = []): FieldChange[] {
  if (isRecord(desired) && isRecord(live)) {
    return Object.keys(desired)
      .sort()
      .flatMap((k) => driftChanges(desired[k], live[k], [...at, k]));
  }
  if (Array.isArray(desired) && Array.isArray(live) && desired.length === live.length) {
    return desired.flatMap((item, i) => driftChanges(item, live[i], [...at, String(i)]));
  }
  if (isRecord(desired) && Object.keys(desired).length === 0 && live === undefined) return [];
  return deepEqual(desired, live) ? [] : [{ path: formatPath(at), left: desired, right: live }];
}

/** Drift of a live object from its desired configuration: both normalized, `apiVersion`/`kind` left out. */
export function objectDrift(
  desired: unknown,
  live: unknown,
  kind: Pick<KindRef, "group" | "kind">,
  options: NormalizeOptions,
): FieldChange[] {
  const strip = (obj: unknown) => {
    const normalized = normalize(obj, kind, options);
    delete normalized.apiVersion;
    delete normalized.kind;
    return normalized;
  };
  return driftChanges(strip(desired), strip(live));
}

export type Bucket = "onlyLeft" | "onlyRight" | "differ" | "same";
export const BUCKETS: readonly Bucket[] = ["onlyLeft", "onlyRight", "differ", "same"];

export interface CompareRow {
  kind: KindRef;
  name: string;
  bucket: Bucket;
  left?: KubeObject;
  right?: KubeObject;
}

/** Per kind key (`group/Kind`), the ignore paths saved for it. */
export type IgnorePathsByKind = Readonly<Record<string, readonly string[] | undefined>>;

function nameOf(obj: KubeObject): string {
  return obj.metadata?.name ?? "";
}

/**
 * The objects of one kind on both sides, by name, in name order: only on one side, the same after normalization, or
 * different. `differentSecrets` names the Secrets whose keys or values differ (the backend compared them); a Secret's
 * own YAML holds no values, so without it two Secrets with other values would read as the same.
 */
export function bucketize(
  kind: KindRef,
  left: readonly KubeObject[],
  right: readonly KubeObject[],
  options: { hideDefaults: boolean; ignorePaths: IgnorePathsByKind; differentSecrets?: ReadonlySet<string> },
): CompareRow[] {
  const byName = (list: readonly KubeObject[]) => new Map(list.map((o) => [nameOf(o), o]));
  const a = byName(left);
  const b = byName(right);
  const names = [...new Set([...a.keys(), ...b.keys()])].sort();
  const normalizeOptions = { hideDefaults: options.hideDefaults, ignorePaths: options.ignorePaths[kindKey(kind)] ?? [] };
  return names.map((name) => {
    const l = a.get(name);
    const r = b.get(name);
    if (!l) return { kind, name, bucket: "onlyRight", right: r };
    if (!r) return { kind, name, bucket: "onlyLeft", left: l };
    const same =
      deepEqual(normalize(l, kind, normalizeOptions), normalize(r, kind, normalizeOptions)) &&
      !(options.differentSecrets?.has(name) ?? false);
    return { kind, name, bucket: same ? "same" : "differ", left: l, right: r };
  });
}

/** How many rows are in each bucket. */
export function countBuckets(rows: readonly CompareRow[]): Record<Bucket, number> {
  const counts: Record<Bucket, number> = { onlyLeft: 0, onlyRight: 0, differ: 0, same: 0 };
  for (const row of rows) counts[row.bucket]++;
  return counts;
}

/** The value of a field change as one line of text: JSON, `undefined` as an empty string. */
export function valueText(value: unknown): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}
