// Checks `sextant-extension.json` the way Sextant does (`parse_manifest` in
// crates/sextant-core/src/extensions/manifest.rs): the supported API version first, then the JSON schema
// (crates/sextant-core/src/extensions/manifest.schema.json — the one file both read) with Sextant's own string formats,
// then contribution ids unique per type. The first problem found is reported as `{path, message}`, in the order Sextant
// finds it (object keys in sorted order). `sdk/test/fixtures/manifest-cases.json` holds the cases both must agree on.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder, TextEncoder } from "node:util";

export const MANIFEST_FILE = "sextant-extension.json";
/** The newest extension API Sextant implements; 2 brought `contributes.problems` (ADR-0137), 3 `contributes.sectionBadges` (ADR-0143). */
export const SUPPORTED_API = 4;
/** The oldest one it still reads: every extension once accepted keeps working (ADR-0142). */
export const MIN_API = 1;
export const MAX_MANIFEST_BYTES = 256 * 1024;
export const SCHEMA_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../crates/sextant-core/src/extensions/manifest.schema.json",
);
/** The kinds with secret material inline (ADR-0120): the table Sextant's checks share. */
export const INLINE_SECRETS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/resources/inline-secrets.json");
/** The fields the API server selects objects by (`is_field_selector`'s table in Rust, the window's `selectors.ts`). */
export const FIELD_SELECTORS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/components/Table/field-selectors.json");
let fieldSelectorsCache;

let schemaCache = null;
/** The manifest's JSON schema, as Sextant has it. */
export function manifestSchema() {
  schemaCache ??= JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  return schemaCache;
}

// A JSON number written with a fraction or an exponent (`1.0`, `1e2`) is not a whole number for Sextant (serde_json
// keeps it a float) even when its value is: such numbers are read as `Float` objects.
class Float {
  constructor(value) {
    this.value = value;
  }
}

/** Reads JSON text as Sextant does; `null` when it is not JSON (the caller reports that). */
export function readJson(text) {
  try {
    return JSON.parse(text, (_key, value, context) => {
      if (typeof value === "number" && context && typeof context.source === "string" && /[.eE]/.test(context.source)) {
        return new Float(value);
      }
      return value;
    });
  } catch {
    return undefined;
  }
}

const isFloat = (value) => value instanceof Float;
const isNumber = (value) => typeof value === "number" || isFloat(value);
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value) && !isFloat(value);
const numberValue = (value) => (isFloat(value) ? value.value : value);
const sortedKeys = (object) => Object.keys(object).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** `contributes.pages[0].id`. */
function pathText(segments) {
  let out = "";
  segments.forEach((segment, i) => {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += i === 0 ? segment : `.${segment}`;
  });
  return out;
}

class ManifestError extends Error {
  constructor(segments, message) {
    super(message);
    this.path = pathText(segments);
  }
}

const fail = (segments, message) => {
  throw new ManifestError(segments, message);
};

/** As serde_json compares values: a float is never equal to an integer. */
function equal(a, b) {
  if (isFloat(a) || isFloat(b)) return isFloat(a) && isFloat(b) && a.value === b.value;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]));
  }
  if (isObject(a) || isObject(b)) {
    if (!isObject(a) || !isObject(b)) return false;
    const ka = sortedKeys(a);
    const kb = sortedKeys(b);
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && equal(a[k], b[k]));
  }
  return a === b;
}

/** Strings in backticks, the rest as JSON. */
function show(value) {
  if (typeof value === "string") return `\`${value}\``;
  return JSON.stringify(isFloat(value) ? value.value : value);
}

const ANNOTATIONS = new Set(["$schema", "$id", "$defs", "$comment", "title", "description", "default", "examples", "pattern"]);
const ASSERTIONS = new Set([
  "$ref",
  "type",
  "const",
  "enum",
  "oneOf",
  "properties",
  "required",
  "additionalProperties",
  "maxProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "format",
]);

function check(root, schema, value, path) {
  if (!isObject(schema)) fail(path, "internal: a schema node is not an object");
  const unknown = Object.keys(schema).find((k) => !ANNOTATIONS.has(k) && !ASSERTIONS.has(k));
  if (unknown !== undefined) fail(path, `internal: unsupported schema keyword \`${unknown}\``);
  if ("$ref" in schema) {
    const ref = schema.$ref;
    const name = typeof ref === "string" && ref.startsWith("#/$defs/") ? ref.slice("#/$defs/".length) : null;
    const target = name !== null ? root.$defs?.[name] : undefined;
    if (target === undefined) fail(path, `internal: unresolved $ref ${JSON.stringify(ref)}`);
    check(root, target, value, path);
  }
  if (Array.isArray(schema.oneOf)) checkOneOf(root, schema.oneOf, value, path);
  if (typeof schema.type === "string") checkType(schema.type, value, path);
  if ("const" in schema && !equal(value, schema.const)) fail(path, `must be ${show(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((allowed) => equal(value, allowed))) {
    fail(path, `must be one of: ${schema.enum.map(show).join(", ")}`);
  }
  if (typeof value === "string") checkString(schema, value, path);
  else if (isNumber(value)) checkNumber(schema, numberValue(value), path);
  else if (Array.isArray(value)) checkArray(root, schema, value, path);
  else if (isObject(value)) checkObject(root, schema, value, path);
}

function checkOneOf(root, branches, value, path) {
  const tags = branches.map((b) => (isObject(b?.properties?.type) && "const" in b.properties.type ? b.properties.type : null));
  if (tags.every((t) => t !== null)) {
    if (!isObject(value)) fail(path, "must be an object");
    const tagPath = [...path, "type"];
    if (!("type" in value)) fail(tagPath, "is required");
    const index = tags.findIndex((t) => equal(t.const, value.type));
    if (index < 0) fail(tagPath, `must be one of: ${tags.map((t) => show(t.const)).join(", ")}`);
    check(root, branches[index], value, path);
    return;
  }
  const matching = branches.filter((b) => {
    try {
      check(root, b, value, path);
      return true;
    } catch (err) {
      if (err instanceof ManifestError) return false;
      throw err;
    }
  }).length;
  if (matching !== 1) fail(path, "does not match any of the allowed shapes");
}

function checkType(expected, value, path) {
  const rules = {
    object: [isObject(value), "must be an object"],
    array: [Array.isArray(value), "must be a list"],
    string: [typeof value === "string", "must be a string"],
    integer: [typeof value === "number" && Number.isInteger(value), "must be a whole number"],
    number: [isNumber(value), "must be a number"],
    boolean: [typeof value === "boolean", "must be true or false"],
  };
  const rule = rules[expected];
  if (!rule) fail(path, `internal: unsupported schema type \`${expected}\``);
  if (!rule[0]) fail(path, rule[1]);
}

function checkString(schema, text, path) {
  const length = [...text].length;
  if (typeof schema.minLength === "number" && length < schema.minLength) {
    fail(path, schema.minLength === 1 ? "must not be empty" : `must be at least ${schema.minLength} characters`);
  }
  if (typeof schema.maxLength === "number" && length > schema.maxLength) {
    fail(path, `must be at most ${schema.maxLength} characters`);
  }
  if (typeof schema.format === "string") {
    const message = checkFormat(schema.format, text);
    if (message !== null) fail(path, message);
  }
}

function checkNumber(schema, value, path) {
  if (typeof schema.minimum === "number" && value < schema.minimum) fail(path, `must be at least ${schema.minimum}`);
  if (typeof schema.maximum === "number" && value > schema.maximum) fail(path, `must be at most ${schema.maximum}`);
}

function checkArray(root, schema, items, path) {
  if (typeof schema.minItems === "number" && items.length < schema.minItems) {
    fail(path, schema.minItems === 1 ? "must not be empty" : `must have at least ${schema.minItems} items`);
  }
  if (typeof schema.maxItems === "number" && items.length > schema.maxItems) {
    fail(path, `must have at most ${schema.maxItems} items`);
  }
  if (schema.uniqueItems === true) {
    items.forEach((item, i) => {
      if (items.slice(0, i).some((other) => equal(other, item))) fail([...path, i], `${show(item)} is listed twice`);
    });
  }
  if ("items" in schema) items.forEach((item, i) => check(root, schema.items, item, [...path, i]));
}

