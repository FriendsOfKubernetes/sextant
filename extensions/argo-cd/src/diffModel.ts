// What the diff shows for one resource of an Application (as Sextant's built-in diff did), and a line diff of two
// texts with the unchanged runs folded. No DOM here.
import type { JsonValue } from "@sextant/extension-sdk";
import { arr, get, record, str } from "./fields";
import { toYaml } from "./yaml";

/** One resource of a `managed-resources` answer, its states parsed (`null` when missing on that side). */
export interface ArgoResource {
  group: string;
  kind: string;
  namespace: string;
  name: string;
  targetState: unknown;
  liveState: unknown;
  normalizedLiveState: unknown;
  predictedLiveState: unknown;
}

/** A state as Argo CD sends it: JSON text (`"null"` when missing); `metadata.managedFields` dropped. */
function state(raw: unknown): unknown {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (value === undefined || value === null) return null;
  const meta = get(value, "metadata");
  if (meta && typeof meta === "object" && !Array.isArray(meta) && "managedFields" in meta) {
    const rest = { ...record(meta) };
    delete rest.managedFields;
    return { ...record(value), metadata: rest };
  }
  return value;
}

/** The `items` of a `managed-resources` answer. Sextant has already emptied every Secret's values in them. */
export function parseManagedResources(body: JsonValue): ArgoResource[] {
  return arr(get(body, "items")).map((item) => ({
    group: str(get(item, "group")) ?? "",
    kind: str(get(item, "kind")) ?? "",
    namespace: str(get(item, "namespace")) ?? "",
    name: str(get(item, "name")) ?? "",
    targetState: state(get(item, "targetState")),
    liveState: state(get(item, "liveState")),
    normalizedLiveState: state(get(item, "normalizedLiveState")),
    predictedLiveState: state(get(item, "predictedLiveState")),
  }));
}

/** The two sides of the diff; `null` when the object is missing on that side. */
export interface DiffSides {
  /** What Argo CD would make of the live object after a sync (or the object from Git when there is no prediction). */
  desired: unknown;
  /** The live object as Argo CD compares it (after its `ignoreDifferences` normalization). */
  live: unknown;
}

/**
 * Argo CD's own pairing: the predicted live state against the normalized live state, so fields the API server
 * fills in by itself do not show as differences. An object missing in Git or in the cluster stays missing.
 */
export function sidesOf(resource: ArgoResource): DiffSides {
  const desired = resource.targetState === null ? null : (resource.predictedLiveState ?? resource.targetState);
  const live = resource.liveState === null ? null : (resource.normalizedLiveState ?? resource.liveState);
  return { desired, live };
}

/** Keys sorted at every level, so the same object always gives the same text whatever order the JSON had. */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

/** The YAML of one side; empty for a missing object. */
export function yamlOf(value: unknown): string {
  return value === null || value === undefined ? "" : toYaml(canonical(value));
}

export type DiffState = "changed" | "inSync" | "missingLive" | "missingTarget";

export function stateOf(resource: ArgoResource): DiffState {
  const { desired, live } = sidesOf(resource);
  if (desired === null) return "missingTarget";
  if (live === null) return "missingLive";
  return yamlOf(desired) === yamlOf(live) ? "inSync" : "changed";
}

export const isSecret = (resource: ArgoResource): boolean => resource.group === "" && resource.kind === "Secret";

/** `Kind namespace/name` (or `Kind name` for cluster-scoped objects). */
export function describe(resource: ArgoResource): string {
  return `${resource.kind} ${resource.namespace ? `${resource.namespace}/` : ""}${resource.name}`;
}

const ORDER: Record<DiffState, number> = { changed: 0, missingLive: 1, missingTarget: 2, inSync: 3 };

/** The resources with their states, the differing ones first, then by name. */
export function diffRows(items: readonly ArgoResource[]): { resource: ArgoResource; state: DiffState; key: string }[] {
  return items
    .map((resource) => ({ resource, state: stateOf(resource), key: describe(resource) }))
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.key.localeCompare(b.key));
}

