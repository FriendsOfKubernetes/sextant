// What to offer at the cursor (#151): the fields of the map the cursor is in (required ones first, the ones already
// written left out), or the values of an enum or a boolean; and what a field is (hover, Explain).
import type { KindSchema, SchemaNode } from "../../../api";
import { contextAt, fieldAt } from "./context";
import { child, isArray, isClosed, isObject, isOpen, nodeAt, pathLabel, resolve, typeLabel, valueText, type PathSeg } from "./model";

export interface Suggestion {
  label: string;
  /** The text inserted for it. */
  apply: string;
  type: string;
  required: boolean;
  description?: string;
  kind: "field" | "value";
}

export interface Suggestions {
  from: number;
  items: Suggestion[];
}

function valuesOf(node: SchemaNode | undefined): string[] {
  if (!node) return [];
  if (node.enum?.length) return node.enum.map(valueText);
  if (node.types?.length === 1 && node.types[0] === "boolean") return ["true", "false"];
  return [];
}

function valueSuggestions(schema: KindSchema, node: SchemaNode | undefined, from: number): Suggestions | null {
  const values = valuesOf(node);
  if (values.length === 0) return null;
  const type = typeLabel(schema, node);
  return { from, items: values.map((v) => ({ label: v, apply: v, type, required: false, kind: "value" as const })) };
}

/** What a field written at `column` inserts: `name: ` for a value, a nested block for a map or a list. */
function insertion(name: string, node: SchemaNode, column: number): string {
  const indent = " ".repeat(column + 2);
  if (isArray(node)) return `${name}:\n${indent}- `;
  if (isObject(node) && !node.types?.includes("string")) return `${name}:\n${indent}`;
  return `${name}: `;
}

/** The suggestions at `offset` in `text`, whose document at that offset is of `schema`'s kind. */
export function suggest(text: string, offset: number, schema: KindSchema): Suggestions | null {
  const ctx = contextAt(text, offset);
  if (!ctx) return null;
  if (ctx.mode === "value") {
    if (ctx.key === undefined) return null;
    return valueSuggestions(schema, nodeAt(schema, [...ctx.path, ctx.key]), ctx.from);
  }
  const node = nodeAt(schema, ctx.path);
  if (!node) return null;
  // A list of plain values: the item itself is being typed.
  if (!isObject(node)) return valueSuggestions(schema, node, ctx.from);
  if (!node.properties) return null;
  const required = new Set(node.required ?? []);
  const taken = new Set(ctx.siblings);
  const items: Suggestion[] = [];
  for (const [name, raw] of Object.entries(node.properties)) {
    if (taken.has(name)) continue;
    const field = resolve(schema, raw) ?? {};
    items.push({
      label: name,
      apply: insertion(name, field, ctx.column),
      type: typeLabel(schema, raw),
      required: required.has(name),
      description: field.description,
      kind: "field",
    });
  }
  items.sort((a, b) => Number(b.required) - Number(a.required) || a.label.localeCompare(b.label));
  return { from: ctx.from, items };
}

/** What `kubectl explain` says about one field. */
export interface Explanation {
  path: PathSeg[];
  pathLabel: string;
  type: string;
  required: boolean;
  description?: string;
  default?: string;
  enum?: string[];
  /** Anything is accepted below it (unknown fields kept, or the schema was cut). */
  open: boolean;
  fields: Array<{ name: string; type: string; required: boolean; summary?: string }>;
}

/** The first sentence (or line) of a description, for a list of fields. */
function summary(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const line = text.split("\n")[0] ?? "";
  const end = line.search(/\.(\s|$)/);
  return end > 0 ? line.slice(0, end + 1) : line;
}

/** The explanation of `path` (the kind itself when empty); `null` when the schema says nothing about it. */
export function explain(schema: KindSchema, path: readonly PathSeg[]): Explanation | null {
  let raw: SchemaNode | undefined = schema.root;
  let parent: SchemaNode | undefined;
  for (const seg of path) {
    parent = resolve(schema, raw);
    raw = typeof seg === "number" ? parent?.items : (parent?.properties?.[seg] ?? parent?.additionalProperties);
    if (!raw || (parent && isOpen(parent))) return null;
  }
  // A list's own explanation is its items' fields.
  let node = resolve(schema, raw);
  if (!node) return null;
  const listOf = isArray(node) ? child(schema, node, -1) : undefined;
  const shown = listOf ?? node;
  const last = path[path.length - 1];
  const required = typeof last === "string" && parent?.required?.includes(last) === true;
  const fieldsRequired = new Set(shown.required ?? []);
  node = { ...node, description: node.description ?? shown.description };
  return {
    path: [...path],
    pathLabel: path.length ? pathLabel(path) : schema.kind,
    type: typeLabel(schema, raw),
    required,
    description: node.description,
    default: node.default === undefined ? undefined : valueText(node.default),
    enum: node.enum?.map(valueText),
    open: isOpen(shown) || (!isClosed(shown) && !shown.properties && isObject(shown)),
    fields: Object.entries(shown.properties ?? {})
      .map(([name, f]) => ({
        name,
        type: typeLabel(schema, f),
        required: fieldsRequired.has(name),
        summary: summary(resolve(schema, f)?.description),
      }))
      .sort((a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name)),
  };
}

/** The explanation of the field under `offset`, with the word's range; `null` when there is none. */
export function explainAt(text: string, offset: number, schema: KindSchema): (Explanation & { from: number; to: number }) | null {
  const field = fieldAt(text, offset);
  if (!field) return null;
  const found = explain(schema, field.path);
  return found ? { ...found, from: field.from, to: field.to } : null;
}
