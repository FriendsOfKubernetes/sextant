// JSON → YAML for the editor. Block style, two-space indent; a string is quoted whenever plain YAML would read it
// as something else (a number, a bool, null, a date, a flow collection…), so saving the text back never changes a
// value's type. Multi-line strings become literal blocks (`|`). Parsing is the backend's job (`resource_replace`,
// `resource_apply`), so there is no parser here.

const INDENT = "  ";

/** `value` as a YAML document (ends with a newline). */
export function toYaml(value: unknown): string {
  return `${emit(value, 0).replace(/^\n/, "")}\n`;
}

function emit(value: unknown, depth: number): string {
  if (Array.isArray(value)) return emitArray(value, depth);
  if (isPlainObject(value)) return emitObject(value, depth);
  return ` ${scalar(value, depth)}`;
}

/** Rendered after a key or dash: a leading newline for nested blocks, a leading space for inline values. */
function emitObject(obj: Record<string, unknown>, depth: number): string {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return " {}";
  const pad = INDENT.repeat(depth);
  return entries.map(([k, v]) => `\n${pad}${key(k)}:${emit(v, depth + 1)}`).join("");
}

function emitArray(items: unknown[], depth: number): string {
  if (items.length === 0) return " []";
  const pad = INDENT.repeat(depth);
  return items
    .map((item) => {
      if (isPlainObject(item) && Object.keys(item).length > 0) {
        // "- first: x\n  second: y": the first key shares the dash's line.
        const body = emitObject(item, depth + 1);
        return `\n${pad}-${body.replace(/^\n\s*/, " ")}`;
      }
      if (Array.isArray(item) && item.length > 0) return `\n${pad}-${emitArray(item, depth + 1)}`;
      return `\n${pad}-${emit(item, depth + 1)}`;
    })
    .join("");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalar(value: unknown, depth: number): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : quote(String(value));
  if (typeof value === "bigint") return value.toString();
  const text = String(value);
  if (text.includes("\n") && canBeLiteralBlock(text)) return literalBlock(text, depth);
  return needsQuotes(text) ? quote(text) : text;
}

function key(name: string): string {
  return needsQuotes(name) ? quote(name) : name;
}

/** Plain scalars YAML 1.1/1.2 would read as another type: bool, null, numbers (also octal, hex, `.inf`), dates. */
const TYPED =
  /^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE|y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF|[-+]?(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][-+]?\d+)?|[-+]?0[xob][0-9a-fA-F_]+|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN)|\d{4}-\d\d?-\d\d?(?:[Tt ].*)?|[-+]?\d[\d_]*(?::[0-5]?\d)+(?:\.\d*)?)$/;

function needsQuotes(text: string): boolean {
  if (text === "") return true;
  if (TYPED.test(text)) return true;
  // Indicators that cannot start a plain scalar, and surrounding whitespace.
  if (/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(text) && !/^-[^\s-]/.test(text)) return true;
  if (/^-\s|^-$|^---|\s$/.test(text)) return true;
  // ": " starts a mapping, " #" a comment; control characters and a trailing colon are not plain either.
  // eslint-disable-next-line no-control-regex
  if (/: |:$| #|\t|[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]/.test(text)) return true;
  return false;
}

/**
 * A literal block keeps the text exactly; not possible with carriage returns or other control characters, nor when
 * the first line starts with a space (that would need an indentation indicator).
 */
function canBeLiteralBlock(text: string): boolean {
  if (text.startsWith(" ")) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\ufeff]/.test(text);
}

function literalBlock(text: string, depth: number): string {
  const pad = INDENT.repeat(Math.max(depth, 1));
  const trailing = /\n+$/.exec(text)?.[0].length ?? 0;
  const chomp = trailing === 0 ? "-" : trailing === 1 ? "" : "+";
  const body = (trailing > 0 ? text.slice(0, -1) : text)
    .split("\n")
    .map((line) => (line === "" ? "" : pad + line))
    .join("\n");
  return `|${chomp}\n${body}`;
}

/** A double-quoted scalar: JSON escapes, plus the characters YAML does not allow raw in one. */
function quote(text: string): string {
  return JSON.stringify(text).replace(
    /[\u007f-\u009f\u2028\u2029\ufeff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
