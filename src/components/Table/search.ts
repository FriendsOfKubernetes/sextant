// Search in resource tables, as in Lens: every word must match. A word with "=" is a label selector term
// (`app=web`, `tier!=db`, `app=` = has the label); any other word matches part of the name, the namespace or a
// `key=value` label, ignoring case.
import type { KubeObject } from "../../api";

export function matchesSearch(obj: KubeObject, query: string): boolean {
  const terms = query
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (terms.length === 0) return true;
  const meta = obj.metadata ?? {};
  const labels = (meta.labels && typeof meta.labels === "object" ? meta.labels : {}) as Record<string, string>;
  const name = (meta.name ?? "").toLowerCase();
  const namespace = (meta.namespace ?? "").toLowerCase();
  const pairs = Object.entries(labels).map(([k, v]) => `${k}=${v}`.toLowerCase());

  return terms.every((term) => {
    const selector = /^([^=!]+)(!=|==|=)(.*)$/.exec(term);
    if (selector) {
      const [, key = "", op, value = ""] = selector;
      const actual = labels[key];
      if (op === "!=") return actual !== value;
      if (value === "") return actual !== undefined;
      return actual === value;
    }
    const lower = term.toLowerCase();
    return name.includes(lower) || namespace.includes(lower) || pairs.some((p) => p.includes(lower));
  });
}
