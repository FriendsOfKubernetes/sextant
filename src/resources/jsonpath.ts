// The JSONPath subset used by CRD `additionalPrinterColumns` (as kubectl evaluates them):
//   .spec.size   .status.replicas   .items[0].name   .items[*].name   .metadata.labels['app\.kubernetes\.io/name']
//   .status.conditions[?(@.type=="Ready")].status   {.spec.size}   $.spec.size
// Unsupported syntax yields no values (an empty cell), never an exception.

type Step =
  | { type: "key"; key: string }
  | { type: "index"; index: number }
  | { type: "wildcard" }
  | { type: "filter"; path: string[]; op: "==" | "!="; value: unknown }
  | { type: "exists"; path: string[] };

const cache = new Map<string, Step[] | null>();

/** Every value `path` selects in `obj` (empty when nothing matches or the path is not understood). */
export function evalJsonPath(obj: unknown, path: string): unknown[] {
  let steps = cache.get(path);
  if (steps === undefined) {
    steps = parse(path);
    cache.set(path, steps);
  }
  if (!steps) return [];
  let current: unknown[] = [obj];
  for (const step of steps) {
    const next: unknown[] = [];
    for (const value of current) apply(step, value, next);
    current = next;
  }
  return current.filter((v) => v !== undefined && v !== null);
}

function apply(step: Step, value: unknown, out: unknown[]): void {
  if (value === null || typeof value !== "object") return;
  switch (step.type) {
    case "key":
      if (!Array.isArray(value)) out.push((value as Record<string, unknown>)[step.key]);
      return;
    case "index": {
      if (!Array.isArray(value)) return;
      const i = step.index < 0 ? value.length + step.index : step.index;
      out.push(value[i]);
      return;
    }
    case "wildcard":
      out.push(...(Array.isArray(value) ? value : Object.values(value)));
      return;
    case "filter":
    case "exists": {
      const items = Array.isArray(value) ? value : [value];
      for (const item of items) {
        const field = step.path.reduce<unknown>(
          (cur, key) => (cur && typeof cur === "object" ? (cur as Record<string, unknown>)[key] : undefined),
          item,
        );
        if (step.type === "exists" ? field !== undefined : (field === step.value) === (step.op === "=="))
          out.push(item);
      }
      return;
    }
  }
}

function parse(raw: string): Step[] | null {
  let path = raw.trim();
  if (path.startsWith("{") && path.endsWith("}")) path = path.slice(1, -1).trim();
  if (path.startsWith("$")) path = path.slice(1);
  const steps: Step[] = [];
  let i = 0;
  while (i < path.length) {
    const ch = path[i];
    if (ch === ".") {
      i++;
      if (path[i] === "*") {
        steps.push({ type: "wildcard" });
        i++;
        continue;
      }
      let key = "";
      while (i < path.length && path[i] !== "." && path[i] !== "[") {
        if (path[i] === "\\" && i + 1 < path.length) i++;
        key += path[i];
        i++;
      }
      if (!key) return null;
      steps.push({ type: "key", key });
    } else if (ch === "[") {
      const end = closingBracket(path, i);
      if (end < 0) return null;
      const inner = path.slice(i + 1, end).trim();
      i = end + 1;
      const step = parseBracket(inner);
      if (!step) return null;
      steps.push(step);
    } else {
      return null;
    }
  }
  return steps;
}

function closingBracket(path: string, open: number): number {
  let quote: string | null = null;
  let depth = 0;
  for (let i = open; i < path.length; i++) {
    const ch = path[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") {
      depth--;
      if (depth === 0 && ch === "]") return i;
    }
  }
  return -1;
}

function parseBracket(inner: string): Step | null {
  if (inner === "*") return { type: "wildcard" };
  if (/^-?\d+$/.test(inner)) return { type: "index", index: Number(inner) };
  const quoted = /^(['"])(.*)\1$/.exec(inner);
  if (quoted) return { type: "key", key: (quoted[2] ?? "").replace(/\\(.)/g, "$1") };
  const filter = /^\?\(\s*@\.([\w.-]+)\s*(?:(==|!=)\s*(.+?))?\s*\)$/.exec(inner);
  if (filter) {
    const path = (filter[1] ?? "").split(".");
    if (!filter[2]) return { type: "exists", path };
    return { type: "filter", path, op: filter[2] as "==" | "!=", value: literal(filter[3] ?? "") };
  }
  return null;
}

function literal(text: string): unknown {
  const t = text.trim();
  const quoted = /^(['"])(.*)\1$/.exec(t);
  if (quoted) return quoted[2];
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  const n = Number(t);
  return Number.isNaN(n) ? t : n;
}

/** Cell text of a printer column value list, the way kubectl prints it. */
export function formatJsonPathValues(values: unknown[]): string {
  return values.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join(", ");
}
