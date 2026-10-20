// Custom columns (#214, ADR-0099): what a column may read and how its value is read and shown. Pure functions; the
// backend keeps the same rules when it reads the settings (`crates/sextant-core/src/settings/custom_columns.rs`).
//
// A field path is a small grammar, not JSONPath: `["."] name ("." name | "[" digits "]" | "[\"" key "\"]")*`, a name
// being `[A-Za-z0-9_-]+` and a quoted key anything without `"`, `\` or control characters. So `.spec.nodeName`,
// `.spec.containers[0].image`, `.metadata.labels["app.kubernetes.io/name"]`; no wildcards, filters, recursion or
// functions. A path into `data` or `stringData` of a core Secret is refused.
import type { KubeObject } from "../../api";
import type { ColumnSource } from "../../api/generated/ColumnSource";
import type { CustomColumnSpec } from "../../api/generated/CustomColumnSpec";

export type { ColumnSource, CustomColumnSpec };

/** Longest label or annotation key (Rust `MAX_KEY_CHARS`). */
export const MAX_KEY_CHARS = 317;
/** Longest field path (Rust `MAX_FIELD_PATH_CHARS`). */
export const MAX_FIELD_PATH_CHARS = 256;
/** Longest header (Rust `MAX_TITLE_CHARS`). */
export const MAX_TITLE_CHARS = 64;
/** Longest text a cell shows; an object or a long list is clipped. */
export const MAX_CELL_CHARS = 200;

export type PathStep = { key: string } | { index: number };

const NAME = /^[A-Za-z0-9_-]+/;
const LABEL_NAME = /^[A-Za-z0-9]([A-Za-z0-9_.-]*[A-Za-z0-9])?$/;
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Whether `key` is a label or annotation key: an optional DNS subdomain prefix and `/`, then a name of ≤ 63 characters. */
export function isMetadataKey(key: string): boolean {
  if (Array.from(key).length > MAX_KEY_CHARS) return false;
  const slash = key.indexOf("/");
  const prefix = slash >= 0 ? key.slice(0, slash) : null;
  const name = slash >= 0 ? key.slice(slash + 1) : key;
  if (name.length === 0 || name.length > 63 || !LABEL_NAME.test(name)) return false;
  if (prefix === null) return true;
  return prefix.length > 0 && prefix.length <= 253 && prefix.split(".").every((p) => p.length <= 63 && DNS_LABEL.test(p));
}

/** The steps of a field path, or `null` when it is not in the grammar. */
export function parseFieldPath(path: string): PathStep[] | null {
  if (path.length === 0 || Array.from(path).length > MAX_FIELD_PATH_CHARS) return null;
  let i = path.startsWith(".") && path[1] !== "[" ? 1 : 0;
  const steps: PathStep[] = [];
  let expectName = true;
  while (i < path.length) {
    if (path[i] === "[") {
      if (path[i + 1] === '"') {
        const end = path.indexOf('"', i + 2);
        if (end < 0 || end === i + 2 || path[end + 1] !== "]") return null;
        const key = path.slice(i + 2, end);
        if (key.includes("\\") || CONTROL.test(key)) return null;
        steps.push({ key });
        i = end + 2;
      } else {
        const end = path.indexOf("]", i + 1);
        if (end < 0) return null;
        const digits = path.slice(i + 1, end);
        if (!/^[0-9]{1,6}$/.test(digits)) return null;
        steps.push({ index: Number(digits) });
        i = end + 1;
      }
      expectName = false;
      continue;
    }
    if (!expectName) {
      if (path[i] !== ".") return null;
      i += 1;
    }
    const name = NAME.exec(path.slice(i))?.[0];
    if (!name) return null;
    steps.push({ key: name });
    i += name.length;
    expectName = false;
  }
  return steps.length > 0 ? steps : null;
}

/** The canonical text of a path: `.name` for plain names, `[n]` for indexes, `["key"]` for other keys. */
export function formatFieldPath(steps: readonly PathStep[]): string {
  return steps
    .map((s) => ("index" in s ? `[${s.index}]` : /^[A-Za-z0-9_-]+$/.test(s.key) ? `.${s.key}` : `["${s.key}"]`))
    .join("");
}

/** Whether a field path reads a core Secret's values (`data`, `stringData` or anything inside them). */
export function isSecretDataPath(group: string, kind: string, steps: readonly PathStep[]): boolean {
  const first = steps[0];
  return group === "" && kind === "Secret" && first !== undefined && "key" in first && (first.key === "data" || first.key === "stringData");
}

