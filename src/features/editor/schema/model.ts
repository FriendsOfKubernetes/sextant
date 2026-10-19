// The compact schema of one kind (`openapi_kind_schema`, #151) and how to walk it: references are followed by name
// (`definitions`), a node's own description and default win over its definition's.
import type { KindSchema, SchemaNode } from "../../../api";

/** A step of a path in a document: a field name, or a list item (its index; -1 when it does not matter). */
export type PathSeg = string | number;

/** How many references are followed in a row before a node reads as "anything" (a broken or circular chain). */
const MAX_HOPS = 32;

const resolved = new WeakMap<SchemaNode, SchemaNode>();

/** `node` with its reference chain followed and merged; a reference to a missing definition allows anything. */
export function resolve(schema: KindSchema, node: SchemaNode | undefined): SchemaNode | undefined {
  if (!node) return undefined;
  if (!node.ref) return node;
  const known = resolved.get(node);
  if (known) return known;
  let out: SchemaNode = node;
  for (let hops = 0; out.ref && hops < MAX_HOPS; hops++) {
    const { ref, ...own } = out;
    const def = schema.definitions[ref];
    // Cut by the backend's limit: nothing is known about it.
    if (!def) return remember(node, { ...own, truncated: true });
    out = { ...def, ...definedOnly(own) };
  }
  if (out.ref) out = { truncated: true };
  return remember(node, out);
}

function remember(node: SchemaNode, out: SchemaNode): SchemaNode {
  resolved.set(node, out);
  return out;
}

function definedOnly(node: SchemaNode): SchemaNode {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) if (value !== undefined) out[key] = value;
  return out as SchemaNode;
}

/** Anything is accepted at and below `node` (cut by a limit, or fields kept as they are). */
export function isOpen(node: SchemaNode): boolean {
  return node.truncated === true || node.preserveUnknown === true;
}

/** Whether a key not in `properties` is unknown here: the node lists its fields and allows no others. */
export function isClosed(node: SchemaNode): boolean {
  return !isOpen(node) && node.properties !== undefined && node.additionalProperties === undefined;
}

/** The schema of `seg` below `node` (resolved), `undefined` when nothing is known about it. */
export function child(schema: KindSchema, node: SchemaNode | undefined, seg: PathSeg): SchemaNode | undefined {
  const parent = resolve(schema, node);
  if (!parent || isOpen(parent)) return undefined;
  const next = typeof seg === "number" ? parent.items : (parent.properties?.[seg] ?? parent.additionalProperties);
  return resolve(schema, next);
}

/** The schema at `path` from the kind's root, `undefined` when unknown (or below an open node). */
export function nodeAt(schema: KindSchema, path: readonly PathSeg[]): SchemaNode | undefined {
  let node: SchemaNode | undefined = schema.root;
  for (const seg of path) {
    node = child(schema, node, seg);
    if (!node) return undefined;
  }
  return resolve(schema, node);
}

/** Whether `node` describes a map with fields (completion of keys makes sense). */
export function isObject(node: SchemaNode): boolean {
  return node.properties !== undefined || node.additionalProperties !== undefined || node.types?.includes("object") === true;
}

/** Whether `node` is a list. */
export function isArray(node: SchemaNode): boolean {
  return node.types?.includes("array") === true || (node.items !== undefined && node.types === undefined);
}

/** The last part of a definition name: `io.k8s.api.core.v1.Container` → `Container`. */
function shortName(ref: string): string {
  return ref.slice(ref.lastIndexOf(".") + 1);
}

/**
 * The type the way `kubectl explain` writes it: `string`, `integer`, `[]Container`, `map[string]string`,
 * `IntOrString`, `Object`.
 */
export function typeLabel(schema: KindSchema, node: SchemaNode | undefined, depth = 0): string {
  if (!node) return "any";
  if (node.ref) {
    const def = schema.definitions[node.ref];
    const target = resolve(schema, node);
    if (target && isArray(target)) return `[]${typeLabel(schema, target.items, depth + 1)}`;
    if (def && !def.properties && def.types && !def.types.includes("object") && def.types.length === 1) {
      return def.types[0] ?? "any";
    }
    return shortName(node.ref);
  }
  if (depth > 4) return "any";
  if (isArray(node)) return `[]${typeLabel(schema, node.items, depth + 1)}`;
  if (node.additionalProperties && !node.properties) {
    return `map[string]${typeLabel(schema, node.additionalProperties, depth + 1)}`;
  }
  if (node.types?.length) {
    const label = node.types.map((t) => (t === "object" ? "Object" : t)).join(" | ");
    return node.format && node.format !== "int-or-string" ? `${label} (${node.format})` : label;
  }
  if (node.properties) return "Object";
  return "any";
}

/** `"apps/v1"` → `{ group: "apps", version: "v1" }`; `"v1"` → the core group. `null` when malformed. */
export function splitApiVersion(apiVersion: string): { group: string; version: string } | null {
  const parts = apiVersion.split("/");
  if (parts.length === 1 && parts[0]) return { group: "", version: parts[0] };
  if (parts.length === 2 && parts[0] && parts[1]) return { group: parts[0], version: parts[1] };
  return null;
}

/** `spec.template.spec.containers[].image`. */
export function pathLabel(path: readonly PathSeg[]): string {
  let out = "";
  for (const seg of path) out += typeof seg === "number" ? "[]" : out ? `.${seg}` : seg;
  return out;
}

/** A schema value (enum member, default) as YAML-ish text. */
export function valueText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