function checkObject(root, schema, fields, path) {
  const properties = isObject(schema.properties) ? schema.properties : null;
  const keys = sortedKeys(fields);
  const known = (k) => properties !== null && Object.hasOwn(properties, k);
  if (schema.additionalProperties === false) {
    const unknown = keys.find((k) => !known(k));
    if (unknown !== undefined) fail([...path, unknown], "unknown field");
  }
  if (typeof schema.maxProperties === "number" && keys.length > schema.maxProperties) {
    fail(path, `must have at most ${schema.maxProperties} entries`);
  }
  if (Array.isArray(schema.required)) {
    for (const name of schema.required) if (!Object.hasOwn(fields, name)) fail([...path, name], "is required");
  }
  if (properties) {
    for (const key of keys) if (Object.hasOwn(properties, key)) check(root, properties[key], fields[key], [...path, key]);
  }
  // A map: every other field is checked against one schema.
  if (isObject(schema.additionalProperties)) {
    for (const key of keys) if (!known(key)) check(root, schema.additionalProperties, fields[key], [...path, key]);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Sextant's string formats (the functions of the same names in manifest.rs).

const FORMAT_MESSAGES = {
  "extension-id":
    "must be 3–64 characters: lowercase letters, digits, `.` and `-`, starting with a letter or digit, not ending with `.`, without `..`, and not a Windows device name such as `nul` or `con`",
  "contribution-id": "must be 1–40 characters: lowercase letters, digits and `-`",
  semver: "must be a semantic version such as 1.0.0 or 1.2.0-beta.1",
  "entry-path":
    "must be an .html file inside the package: a relative path with `/`, without `..`, `.`, `\\`, `:` or other characters Windows forbids, no part starting with `.`, named `node_modules`, ending with `.` or a space, or named like a Windows device (`nul`, `con`, `com1`, …)",
  identifier: "must be a name of letters, digits and `-`, starting with a letter",
  "non-blank": "must not be blank",
  "json-path": "is not a JSONPath Sextant understands (as in CRD printer columns, e.g. .spec.replicas)",
  "wasm-path":
    "must be a .wasm file inside the package: a relative path with `/`, without `..`, `.`, `\\`, `:` or other characters Windows forbids, no part starting with `.` or named `node_modules`",
  "host-name":
    "must be a lower-case host name such as api.example.com: no scheme, port, path, wildcard or IP address, and not localhost",
};

/** The message for a string that is not in `format`; `null` when it is. */
export function checkFormat(format, text) {
  const checks = {
    "extension-id": isExtensionId,
    "contribution-id": isContributionId,
    semver: isSemver,
    "entry-path": (t) => isServablePath(t) && isHtmlPath(t),
    identifier: isIdentifier,
    "non-blank": (t) => t.trim() !== "",
    "json-path": isSupportedJsonPath,
    "wasm-path": isWasmPath,
    "host-name": isHostName,
  };
  const ok = checks[format];
  if (!ok) return `internal: unsupported schema format \`${format}\``;
  return ok(text) ? null : FORMAT_MESSAGES[format];
}

const LOWER = /^[a-z]$/;
const DIGIT = /^[0-9]$/;
const utf8Length = (text) => new TextEncoder().encode(text).length;
const isAsciiAlphanumeric = (c) => /^[A-Za-z0-9]$/.test(c);

export function isExtensionId(text) {
  const length = utf8Length(text);
  return (
    length >= 3 &&
    length <= 64 &&
    (LOWER.test(text[0]) || DIGIT.test(text[0])) &&
    /^[a-z0-9.-]*$/.test(text) &&
    !text.endsWith(".") &&
    !text.includes("..") &&
    !isWindowsDeviceName(text)
  );
}

/** A name Windows reads as a device (`CON`, `nul.js`, `COM0.html`, `lpt¹`, any case). */
export function isWindowsDeviceName(segment) {
  const stem = segment.split(".")[0].replace(/ +$/, "");
  const upper = stem.replace(/[a-z]/g, (c) => c.toUpperCase());
  if (["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].includes(upper)) return true;
  const chars = [...upper];
  const prefix = chars.slice(0, 3).join("");
  const rest = chars.slice(3);
  return (prefix === "COM" || prefix === "LPT") && rest.length === 1 && /^[0-9¹²³]$/.test(rest[0]);
}

export function isContributionId(text) {
  return /^[a-z0-9-]{1,40}$/.test(text);
}

export function isIdentifier(text) {
  return /^[A-Za-z][A-Za-z0-9-]{0,39}$/.test(text);
}

export function isSemver(text) {
  const number = (part) => /^[0-9]+$/.test(part) && (part === "0" || !part.startsWith("0"));
  const identifiers = (part, numericRule) =>
    part
      .split(".")
      .every((id) => /^[A-Za-z0-9-]+$/.test(id) && (!numericRule || !/^[0-9]+$/.test(id) || number(id)));
  const plus = text.indexOf("+");
  const rest = plus < 0 ? text : text.slice(0, plus);
  const build = plus < 0 ? null : text.slice(plus + 1);
  const dash = rest.indexOf("-");
  const core = dash < 0 ? rest : rest.slice(0, dash);
  const pre = dash < 0 ? null : rest.slice(dash + 1);
  const parts = core.split(".");
  return (
    parts.length === 3 &&
    parts.every(number) &&
    (pre === null || identifiers(pre, true)) &&
    (build === null || identifiers(build, false))
  );
}

// Rust's `char::is_control`: the Cc category.
const isControl = (c) => {
  const code = c.codePointAt(0);
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
};

/** A file path inside a package: relative, `/`-separated, nothing Windows or another OS would read otherwise. */
export function isPackagePath(text) {
  return (
    text !== "" &&
    utf8Length(text) <= 1024 &&
    !text.startsWith("/") &&
    ![...text].some((c) => '\\:*?"<>|'.includes(c) || isControl(c)) &&
    text
      .split("/")
      .every(
        (s) =>
          s !== "" && s !== "." && s !== ".." && !s.endsWith(".") && !s.endsWith(" ") && !isWindowsDeviceName(s),
      )
  );
}

/** A package path Sextant serves: also no part starting with `.` and no `node_modules` (any case). */
export function isServablePath(text) {
  return (
    isPackagePath(text) && text.split("/").every((s) => !s.startsWith(".") && s.toLowerCase() !== "node_modules")
  );
}

/** A backend's component (ADR-0131): a servable package path ending with `.wasm` (any case). */
export function isWasmPath(text) {
  return isServablePath(text) && text.toLowerCase().endsWith(".wasm");
}

/**
 * A host a backend may call: a lower-case DNS name of at least two labels, each 1–63 letters, digits and `-` not at
 * either end, at most 253 characters; not an IP address (the last label has a letter), not localhost or under it.
 */
export function isHostName(text) {
  const labels = text.split(".");
  return (
    text.length <= 253 &&
    labels.length >= 2 &&
    labels.every((l) => l.length >= 1 && l.length <= 63 && /^[a-z0-9-]+$/.test(l) && !l.startsWith("-") && !l.endsWith("-")) &&
    /[a-z]/.test(labels[labels.length - 1]) &&
    text !== "localhost" &&
    !text.endsWith(".localhost")
  );
}

export function isHtmlPath(text) {
  const lower = text.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return lower.endsWith(".html") || lower.endsWith(".htm");
}

/** The JSONPath subset of CRD printer columns that Sextant's table evaluates. */
export function isSupportedJsonPath(raw) {
  let path = raw.trim();
  if (path.startsWith("{") && path.endsWith("}") && path.length >= 2) path = path.slice(1, -1).trim();
  if (path.startsWith("$")) path = path.slice(1);
  const chars = [...path];
  let steps = 0;
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === ".") {
      i += 1;
      if (chars[i] === "*") {
        i += 1;
        steps += 1;
        continue;
      }
      let key = 0;
      while (i < chars.length && chars[i] !== "." && chars[i] !== "[") {
        if (chars[i] === "\\" && i + 1 < chars.length) i += 1;
        key += 1;
        i += 1;
      }
      if (key === 0) return false;
      steps += 1;
    } else if (chars[i] === "[") {
      const end = closingBracket(chars, i);
      if (end === null) return false;
      if (!isBracketStep(chars.slice(i + 1, end).join("").trim())) return false;
      i = end + 1;
      steps += 1;
    } else {
      return false;
    }
  }
  return steps > 0;
}

function closingBracket(chars, open) {
  let quote = null;
  let depth = 0;
  for (let i = open; i < chars.length; i++) {
    const ch = chars[i];
    if (quote !== null) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "[" || ch === "(") {
      depth += 1;
    } else if (ch === "]" || ch === ")") {
      depth -= 1;
      if (depth === 0 && ch === "]") return i;
    }
  }
  return null;
}

function isBracketStep(inner) {
  if (inner === "*") return true;
  const digits = inner.startsWith("-") ? inner.slice(1) : inner;
  if (/^[0-9]+$/.test(digits)) return true;
  if (inner.length >= 2) {
    const first = inner[0];
    if ((first === "'" || first === '"') && inner[inner.length - 1] === first) return true;
  }
  return isFilter(inner);
}

function isFilter(inner) {
  if (!inner.startsWith("?(") || !inner.endsWith(")")) return false;
  const body = inner.slice(2, -1).trimStart();
  if (!body.startsWith("@.")) return false;
  const rest = body.slice(2);
  let fieldEnd = 0;
  while (fieldEnd < rest.length && (isAsciiAlphanumeric(rest[fieldEnd]) || "_.-".includes(rest[fieldEnd]))) fieldEnd++;
  if (fieldEnd === 0) return false;
  const after = rest.slice(fieldEnd).trimStart();
  if (after === "") return true;
  const literal = after.startsWith("==") || after.startsWith("!=") ? after.slice(2) : null;
  return literal !== null && literal !== "";
}

// ---------------------------------------------------------------------------------------------------------------

/** Contribution ids are unique within each contribution type. */
function checkUniqueIds(manifest) {
  const credentials = manifest.backend?.credentials;
  if (Array.isArray(credentials)) {
    credentials.forEach((item, i) => {
      const id = typeof item?.id === "string" ? item.id : "";
      const first = credentials.slice(0, i).findIndex((other) => other?.id === id);
      if (first >= 0) {
        fail(["backend", "credentials", i, "id"], `duplicate id \`${id}\` (also ${pathText(["backend", "credentials", first])})`);
      }
    });
  }
  for (const kind of ["pages", "detailsSections", "actions", "columns", "dockActions", "problems", "metricQueries", "commands", "menuItems", "services", "agentTools"]) {
    const items = manifest.contributes?.[kind];
    if (!Array.isArray(items)) continue;
    items.forEach((item, i) => {
      const id = typeof item?.id === "string" ? item.id : "";
      const first = items.slice(0, i).findIndex((other) => other?.id === id);
      if (first >= 0) {
        fail(["contributes", kind, i, "id"], `duplicate id \`${id}\` (also ${pathText(["contributes", kind, first])})`);
      }
    });
  }
}

// --- Problem rules (`check_problems` in crates/sextant-core/src/extensions/problems.rs) ----------------------------

const PROBLEMS_API = 2;
/** `rule_limits`: rules and the kinds they judge, more from sextantApi 4. */
const ruleLimits = (api) => (api >= 4 ? [30, 20] : [20, 10]);
const MAX_CONDITIONS = 20;
const MAX_DEPTH = 3;
/** From sextantApi 4 (#381): an older Sextant reads only older manifests, so the limits grow with the version. */
const MAX_CONDITIONS_4 = 40;
const MAX_DEPTH_4 = 6;
/** `condition_limits`: the limits of a rule's conditions for a manifest of `api`. */
const conditionLimits = (api) => (api >= 4 ? [MAX_CONDITIONS_4, MAX_DEPTH_4] : [MAX_CONDITIONS, MAX_DEPTH]);
const MAX_PLACEHOLDERS = 5;
const MAX_FIELD_PATH_CHARS = 256;

let inlineSecretsCache = null;
function inlineSecrets() {
  inlineSecretsCache ??= JSON.parse(readFileSync(INLINE_SECRETS_PATH, "utf8")).kinds;
  return inlineSecretsCache;
}

const sameKind = (a, b) => a.group.toLowerCase() === b.group.toLowerCase() && a.kind.toLowerCase() === b.kind.toLowerCase();
const kindName = (kind) => (kind.group === "" ? kind.kind : `${kind.group}/${kind.kind}`);
const isNameChar = (c) => /^[A-Za-z0-9_-]$/.test(c);

/** The steps of a field path of the custom columns' grammar (ADR-0099), or `null`. */
export function parseFieldPath(path) {
  const chars = Array.from(path);
  if (chars.length === 0 || chars.length > MAX_FIELD_PATH_CHARS) return null;
  let i = chars[0] === "." && chars[1] !== "[" ? 1 : 0;
  const steps = [];
  let expectName = true;
  while (i < chars.length) {
    if (chars[i] === "[") {
      if (chars[i + 1] === '"') {
        const end = chars.indexOf('"', i + 2);
        if (end < 0 || chars[end + 1] !== "]" || end === i + 2) return null;
        const key = chars.slice(i + 2, end).join("");
        // eslint-disable-next-line no-control-regex
        if (/[\\\u0000-\u001f\u007f-\u009f]/.test(key)) return null;
        steps.push({ key });
        i = end + 2;
      } else if (chars[i + 1] === "*" && chars[i + 2] === "]") {
        // `[*]`: every item, as a list (#404).
        steps.push({ match: [], pick: "all" });
        i += 3;
      } else if (chars[i + 1] === "<") {
        // `[<field]`: the item with the smallest value there (#404).
        const end = chars.indexOf("]", i + 2);
        const name = end < 0 ? "" : chars.slice(i + 2, end).join("");
        if (!/^[A-Za-z0-9_-]+$/.test(name)) return null;
        steps.push({ match: [], pick: { earliest: name } });
        i = end + 1;
      } else if (chars.slice(i + 1, chars.indexOf("]", i + 1) < 0 ? chars.length : chars.indexOf("]", i + 1)).includes("=")) {
        // `[field="value",…]` (`PathStep::Match` in Rust): up to 4 pairs; a value may hold `]` or `,` (#392).
        const pairs = [];
        let pick = "first";
        let at = i + 1;
        for (;;) {
          const eq = chars.indexOf("=", at);
          if (eq < 0) return null;
          const field = chars.slice(at, eq).join("");
          // Names joined by dots, optionally ending in `!` (#404).
          if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*!?$/.test(field) || chars[eq + 1] !== '"') return null;
          const close = chars.indexOf('"', eq + 2);
          if (close < 0) return null;
          const value = chars.slice(eq + 2, close).join("");
          // eslint-disable-next-line no-control-regex
          if (/[\\\u0000-\u001f\u007f-\u009f]/.test(value)) return null;
          pairs.push([field, value]);
          if (pairs.length > 4) return null;
          if (chars[close + 1] === "]") {
            at = close + 2;
            break;
          }
          if (chars[close + 1] !== ",") return null;
          at = close + 2;
          // A last part: `*` (every match) or `<field` (the earliest by it), then `]` (#399).
          if (chars[at] === "*") {
            if (chars[at + 1] !== "]") return null;
            pick = "all";
            at += 2;
            break;
          }
          if (chars[at] === "<") {
            const end = chars.indexOf("]", at + 1);
            if (end < 0) return null;
            const name = chars.slice(at + 1, end).join("");
            if (!/^[A-Za-z0-9_-]+$/.test(name)) return null;
            pick = { earliest: name };
            at = end + 1;
            break;
          }
        }
        steps.push({ match: pairs, pick });
        i = at;
      } else {
        const end = chars.indexOf("]", i + 1);
        if (end < 0) return null;
        const digits = chars.slice(i + 1, end).join("");
        if (!/^[0-9]{1,6}$/.test(digits)) return null;
        steps.push({ index: Number(digits) });
        i = end + 1;
      }
      expectName = false;
      continue;
    }
    if (!expectName) {
      if (chars[i] !== ".") return null;
      i += 1;
    }
    const start = i;
    while (i < chars.length && isNameChar(chars[i])) i += 1;
    if (i === start) return null;
    steps.push({ key: chars.slice(start, i).join("") });
    expectName = false;
  }
  // The steps after `*` read each item (#404); one list per path.
  if (steps.filter((s) => s.pick === "all").length > 1) return null;
  return steps.length > 0 ? steps : null;
}

