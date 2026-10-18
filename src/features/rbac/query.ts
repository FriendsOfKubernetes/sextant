// Reading what the user typed into the reverse query and the "Can I" form: `pods`, `deployments.apps`,
// `pods/exec`, `*`, resolved against discovery (the API group, whether the resource is cluster-scoped).
import type { ResourceKind } from "../../api";
import type { ClusterScoped } from "./engine";

export interface ResolvedResource {
  group: string;
  /** Plural, without the subresource. */
  resource: string;
  subresource: string;
  clusterScoped: boolean;
  /** Discovery serves it (always true for `*`; false while discovery is unknown). */
  known: boolean;
}

/** Verbs the forms offer; any other verb can be typed. */
export const COMMON_VERBS = [
  "get",
  "list",
  "watch",
  "create",
  "update",
  "patch",
  "delete",
  "deletecollection",
  "impersonate",
  "bind",
  "escalate",
  "use",
] as const;

/**
 * `resource[.group][/subresource]`: the group is what follows the first dot (`deployments.apps`); without one, the
 * served resource of that name (the core group first). `subresource` from the field wins over one in the text.
 */
export function resolveResource(text: string, subresourceField: string, kinds: readonly ResourceKind[] | null): ResolvedResource | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const [main = "", fromText = ""] = trimmed.split("/", 2);
  const subresource = subresourceField.trim() || fromText;
  if (main === "*") return { group: "*", resource: "*", subresource, clusterScoped: false, known: true };
  const dot = main.indexOf(".");
  const plural = (dot < 0 ? main : main.slice(0, dot)).toLowerCase();
  const group = dot < 0 ? undefined : main.slice(dot + 1);
  const candidates = (kinds ?? []).filter((k) => k.plural === plural && (group === undefined || k.kindRef.group === group));
  const found = candidates.find((k) => k.kindRef.group === "") ?? candidates[0];
  if (found) {
    return { group: found.kindRef.group, resource: plural, subresource, clusterScoped: !found.namespaced, known: true };
  }
  return { group: group ?? "", resource: plural, subresource, clusterScoped: false, known: false };
}

/** Resource names for the input's suggestions: `pods`, `deployments.apps`, … sorted, unique. */
export function resourceSuggestions(kinds: readonly ResourceKind[] | null): string[] {
  const names = new Set<string>();
  for (const k of kinds ?? []) names.add(k.kindRef.group ? `${k.plural}.${k.kindRef.group}` : k.plural);
  return [...names].sort();
}

/**
 * Which resources are cluster-scoped, from discovery: `(group, plural)`; for the group `*`, a plural every served
 * kind of which is cluster-scoped. A resource discovery does not know counts as namespaced.
 */
export function clusterScopedOf(kinds: readonly ResourceKind[] | null): ClusterScoped {
  const byPlural = new Map<string, { group: string; namespaced: boolean }[]>();
  for (const k of kinds ?? []) {
    const list = byPlural.get(k.plural) ?? [];
    list.push({ group: k.kindRef.group, namespaced: k.namespaced });
    byPlural.set(k.plural, list);
  }
  return (group, resource) => {
    const list = byPlural.get(resource) ?? [];
    if (group === "*") return list.length > 0 && list.every((k) => !k.namespaced);
    return list.some((k) => k.group === group && !k.namespaced);
  };
}
