// What the user may read, as the API server answers it (#285, ADR-0124) — the pure part of the access check that
// `accessStore.ts` runs on connect. Kubernetes has no API that names the namespaces a user may read without listing
// Namespaces; it does answer "may I …" (SelfSubjectAccessReview) and "what may I do in this namespace"
// (SelfSubjectRulesReview). Everything here reads those answers; nothing is guessed from Roles or bindings.
//
// - Namespaces: "may I list namespaces?" once; when not, every candidate (known, the context's namespace, the
//   ServiceAccount's, OpenShift projects) is asked "may I list pods in it?" — "accessible", "noAccess", or "unknown"
//   when the review failed or has not answered.
// - Kinds: a cluster-scoped kind by "may I list it?"; a namespaced kind by the rules review of each namespace looked
//   at: a rule with the verb `list` (or `*`), the kind's group (or `*`) and its plural (or `*`) and no resource names
//   grants it, as the RBAC authorizer matches rules (`k8s.io/kubernetes/plugin/pkg/auth/authorizer/rbac`,
//   `RuleAllows`). A review the server marks `incomplete` (another authorizer, e.g. a webhook, cannot list its rules)
//   can only grant: its "no" is "unknown".
import type { AccessAnswer, AccessQuery, KindRef, ResourceKind, RulesReview } from "../../api";

/** A namespace the access check looked at. */
export type NamespaceAccess = "accessible" | "noAccess" | "unknown";
/** Whether a kind can be listed where it is looked at. */
export type KindAccess = "readable" | "noAccess" | "unknown";
/** Where the check found a candidate namespace. */
export type FoundBy = "context" | "serviceAccount" | "project";

/** Questions of one `rbac_can_i` call (`rbac::MAX_QUERIES`). */
export const MAX_QUERIES = 64;
/** Candidate namespaces asked about per check (the known ones are at most 200 too). */
export const MAX_CHECKED_NAMESPACES = 200;
/** Namespaces whose rules review is asked for, per connection. */
export const MAX_RULES_REVIEWS = 10;
/** Namespaces "All namespaces" watches for a user who may not list Namespaces (one list and watch per kind each). */
export const MAX_SCOPE_NAMESPACES = 20;

/** "May I list namespaces?" — cluster-wide. */
export const LIST_NAMESPACES: AccessQuery = query("list", "", "namespaces", "");

function query(verb: string, group: string, resource: string, namespace: string): AccessQuery {
  return { verb, group, resource, subresource: "", name: "", namespace, nonResourceUrl: "" };
}

/** The question asked about a candidate namespace: may the user list pods in it. */
export function namespaceQuery(namespace: string): AccessQuery {
  return query("list", "", "pods", namespace);
}

/** The question asked about a cluster-scoped kind. */
export function kindQuery(kind: ResourceKind): AccessQuery {
  return query("list", kind.kindRef.group, kind.plural, "");
}

/** Splits `items` into calls of at most `MAX_QUERIES`. */
export function batches<T>(items: readonly T[], size = MAX_QUERIES): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The API server's answer as a mark: allowed → accessible; a clean "no" → no access; an evaluation error → unknown. */
export function namespaceAccessOf(answer: AccessAnswer | undefined): NamespaceAccess {
  if (!answer) return "unknown";
  if (answer.allowed) return "accessible";
  return answer.evaluationError ? "unknown" : "noAccess";
}

/** A cluster-scoped kind's answer: `true` may list, `false` may not, `null` cannot tell. */
export function kindAnswerOf(answer: AccessAnswer | undefined): boolean | null {
  if (!answer) return null;
  if (answer.allowed) return true;
  return answer.evaluationError ? null : false;
}

/** Whether one rules review grants `list` on the kind (see the header). */
export function rulesAllowList(review: RulesReview, group: string, plural: string): boolean {
  return review.resourceRules.some(
    (rule) =>
      rule.resourceNames.length === 0 &&
      (rule.verbs.includes("list") || rule.verbs.includes("*")) &&
      (rule.apiGroups.includes(group) || rule.apiGroups.includes("*")) &&
      (rule.resources.includes(plural) || rule.resources.includes("*")),
  );
}

/** What the check knows of a kind (see `kindAccessIn`). */
export interface KindFacts {
  /** Cluster-scoped kinds by `kindKeyOf`: `true` may list, `false` may not, `null` cannot tell. */
  clusterKinds: ReadonlyMap<string, boolean | null>;
  /** Rules reviews by namespace; `null` when the review failed. */
  rules: ReadonlyMap<string, RulesReview | null>;
}

/** `group/Kind`, the key of a kind here. */
export function kindKeyOf(kind: Pick<KindRef, "group" | "kind">): string {
  return `${kind.group}/${kind.kind}`;
}

/**
 * Whether the kind can be listed in `namespaces` (a namespaced kind) or at all (a cluster-scoped one): "readable"
 * when any reviewed namespace grants it, "noAccess" only when every namespace of the list was reviewed completely and
 * none grants it, otherwise "unknown". `namespaces: null` (every namespace) is unknown for a namespaced kind.
 */
export function kindAccessIn(
  facts: KindFacts,
  kind: { kind: Pick<KindRef, "group" | "kind">; plural: string; namespaced: boolean },
  namespaces: readonly string[] | null,
): KindAccess {
  if (!kind.namespaced) {
    const answer = facts.clusterKinds.get(kindKeyOf(kind.kind));
    return answer === true ? "readable" : answer === false ? "noAccess" : "unknown";
  }
  if (!namespaces || namespaces.length === 0) return "unknown";
  let unknown = false;
  for (const ns of namespaces) {
    const review = facts.rules.get(ns);
    if (!review) {
      unknown = true;
      continue;
    }
    if (rulesAllowList(review, kind.kind.group, kind.plural)) return "readable";
    if (review.incomplete || review.evaluationError) unknown = true;
  }
  return unknown ? "unknown" : "noAccess";
}

/**
 * Whether a candidate belongs to "All namespaces" of a restricted user: answered and not refused ("unknown" after a
 * failed review is tried). A candidate not answered yet is left out, so a typed name does not join the scope only to
 * leave it once refused (each move of the scope restarts every watch of "All namespaces").
 */
export function inScope(mark: NamespaceAccess | undefined): boolean {
  return mark !== undefined && mark !== "noAccess";
}

/**
 * What "All namespaces" watches for a user who may not list Namespaces: the found namespaces (by name) and the known
 * ones (in their order) the server answered for and did not say "no" to (`inScope`), at most `MAX_SCOPE_NAMESPACES`;
 * sorted by name.
 */
export function scopeOf(
  known: readonly string[],
  found: ReadonlyMap<string, readonly FoundBy[]>,
  marks: ReadonlyMap<string, NamespaceAccess>,
): string[] {
  const names = candidatesOf(known, found).filter((ns) => inScope(marks.get(ns)));
  return names.slice(0, MAX_SCOPE_NAMESPACES).sort();
}

/** The candidates asked about: the found ones first (by name), then the known ones, at most `MAX_CHECKED_NAMESPACES`. */
export function candidatesOf(known: readonly string[], found: ReadonlyMap<string, readonly FoundBy[]>): string[] {
  return [...new Set([...[...found.keys()].sort(), ...known])].slice(0, MAX_CHECKED_NAMESPACES);
}
