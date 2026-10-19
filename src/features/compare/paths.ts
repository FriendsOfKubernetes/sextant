// JSON-pointer-like paths of the comparison (#156): the saved ignore paths (`AppSettings.compare.ignorePaths`) and
// the defaulted-field rules of `normalize.ts`. A path is `/`-separated keys with the pointer escapes (`~1` for `/`,
// `~0` for `~`); `*` stands for any one key or list item: `/spec/replicas`,
// `/metadata/labels/app.kubernetes.io~1version`, `/spec/template/spec/containers/*/image`.

/** The same caps as the backend (`settings/compare.rs`): what is past them is not saved. */
export const MAX_IGNORE_PATHS = 50;
export const MAX_IGNORE_PATH_CHARS = 256;

/** The segments of `path`, or `null` when it is not a path (no leading `/`, empty, too long, a control character). */
export function parsePath(path: string): string[] | null {
  const text = path.trim();
  if (!text.startsWith("/") || text.length < 2 || [...text].length > MAX_IGNORE_PATH_CHARS) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) return null;
  const segments = text
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  return segments.some((s) => s === "") ? null : segments;
}

/** The segments as a path again (the inverse of `parsePath`). */
export function formatPath(segments: readonly string[]): string {
  return `/${segments.map((s) => s.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}

type Container = Record<string, unknown> | unknown[];

function isContainer(value: unknown): value is Container {
  return typeof value === "object" && value !== null;
}

function childKeys(value: Container): string[] {
  return Array.isArray(value) ? value.map((_, i) => String(i)) : Object.keys(value);
}

function childOf(value: Container, key: string): unknown {
  return Array.isArray(value) ? value[Number(key)] : value[key];
}

/**
 * Removes from `root` (mutated) what `segments` point to, for which `when` (default: always) holds. List items are
 * removed from the end, so the indexes of a `*` stay right; a removed item shifts the rest.
 */
export function removeAt(root: unknown, segments: readonly string[], when?: (value: unknown) => boolean): void {
  const [head, ...rest] = segments;
  if (!isContainer(root) || head === undefined) return;
  const keys = head === "*" ? childKeys(root) : [head];
  if (rest.length > 0) {
    for (const key of keys) removeAt(childOf(root, key), rest, when);
    return;
  }
  for (const key of [...keys].reverse()) {
    if (Array.isArray(root)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= root.length) continue;
      if (!when || when(root[index])) root.splice(index, 1);
    } else if (Object.prototype.hasOwnProperty.call(root, key)) {
      if (!when || when(root[key])) delete root[key];
    }
  }
}

/** Saved ignore paths of a kind, kept only when they parse, without repeats, at most `MAX_IGNORE_PATHS`. */
export function cleanIgnorePaths(paths: readonly unknown[] | undefined): string[] {
  const kept: string[] = [];
  for (const path of paths ?? []) {
    if (kept.length >= MAX_IGNORE_PATHS) break;
    if (typeof path !== "string") continue;
    const text = path.trim();
    if (parsePath(text) && !kept.includes(text)) kept.push(text);
  }
  return kept;
}
