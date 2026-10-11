// JSON → YAML for showing objects (there is no YAML library in the project; this covers what JSON can hold).
// Strings that YAML would read as something else (numbers, booleans, null, indicators, `: `, ` #`) are quoted;
// multi-line strings become literal blocks.
import type { KubeObject } from "../../api";

// "-", "?" and ":" start a plain scalar unless a space (or nothing) follows: "--port" stays plain.
const INDICATOR = /^(?:[,[\]{}#&*!|>'"%@`\s]|[-?:](?:\s|$))/;
// Words a YAML 1.1/1.2 reader turns into booleans or null, and anything that looks like a number.
const AMBIGUOUS = /^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE|y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF)$/;
const NUMBER_LIKE = /^[-+]?(?:\.?\d|0x|0o|\.inf|\.Inf|\.INF|\.nan|\.NaN|\.NAN)/;
/** Characters that are not allowed (or not kept) in plain and block scalars: C0/C1 controls except tab and newline. */
function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a) || c === 0x7f || c === 0x85 || c === 0x2028 || c === 0x2029 || c === 0xfeff)
      return true;
  }
  return false;
}

function plainSafe(s: string): boolean {
  return (
    s.length > 0 &&
    !INDICATOR.test(s) &&
    !AMBIGUOUS.test(s) &&
    !NUMBER_LIKE.test(s) &&
    !hasControl(s) &&
    !s.includes(": ") &&
    !s.includes(" #") &&
    !s.includes("\n") &&
    !s.includes("\t") &&
    !s.endsWith(":") &&
    !s.endsWith(" ")
  );
}

function scalarString(s: string, indent: string): string {
  if (plainSafe(s)) return s;
  // A literal block keeps multi-line text readable (config files in ConfigMaps, certificates, scripts).
  const lines = s.split("\n");
  const blockable =
    lines.length > 1 &&
    s.trim().length > 0 &&
    !hasControl(s) &&
    !s.includes("\r") &&
    !/^[ \t]/.test(s) &&
    !s.endsWith("\n\n") &&
    lines.every((l) => !/[ \t]$/.test(l));
  if (blockable) {
    const chomp = s.endsWith("\n") ? "" : "-";
    const body = (s.endsWith("\n") ? lines.slice(0, -1) : lines).map((l) => (l ? `${indent}${l}` : "")).join("\n");
    return `|${chomp}\n${body}`;
  }
  return JSON.stringify(s);
}

function key(k: string): string {
  return plainSafe(k) ? k : JSON.stringify(k);
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value !== "object" || (Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0);
}

function scalar(value: unknown, indent: string): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return scalarString(value, indent);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : ".nan";
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "[]";
  return "{}";
}

function lines(value: unknown, indent: string): string[] {
  const deeper = `${indent}  `;
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (isScalar(item)) return [`${indent}- ${scalar(item, deeper)}`];
      const inner = lines(item, deeper);
      // The first line of a nested map/list goes on the dash line.
      const first = inner[0]!.slice(deeper.length);
      return [`${indent}- ${first}`, ...inner.slice(1)];
    });
  }
  return Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .flatMap(([k, v]) => {
      if (isScalar(v)) return [`${indent}${key(k)}: ${scalar(v, deeper)}`];
      // Lists under a key are not indented further (kubectl style).
      return [`${indent}${key(k)}:`, ...lines(v, Array.isArray(v) ? indent : deeper)];
    });
}

/** YAML text of a JSON value (a map or list at the top). */
export function toYaml(value: unknown): string {
  if (isScalar(value)) return `${scalar(value, "  ")}\n`;
  return `${lines(value, "").join("\n")}\n`;
}

const TOP_ORDER = ["apiVersion", "kind", "metadata", "spec", "data", "stringData", "status"];

/** The object as shown to the user: `managedFields` removed, `apiVersion`/`kind`/`metadata` first. */
export function displayObject(obj: KubeObject): KubeObject {
  const { metadata, ...rest } = obj;
  const meta = metadata ? Object.fromEntries(Object.entries(metadata).filter(([k]) => k !== "managedFields")) : undefined;
  const all: Record<string, unknown> = { ...rest, metadata: meta };
  const ordered: Record<string, unknown> = {};
  for (const k of TOP_ORDER) if (all[k] !== undefined) ordered[k] = all[k];
  for (const [k, v] of Object.entries(all)) if (!(k in ordered) && v !== undefined) ordered[k] = v;
  return ordered as KubeObject;
}