/** Whether a path of an object of `kind` reads a core Secret's values or is, holds or lies under an inline secret. */
function readsSecret(kind, steps) {
  const first = steps[0];
  if (kind.group === "" && kind.kind.toLowerCase() === "secret" && first && (first.key === "data" || first.key === "stringData")) {
    return true;
  }
  return inlineSecrets()
    .filter((k) => sameKind(k, kind))
    .some((k) =>
      k.paths.some((secret) =>
        // A map's value picked by its fields may sit under any key (#392): as `*`.
        secret.slice(0, steps.length).every((want, i) => want === "*" || steps[i].match !== undefined || (steps[i].key !== undefined && steps[i].key === want)),
      ),
    );
}

function checkPath(text, kind, segments) {
  const steps = parseFieldPath(text);
  if (!steps) fail(segments, 'must be a field path such as `.status.phase`, `.items[0]` or `.metadata.labels["app"]`');
  if (readsSecret(kind, steps)) fail(segments, `reads secret values of ${kindName(kind)}, which rules may not`);
}

/** The insides of the `{{…}}` of a message, in order; `null` when a `{{` has no `}}`. */
export function placeholders(text) {
  const out = [];
  let rest = text;
  for (let start = rest.indexOf("{{"); start >= 0; start = rest.indexOf("{{")) {
    const after = rest.slice(start + 2);
    const end = after.indexOf("}}");
    if (end < 0) return null;
    out.push(after.slice(0, end));
    rest = after.slice(end + 2);
  }
  return out;
}

const ACROSS_API = 3;
const SOURCES_API = 4;
const MAX_SELECTOR_CHARS = 1000;

/** A rule's path: no secret, and under `.metadata` when its source watches metadata only (`check_rule_path`). */
function checkRulePath(text, kind, segments, metadataOnly) {
  checkPath(text, kind, segments);
  const steps = parseFieldPath(text);
  if (metadataOnly && !(steps && steps.length > 0 && steps[0].key === "metadata")) {
    fail(segments, "must be under `.metadata`: the rule's source watches metadata only");
  }
}

function checkCondition(condition, kind, segments, depth, counter, inside = "top") {
  counter.count += 1;
  const [maxConditions, maxDepth] = conditionLimits(counter.api);
  if (counter.count > maxConditions) fail(segments, `a rule has at most ${maxConditions} conditions`);
  if (condition.type === "condition") {
    if (counter.metadataOnly) {
      fail([...segments, "type"], "`condition` reads `.status.conditions`, which a `metadataOnly` source does not watch");
    }
    return;
  }
  if (condition.type === "all" || condition.type === "any") {
    if (depth >= maxDepth) fail(segments, `\`all\` and \`any\` nest at most ${maxDepth} deep`);
    const innerInside = inside === "top" && condition.type === "any" ? "any" : inside;
    condition.of.forEach((inner, i) => checkCondition(inner, kind, [...segments, "of", i], depth + 1, counter, innerInside));
    return;
  }
  if (condition.type === "not") {
    if (counter.api < SOURCES_API) fail([...segments, "type"], `\`not\` needs sextantApi ${SOURCES_API} or later`);
    if (depth >= maxDepth) fail(segments, `\`all\`, \`any\` and \`not\` nest at most ${maxDepth} deep`);
    checkCondition(condition.of, kind, [...segments, "of"], depth + 1, counter, "not");
    return;
  }
  if (condition.type === "enteredWithin") {
    if (counter.api < SOURCES_API) fail([...segments, "type"], `\`enteredWithin\` needs sextantApi ${SOURCES_API} or later`);
    if (counter.single || !counter.narrowed) {
      fail([...segments, "type"], "`enteredWithin` tells when an object entered a rule's `source.labelSelector`: only such rules may use it");
    }
    if (condition.minutes < 1 || condition.minutes > 10080) fail([...segments, "minutes"], "must be 1 to 10080 minutes");
    return;
  }
  if (condition.type === "contains" || condition.type === "startsWith") {
    if (counter.api < SOURCES_API) fail([...segments, "type"], `text conditions need sextantApi ${SOURCES_API} or later`);
    checkRulePath(condition.path, kind, [...segments, "path"], counter.metadataOnly);
    return;
  }
  if (condition.type === "same" || condition.type === "atLeast") {
    if (counter.api < SOURCES_API) fail([...segments, "type"], `\`${condition.type}\` needs sextantApi ${SOURCES_API} or later`);
    checkRulePath(numericPath(condition.path, counter.api, [...segments, "path"]), kind, [...segments, "path"], counter.metadataOnly);
    checkRulePath(numericPath(condition.otherPath, counter.api, [...segments, "otherPath"]), kind, [...segments, "otherPath"], counter.metadataOnly);
    if (condition.type === "atLeast" && condition.addPaths !== undefined) {
      if (condition.addPaths.length === 0 || condition.addPaths.length > 3) fail([...segments, "addPaths"], "has 1 to 3 paths");
      condition.addPaths.forEach((extra, j) =>
        checkRulePath(numericPath(extra, counter.api, [...segments, "addPaths", j]), kind, [...segments, "addPaths", j], counter.metadataOnly),
      );
    }
    return;
  }
  if (["equals", "in", "above", "below"].includes(condition.type)) {
    checkRulePath(numericPath(condition.path, counter.api, [...segments, "path"]), kind, [...segments, "path"], counter.metadataOnly);
    return;
  }
  if (condition.type === "related") {
    if (counter.single) fail([...segments, "type"], "`related` judges across objects: only problem rules may use it");
    if (counter.api < SOURCES_API) fail([...segments, "type"], `\`related\` needs sextantApi ${SOURCES_API} or later`);
    if (inside !== "top") fail([...segments, "type"], "`related` cannot be inside `any` or `not`: a list not read would make it unknown");
    if (condition.kind.group === "" && condition.kind.kind.toLowerCase() === "secret") fail([...segments, "kind"], "Secrets are never listed for rules");
    checkRulePath(condition.path, kind, [...segments, "path"], counter.metadataOnly);
    checkObjectCondition(condition.when, [condition.kind], [...segments, "when"], counter.api);
    if (usesTime(condition.when)) fail([...segments, "when"], "reads no time (`olderThan`): it is judged when that object changes");
    if (!counter.kinds.some((k) => sameKind(k, condition.kind))) {
      counter.kinds.push(condition.kind);
      const maxKinds = ruleLimits(counter.api)[1];
      if (counter.kinds.length > maxKinds) fail([...segments, "kind"], `the rules judge at most ${maxKinds} kinds`);
    }
    return;
  }
  if (condition.type === "missing") {
    if (counter.single) fail([...segments, "type"], "`missing` judges across objects: only problem rules may use it");
    if (counter.api < ACROSS_API) fail([...segments, "type"], `\`missing\` needs sextantApi ${ACROSS_API} or later`);
    if (inside === "any") fail([...segments, "type"], "`missing` cannot be inside `any`: a list not read would make the whole `any` unknown");
    if (inside === "not") fail([...segments, "type"], "`missing` cannot be inside `not`: a list not read would make it unknown");
    if (condition.kind.group === "" && condition.kind.kind.toLowerCase() === "secret") {
      fail([...segments, "kind"], "Secrets are never listed for rules");
    }
    checkRulePath(condition.path, kind, [...segments, "path"], counter.metadataOnly);
    if (!counter.kinds.some((k) => sameKind(k, condition.kind))) {
      counter.kinds.push(condition.kind);
      const maxKinds = ruleLimits(counter.api)[1];
      if (counter.kinds.length > maxKinds) fail([...segments, "kind"], `the rules judge at most ${maxKinds} kinds`);
    }
    return;
  }
  checkRulePath(condition.path, kind, [...segments, "path"], counter.metadataOnly);
}

/** A Kubernetes label selector (`is_set_selector` in Rust): `key`, `!key`, `key=value`, `key==value`, `key!=value`,
 * `key in (…)`, `key notin (…)`, separated by commas outside parentheses; a value may be empty. */
export function isSetSelector(text) {
  if (text.length === 0 || Array.from(text).length > MAX_SELECTOR_CHARS) return false;
  const requirements = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth += 1;
    else if (c === ")") {
      if (depth === 0) return false;
      depth -= 1;
    } else if (c === "," && depth === 0) {
      requirements.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0) return false;
  requirements.push(text.slice(start));
  return requirements.every(isRequirement);
}

const isSelectorValue = (text) => text === "" || (isLabelKey(text) && !text.includes("/"));

function isRequirement(raw) {
  const text = raw.trim();
  if (text.startsWith("!")) return isLabelKey(text.slice(1).trim());
  for (const op of ["!=", "==", "="]) {
    const at = text.indexOf(op);
    if (at >= 0) return isLabelKey(text.slice(0, at).trim()) && isSelectorValue(text.slice(at + op.length).trim());
  }
  for (const op of [" notin ", " in "]) {
    const at = text.indexOf(op);
    if (at >= 0) {
      const values = text.slice(at + op.length).trim();
      if (!values.startsWith("(") || !values.endsWith(")")) return false;
      return isLabelKey(text.slice(0, at).trim()) && values.slice(1, -1).split(",").every((v) => isSelectorValue(v.trim()));
    }
  }
  return isLabelKey(text);
}

