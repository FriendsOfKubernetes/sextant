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
/** The newest extension API Sextant implements; 2 brought `contributes.problems` (ADR-0137). */
export const SUPPORTED_API = 2;
/** The oldest one it still reads. */
export const MIN_API = 1;
export const MAX_MANIFEST_BYTES = 256 * 1024;
export const SCHEMA_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../crates/sextant-core/src/extensions/manifest.schema.json",
);
/** The kinds with secret material inline (ADR-0120): the table Sextant's checks share. */
export const INLINE_SECRETS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/resources/inline-secrets.json");

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
  if (schema.additionalProperties === false) {
    const unknown = keys.find((k) => !(properties && Object.hasOwn(properties, k)));
    if (unknown !== undefined) fail([...path, unknown], "unknown field");
  }
  if (Array.isArray(schema.required)) {
    for (const name of schema.required) if (!Object.hasOwn(fields, name)) fail([...path, name], "is required");
  }
  if (properties) {
    for (const key of keys) if (Object.hasOwn(properties, key)) check(root, properties[key], fields[key], [...path, key]);
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
  for (const kind of ["pages", "detailsSections", "actions", "columns", "dockActions", "problems", "metricQueries"]) {
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
const MAX_KINDS = 10;
const MAX_CONDITIONS = 20;
const MAX_DEPTH = 3;
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
        secret.slice(0, steps.length).every((want, i) => want === "*" || (steps[i].key !== undefined && steps[i].key === want)),
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

function checkCondition(condition, kind, segments, depth, counter) {
  counter.count += 1;
  if (counter.count > MAX_CONDITIONS) fail(segments, `a rule has at most ${MAX_CONDITIONS} conditions`);
  if (condition.type === "condition") return;
  if (condition.type === "all" || condition.type === "any") {
    if (depth >= MAX_DEPTH) fail(segments, `\`all\` and \`any\` nest at most ${MAX_DEPTH} deep`);
    condition.of.forEach((inner, i) => checkCondition(inner, kind, [...segments, "of", i], depth + 1, counter));
    return;
  }
  checkPath(condition.path, kind, [...segments, "path"]);
}

/** What Sextant checks of problem rules beyond the schema, in its order. */
function checkProblems(manifest) {
  const rules = manifest.contributes?.problems ?? [];
  const list = ["contributes", "problems"];
  if (rules.length === 0) return;
  if (manifest.sextantApi < PROBLEMS_API) fail(list, `needs sextantApi ${PROBLEMS_API} or later`);
  const kinds = [];
  rules.forEach((rule, i) => {
    const here = [...list, i];
    const first = rules.slice(0, i).findIndex((other) => other.title.trim() === rule.title.trim());
    if (first >= 0) fail([...here, "title"], `duplicate title (also ${pathText([...list, first])})`);
    if (!kinds.some((k) => sameKind(k, rule.kind))) {
      kinds.push(rule.kind);
      if (kinds.length > MAX_KINDS) fail([...here, "kind"], `the rules judge at most ${MAX_KINDS} kinds`);
    }
    checkCondition(rule.when, rule.kind, [...here, "when"], 1, { count: 0 });
    if (rule.since !== undefined) checkPath(rule.since, rule.kind, [...here, "since"]);
    const found = placeholders(rule.message);
    if (found === null) fail([...here, "message"], "has a `{{` without its `}}`");
    if (found.length > MAX_PLACEHOLDERS) fail([...here, "message"], `has at most ${MAX_PLACEHOLDERS} placeholders`);
    for (const field of found) checkPath(field.trim(), rule.kind, [...here, "message"]);
  });
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
