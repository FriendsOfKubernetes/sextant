// Checks every document of a YAML text against the schema of its own apiVersion/kind (#151): unknown fields (unless
// the schema keeps unknown fields or allows any key), wrong types (int-or-string included), missing required fields
// and values outside an enum. Only a hint before sending: the API server's validation still decides.
import { isAlias, isMap, isScalar, isSeq, parseAllDocuments, type Node } from "yaml";
import type { KindSchema, SchemaNode } from "../../../api";
import { isClosed, isOpen, pathLabel, resolve, typeLabel, valueText, type PathSeg } from "./model";

export type ProblemCode = "unknownField" | "wrongType" | "missingRequired" | "notInEnum" | "syntax";

export interface Problem {
  from: number;
  to: number;
  severity: "error" | "warning";
  code: ProblemCode;
  /** Filled into the message: `field`, `path`, `expected`, `found`, `value`, `allowed` (a list), `message`. */
  params: Record<string, string>;
  /** Values for `allowed` (joined by the caller in the interface's language). */
  allowed?: string[];
}

/** The document's schema: a schema, `null` (none, nothing to check) or `undefined` (not known yet). */
export type SchemaLookup = (apiVersion: string, kind: string) => KindSchema | null | undefined;

/** The apiVersion/kind pairs of the documents in `text` (for loading their schemas first). */
export function kindsOf(text: string): Array<{ apiVersion: string; kind: string }> {
  const out: Array<{ apiVersion: string; kind: string }> = [];
  for (const doc of parseAllDocuments(text, { prettyErrors: false })) {
    const contents = doc.contents;
    if (!isMap(contents)) continue;
    const apiVersion = contents.get("apiVersion");
    const kind = contents.get("kind");
    if (typeof apiVersion === "string" && typeof kind === "string") out.push({ apiVersion, kind });
  }
  return out;
}

type Range = readonly [number, number];

function rangeOf(node: Node | null | undefined, fallback: Range): Range {
  const r = node?.range;
  return r ? [r[0], Math.max(r[0], r[1])] : fallback;
}

function jsonType(value: unknown): string {
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  if (typeof value === "bigint") return "integer";
  return "string";
}

function accepts(node: SchemaNode, type: string): boolean {
  const types = node.types;
  if (!types || types.length === 0) {
    // No type, but fields: a map. No type and no fields: anything.
    if (type === "object") return true;
    return node.properties === undefined;
  }
  return types.includes(type) || (type === "integer" && types.includes("number"));
}

class Checker {
  readonly problems: Problem[] = [];
  constructor(private readonly schema: KindSchema) {}

  check(node: Node | null | undefined, schemaNode: SchemaNode | undefined, anchor: Range, path: PathSeg[]): void {
    const s = resolve(this.schema, schemaNode);
    if (!node || !s || s.truncated || isAlias(node)) return;
    const here = rangeOf(node, anchor);
    if (isMap(node)) {
      if (!accepts(s, "object")) return this.wrongType(anchor, s, "object", path);
      const present = new Set<string>();
      for (const pair of node.items) {
        const keyNode = pair.key as Node | null;
        const key = isScalar(keyNode) ? String(keyNode.value) : null;
        if (key === null || key === "<<") continue;
        present.add(key);
        // The status is written by controllers and ignored on create and update: not checked.
        if (path.length === 0 && key === "status") continue;
        const keyRange = rangeOf(keyNode, here);
        if (isOpen(s)) continue;
        const field = s.properties?.[key] ?? s.additionalProperties;
        if (!field) {
          if (isClosed(s)) this.add(keyRange, "warning", "unknownField", { field: key, path: pathLabel(path) });
          continue;
        }
        this.check(pair.value as Node | null, field, keyRange, [...path, key]);
      }
      for (const field of s.required ?? []) {
        if (!present.has(field)) this.add(anchor, "error", "missingRequired", { field, path: pathLabel(path) });
      }
    } else if (isSeq(node)) {
      if (!accepts(s, "array")) return this.wrongType(anchor, s, "array", path);
      for (const item of node.items) {
        // A missing field of an item is shown at its first key, not under the whole item.
        const first = isMap(item) ? (item.items[0]?.key as Node | undefined) : undefined;
        this.check(item as Node | null, s.items, rangeOf(first ?? (item as Node), here), [...path, -1]);
      }
    } else if (isScalar(node)) {
      const value = node.value;
      if (value === null || value === undefined) return;
      const type = jsonType(value);
      if (!accepts(s, type)) return this.wrongType(here, s, type, path);
      if (s.enum && s.enum.length > 0 && !s.enum.some((e) => e === value)) {
        const allowed = s.enum.map(valueText);
        this.problems.push({ from: here[0], to: here[1], severity: "error", code: "notInEnum", params: { value: valueText(value), path: pathLabel(path) }, allowed });
      }
    }
  }

  private wrongType(at: Range, s: SchemaNode, found: string, path: PathSeg[]): void {
    this.add(at, "error", "wrongType", { expected: typeLabel(this.schema, s), found, path: pathLabel(path) });
  }

  private add(at: Range, severity: Problem["severity"], code: ProblemCode, params: Record<string, string>): void {
    this.problems.push({ from: at[0], to: at[1], severity, code, params });
  }
}

/** The problems of every document of `text`; a document whose kind has no schema (or none yet) is not checked. */
export function validate(text: string, lookup: SchemaLookup): Problem[] {
  const problems: Problem[] = [];
  for (const doc of parseAllDocuments(text, { prettyErrors: false })) {
    if (doc.errors.length > 0) {
      const err = doc.errors[0];
      if (err) {
        const [from, to] = err.pos;
        const message = err.message.split("\n")[0] ?? err.message;
        problems.push({ from, to: Math.max(to, from + 1), severity: "error", code: "syntax", params: { message } });
      }
      continue;
    }
    const contents = doc.contents;
    if (!isMap(contents)) continue;
    const apiVersion = contents.get("apiVersion");
    const kind = contents.get("kind");
    if (typeof apiVersion !== "string" || typeof kind !== "string") continue;
    const schema = lookup(apiVersion, kind);
    if (!schema) continue;
    const kindKey = contents.items.find((p) => isScalar(p.key) && p.key.value === "kind")?.key as Node | undefined;
    const anchor = rangeOf(kindKey, rangeOf(contents, [0, 0]));
    const checker = new Checker(schema);
    checker.check(contents, schema.root, anchor, []);
    problems.push(...checker.problems);
  }
  return problems
    .map((p) => ({ ...p, to: Math.min(p.to, text.length), from: Math.min(p.from, text.length) }))
    .sort((a, b) => a.from - b.from);
}