/** `is_field_selector` (#409): field terms of the fields the API server selects `kind` by (the shared table). */
function isFieldSelector(selector, kind) {
  fieldSelectorsCache ??= JSON.parse(readFileSync(FIELD_SELECTORS_PATH, "utf8"));
  const table = fieldSelectorsCache;
  const fields = new Set([...table.common, ...(table.kinds[`${kind.group}/${kind.kind}`] ?? [])]);
  if (selector.length === 0 || selector.length > 1000) return false;
  return selector.split(",").every((term) => {
    const m = /^([^=!]+)(!=|==|=)(.*)$/.exec(term);
    return m !== null && fields.has(m[1].trim()) && m[3].length <= 63 && /^[A-Za-z0-9._-]*$/.test(m[3]);
  });
}

/** A rule's `source` (`check_source` in Rust); whether it watches metadata only. */
function checkSource(rule, rules, api, list, here) {
  if (rule.source !== undefined) {
    const path = [...here, "source"];
    if (api < SOURCES_API) fail(path, `needs sextantApi ${SOURCES_API} or later`);
    if (rule.source.maxObjects !== undefined && (rule.source.maxObjects < 1 || rule.source.maxObjects > 20000)) fail([...path, "maxObjects"], "is 1 to 20 000");
    if (rule.source.labelSelector === undefined && rule.source.fieldSelector === undefined && rule.source.maxObjects === undefined && rule.source.metadataOnly !== true) {
      fail(path, "names a `labelSelector`, a `fieldSelector`, `metadataOnly: true` or more");
    }
    if (rule.source.fieldSelector !== undefined && !isFieldSelector(rule.source.fieldSelector, rule.kind)) {
      fail([...path, "fieldSelector"], "must be field terms the API server selects this kind by, such as `status.phase=Pending` on pods");
    }
    if (rule.source.labelSelector !== undefined && !isSetSelector(rule.source.labelSelector)) {
      fail([...path, "labelSelector"], "must be a Kubernetes label selector such as `app=web`, `tier in (a,b)` or `!canary`");
    }
  }
  const first = rules.findIndex((other) => sameKind(other.kind, rule.kind));
  if (first >= 0 && !sameSource(rules[first].source, rule.source)) {
    fail([...here, "source"], `every rule of ${kindName(rule.kind)} has the same source (as ${pathText([...list, first])})`);
  }
  return rule.source?.metadataOnly === true;
}

const sameSource = (a, b) =>
  (a?.labelSelector ?? null) === (b?.labelSelector ?? null) && (a?.metadataOnly === true) === (b?.metadataOnly === true);

/** A label key: an optional DNS subdomain prefix and `/`, then a name of 1–63 characters (`is_label_key` in Rust). */
function isLabelKey(text) {
  const at = text.lastIndexOf("/");
  const prefix = at >= 0 ? text.slice(0, at) : null;
  const name = at >= 0 ? text.slice(at + 1) : text;
  const nameOk = name.length >= 1 && name.length <= 63 && /^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/.test(name);
  const prefixOk =
    prefix === null ||
    (prefix.length >= 1 && prefix.length <= 253 && prefix.split(".").every((part) => part.length <= 63 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(part)));
  return nameOk && prefixOk;
}

/** What Sextant checks of problem rules beyond the schema, in its order. */
function checkProblems(manifest) {
  const rules = manifest.contributes?.problems ?? [];
  const list = ["contributes", "problems"];
  if (rules.length === 0) return;
  if (manifest.sextantApi < PROBLEMS_API) fail(list, `needs sextantApi ${PROBLEMS_API} or later`);
  const [maxRules, maxKinds] = ruleLimits(manifest.sextantApi);
  if (rules.length > maxRules) fail(list, `has at most ${maxRules} rules`);
  const kinds = [];
  rules.forEach((rule, i) => {
    const here = [...list, i];
    const first = rules.slice(0, i).findIndex((other) => other.title.trim() === rule.title.trim());
    if (first >= 0) fail([...here, "title"], `duplicate title (also ${pathText([...list, first])})`);
    if (!kinds.some((k) => sameKind(k, rule.kind))) {
      kinds.push(rule.kind);
      if (kinds.length > maxKinds) fail([...here, "kind"], `the rules judge at most ${maxKinds} kinds`);
    }
    const metadataOnly = checkSource(rule, rules, manifest.sextantApi, list, here);
    checkCondition(rule.when, rule.kind, [...here, "when"], 1, {
      count: 0,
      api: manifest.sextantApi,
      kinds,
      metadataOnly,
      narrowed: rule.source?.labelSelector !== undefined,
    });
    if (rule.toldThroughOwner === true && manifest.sextantApi < ACROSS_API) {
      fail([...here, "toldThroughOwner"], `needs sextantApi ${ACROSS_API} or later`);
    }
    if (rule.newestPer !== undefined) {
      if (manifest.sextantApi < ACROSS_API) fail([...here, "newestPer"], `needs sextantApi ${ACROSS_API} or later`);
      if (!isLabelKey(rule.newestPer)) fail([...here, "newestPer"], "must be a label key such as `app` or `example.com/name`");
    }
    if (rule.group !== undefined && manifest.sextantApi < SOURCES_API) fail([...here, "group"], `needs sextantApi ${SOURCES_API} or later`);
    if (rule.reason !== undefined) {
      if (manifest.sextantApi < SOURCES_API) fail([...here, "reason"], `needs sextantApi ${SOURCES_API} or later`);
      checkMessage(rule.reason, rule.kind, [...here, "reason"], metadataOnly);
    }
    if (rule.since !== undefined) checkRulePath(rule.since, rule.kind, [...here, "since"], metadataOnly);
    for (const field of ["reasonOr", "sinceOr", "about", "stamp", "notifyAgainOn", "sinceUnit"]) {
      if (rule[field] !== undefined && manifest.sextantApi < SOURCES_API) fail([...here, field], `needs sextantApi ${SOURCES_API} or later`);
    }
    if (rule.reasonOr !== undefined && rule.reasonOr.includes("{{")) fail([...here, "reasonOr"], "is written as it shows: no `{{…}}`");
    if (rule.sinceOr !== undefined && rule.since === undefined) fail([...here, "sinceOr"], "falls back from `since`: the rule needs a `since`");
    if (rule.sinceUnit !== undefined && rule.since === undefined) fail([...here, "sinceUnit"], "says how `since` is written: the rule needs a `since`");
    (rule.sinceOr ?? []).forEach((path, j) => checkRulePath(path, rule.kind, [...here, "sinceOr", j], metadataOnly));
    if (rule.about !== undefined) {
      const about = rule.about;
      const named = about.kind !== undefined && about.apiVersionPath === undefined && about.kindPath === undefined;
      const read = about.kind === undefined && about.apiVersionPath !== undefined && about.kindPath !== undefined;
      if (!named && !read) fail([...here, "about"], "names its kind, or reads it with both `apiVersionPath` and `kindPath`");
      if (about.clusterScoped === true && about.namespacePath !== undefined) fail([...here, "about", "namespacePath"], "is not for a cluster-scoped object");
      for (const field of ["apiVersionPath", "kindPath", "namePath", "namespacePath"]) {
        if (about[field] !== undefined) checkRulePath(about[field], rule.kind, [...here, "about", field], metadataOnly);
      }
    }
    for (const field of ["stamp", "notifyAgainOn"]) {
      if (rule[field] === undefined) continue;
      if (rule[field].length === 0 || rule[field].length > 4) fail([...here, field], "has 1 to 4 paths");
      rule[field].forEach((path, j) => checkRulePath(path, rule.kind, [...here, field, j], metadataOnly));
    }
    if (rule.notifyAs !== undefined) {
      if (manifest.sextantApi < SOURCES_API) fail([...here, "notifyAs"], `needs sextantApi ${SOURCES_API} or later`);
      checkRulePath(rule.notifyAs, rule.kind, [...here, "notifyAs"], metadataOnly);
    }
    checkMessage(rule.message, rule.kind, [...here, "message"], metadataOnly);
  });
}

/** Text with `{{<field path>}}` placeholders (`check_message`): each a path that reads no secret of `kind`. */
function checkMessage(text, kind, segments, metadataOnly) {
  const found = placeholders(text);
  if (found === null) fail(segments, "has a `{{` without its `}}`");
  if (found.length > MAX_PLACEHOLDERS) fail(segments, `has at most ${MAX_PLACEHOLDERS} placeholders`);
  for (const raw of found) {
    // `{{path|filter}}` (#404).
    // Up to two filters in a row (`|firstLine|clip:300`, #404); `clip:<n>` keeps 1 to 1000 characters.
    const [field, ...filters] = raw.split("|");
    if (filters.length > 2) fail(segments, "has at most two filters");
    // Paths tried in turn with `??` (#404): `{{.message ?? .reason}}`, the first with a value that is not empty.
    const tried = splitOutsideQuotes(field, "??");
    if (tried.length > MAX_ADDED_PATHS) fail(segments, `tries at most ${MAX_ADDED_PATHS} paths`);
    if (tried.length > 1 && addedPaths(field).length > 1) fail(segments, "adds paths with `+` or tries them with `??`, not both");
    if (tried.length > 1) {
      for (const one of tried) checkRulePath(one.trim(), kind, segments, metadataOnly);
    }
    // Paths added with `+` before `|sum` (#404): `{{.status.restarts + .status.jobs[*].restarts|sum}}`.
    const added = tried.length > 1 ? [] : addedPaths(field);
    if (added.length > 1 && filters[0]?.trim() !== "sum") fail(segments, "adds paths with `+` only before `|sum`");
    if (added.length > MAX_ADDED_PATHS) fail(segments, `adds at most ${MAX_ADDED_PATHS} paths`);
    for (const filter of filters.map((f) => f.trim())) {
      const clip = /^clip:([0-9]{1,4})$/.exec(filter);
      const clipOk = clip !== null && Number(clip[1]) >= 1 && Number(clip[1]) <= 1000;
      if (!clipOk && !PLACEHOLDER_FILTERS.includes(filter)) fail(segments, `has a filter \`${filter}\`: one of ${PLACEHOLDER_FILTERS.join(", ")}, clip:<1 to 1000>`);
    }
    for (const one of added) checkRulePath(one.trim(), kind, segments, metadataOnly);
  }
}

/** `MAX_ADDED_PATHS` (#404). */
const MAX_ADDED_PATHS = 4;

/** `added_paths`: a placeholder's path split at each `+` outside a quoted match value. */
export function addedPaths(field) {
  return splitOutsideQuotes(field, "+");
}

/** `split_outside_quotes`: `field` split at each `sep` outside a quoted match value. */
export function splitOutsideQuotes(field, sep) {
  const out = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < field.length; ) {
    if (field[i] === '"') quoted = !quoted;
    else if (!quoted && field.startsWith(sep, i)) {
      out.push(field.slice(start, i));
      i += sep.length;
      start = i;
      continue;
    }
    i += 1;
  }
  out.push(field.slice(start));
  return out;
}

/** `PLACEHOLDER_FILTERS` (#404). */
const PLACEHOLDER_FILTERS = ["firstLine", "lastSegment", "list", "join", "count", "sum", "keys"];

// --- Commands (`check_commands` in crates/sextant-core/src/extensions/commands.rs) ------------------------------

const COMMANDS_API = 3;
const COMMAND_WORD =
  "must be a word without control characters and without `{{` or `}}`, or exactly `{{name}}` of a parameter";

/** `name` when `word` is exactly `{{name}}`. */
function commandPlaceholder(word) {
  return word.startsWith("{{") && word.endsWith("}}") ? word.slice(2, -2).trim() : null;
}

const isCommandWord = (text) =>
  Array.from(text).length <= 256 && !Array.from(text).some(isControl) && !text.includes("{{") && !text.includes("}}");

