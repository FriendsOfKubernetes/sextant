// Contour's problems judged across proxies (#233): when a root is invalid, Contour stops at it and never reaches the
// proxies it includes, so it marks each of them orphaned — one broken TLS Secret on a root with 20 includes would be
// 21 problems. An orphan whose include path goes up to an invalid proxy is told through that proxy instead (as Knative
// tells an owned object through its owner); an orphan nobody includes, or one under valid and orphaned proxies only,
// stays a problem of its own. The rows are the problems store's tap of its HTTPProxy watch (`SourceDef.across`), the
// same rows the delegation tree reads (hooks.ts), so nothing more is watched.
import type { AcrossDef } from "../problems/sources";
import type { Problem } from "../problems/model";
import { indexRows, proxyKey, proxyRow, type ProxyRow } from "./model";

/** Rows the tap keeps at most (beyond it the tree says it may be incomplete). */
export const MAX_PROXY_ROWS = 5000;

export const PROXY_TAP = { id: "contour:proxies", toRow: proxyRow, max: MAX_PROXY_ROWS };

/** The problems less the orphans an invalid proxy above them already tells. */
export function toldThroughInvalid(problems: readonly Problem[], rows: ReadonlyMap<string, ProxyRow>): Problem[] {
  if (!problems.some((p) => p.reason === "Orphaned")) return [...problems];
  const index = indexRows(rows.values());
  // Who includes whom, built once: an include path is walked upwards.
  const parents = new Map<string, string[]>();
  for (const [key, row] of index) {
    for (const inc of row.includes) parents.set(inc.key, [...(parents.get(inc.key) ?? []), key]);
  }
  const underInvalid = (start: string): boolean => {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
      for (const parent of parents.get(queue.shift()!) ?? []) {
        if (seen.has(parent)) continue;
        if (index.get(parent)?.state === "invalid") return true;
        seen.add(parent);
        queue.push(parent);
      }
    }
    return false;
  };
  return problems.filter((p) => p.reason !== "Orphaned" || !underInvalid(proxyKey(p.object.namespace ?? "", p.object.name)));
}

export const CONTOUR_ACROSS: AcrossDef = {
  tap: PROXY_TAP,
  keep: (problems, rows) => toldThroughInvalid(problems, rows as ReadonlyMap<string, ProxyRow>),
};
