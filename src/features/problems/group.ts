// How the problems screen lists problems: filtered by the namespace filter and "Only new since…", grouped by category
// (in `PROBLEM_CATEGORIES` order) and namespace (cluster-wide objects first), newest first. Pure.
import { extensionCategories } from "./extensionCategories";
import { PROBLEM_CATEGORIES, startedAt, type Problem, type ProblemCategory } from "./model";

export interface NamespaceGroup {
  /** `null`: cluster-wide objects (nodes, …). */
  namespace: string | null;
  problems: Problem[];
}

export interface CategoryGroup {
  category: ProblemCategory;
  count: number;
  namespaces: NamespaceGroup[];
}

export interface ProblemFilter {
  /** The namespaces chosen in the namespace filter; `null`: all. Cluster-wide objects are always kept. */
  namespaces: readonly string[] | null;
  /** Keep only problems that began after this time (ms). */
  newSince: number | null;
}

export function filterProblems(problems: readonly Problem[], filter: ProblemFilter): Problem[] {
  const chosen = filter.namespaces && filter.namespaces.length > 0 ? new Set(filter.namespaces) : null;
  return problems.filter((p) => {
    if (chosen && p.object.namespace !== null && !chosen.has(p.object.namespace)) return false;
    if (filter.newSince !== null && startedAt(p) <= filter.newSince) return false;
    return true;
  });
}

export function groupProblems(problems: readonly Problem[]): CategoryGroup[] {
  const groups: CategoryGroup[] = [];
  // Sextant's categories in their order, then the extensions' (by name; one that went meanwhile last).
  const registered = extensionCategories();
  const gone = [...new Set(problems.map((p) => p.category))].filter(
    (c) => c.startsWith("ext:") && !(registered as readonly string[]).includes(c),
  );
  for (const category of [...PROBLEM_CATEGORIES, ...registered, ...gone]) {
    const ofCategory = problems.filter((p) => p.category === category);
    if (ofCategory.length === 0) continue;
    const byNamespace = new Map<string | null, Problem[]>();
    for (const p of ofCategory) {
      const list = byNamespace.get(p.object.namespace) ?? [];
      list.push(p);
      byNamespace.set(p.object.namespace, list);
    }
    const namespaces = [...byNamespace.entries()]
      .sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : a.localeCompare(b)))
      .map(([namespace, list]) => ({
        namespace,
        problems: list.sort(
          (x, y) => startedAt(y) - startedAt(x) || x.object.name.localeCompare(y.object.name) || x.key.localeCompare(y.key),
        ),
      }));
    groups.push({ category, count: ofCategory.length, namespaces });
  }
  return groups;
}