const isLabelValue = (text) => text.length >= 1 && text.length <= 63 && /^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/.test(text);
const isDnsName = (text, max, dots) =>
  text.length >= 1 && text.length <= max && (dots ? /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/ : /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/).test(text);

function isLabelSelector(text) {
  return (
    text.length > 0 &&
    text.split(",").every((pair) => {
      const at = pair.indexOf("=");
      if (at < 0) return false;
      const key = pair.slice(0, at);
      const value = pair.slice(at + 1);
      const slash = key.lastIndexOf("/");
      const name = slash >= 0 ? key.slice(slash + 1) : key;
      const prefix = slash >= 0 ? key.slice(0, slash) : null;
      return isLabelValue(name) && (prefix === null || isDnsName(prefix, 253, true)) && isLabelValue(value);
    })
  );
}

function checkCommands(manifest) {
  const commands = manifest.contributes?.commands ?? [];
  const list = ["contributes", "commands"];
  if (commands.length === 0) return;
  if (manifest.sextantApi < COMMANDS_API) fail(list, `needs sextantApi ${COMMANDS_API} or later`);
  commands.forEach((command, i) => {
    const here = [...list, i];
    if (!isLabelSelector(command.target.labelSelector)) {
      fail([...here, "target", "labelSelector"], "must be `key=value` pairs separated by commas, such as `app=rook-ceph-tools`");
    }
    if (!isDnsName(command.target.container, 63, false)) fail([...here, "target", "container"], "must be a container name");
    const params = command.params ?? [];
    params.forEach((param, j) => {
      const at = [...here, "params", j];
      if (params.slice(0, j).some((p) => p.name === param.name)) fail([...at, "name"], "is the name of another parameter");
      const values = param.values ?? [];
      if (param.type === "enum") {
        if (values.length === 0) fail([...at, "values"], "an `enum` lists its values");
        values.forEach((value, k) => {
          if (!isCommandWord(value)) fail([...at, "values", k], COMMAND_WORD);
        });
      } else if (values.length > 0) {
        fail([...at, "values"], "only an `enum` has values");
      }
      if (param.type !== "int" && (param.min !== undefined || param.max !== undefined)) fail(at, "only an `int` has `min` and `max`");
      if (param.min !== undefined && param.max !== undefined && param.min > param.max) fail([...at, "min"], "is above `max`");
    });
    const used = params.map(() => false);
    command.argv.forEach((word, j) => {
      const at = [...here, "argv", j];
      const name = commandPlaceholder(word);
      if (name !== null) {
        if (j === 0) fail(at, "the program is a word of its own, never a parameter");
        const k = params.findIndex((p) => p.name === name);
        if (k < 0) fail(at, `names no parameter \`${name}\``);
        used[k] = true;
      } else if (!isCommandWord(word)) {
        fail(at, COMMAND_WORD);
      }
    });
    const unused = used.indexOf(false);
    if (unused >= 0) fail([...here, "params", unused, "name"], "is not used by `argv`");
  });
}

// --- Section counters (`check_section_badges` in crates/sextant-core/src/extensions/section_badges.rs) ------------

const SECTION_BADGES_API = 3;

function checkSectionBadges(manifest) {
  const badges = manifest.contributes?.sectionBadges ?? [];
  const list = ["contributes", "sectionBadges"];
  if (badges.length === 0) return;
  if (manifest.sextantApi < SECTION_BADGES_API) fail(list, `needs sextantApi ${SECTION_BADGES_API} or later`);
  const rules = manifest.contributes?.problems ?? [];
  if (rules.length === 0) fail(list, "counts problems: needs `contributes.problems`");
  badges.forEach((badge, i) => {
    const here = [...list, i];
    if (!ownSection(manifest, badge.section)) {
      fail([...here, "section"], "must be a section of the extension's own: one of its pages (or kinds) with this section has a `sectionTitle`");
    }
    const first = badges.slice(0, i).findIndex((other) => other.section === badge.section);
    if (first >= 0) fail([...here, "section"], `duplicate section (also ${pathText([...list, first])})`);
    if (badge.label !== undefined) {
      if (manifest.sextantApi < WINDOW_API) fail([...here, "label"], `needs sextantApi ${WINDOW_API} or later`);
      checkLabelForms(badge.label, [...here, "label"]);
    }
    (badge.rules ?? []).forEach((rule, j) => {
      if (!rules.some((r) => r.id === rule)) fail([...here, "rules", j], "is not the id of one of `contributes.problems`");
    });
  });
}

/** `is_column_width` (#403): `<n>px` or `minmax(<n>px, <m>fr)`. */
export function isColumnWidth(text) {
  const px = (s) => /^[0-9]{1,3}px$/.test(s) && Number(s.slice(0, -2)) >= 40 && Number(s.slice(0, -2)) <= 600;
  if (px(text)) return true;
  const m = /^minmax\((.+), (.+)\)$/.exec(text);
  if (!m) return false;
  const fr = /^([0-9][0-9.]{0,2})fr$/.exec(m[2]);
  return px(m[1]) && fr !== null && !fr[1].endsWith(".") && Number(fr[1]) >= 0.5 && Number(fr[1]) <= 5;
}

/** `check_problem_categories` (#410): categories besides the main one, and each rule's `category`. */
function checkProblemCategories(manifest) {
  const list = ["contributes", "problemCategories"];
  const categories = manifest.contributes?.problemCategories ?? [];
  const rules = manifest.contributes?.problems ?? [];
  if (categories.length > 0 && manifest.sextantApi < WINDOW_API) fail(list, `needs sextantApi ${WINDOW_API} or later`);
  if (categories.length > 0 && rules.length === 0) fail(list, "needs `contributes.problems`");
  categories.forEach((category, i) => {
    if (categories.slice(0, i).some((c) => c.id === category.id)) fail([...list, i, "id"], "is the id of another category");
  });
  rules.forEach((rule, i) => {
    if (rule.category !== undefined && !categories.some((c) => c.id === rule.category)) {
      fail(["contributes", "problems", i, "category"], "is not the id of one of `contributes.problemCategories`");
    }
  });
}

/** `PLURAL_FORMS` and `check_label_forms` (#398). */
const PLURAL_FORMS = ["zero", "one", "two", "few", "many", "other"];

function checkLabelForms(forms, segments) {
  if (!Object.hasOwn(forms, "other")) fail(segments, "gives the form `other`");
  for (const form of sortedKeys(forms)) {
    if (!PLURAL_FORMS.includes(form)) fail([...segments, form], "is a CLDR plural form: zero, one, two, few, many or other");
    const found = placeholders(forms[form]);
    if (found === null || found.length !== 1 || found[0] !== "count") fail([...segments, form], "has `{{count}}` once, and no other placeholder");
  }
}

// --- Metric queries (`check_metric_queries` in crates/sextant-core/src/extensions/metric_queries.rs) -------------

const METRIC_QUERIES_API = 2;

/**
 * `query` split into text and `{{name}}` placeholders: `{text}` or `{name, string}` where `string` is `null` outside
 * strings and otherwise whether the `"…"` string is a regular-expression matcher's (`=~`, `!~`); throws a message.
 */
export function queryPieces(query) {
  const out = [];
  let quote = null;
  let regex = false;
  let i = 0;
  let textStart = 0;
  while (i < query.length) {
    const ch = query[i];
    if (ch === "{" && query[i + 1] === "{") {
      const end = query.indexOf("}}", i + 2);
      if (end < 0) throw new Error("a `{{` is not closed by `}}`");
      const name = query.slice(i + 2, end);
      if (!/^[A-Za-z][A-Za-z0-9-]{0,39}$/.test(name)) throw new Error(`\`{{${name}}}\` is not a placeholder of a parameter name`);
      if (quote !== null && quote !== '"') {
        throw new Error(`\`{{${name}}}\` is in a '…' or \`…\` string: a parameter goes only into a "…" string`);
      }
      if (textStart < i) out.push({ text: query.slice(textStart, i) });
      out.push({ name, string: quote === null ? null : regex });
      i = end + 2;
      textStart = i;
      continue;
    }
    if (quote !== null) {
      if (ch === "\\" && quote !== "`") i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      const before = query.slice(0, i).trimEnd();
      quote = ch;
      regex = before.endsWith("=~") || before.endsWith("!~");
    } else if (ch === "#") {
      throw new Error("comments (`#`) are not allowed");
    }
    i += 1;
  }
  if (quote !== null) throw new Error("a string is not closed");
  if (textStart < query.length) out.push({ text: query.slice(textStart) });
  return out;
}

/** What Sextant checks of metric queries beyond the schema, in its order. */
function checkMetricQueries(manifest) {
  const queries = manifest.contributes?.metricQueries ?? [];
  const list = ["contributes", "metricQueries"];
  if (queries.length === 0) return;
  if (manifest.sextantApi < METRIC_QUERIES_API) fail(list, `needs sextantApi ${METRIC_QUERIES_API} or later`);
  queries.forEach((query, i) => {
    const here = [...list, i];
    const params = query.params ?? [];
    params.forEach((param, p) => {
      const first = params.slice(0, p).findIndex((other) => other.name === param.name);
      if (first >= 0) {
        fail([...here, "params", p, "name"], `duplicate parameter \`${param.name}\` (also ${pathText([...here, "params", first])})`);
      }
    });
    let parts;
    try {
      parts = queryPieces(query.query);
    } catch (err) {
      fail([...here, "query"], err.message);
    }
    for (const part of parts) {
      if (part.name === undefined) continue;
      const param = params.find((p) => p.name === part.name);
      if (!param) fail([...here, "query"], `\`{{${part.name}}}\` is not a parameter of this query`);
      if (param.type === "duration" && part.string !== null) {
        fail([...here, "query"], `the duration \`{{${part.name}}}\` goes outside strings`);
      }
      if (param.type !== "duration" && part.string === null) {
        fail([...here, "query"], `\`{{${part.name}}}\` goes inside a "…" string`);
      }
    }
    params.forEach((param, p) => {
      if (!parts.some((part) => part.name === param.name)) {
        fail([...here, "params", p], `\`${param.name}\` is not used in the query`);
      }
    });
  });
}

/** A language tag as Sextant's own languages are written: `de`, `pt-BR`, `zh-CN`, `sr-Latn`, `es-419`. */
export function isLanguageTag(tag) {
  return /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$/.test(tag);
}