/** Why a column cannot be added; each is a key of `customcolumns:errors`. */
export type SpecProblem =
  | "keyEmpty"
  | "keyInvalid"
  | "keyTooLong"
  | "pathEmpty"
  | "pathInvalid"
  | "pathTooLong"
  | "secretData"
  | "metadataOnly"
  | "titleTooLong"
  | "titleInvalid";

export interface SpecTarget {
  group: string;
  kind: string;
  /** The table lists metadata only (e.g. Helm releases): only labels, annotations and `.metadata` paths. */
  metadataOnly?: boolean;
}

/**
 * The column `source` + `text` + `title` as stored (the key trimmed, the path in its canonical form), or the reason
 * it is refused.
 */
export function checkSpec(
  target: SpecTarget,
  source: ColumnSource,
  text: string,
  title: string,
): { spec: CustomColumnSpec } | { problem: SpecProblem } {
  const cleanTitle = title.trim();
  if (Array.from(cleanTitle).length > MAX_TITLE_CHARS) return { problem: "titleTooLong" };
  if (CONTROL.test(cleanTitle)) return { problem: "titleInvalid" };
  const raw = text.trim();
  if (source !== "field") {
    if (!raw) return { problem: "keyEmpty" };
    if (Array.from(raw).length > MAX_KEY_CHARS) return { problem: "keyTooLong" };
    if (!isMetadataKey(raw)) return { problem: "keyInvalid" };
    return { spec: { source, path: raw, title: cleanTitle } };
  }
  if (!raw) return { problem: "pathEmpty" };
  if (Array.from(raw).length > MAX_FIELD_PATH_CHARS) return { problem: "pathTooLong" };
  const steps = parseFieldPath(raw);
  if (!steps) return { problem: "pathInvalid" };
  if (isSecretDataPath(target.group, target.kind, steps)) return { problem: "secretData" };
  const first = steps[0];
  if (target.metadataOnly && !(first && "key" in first && first.key === "metadata")) return { problem: "metadataOnly" };
  return { spec: { source, path: formatFieldPath(steps), title: cleanTitle } };
}

/** Whether a stored or imported column may be shown on `target` (the same rules as `checkSpec`). */
export function isAllowedSpec(target: SpecTarget, spec: CustomColumnSpec): boolean {
  const checked = checkSpec(target, spec.source, spec.path, spec.title);
  return "spec" in checked && checked.spec.path === spec.path.trim();
}

/** The raw value a column reads from `obj` (`undefined` when it is not there). */
export function readColumn(obj: KubeObject, source: ColumnSource, steps: readonly PathStep[] | null, key: string): unknown {
  if (source === "label" || source === "annotation") {
    const map = source === "label" ? obj.metadata?.labels : obj.metadata?.annotations;
    if (!map || typeof map !== "object") return undefined;
    return Object.prototype.hasOwnProperty.call(map, key) ? (map as Record<string, unknown>)[key] : undefined;
  }
  let current: unknown = obj;
  for (const step of steps ?? []) {
    if (current === null || typeof current !== "object") return undefined;
    if ("index" in step) {
      if (!Array.isArray(current)) return undefined;
      current = current[step.index];
    } else {
      if (Array.isArray(current) || !Object.prototype.hasOwnProperty.call(current, step.key)) return undefined;
      current = (current as Record<string, unknown>)[step.key];
    }
  }
  return current;
}

function clip(text: string): string {
  const chars = Array.from(text);
  return chars.length > MAX_CELL_CHARS ? `${chars.slice(0, MAX_CELL_CHARS - 1).join("")}…` : text;
}

function compact(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * The value a cell shows and sorts by: strings, numbers and booleans as they are, a list joined with `separator`
 * (objects in it as compact JSON), an object as compact JSON; texts clipped to {@link MAX_CELL_CHARS}. Nothing
 * (`undefined`) when the object has no such value, so it sorts last.
 */
export function cellValue(value: unknown, separator: string): string | number | boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return clip(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    return clip(value.map((v) => (v !== null && typeof v === "object" ? compact(v) : String(v))).join(separator));
  }
  return clip(compact(value));
}

/** Longest column id the saved widths keep (Rust `MAX_COLUMN_ID_CHARS`, #191). */
const MAX_COLUMN_ID_CHARS = 128;

function fnv1a(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * A stable column id for a source and path (`custom:label:app`), the same on every machine, so a saved view's sort
 * and hidden columns and the saved widths find the column; a long one is hashed to fit the widths' id cap.
 */
export function columnIdOf(source: ColumnSource, path: string): string {
  const plain = `custom:${source}:${path}`;
  if (plain.length <= MAX_COLUMN_ID_CHARS) return plain;
  return `custom:${source}#${fnv1a(path, 0x811c9dc5)}${fnv1a(path, 0x050c5d1f)}`;
}
