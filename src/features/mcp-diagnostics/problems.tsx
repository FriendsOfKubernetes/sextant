// `get_problems`: the problems screen's findings (ADR-0066), from the same shared sources (`useClusterProblems`) and
// the same opt-in rule (`useCategoriesOn`), as the agent may read them.
import { useMemo } from "react";
import { useClusterKinds } from "../../resources";
import { useCategoriesOn, useClusterProblems } from "../problems/hooks";
import { needsDiscovery, sourcesFor } from "../problems/sources";
import { isActive, PROBLEM_CATEGORIES, startedAt, type Problem, type ProblemCategory } from "../problems/model";
import { en, iso, list } from "./english";
import { canRead, objectName } from "./scope";
import { useAnswer, type WorkerProps } from "./worker";

interface Args {
  namespace: string | null;
  categories: string[];
}

/** A problem's message in English: the cluster's own text, or Sextant's phrase. */
export function englishMessage(p: Pick<Problem, "message" | "messageKey" | "messageParams" | "messageLists">): string | undefined {
  if (p.message) return p.message;
  if (!p.messageKey) return undefined;
  const lists = Object.fromEntries(Object.entries(p.messageLists ?? {}).map(([key, items]) => [key, list(items)]));
  return en(`problems:${p.messageKey}`, { ...p.messageParams, ...lists });
}

export function ProblemsWorker(props: WorkerProps) {
  const { request } = props;
  const args = request.args as unknown as Args;
  const asked = useMemo(
    () => PROBLEM_CATEGORIES.filter((c) => args.categories.includes(c)) as ProblemCategory[],
    [args.categories],
  );
  const categories = useCategoriesOn(asked);
  const { sources, loading } = useClusterProblems(request.clusterId, categories);
  // Ready once discovery said which tools' kinds are served and every source has listed its kind.
  const discovery = useClusterKinds(needsDiscovery(categories) ? request.clusterId : null);
  const kinds = discovery.kinds ?? (discovery.error ? null : undefined);
  const settled = !needsDiscovery(categories) || kinds !== undefined;
  const expected = useMemo(() => sourcesFor(categories, kinds).length, [categories, kinds]);
  const ready = settled && !loading && sources.length >= expected;

  useAnswer(props, ready, () => {
    const now = Date.now();
    const problems = [];
    for (const source of sources) {
      for (const p of source.problems) {
        const ns = p.object.namespace ?? null;
        if (!isActive(p, now)) continue;
        if (args.namespace && ns !== args.namespace) continue;
        if (!canRead(request.reads, source.def.kind, ns) || !canRead(request.reads, p.object.kind, ns)) continue;
        problems.push({
          category: p.category,
          reason: p.reason,
          message: englishMessage(p),
          object: objectName(p.object.kind, ns, p.object.name),
          source: { group: source.def.kind.group, kind: source.def.kind.kind },
          since: iso(startedAt(p)),
          needsAttention: p.notify,
        });
      }
    }
    return {
      problems,
      categories,
      loading: [...new Set(sources.filter((s) => s.status === "loading").map((s) => s.category))],
      truncated: sources.some((s) => s.truncated),
    };
  });
  return null;
}