/** Every text of the manifest a translation may give: key → `{max, message?}` (the English message of a rule). */
export function translatableTexts(manifest) {
  const c = manifest.contributes ?? {};
  const out = new Map([
    ["name", { max: 80 }],
    ["description", { max: 500 }],
  ]);
  const title = { max: 80 };
  for (const page of c.pages ?? []) {
    out.set(`pages.${page.id}.title`, title);
    if (page.sectionTitle !== undefined) out.set(`pages.${page.id}.sectionTitle`, title);
  }
  for (const section of c.detailsSections ?? []) out.set(`detailsSections.${section.id}.title`, title);
  for (const action of c.actions ?? []) {
    out.set(`actions.${action.id}.title`, title);
    if (action.whyNot !== undefined) out.set(`actions.${action.id}.whyNot`, { max: 200 });
    if (action.ask !== undefined) {
      out.set(`actions.${action.id}.ask.title`, { max: 80, message: action.ask.title });
      out.set(`actions.${action.id}.ask.text`, { max: 300, message: action.ask.text });
      out.set(`actions.${action.id}.ask.confirm`, { max: 40, message: action.ask.confirm });
    }
    if (action.done !== undefined) out.set(`actions.${action.id}.done`, { max: 200 });
  }
  for (const column of c.columns ?? []) {
    out.set(`columns.${column.id}.title`, title);
    if (column.valueText !== undefined) out.set(`columns.${column.id}.valueText`, { max: 40, message: column.valueText });
    (column.items?.cases ?? []).forEach((c, i) => out.set(`columns.${column.id}.items.${i}.text`, { max: 200, message: c.text }));
    (column.cases ?? []).forEach((c, i) => {
      // An empty text is nothing to translate (#404).
      if (c.text !== "") out.set(`columns.${column.id}.cases.${i}.text`, { max: 200, message: c.text });
      if (c.tooltip !== undefined) out.set(`columns.${column.id}.cases.${i}.tooltip`, { max: 300, message: c.tooltip });
      (c.tooltipOr ?? []).forEach((t, k) => out.set(`columns.${column.id}.cases.${i}.tooltipOr.${k}`, { max: 300, message: t }));
    });
  }
  for (const section of c.sections ?? []) if (section.title !== undefined) out.set(`sections.${section.section}.title`, title);
  if (c.clusterSettings !== undefined) out.set("clusterSettings.title", title);
  for (const tool of c.agentTools ?? []) out.set(`agentTools.${tool.id}.title`, title);
  for (const service of c.services ?? []) {
    out.set(`services.${service.id}.title`, title);
    for (const field of service.signIn?.fields ?? []) out.set(`services.${service.id}.signIn.${field.id}.label`, title);
  }
  for (const badge of c.sectionBadges ?? []) {
    const other = badge.label?.other;
    if (other !== undefined) for (const form of PLURAL_FORMS) out.set(`sectionBadges.${badge.section}.label.${form}`, { max: 80, message: other });
  }
  for (const item of c.menuItems ?? []) out.set(`menuItems.${item.id}.title`, title);
  (c.kinds ?? []).forEach((kind, i) => {
    if (kind.title !== undefined) out.set(`kinds.${i}.title`, title);
    if (kind.sectionTitle !== undefined) out.set(`kinds.${i}.sectionTitle`, title);
  });
  for (const dock of c.dockActions ?? []) out.set(`dockActions.${dock.id}.title`, title);
  if (c.settings !== undefined) out.set("settings.title", title);
  for (const rule of c.problems ?? []) {
    out.set(`problems.${rule.id}.title`, title);
    out.set(`problems.${rule.id}.message`, { max: 300, message: rule.message });
  }
  for (const category of c.problemCategories ?? []) out.set(`problemCategories.${category.id}.title`, title);
  for (const command of c.commands ?? []) out.set(`commands.${command.id}.title`, title);
  for (const query of c.metricQueries ?? []) out.set(`metricQueries.${query.id}.title`, title);
  for (const credential of manifest.backend?.credentials ?? []) out.set(`backend.credentials.${credential.id}.label`, title);
  return out;
}

const sortedPlaceholders = (text) => placeholders(text)?.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) ?? null;

/** What Sextant checks of `translations` beyond the schema, in its order (languages, then keys). */
function checkTranslations(manifest) {
  const translations = manifest.translations ?? {};
  const languages = sortedKeys(translations);
  if (languages.length === 0) return;
  const root = ["translations"];
  if (manifest.sextantApi < PROBLEMS_API) fail(root, `needs sextantApi ${PROBLEMS_API} or later`);
  const texts = translatableTexts(manifest);
  for (const language of languages) {
    const here = [...root, language];
    if (!isLanguageTag(language)) fail(here, "must be a language tag such as `de`, `pt-BR` or `zh-CN`");
    if (language === "en") fail(here, "English is the manifest itself: translate to other languages only");
    const translated = translations[language];
    for (const key of sortedKeys(translated)) {
      const path = [...here, key];
      const text = translated[key];
      const kind = texts.get(key);
      if (!kind) fail(path, `\`${key}\` is not a text of this manifest`);
      if (text.trim() === "") fail(path, "must not be blank");
      if ([...text].length > kind.max) fail(path, `must be at most ${kind.max} characters`);
      if (kind.message !== undefined && !equal(sortedPlaceholders(text), sortedPlaceholders(kind.message))) {
        fail(path, "must have the same `{{…}}` placeholders as the English message");
      }
    }
    // A problem's title is its reason: unique among the rules in every language.
    const titles = [];
    for (const rule of manifest.contributes?.problems ?? []) {
      const key = `problems.${rule.id}.title`;
      const title = Object.hasOwn(translated, key) ? translated[key] : rule.title;
      const other = titles.find((t) => t.title === title);
      if (other) fail([...here, key], `is also the title of the rule \`${other.id}\` in this language`);
      titles.push({ id: rule.id, title });
    }
  }
}

// --- Window contributions of sextantApi 4 (crates/sextant-core/src/extensions/contributions.rs) --------------------

const WINDOW_API = 4;
const MAX_TONE_VALUE_CHARS = 100;

/** A custom resource's API group (`is_custom_group`): with a dot, not Kubernetes' own. */
function isCustomGroup(group) {
  const g = group.toLowerCase();
  return g.includes(".") && !g.includes("*") && g.trim() !== "" && g !== "k8s.io" && !g.endsWith(".k8s.io") && !g.endsWith(".kubernetes.io");
}

/** `portForward` and `statusPatches` (`check_permissions`). */
function checkPermissions(manifest) {
  const permissions = manifest.permissions ?? {};
  if (manifest.sextantApi < WINDOW_API) {
    (permissions.rules ?? []).forEach((rule, i) => {
      const j = (rule.actions ?? []).indexOf("portForward");
      if (j >= 0) fail(["permissions", "rules", i, "actions", j], `\`portForward\` needs sextantApi ${WINDOW_API} or later`);
    });
  }
  const kinds = permissions.statusPatches ?? [];
  const list = ["permissions", "statusPatches"];
  if (kinds.length === 0) return;
  if (manifest.sextantApi < WINDOW_API) fail(list, `needs sextantApi ${WINDOW_API} or later`);
  kinds.forEach((kind, i) => {
    const here = [...list, i];
    if (!isCustomGroup(kind.group) || kind.kind.includes("*")) {
      fail([...here, "group"], "must be the API group of a custom resource: Kubernetes' own kinds' status is never patched");
    }
    const first = kinds.slice(0, i).findIndex((other) => sameKind(other, kind));
    if (first >= 0) fail([...here, "kind"], `duplicate kind (also ${pathText([...list, first])})`);
  });
}

const isDnsLabel = (text) => text.length >= 1 && text.length <= 63 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(text);
const isPortName = (text) => text.length <= 15 && isDnsLabel(text) && /[a-z]/.test(text) && !text.includes("--");

/** `contributes.services` (`check_services` in crates/sextant-core/src/extensions/services.rs). */
function checkServices(manifest) {
  const services = manifest.contributes?.services ?? [];
  const list = ["contributes", "services"];
  if (services.length === 0) return;
  if (manifest.sextantApi < WINDOW_API) fail(list, `needs sextantApi ${WINDOW_API} or later`);
  services.forEach((service, i) => {
    const here = [...list, i];
    if (service.name !== undefined && service.labelSelector === undefined) {
      if (!isDnsLabel(service.name)) fail([...here, "name"], "must be a Service name: lowercase letters, digits and `-`, at most 63");
    } else if (service.name === undefined && service.labelSelector !== undefined) {
      if (!isSetSelector(service.labelSelector)) {
        fail([...here, "labelSelector"], "must be a Kubernetes label selector such as `app.kubernetes.io/name=argocd-server`");
      }
    } else {
      fail(here, "names the Service by `name` or `labelSelector`, one of them");
    }
    (service.secrets ?? []).forEach((secret, j) => {
      const okSecret =
        secret.name !== undefined && secret.labelSelector === undefined
          ? isDnsLabel(secret.name)
          : secret.name === undefined && secret.labelSelector !== undefined && isSetSelector(secret.labelSelector);
      if (!okSecret || !/^[A-Za-z0-9._-]{1,253}$/.test(secret.key)) {
        fail(
          [...here, "secrets", j],
          "names a Secret by `name` (a DNS name) or `labelSelector`, and a key (letters, digits, `-`, `_`, `.`)",
        );
      }
    });
    const port = service.port;
    const ok = isNumber(port) ? !isFloat(port) && port >= 1 && port <= 65535 : typeof port === "string" && isPortName(port);
    if (!ok) fail([...here, "port"], "must be a port number (1–65535) or a port name");
    const fields = service.signIn?.fields ?? [];
    fields.forEach((field, j) => {
      const first = fields.slice(0, j).findIndex((f) => f.id === field.id);
      if (first >= 0) {
        fail([...here, "signIn", "fields", j, "id"], `duplicate id \`${field.id}\` (also ${pathText([...here, "signIn", "fields", first])})`);
      }
    });
  });
}

// --- Agent tools (`check_agent_tools` in crates/sextant-core/src/extensions/agent_tools.rs) ------------------------

const MAX_TOOL_NAME_CHARS = 64;
const MAX_SCHEMA_BYTES = 8 * 1024;
const MAX_SCHEMA_DEPTH = 4;
const SCHEMA_KEYWORDS = [
  "type",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
];
const SCHEMA_TYPES = ["object", "string", "number", "integer", "boolean", "array"];

/** The MCP name of an extension's tool (`mcp_tool_name`). */
export const mcpToolName = (extensionId, toolId) => `ext_${extensionId.replaceAll(".", "_")}__${toolId}`;

