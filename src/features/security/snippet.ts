// The suggested fix of a finding as YAML: a strategic merge patch from the object's root (containers and volumes are
// merged by name, `null` removes a field), ready for `kubectl patch --type strategic --patch-file` or to compare with
// the manifest. Nothing is applied by Sextant: the snippet goes to the clipboard. Only what fixes need is written:
// maps, lists, strings, numbers, booleans and null.

/** Strings that YAML would read as something else, or that need quotes. */
const PLAIN = /^[A-Za-z_./][A-Za-z0-9_./@-]*$/;
const RESERVED = /^(true|false|yes|no|on|off|y|n|null|~)$/i;

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const s = String(value);
  return PLAIN.test(s) && !RESERVED.test(s) ? s : JSON.stringify(s);
}

function key(k: string): string {
  return PLAIN.test(k) && !RESERVED.test(k) ? k : JSON.stringify(k);
}

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function inline(value: unknown): string | undefined {
  if (isMap(value) && Object.keys(value).length === 0) return "{}";
  if (Array.isArray(value) && value.length === 0) return "[]";
  if (!isMap(value) && !Array.isArray(value)) return scalar(value);
  // A list of scalars reads best on one line (`drop: ["ALL"]` in flow style).
  if (Array.isArray(value) && value.every((v) => !isMap(v) && !Array.isArray(v))) return `[${value.map(scalar).join(", ")}]`;
  return undefined;
}

function mapLines(map: Record<string, unknown>, indent: string): string[] {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(map)) {
    const short = inline(v);
    if (short !== undefined) {
      lines.push(`${indent}${key(k)}: ${short}`);
    } else if (Array.isArray(v)) {
      lines.push(`${indent}${key(k)}:`);
      lines.push(...listLines(v, `${indent}  `));
    } else {
      lines.push(`${indent}${key(k)}:`);
      lines.push(...mapLines(v as Record<string, unknown>, `${indent}  `));
    }
  }
  return lines;
}

function listLines(list: unknown[], indent: string): string[] {
  const lines: string[] = [];
  for (const item of list) {
    const short = isMap(item) ? (Object.keys(item).length === 0 ? "{}" : undefined) : inline(item);
    if (short !== undefined) {
      lines.push(`${indent}- ${short}`);
      continue;
    }
    if (Array.isArray(item)) {
      lines.push(`${indent}-`);
      lines.push(...listLines(item, `${indent}  `));
      continue;
    }
    // The first field on the dash's line, the rest under it.
    const inner = mapLines(item as Record<string, unknown>, `${indent}  `);
    if (inner.length > 0) inner[0] = `${indent}- ${inner[0]!.slice(indent.length + 2)}`;
    lines.push(...inner);
  }
  return lines;
}

/** A map as block YAML, with a trailing newline. */
export function toYaml(value: Record<string, unknown>): string {
  return `${mapLines(value, "").join("\n")}\n`;
}
