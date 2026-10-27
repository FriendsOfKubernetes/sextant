// Secret material some kinds carry inline, outside a core Secret (ADR-0120, ADR-0121, ADR-0123): a Route's private
// key, a BuildConfig's webhook secrets, a HelmChart's values, an InstallPlan's manifests, a k3s/RKE2 node's arguments
// and environment. The window gets these objects whole (its YAML view and editor need them as they are), so what
// keeps or passes on their contents uses this table: the change timeline never keeps or shows their values (its
// projection, `src/features/timeline/model.ts`), and the details' metadata masks the node annotations.
//
// The one table is `inline-secrets.json`, shared with the core (`crates/sextant-core/src/resources/inline_secrets.rs`,
// which hides the same paths from agents and extensions and in the saved timeline); each side's test checks it.
// Pure functions.
import shared from "./inline-secrets.json";

export interface InlineSecretKind {
  group: string;
  kind: string;
  /** Field names from the object's root; `*` is every item of a list (or every value of a map). */
  paths: readonly (readonly string[])[];
}

/** Every kind with secret material inline. */
export const INLINE_SECRETS: readonly InlineSecretKind[] = shared.kinds;

const byKind = new Map(INLINE_SECRETS.map((k) => [`${k.group}/${k.kind}`, k.paths]));

/** The secret paths of `group`/`kind`; empty for a kind without any. */
export function inlineSecretPaths(group: string, kind: string): readonly (readonly string[])[] {
  return byKind.get(`${group}/${kind}`) ?? [];
}

export function hasInlineSecrets(group: string, kind: string): boolean {
  return inlineSecretPaths(group, kind).length > 0;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * A copy of `obj` (any JSON) with every value at one of `group`/`kind`'s secret paths replaced by `replace(value)`
 * (a map's values each, its keys kept). `obj` itself is not changed; an object without the fields comes back equal.
 */
export function replaceInlineSecrets<T>(group: string, kind: string, obj: T, replace: (value: unknown) => unknown): T {
  const paths = inlineSecretPaths(group, kind);
  if (paths.length === 0) return obj;
  let out: unknown = obj;
  for (const path of paths) out = replaceAt(out, path, replace);
  return out as T;
}

function replaceAt(value: unknown, path: readonly string[], replace: (value: unknown) => unknown): unknown {
  if (path.length === 0) {
    if (value === null || value === undefined) return value;
    if (isRecord(value)) return Object.fromEntries(Object.keys(value).map((k) => [k, replace(value[k])]));
    return replace(value);
  }
  const [first, ...rest] = path;
  if (first === "*") {
    if (Array.isArray(value)) return value.map((item) => replaceAt(item, rest, replace));
    if (isRecord(value)) return Object.fromEntries(Object.keys(value).map((k) => [k, replaceAt(value[k], rest, replace)]));
    return value;
  }
  if (!isRecord(value) || !(first! in value)) return value;
  return { ...value, [first!]: replaceAt(value[first!], rest, replace) };
}

/**
 * The segments of a recorded-change path as the timeline writes them (`spec.triggers[0].github.secret`,
 * `metadata.annotations["k3s.io/node-args"]`, `spec.template.spec.containers[web].image`); `undefined` when it does
 * not read as one.
 */
function pathSegments(path: string): string[] | undefined {
  const out: string[] = [];
  let rest = path;
  while (rest.length > 0) {
    if (rest.startsWith("[")) {
      const inner = rest.slice(1);
      if (inner.startsWith('"')) {
        // A JSON string up to its closing quote, then `]`.
        const match = /^"(?:[^"\\]|\\.)*"/.exec(inner);
        if (!match) return undefined;
        let key: unknown;
        try {
          key = JSON.parse(match[0]);
        } catch {
          return undefined;
        }
        if (typeof key !== "string" || inner[match[0].length] !== "]") return undefined;
        out.push(key);
        rest = inner.slice(match[0].length + 1);
      } else {
        const end = inner.indexOf("]");
        if (end < 0) return undefined;
        out.push(inner.slice(0, end));
        rest = inner.slice(end + 1);
      }
    } else {
      const plain = rest.startsWith(".") ? rest.slice(1) : rest;
      const end = plain.search(/[.[]/);
      const stop = end < 0 ? plain.length : end;
      if (stop === 0) return undefined;
      out.push(plain.slice(0, stop));
      rest = plain.slice(stop);
    }
  }
  return out;
}

/**
 * Whether a recorded change at `path` of an object of `group`/`kind` is, holds or lies under one of its secret paths:
 * its values must not be kept or shown. A path that does not read is taken as one.
 */
export function isInlineSecretPath(group: string, kind: string, path: string): boolean {
  const paths = inlineSecretPaths(group, kind);
  if (paths.length === 0) return false;
  const segments = pathSegments(path);
  if (!segments) return true;
  return paths.some((secret) => secret.every((want, i) => i >= segments.length || want === "*" || want === segments[i]));
}
