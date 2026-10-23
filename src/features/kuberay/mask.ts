// What of a RayJob's entrypoint and a RayService's `serveConfigV2` may be shown (ADR-0115): both are configuration
// people put credentials into (an `HF_TOKEN` in `runtime_env.env_vars`, `--api-key=…` on a command line, a pip URL
// with a token). The details show them masked; the YAML section stays the deliberate place to see the stored object.
//   - serveConfigV2 is parsed as YAML: every value under an `env_vars` map, and every value whose key looks secret,
//     becomes `<hidden>`; every other string has its URI-looking parts cleaned (`cleanText`: `working_dir`,
//     `py_modules`, pip and conda URLs). A text that does not parse as one YAML mapping is not shown at all.
//   - an entrypoint (a shell command line) has `--<secret-looking flag>=value`, `--<secret-looking flag> value` and
//     `NAME=value` with a secret-looking NAME masked, and its URI-looking parts cleaned.
// Pure functions.
import { parseDocument, stringify } from "yaml";
import { cleanText } from "../../resources/uri";

export const HIDDEN = "<hidden>";

/** A serveConfigV2 longer than this is not parsed (and not shown). */
export const MAX_SERVE_CONFIG = 256 * 1024;

/** Words that make a name secret wherever they appear in it (separators ignored). */
const SECRET_SUBSTRINGS = ["secret", "password", "passwd", "credential", "apikey", "accesskey", "privatekey", "passphrase"];
/** Words that make a name secret as a whole part of it (`HF_TOKEN`, `authToken`, `AWS_ACCESS_KEY_ID`; not `tokenizer`, `author`, `monkey`). */
const SECRET_PARTS = new Set(["token", "key", "auth", "authorization", "pwd", "pass", "cred", "creds", "sas", "signature", "cookie", "bearer", "dsn"]);

/** Whether a key, flag or variable name looks like it holds a secret. */
export function looksSecret(name: string): boolean {
  const flat = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (SECRET_SUBSTRINGS.some((w) => flat.includes(w)) || flat.endsWith("token")) return true;
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return parts.some((p) => SECRET_PARTS.has(p));
}

const hideAll = (value: unknown): unknown =>
  value === null || value === undefined
    ? value
    : Array.isArray(value)
      ? value.map(hideAll)
      : typeof value === "object"
        ? Object.fromEntries(Object.keys(value as Record<string, unknown>).map((k) => [k, hideAll((value as Record<string, unknown>)[k])]))
        : HIDDEN;

function mask(value: unknown): unknown {
  if (typeof value === "string") return cleanText(value);
  if (Array.isArray(value)) return value.map(mask);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (key === "env_vars") out[key] = hideAll(v);
      else if (looksSecret(key) && v !== null && v !== undefined) out[key] = typeof v === "object" ? hideAll(v) : HIDDEN;
      else out[key] = mask(v);
    }
    return out;
  }
  return value;
}

/** The serve config as it may be shown; `undefined` when it cannot be read safely (not shown then). */
export function maskedServeConfig(text: string): string | undefined {
  if (text.length > MAX_SERVE_CONFIG) return undefined;
  try {
    const doc = parseDocument(text);
    if (doc.errors.length > 0) return undefined;
    const value: unknown = doc.toJS({ maxAliasCount: 100 });
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return stringify(mask(value), { lineWidth: 0 });
  } catch {
    return undefined;
  }
}

/** A shell word: double-quoted (with escapes), single-quoted, or bare. */
const WORD = String.raw`"(?:[^"\\]|\\[\s\S])*"|'[^']*'|[^\s"']+`;
/** A flag's value after a space must not be the next flag. */
const VALUE_WORD = String.raw`"(?:[^"\\]|\\[\s\S])*"|'[^']*'|[^\s"'-][^\s"']*`;
const FLAG_EQUALS = new RegExp(String.raw`(^|\s)(--?)([A-Za-z0-9][\w.-]*)=(${WORD})`, "g");
const FLAG_SPACE = new RegExp(String.raw`(^|\s)(--?)([A-Za-z0-9][\w.-]*)(\s+)(${VALUE_WORD})`, "g");
const ASSIGNMENT = new RegExp(String.raw`(^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=(${WORD})`, "g");

/** An entrypoint as it may be shown. */
export function maskedEntrypoint(text: string): string {
  const masked = text
    .replace(FLAG_EQUALS, (all, lead: string, dashes: string, name: string) => (looksSecret(name) ? `${lead}${dashes}${name}=${HIDDEN}` : all))
    .replace(FLAG_SPACE, (all, lead: string, dashes: string, name: string, space: string, value: string) =>
      looksSecret(name) && value !== HIDDEN ? `${lead}${dashes}${name}${space}${HIDDEN}` : all,
    )
    .replace(ASSIGNMENT, (all, lead: string, name: string) => (looksSecret(name) ? `${lead}${name}=${HIDDEN}` : all));
  return cleanText(masked) ?? "";
}