/** JSON text as serde_json writes it (no spaces): to measure a schema as Sextant does. */
function compactJson(value) {
  if (isFloat(value)) return String(value.value);
  if (Array.isArray(value)) return `[${value.map(compactJson).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).map((k) => `${JSON.stringify(k)}:${compactJson(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

function checkSchemaNode(node, path, depth) {
  if (!isObject(node)) fail(path, "must be a schema object");
  if (depth > MAX_SCHEMA_DEPTH) fail(path, `schemas nest at most ${MAX_SCHEMA_DEPTH} deep`);
  const unknown = sortedKeys(node).find((k) => !SCHEMA_KEYWORDS.includes(k));
  if (unknown !== undefined) fail([...path, unknown], `\`${unknown}\` is not a keyword Sextant reads in an argument schema`);
  const kind = typeof node.type === "string" ? node.type : undefined;
  if (kind === undefined || !SCHEMA_TYPES.includes(kind)) {
    fail([...path, "type"], "must be one of: `object`, `string`, `number`, `integer`, `boolean`, `array`");
  }
  if (node.description !== undefined && !(typeof node.description === "string" && Array.from(node.description).length <= 500)) {
    fail([...path, "description"], "must be text of at most 500 characters");
  }
  for (const bound of ["minimum", "maximum"]) {
    if (node[bound] !== undefined && !isNumber(node[bound])) fail([...path, bound], "must be a number");
  }
  for (const bound of ["minLength", "maxLength", "minItems", "maxItems"]) {
    const v = node[bound];
    if (v !== undefined && !(typeof v === "number" && Number.isInteger(v) && v >= 0)) fail([...path, bound], "must be a whole number of 0 or more");
  }
  if (node.enum !== undefined) {
    const ok =
      Array.isArray(node.enum) &&
      node.enum.length > 0 &&
      node.enum.length <= 50 &&
      node.enum.every((v) => typeof v === "string" || isNumber(v) || typeof v === "boolean");
    if (!ok) fail([...path, "enum"], "must list 1 to 50 strings, numbers or booleans");
  }
  if (node.additionalProperties !== undefined && typeof node.additionalProperties !== "boolean") {
    fail([...path, "additionalProperties"], "must be true or false");
  }
  if (kind !== "object") {
    for (const key of ["properties", "required", "additionalProperties"]) {
      if (node[key] !== undefined) fail([...path, key], 'goes only with `"type": "object"`');
    }
  }
  if (kind !== "array" && node.items !== undefined) fail([...path, "items"], 'goes only with `"type": "array"`');
  let properties;
  if (node.properties !== undefined) {
    if (!isObject(node.properties)) fail([...path, "properties"], "must be an object of schemas");
    properties = node.properties;
    for (const name of sortedKeys(properties)) {
      if (!(name.length >= 1 && name.length <= 64 && /^[A-Za-z0-9_-]+$/.test(name))) {
        fail([...path, "properties", name], "a property name has 1 to 64 letters, digits, `_` and `-`");
      }
      checkSchemaNode(properties[name], [...path, "properties", name], depth + 1);
    }
  }
  if (node.required !== undefined) {
    if (!Array.isArray(node.required) || !node.required.every((n) => typeof n === "string")) fail([...path, "required"], "must list property names");
    node.required.forEach((name, i) => {
      if (!(properties !== undefined && Object.hasOwn(properties, name))) fail([...path, "required", i], "is not one of `properties`");
    });
  }
  if (node.items !== undefined) checkSchemaNode(node.items, [...path, "items"], depth + 1);
}

function checkAgentTools(manifest) {
  const tools = manifest.contributes?.agentTools ?? [];
  const list = ["contributes", "agentTools"];
  if (tools.length === 0) return;
  if (manifest.sextantApi < WINDOW_API) fail(list, `needs sextantApi ${WINDOW_API} or later`);
  if (manifest.backend === undefined) fail(list, "needs a `backend`: the extension's backend answers the tools");
  tools.forEach((tool, i) => {
    const here = [...list, i];
    const name = mcpToolName(manifest.id, tool.id);
    if (Array.from(name).length > MAX_TOOL_NAME_CHARS) {
      fail([...here, "id"], `with the extension's id the tool's name \`${name}\` is longer than ${MAX_TOOL_NAME_CHARS} characters`);
    }
    if (new TextEncoder().encode(compactJson(tool.inputSchema)).length > MAX_SCHEMA_BYTES) {
      fail([...here, "inputSchema"], `is larger than ${MAX_SCHEMA_BYTES} bytes`);
    }
    if (tool.inputSchema.type !== "object") fail([...here, "inputSchema", "type"], 'the arguments are an object: `"type": "object"`');
    checkSchemaNode(tool.inputSchema, [...here, "inputSchema"], 1);
  });
}

/** Whether `section` is the extension's own: a page or listed kind with this section gives it a title, or `sections`
 * lists it with one (`own_section`). */
function ownSection(manifest, section) {
  const c = manifest.contributes ?? {};
  return (
    (c.pages ?? []).some((page) => page.section === section && page.sectionTitle !== undefined) ||
    (c.kinds ?? []).some((kind) => kind.section === section && kind.sectionTitle !== undefined) ||
    (c.sections ?? []).some((s) => s.section === section && s.title !== undefined)
  );
}

/** `contributes.sections` and `clusterSettings` (`check_sections`). */
function checkSections(manifest) {
  const c = manifest.contributes ?? {};
  if (c.clusterSettings !== undefined && manifest.sextantApi < WINDOW_API) {
    fail(["contributes", "clusterSettings"], `needs sextantApi ${WINDOW_API} or later`);
  }
  const sections = c.sections ?? [];
  const list = ["contributes", "sections"];
  if (sections.length === 0) return;
  if (manifest.sextantApi < WINDOW_API) fail(list, `needs sextantApi ${WINDOW_API} or later`);
  sections.forEach((entry, i) => {
    const here = [...list, i];
    const first = sections.slice(0, i).findIndex((o) => o.section === entry.section);
    if (first >= 0) fail([...here, "section"], `duplicate section (also ${pathText([...list, first])})`);
    if (!ownSection(manifest, entry.section)) {
      fail([...here, "section"], "must be a section of the extension's own: it, or a kind or page of it with this section, has a title");
    }
  });
}

/** A condition of an action or a column (`check_object_condition`): no `missing`, no secret of any of `kinds`. */
/** `numeric_path` (#407): a compared path without its `|sum` or `|count`. */
function numericPath(text, api, segments) {
  const bar = text.lastIndexOf("|");
  if (bar < 0) return text;
  const filter = text.slice(bar + 1).trim();
  if (filter !== "sum" && filter !== "count") fail(segments, "ends in `|sum` or `|count`, or in no filter");
  if (api < SOURCES_API) fail(segments, `\`|${filter}\` needs sextantApi ${SOURCES_API} or later`);
  return text.slice(0, bar).trim();
}

/** `uses_time`: a condition that holds only from or until a time. */
function usesTime(condition) {
  if (condition.type === "olderThan" || condition.type === "enteredWithin") return true;
  if (condition.type === "all" || condition.type === "any") return condition.of.some(usesTime);
  if (condition.type === "not") return usesTime(condition.of);
  return false;
}

function checkObjectCondition(condition, kinds, segments, api) {
  for (const kind of kinds) checkCondition(condition, kind, segments, 1, { count: 0, api, kinds: [], metadataOnly: false, single: true });
}

/** `check_details_sections` (#408). */
function checkDetailsSections(manifest) {
  const list = ["contributes", "detailsSections"];
  (manifest.contributes?.detailsSections ?? []).forEach((section, i) => {
    for (const field of ["heading", "startHidden"]) {
      if (section[field] === undefined) continue;
      if (manifest.sextantApi < WINDOW_API) fail([...list, i, field], `needs sextantApi ${WINDOW_API} or later`);
      if (section.placement !== "section") fail([...list, i, field], "is for a `section`, not a tab");
    }
    // `{"group": "*", "kind": "*"}` alone: every kind (#411), without a `when`.
    if ((section.kinds ?? []).some((k) => k.group === "*" && k.kind === "*")) {
      if (manifest.sextantApi < WINDOW_API) fail([...list, i, "kinds"], `every kind needs sextantApi ${WINDOW_API} or later`);
      if (section.kinds.length !== 1) fail([...list, i, "kinds"], "with every kind (`*`/`*`) lists no other kind");
      if (section.when !== undefined) fail([...list, i, "when"], "is not for a section of every kind");
    }
    if (section.when === undefined) return;
    const here = [...list, i, "when"];
    if (manifest.sextantApi < WINDOW_API) fail(here, `needs sextantApi ${WINDOW_API} or later`);
    checkObjectCondition(section.when, section.kinds, here, manifest.sextantApi);
  });
}

function checkActions(manifest) {
  const list = ["contributes", "actions"];
  (manifest.contributes?.actions ?? []).forEach((action, i) => {
    const here = [...list, i];
    for (const field of ["headless", "when", "whyNot", "placement", "patch", "ask", "done"]) {
      if (action[field] !== undefined && manifest.sextantApi < WINDOW_API) fail([...here, field], `needs sextantApi ${WINDOW_API} or later`);
    }
    if (action.requiresKinds !== undefined) {
      if (manifest.sextantApi < WINDOW_API) fail([...here, "requiresKinds"], `needs sextantApi ${WINDOW_API} or later`);
      if (action.requiresKinds.length === 0 || action.requiresKinds.length > 5) fail([...here, "requiresKinds"], "names 1 to 5 kinds");
    }
    if (action.whyNot !== undefined && action.when === undefined) fail([...here, "whyNot"], "explains `when`: the action needs a `when`");
    if (action.when !== undefined) checkObjectCondition(action.when, action.kinds, [...here, "when"], manifest.sextantApi);
    for (const field of ["ask", "done"]) {
      if (action[field] !== undefined && action.patch === undefined) fail([...here, field], "goes with `patch`: the action needs a `patch`");
    }
    if (action.patch !== undefined) {
      if (action.headless === true) fail([...here, "headless"], "a `patch` is sent by Sextant without any frame: leave `headless` out");
      checkActionPatch(action.patch, [...here, "patch"]);
    }
    if (action.ask !== undefined) {
      for (const field of ["title", "text", "confirm"]) checkAskText(action.ask[field], action.multiple === true, [...here, "ask", field]);
    }
  });
}

/** `ASK_PLACEHOLDERS`: what Sextant fills in an action's question (#378). */
const ASK_PLACEHOLDERS = ["count", "kind", "namespace", "name"];

/** `check_ask_text`: `{{count}}`, and `{{kind}}`, `{{namespace}}`, `{{name}}` only on an action of one object. */
function checkAskText(text, multiple, segments) {
  const found = placeholders(text);
  if (found === null) fail(segments, "has a `{{` without its `}}`");
  for (const raw of found) {
    const name = raw.trim();
    if (!ASK_PLACEHOLDERS.includes(name)) {
      fail(segments, `\`{{${name}}}\`: Sextant fills only \`{{count}}\`, \`{{kind}}\`, \`{{namespace}}\` and \`{{name}}\``);
    }
    if (multiple && name !== "count") fail(segments, `\`{{${name}}}\` names one object: the action runs on several (\`multiple\`)`);
  }
}

/** An action's `patch`, serialized, at most (`MAX_ACTION_PATCH_BYTES`, #367). */
export const MAX_ACTION_PATCH_BYTES = 4096;

/** `check_action_patch`: at most 4 KiB, `{{now}}` only as a whole string value, no key with `{{`, no hidden-values marker. */
function checkActionPatch(patch, segments) {
  if (Object.keys(patch).length === 0) fail(segments, "must not be empty");
  if (new TextEncoder().encode(JSON.stringify(patch)).length > MAX_ACTION_PATCH_BYTES) {
    fail(segments, `must be at most ${MAX_ACTION_PATCH_BYTES} bytes`);
  }
  const walk = (value, at) => {
    if (typeof value === "string") {
      if (value.includes("{{") && value !== "{{now}}") fail(at, "has `{{now}}` as a whole value, and no other `{{…}}`");
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, [...at, i]));
    } else if (value !== null && typeof value === "object") {
      // serde_json keeps an object's keys sorted: the first failing key is the same in both checks.
      for (const key of sortedKeys(value)) {
        if (key.includes("{{")) fail([...at, key], "a key has no placeholder");
        if (key === "sextant.dev/values-hidden") fail([...at, key], "must not name Sextant's marker of hidden values");
        walk(value[key], [...at, key]);
      }
    }
  };
  walk(patch, segments);
}

/** `MAX_ITEM_CASES` (#404). */
const MAX_ITEM_CASES = 10;

const COLUMN_FIELDS = ["items", "filterBy", "joinPaths", "paths", "lookup", "valueText", "format", "endPaths", "totalPaths", "tones", "tooltipPaths", "cases"];

function checkColumns(manifest) {
  const list = ["contributes", "columns"];
  (manifest.contributes?.columns ?? []).forEach((column, i) => {
    const here = [...list, i];
    const maxCases = manifest.sextantApi >= WINDOW_API ? 20 : 10;
    if ((column.cases ?? []).length > maxCases) fail([...here, "cases"], `has at most ${maxCases} cases`);
    if (column.width !== undefined) {
      if (manifest.sextantApi < WINDOW_API) fail([...here, "width"], `needs sextantApi ${WINDOW_API} or later`);
      if (!isColumnWidth(column.width)) fail([...here, "width"], "is `<n>px` or `minmax(<n>px, <m>fr)`, n from 40 to 600 and m from 0.5 to 5");
    }
    if (column.filterBy !== undefined) {
      if (manifest.sextantApi < WINDOW_API) fail([...here, "filterBy"], `needs sextantApi ${WINDOW_API} or later`);
      if (column.filterBy !== "value" || (column.format ?? "text") !== "text" || (column.cases ?? []).length === 0) fail([...here, "filterBy"], 'is `"value"` on a text column with `cases`');
    }
    if (column.items !== undefined) {
      const at = [...here, "items"];
      if (manifest.sextantApi < WINDOW_API) fail(at, `needs sextantApi ${WINDOW_API} or later`);
      if (column.format !== "list") fail(at, 'goes with `format: "list"`');
      if ((column.paths ?? []).some((p) => p.includes("*"))) fail([...at, "cases"], "go with `paths` that name the lists themselves, without `*`");
      if (column.items.cases.length === 0 || column.items.cases.length > MAX_ITEM_CASES) fail([...at, "cases"], `has 1 to ${MAX_ITEM_CASES} cases`);
      column.items.cases.forEach((c, j) => {
        checkObjectCondition(c.when, [column.kind], [...at, "cases", j, "when"], manifest.sextantApi);
        if (c.text.trim() === "" || Array.from(c.text).length > 200) fail([...at, "cases", j, "text"], "is a text of 1 to 200 characters");
        checkMessage(c.text, column.kind, [...at, "cases", j, "text"], false);
      });
      const sep = column.items.separator;
      if (sep !== undefined && (Array.from(sep).length < 1 || Array.from(sep).length > 5 || /\p{Cc}/u.test(sep) || sep.includes("{{"))) fail([...at, "separator"], "is 1 to 5 characters, no control characters or `{{`");
    }
    if (column.joinPaths !== undefined) {
      if (manifest.sextantApi < WINDOW_API) fail([...here, "joinPaths"], `needs sextantApi ${WINDOW_API} or later`);
      if (column.format !== "list") fail([...here, "joinPaths"], 'goes with `format: "list"`');
    }
    if (column.afterColumn !== undefined) {
      if (manifest.sextantApi < WINDOW_API) fail([...here, "afterColumn"], `needs sextantApi ${WINDOW_API} or later`);
      if (!/^[A-Za-z0-9:_-]{1,80}$/.test(column.afterColumn)) fail([...here, "afterColumn"], "must be a column id: letters, digits, `-`, `_` and `:`");
    }
    for (const field of COLUMN_FIELDS) {
      if (column[field] !== undefined && manifest.sextantApi < WINDOW_API) fail([...here, field], `needs sextantApi ${WINDOW_API} or later`);
    }
    if (column.jsonPath === undefined && column.paths === undefined && column.lookup === undefined) {
      fail(here, "needs a `jsonPath`, `paths` or a `lookup`");
    }
    if (column.jsonPath !== undefined && column.paths !== undefined) fail([...here, "paths"], "a column has a `jsonPath` or `paths`, not both");
    if (column.jsonPath !== undefined) {
      const extra = COLUMN_FIELDS.slice(1).find((field) => column[field] !== undefined);
      if (extra !== undefined) fail([...here, extra], "goes with `paths` or a `lookup`, not `jsonPath`");
      return;
    }
    const format = column.format ?? "text";
    if (column.lookup !== undefined) checkLookup(column.lookup, column.kind, [...here, "lookup"]);
    if (column.valueText !== undefined) checkValueText(column.valueText, format, [...here, "valueText"]);
    if (column.endPaths !== undefined && format !== "duration") fail([...here, "endPaths"], 'goes with `format: "duration"`');
    if (format === "ratio" && column.totalPaths === undefined) fail([...here, "totalPaths"], '`format: "ratio"` needs `totalPaths`');
    if (format !== "ratio" && column.totalPaths !== undefined) fail([...here, "totalPaths"], 'goes with `format: "ratio"`');
    for (const field of ["paths", "endPaths", "totalPaths", "tooltipPaths"]) {
      (column[field] ?? []).forEach((text, j) => {
        // A number read may be a list's sum or count (#407).
        const place = [...here, field, j];
        checkPath(field === "paths" || field === "totalPaths" ? numericPath(text, manifest.sextantApi, place) : text, column.kind, place);
      });
    }
    for (const value of sortedKeys(column.tones ?? {})) {
      if (value.trim() === "" || Array.from(value).length > MAX_TONE_VALUE_CHARS) {
        fail([...here, "tones"], `names values of 1 to ${MAX_TONE_VALUE_CHARS} characters`);
      }
    }
    (column.cases ?? []).forEach((c, j) => {
      checkObjectCondition(c.when, [column.kind], [...here, "cases", j, "when"], manifest.sextantApi);
      // Field values in the text, as a problem message has them (#368). An empty text leaves the cell blank (#404).
      if (c.text === "" ? manifest.sextantApi < WINDOW_API : c.text.trim() === "") fail([...here, "cases", j, "text"], c.text === "" ? `is empty only from sextantApi ${WINDOW_API}` : "must not be blank");
      checkMessage(c.text, column.kind, [...here, "cases", j, "text"], false);
      if (c.value !== undefined) {
        // A text column's value may be a text with placeholders, the reason a row sorts by (#404).
        const bad = 'goes with `format: "number"` or `"text"` (a text only with `"text"`)';
        if (typeof c.value === "string") {
          if (format !== "text") fail([...here, "cases", j, "value"], bad);
          if (c.value.trim() === "" || Array.from(c.value).length > 200) fail([...here, "cases", j, "value"], "is a text of 1 to 200 characters");
          checkMessage(c.value, column.kind, [...here, "cases", j, "value"], false);
        } else if (!["number", "text", "count", "sum"].includes(format)) fail([...here, "cases", j, "value"], bad);
      }
      if (c.tooltip !== undefined) checkMessage(c.tooltip, column.kind, [...here, "cases", j, "tooltip"], false);
      if (c.tooltipOr !== undefined) {
        if (c.tooltip === undefined || c.tooltipOr.length === 0 || c.tooltipOr.length > 3) fail([...here, "cases", j, "tooltipOr"], "follows a `tooltip` with 1 to 3 more");
        c.tooltipOr.forEach((t, k) => checkMessage(t, column.kind, [...here, "cases", j, "tooltipOr", k], false));
      }
    });
  });
}

/** `check_lookup` (#387): list, index and the item's field are paths that read no secret of the kind. */
function checkLookup(lookup, kind, segments) {
  checkPath(lookup.list, kind, [...segments, "list"]);
  checkPath(lookup.index, kind, [...segments, "index"]);
  const field = lookup.field.trim();
  if (!field.startsWith(".") && !field.startsWith("[")) fail([...segments, "field"], "must be a field path inside an item, such as `.setWeight`");
  checkPath(`${lookup.list.trim()}[0]${field}`, kind, [...segments, "field"]);
}

/** `check_value_text` (#387): the one placeholder `{{value}}`, for a `text` or `number` value. */
function checkValueText(text, format, segments) {
  if (!["text", "number", "count", "sum"].includes(format)) fail(segments, "goes with `format` `text`, `number`, `count` or `sum`");
  const found = placeholders(text);
  if (found === null) fail(segments, "has a `{{` without its `}}`");
  if (found.length === 0 || found.some((p) => p.trim() !== "value")) fail(segments, "has `{{value}}`, and no other placeholder");
}

function checkKinds(manifest) {
  const kinds = manifest.contributes?.kinds ?? [];
  const list = ["contributes", "kinds"];
  if (kinds.length === 0) return;
  if (manifest.sextantApi < WINDOW_API) fail(list, `needs sextantApi ${WINDOW_API} or later`);
  kinds.forEach((entry, i) => {
    const here = [...list, i];
    if (entry.group.trim() === "" || entry.group.includes("*") || entry.kind.includes("*")) {
      fail([...here, "group"], "must be the API group of a custom resource: Sextant lists the core API's kinds itself");
    }
    const first = kinds.slice(0, i).findIndex((other) => sameKind(other, entry));
    if (first >= 0) fail([...here, "kind"], `duplicate kind (also ${pathText([...list, first])})`);
    if (!ownSection(manifest, entry.section)) {
      fail([...here, "section"], "must be a section of the extension's own: a kind or page of it with this section has a `sectionTitle`");
    }
    if (entry.problemWhen !== undefined) {
      checkObjectCondition(entry.problemWhen, [{ group: entry.group, kind: entry.kind }], [...here, "problemWhen"], manifest.sextantApi);
    }
    (entry.aliases ?? []).forEach((alias, j) => {
      if (!(alias.length >= 1 && alias.length <= 20 && /^[a-z0-9-]+$/.test(alias))) {
        fail([...here, "aliases", j], "a short name has 1 to 20 lowercase letters, digits and `-`");
      }
    });
  });
}

/** The problem with a parsed manifest (see `readJson`) as `{path, message}`, or `null` when Sextant accepts it. */
export function validateManifest(value, schema = manifestSchema()) {
  try {
    if (!isObject(value)) fail([], "must be an object");
    const api = value.sextantApi;
    if (typeof api === "number" && Number.isInteger(api) && (api < MIN_API || api > SUPPORTED_API)) {
      fail(["sextantApi"], `extension API ${api} is not supported; this Sextant supports ${MIN_API} to ${SUPPORTED_API}`);
    }
    check(schema, schema, value, []);
    checkUniqueIds(value);
    checkProblems(value);
    checkMetricQueries(value);
    checkTranslations(value);
    checkSectionBadges(value);
    checkProblemCategories(value);
    checkCommands(value);
    checkActions(value);
    checkDetailsSections(value);
    checkColumns(value);
    checkKinds(value);
    checkPermissions(value);
    if ((value.contributes?.menuItems ?? []).length > 0 && value.sextantApi < WINDOW_API) {
      fail(["contributes", "menuItems"], `needs sextantApi ${WINDOW_API} or later`);
    }
    checkServices(value);
    checkAgentTools(value);
    checkSections(value);
    return null;
  } catch (err) {
    if (err instanceof ManifestError) return { path: err.path, message: err.message };
    throw err;
  }
}

/** Checks the bytes of `sextant-extension.json`: `{manifest}` (plain JSON) or `{error: {path, message}}`. */
export function checkManifestBytes(bytes) {
  if (bytes.length > MAX_MANIFEST_BYTES) {
    return { error: { path: "", message: `the file is too large (${bytes.length} bytes; at most ${MAX_MANIFEST_BYTES})` } };
  }
  let text;
  try {
    // As serde_json: invalid UTF-8 or a byte order mark is not JSON.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { error: { path: "", message: "not valid JSON" } };
  }
  const value = readJson(text);
  if (value === undefined) return { error: { path: "", message: "not valid JSON" } };
  const error = validateManifest(value);
  return error ? { error } : { manifest: JSON.parse(text) };
}

/** `sextant-extension.json: <path>: <message>`, as Sextant prints it. */
export function formatManifestError(error) {
  return error.path ? `${MANIFEST_FILE}: ${error.path}: ${error.message}` : `${MANIFEST_FILE}: ${error.message}`;
}