// ---------- Line diff ----------

export interface LineOp {
  type: "same" | "removed" | "added";
  text: string;
}

/** Above this many differing lines the texts are shown as all removed and all added (the diff would cost too much). */
export const MAX_EDIT_DISTANCE = 4000;

/** The lines of `a` and `b` as a shortest edit script (Myers' algorithm). */
export function diffLines(a: readonly string[], b: readonly string[]): LineOp[] {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    v = next;
  }
  if (found < 0) {
    return [...a.map((text): LineOp => ({ type: "removed", text })), ...b.map((text): LineOp => ({ type: "added", text }))];
  }
  // Walk back through the saved frontiers.
  const ops: LineOp[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d]!;
    const k = x - y;
    const down = k === -d || (k !== d && prev[offset + k - 1]! < prev[offset + k + 1]!);
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      y--;
      ops.push({ type: "same", text: a[--x]! });
    }
    if (down) ops.push({ type: "added", text: b[--y]! });
    else ops.push({ type: "removed", text: a[--x]! });
  }
  while (x > 0 && y > 0) {
    y--;
    ops.push({ type: "same", text: a[--x]! });
  }
  return ops.reverse();
}

/** One row of the side-by-side view: a line of each side (missing on a side that has none there), or a fold. */
export type DiffRow =
  | { type: "line"; left: { no: number; text: string } | null; right: { no: number; text: string } | null; changed: boolean }
  | { type: "fold"; count: number; rows: DiffRow[] };

/** Unchanged lines kept around a change; a run longer than `margin * 2 + minSize - 1` is folded. */
export const FOLD = { margin: 3, minSize: 6 };

/** The rows of the side-by-side view of `desired` ↔ `live`, unchanged runs folded as the built-in merge view did. */
export function sideBySide(desired: string, live: string): DiffRow[] {
  const split = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));
  const ops = diffLines(split(desired), split(live));
  const rows: Extract<DiffRow, { type: "line" }>[] = [];
  let left = 0;
  let right = 0;
  for (let i = 0; i < ops.length; ) {
    const op = ops[i]!;
    if (op.type === "same") {
      rows.push({ type: "line", left: { no: ++left, text: op.text }, right: { no: ++right, text: op.text }, changed: false });
      i++;
      continue;
    }
    // A run of removed and added lines: paired side by side.
    const removed: string[] = [];
    const added: string[] = [];
    while (i < ops.length && ops[i]!.type !== "same") {
      const o = ops[i++]!;
      (o.type === "removed" ? removed : added).push(o.text);
    }
    for (let j = 0; j < Math.max(removed.length, added.length); j++) {
      rows.push({
        type: "line",
        left: j < removed.length ? { no: ++left, text: removed[j]! } : null,
        right: j < added.length ? { no: ++right, text: added[j]! } : null,
        changed: true,
      });
    }
  }
  return fold(rows);
}

function fold(rows: Extract<DiffRow, { type: "line" }>[]): DiffRow[] {
  const out: DiffRow[] = [];
  for (let i = 0; i < rows.length; ) {
    if (rows[i]!.changed) {
      out.push(rows[i++]!);
      continue;
    }
    let end = i;
    while (end < rows.length && !rows[end]!.changed) end++;
    const keepBefore = i === 0 ? 0 : FOLD.margin;
    const keepAfter = end === rows.length ? 0 : FOLD.margin;
    const hidden = end - i - keepBefore - keepAfter;
    if (hidden >= FOLD.minSize) {
      out.push(...rows.slice(i, i + keepBefore));
      out.push({ type: "fold", count: hidden, rows: rows.slice(i + keepBefore, end - keepAfter) });
      out.push(...rows.slice(end - keepAfter, end));
    } else {
      out.push(...rows.slice(i, end));
    }
    i = end;
  }
  return out;
}
