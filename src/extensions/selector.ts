// Kubernetes label selectors (`labels.Parse`) matched in the window: the source of an extension's problem rule
// (ADR-0152) names the objects its rules are about, so a table's "Only problems" asks the rule only of those. The
// manifest's selector was checked in Rust (`is_set_selector`); one that does not parse here matches nothing.

type Requirement =
  | { op: "exists" | "absent"; key: string }
  | { op: "in" | "notin"; key: string; values: string[] };

function parse(text: string): Requirement[] | null {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (c === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  const out: Requirement[] = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (part === "") return null;
    if (part.startsWith("!")) {
      out.push({ op: "absent", key: part.slice(1).trim() });
      continue;
    }
    const eq = /^(.+?)\s*(!=|==|=)\s*(.*)$/.exec(part);
    if (eq) {
      out.push({ op: eq[2] === "!=" ? "notin" : "in", key: eq[1]!.trim(), values: [eq[3]!.trim()] });
      continue;
    }
    const set = /^(\S+)\s+(in|notin)\s*\((.*)\)$/.exec(part);
    if (set) {
      out.push({ op: set[2] as "in" | "notin", key: set[1]!, values: set[3]!.split(",").map((v) => v.trim()) });
      continue;
    }
    out.push({ op: "exists", key: part });
  }
  return out;
}

const cache = new Map<string, Requirement[] | null>();

/** Whether `labels` match the Kubernetes label selector `selector`. */
export function matchesSelector(labels: Record<string, string> | undefined, selector: string): boolean {
  let requirements = cache.get(selector);
  if (requirements === undefined) {
    requirements = parse(selector);
    cache.set(selector, requirements);
  }
  if (!requirements) return false;
  const have = labels ?? {};
  return requirements.every((r) => {
    const present = Object.prototype.hasOwnProperty.call(have, r.key);
    switch (r.op) {
      case "exists":
        return present;
      case "absent":
        return !present;
      case "in":
        return present && r.values.includes(have[r.key]!);
      case "notin":
        return !present || !r.values.includes(have[r.key]!);
    }
  });
}
