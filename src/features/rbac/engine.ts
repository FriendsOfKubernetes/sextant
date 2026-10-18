// The RBAC engine (#140): pure functions over Roles, ClusterRoles, RoleBindings and ClusterRoleBindings as watched,
// with no React and no requests. It mirrors the Kubernetes RBAC authorizer:
//
//   - a rule allows a request when its verbs, API groups and resources match (each by `*` or exactly); `*` in
//     resources also covers every subresource, `*/scale` covers the subresource `scale` of any resource, while `pods`
//     does not cover `pods/exec` or `pods/log`; a rule with `resourceNames` allows only requests naming one of them
//     (so never `list`, `watch` or `create`, which name no object);
//   - a ClusterRoleBinding grants its role everywhere (all namespaces and cluster-scoped resources); a RoleBinding
//     grants its Role, or the ClusterRole it references, only in the binding's own namespace and never cluster-scoped
//     resources or non-resource URLs;
//   - a ServiceAccount subject without a namespace means the binding's namespace; a ServiceAccount is also the user
//     `system:serviceaccount:<ns>:<name>` and a member of the groups `system:serviceaccounts`,
//     `system:serviceaccounts:<ns>` and `system:authenticated`; every authenticated user is in `system:authenticated`;
//   - a ClusterRole with an `aggregationRule` holds the union of the rules of the ClusterRoles its selectors match (the
//     controller writes that union into its `rules`); the engine reads the stored rules and adds any rule of a matched
//     ClusterRole that is not stored yet (`pending`), so a role is right both before and after the controller ran.
//
// What it cannot know: other authorizers (Node, webhook, ABAC) and the group `system:masters`, which bypasses RBAC
// entirely; users and groups are not Kubernetes objects, so a user's groups come from the authenticator, not from here.
// For the current user the API server's own answer (`api.rbac`, SelfSubjectAccessReview) is authoritative.
import type { KubeObject, RulesReview } from "../../api";
import { status } from "../../resources";

const { arr, get, record, str } = status;

export const RBAC_GROUP = "rbac.authorization.k8s.io";
export const SERVICE_ACCOUNT_PREFIX = "system:serviceaccount:";
export const AUTHENTICATED = "system:authenticated";
export const UNAUTHENTICATED = "system:unauthenticated";
export const ANONYMOUS = "system:anonymous";
export const ALL_SERVICE_ACCOUNTS = "system:serviceaccounts";
export const MASTERS = "system:masters";
/** Verbs the matrix always shows, in this order; other verbs found in rules follow. */
export const STANDARD_VERBS = ["get", "list", "watch", "create", "update", "patch", "delete", "deletecollection"] as const;
/** Verbs that let a subject gain more than it was given. */
export const ESCALATING_VERBS = ["escalate", "bind", "impersonate"] as const;
/** At most this many rows in a matrix; more are cut (`truncated`). */
export const MAX_MATRIX_ROWS = 500;
/** At most this many answers to a reverse query; more are cut (`truncated`). */
export const MAX_WHO_CAN = 1000;

export type SubjectKind = "User" | "Group" | "ServiceAccount";

/** Whose permissions to compute. */
export interface Subject {
  kind: SubjectKind;
  name: string;
  /** The ServiceAccount's namespace. */
  namespace?: string;
  /** Groups a User is in (from the authenticator; Kubernetes does not store them). */
  groups?: readonly string[];
}

export interface PolicyRule {
  verbs: string[];
  apiGroups: string[];
  resources: string[];
  resourceNames: string[];
  nonResourceURLs: string[];
}

export type RbacKind = "Role" | "ClusterRole" | "RoleBinding" | "ClusterRoleBinding";

export interface RbacRef {
  kind: RbacKind;
  name: string;
  /** `null` for ClusterRoles and ClusterRoleBindings. */
  namespace: string | null;
}

/** A subject as a binding lists it. */
export interface BindingSubject {
  kind: string;
  name: string;
  /** As written; a ServiceAccount without one in a RoleBinding means the binding's namespace. */
  namespace?: string;
}

/** A rule of a role and, for an aggregated ClusterRole, the ClusterRole it came from. */
export interface SourcedRule {
  rule: PolicyRule;
  /** The ClusterRole an aggregated rule came from. */
  via?: string;
  /** Aggregated from `via` but not in the role's stored rules yet (the controller has not run). */
  pending?: boolean;
}

/** One rule a subject holds, and through what. */
export interface Grant extends SourcedRule {
  role: RbacRef;
  binding: RbacRef;
  /** The only namespace it applies in; `null` for a ClusterRoleBinding (everywhere). */
  scope: string | null;
  /** The binding's subject entry that matched (the subject itself, or a group it is in). */
  matchedBy: BindingSubject;
}

export interface RbacWarning {
  type: "missingRole";
  binding: RbacRef;
  role: RbacRef;
}

/** The watched objects; a list that is unknown (forbidden, loading) is `undefined`. */
export interface RbacData {
  roles?: readonly KubeObject[];
  clusterRoles?: readonly KubeObject[];
  roleBindings?: readonly KubeObject[];
  clusterRoleBindings?: readonly KubeObject[];
  /** Namespaces whose Roles could not be read (a partial list): a Role there is unknown, not missing. */
  rolesUnreadableIn?: readonly string[];
}

/**
 * Whether a resource (plural, in an API group; `*` for every group) is cluster-scoped, from discovery. A RoleBinding
 * never grants a cluster-scoped resource, even through a ClusterRole that names it.
 */
export type ClusterScoped = (group: string, resource: string) => boolean;

const notClusterScoped: ClusterScoped = () => false;

const strings = (value: unknown): string[] => arr(value).filter((v): v is string => typeof v === "string");

export function parseRule(raw: unknown): PolicyRule {
  return {
    verbs: strings(get(raw, "verbs")),
    apiGroups: strings(get(raw, "apiGroups")),
    resources: strings(get(raw, "resources")),
    resourceNames: strings(get(raw, "resourceNames")),
    nonResourceURLs: strings(get(raw, "nonResourceURLs")),
  };
}

export const rulesOf = (obj: KubeObject): PolicyRule[] => arr(get(obj, "rules")).map(parseRule);

const ruleKey = (r: PolicyRule) =>
  JSON.stringify([r.verbs, r.apiGroups, r.resources, r.resourceNames, r.nonResourceURLs]);

export function subjectsOf(binding: KubeObject): BindingSubject[] {
  return arr(get(binding, "subjects")).flatMap((s) => {
    const kind = str(get(s, "kind"));
    const name = str(get(s, "name"));
    if (!kind || !name) return [];
    const namespace = str(get(s, "namespace"));
    return [namespace ? { kind, name, namespace } : { kind, name }];
  });
}

export function roleRefOf(binding: KubeObject): RbacRef | undefined {
  const kind = str(get(binding, "roleRef", "kind"));
  const name = str(get(binding, "roleRef", "name"));
  if (!name || (kind !== "Role" && kind !== "ClusterRole")) return undefined;
  return { kind, name, namespace: kind === "Role" ? (binding.metadata?.namespace ?? null) : null };
}

export function refOf(obj: KubeObject): RbacRef {
  const kind = (obj.kind ?? "") as RbacKind;
  return { kind, name: obj.metadata?.name ?? "", namespace: obj.metadata?.namespace ?? null };
}

// ---------- Label selectors (aggregation) ----------

/** Whether `labels` match a Kubernetes LabelSelector; an empty selector matches everything. */
export function selectorMatches(selector: unknown, labels: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(record(get(selector, "matchLabels")))) {
    if (labels[key] !== value) return false;
  }
  for (const expr of arr(get(selector, "matchExpressions"))) {
    const key = str(get(expr, "key")) ?? "";
    const values = strings(get(expr, "values"));
    const has = Object.hasOwn(labels, key);
    const value = labels[key];
    switch (str(get(expr, "operator"))) {
      case "In":
        if (!has || !values.includes(String(value))) return false;
        break;
      case "NotIn":
        if (has && values.includes(String(value))) return false;
        break;
      case "Exists":
        if (!has) return false;
        break;
      case "DoesNotExist":
        if (has) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

// ---------- Index ----------

export interface RbacIndex {
  data: RbacData;
  /** The rules of a role (aggregation resolved); `undefined` when it does not exist (or its list is unknown). */
  rulesOfRole(ref: RbacRef): SourcedRule[] | undefined;
  /** Whether a role is known to be missing (its list is known and it is not in it). */
  isMissing(ref: RbacRef): boolean;
  /** The ClusterRoles an aggregated ClusterRole takes rules from (by name, sorted). */
  aggregatedFrom(name: string): string[];
  role(ref: RbacRef): KubeObject | undefined;
}

export function buildIndex(data: RbacData): RbacIndex {
  const clusterRoles = new Map<string, KubeObject>();
  for (const r of data.clusterRoles ?? []) clusterRoles.set(r.metadata?.name ?? "", r);
  const roles = new Map<string, KubeObject>();
  for (const r of data.roles ?? []) roles.set(`${r.metadata?.namespace ?? ""}/${r.metadata?.name ?? ""}`, r);
  const cache = new Map<string, SourcedRule[]>();
  const sources = new Map<string, string[]>();

  const role = (ref: RbacRef) =>
    ref.kind === "ClusterRole" ? clusterRoles.get(ref.name) : roles.get(`${ref.namespace ?? ""}/${ref.name}`);

  const aggregatedFrom = (name: string): string[] => {
    const cached = sources.get(name);
    if (cached) return cached;
    const obj = clusterRoles.get(name);
    const selectors = arr(get(obj, "aggregationRule", "clusterRoleSelectors"));
    const found = new Set<string>();
    if (obj && selectors.length > 0) {
      for (const selector of selectors) {
        for (const [other, candidate] of clusterRoles) {
          if (other === name) continue; // as the controller does
          if (selectorMatches(selector, record(candidate.metadata?.labels))) found.add(other);
        }
      }
    }
    const list = [...found].sort();
    sources.set(name, list);
    return list;
  };

  const clusterRoleRules = (name: string): SourcedRule[] | undefined => {
    const obj = clusterRoles.get(name);
    if (!obj) return undefined;
    const cached = cache.get(name);
    if (cached) return cached;
    const own = rulesOf(obj);
    const from = aggregatedFrom(name);
    // Where each aggregated rule came from (the first source by name, as the controller adds them).
    const origin = new Map<string, string>();
    const aggregated: PolicyRule[] = [];
    for (const source of from) {
      for (const rule of rulesOf(clusterRoles.get(source) ?? {})) {
        const key = ruleKey(rule);
        if (origin.has(key)) continue;
        origin.set(key, source);
        aggregated.push(rule);
      }
    }
    const ownKeys = new Set(own.map(ruleKey));
    const result: SourcedRule[] = own.map((rule) => {
      const via = origin.get(ruleKey(rule));
      return via ? { rule, via } : { rule };
    });
    for (const rule of aggregated) {
      if (!ownKeys.has(ruleKey(rule))) result.push({ rule, via: origin.get(ruleKey(rule)), pending: true });
    }
    cache.set(name, result);
    return result;
  };

  return {
    data,
    role,
    aggregatedFrom,
    rulesOfRole(ref) {
      if (ref.kind === "ClusterRole") return clusterRoleRules(ref.name);
      const obj = role(ref);
      return obj ? rulesOf(obj).map((rule) => ({ rule })) : undefined;
    },
    isMissing(ref) {
      const list = ref.kind === "ClusterRole" ? data.clusterRoles : data.roles;
      if (ref.kind === "Role" && ref.namespace !== null && data.rolesUnreadableIn?.includes(ref.namespace)) return false;
      return list !== undefined && role(ref) === undefined;
    },
  };
}

// ---------- Subjects ----------

/** The user name and groups the authorizer sees for a subject. */
export interface Identity {
  user?: string;
  groups: string[];
}

export function identityOf(subject: Subject): Identity {
  switch (subject.kind) {
    case "ServiceAccount": {
      const ns = subject.namespace ?? "";
      return {
        user: `${SERVICE_ACCOUNT_PREFIX}${ns}:${subject.name}`,
        groups: [ALL_SERVICE_ACCOUNTS, `${ALL_SERVICE_ACCOUNTS}:${ns}`, AUTHENTICATED],
      };
    }
    case "User": {
      const implicit = subject.name === ANONYMOUS ? UNAUTHENTICATED : AUTHENTICATED;
      return { user: subject.name, groups: [...new Set([...(subject.groups ?? []), implicit])] };
    }
    case "Group":
      return { groups: [subject.name] };
  }
}

/** Whether a binding's subject entry applies to `identity` (`bindingNamespace`: `null` for a ClusterRoleBinding). */
export function subjectApplies(entry: BindingSubject, identity: Identity, bindingNamespace: string | null): boolean {
  switch (entry.kind) {
    case "User":
      return identity.user !== undefined && identity.user === entry.name;
    case "Group":
      return identity.groups.includes(entry.name);
    case "ServiceAccount": {
      const ns = entry.namespace || bindingNamespace;
      return !!ns && identity.user === `${SERVICE_ACCOUNT_PREFIX}${ns}:${entry.name}`;
    }
    default:
      return false;
  }
}

/** The subject a `system:serviceaccount:<ns>:<name>` user name stands for, else the User. */
export function subjectOfEntry(entry: BindingSubject, bindingNamespace: string | null): Subject {
  if (entry.kind === "ServiceAccount") {
    return { kind: "ServiceAccount", name: entry.name, namespace: entry.namespace || bindingNamespace || "" };
  }
  if (entry.kind === "User" && entry.name.startsWith(SERVICE_ACCOUNT_PREFIX)) {
    const [ns, name] = entry.name.slice(SERVICE_ACCOUNT_PREFIX.length).split(":");
    if (ns && name) return { kind: "ServiceAccount", name, namespace: ns };
  }
  return { kind: entry.kind === "Group" ? "Group" : "User", name: entry.name };
}

export const subjectKey = (s: Subject) => `${s.kind}:${s.namespace ?? ""}:${s.name}`;

/** Every subject named by a binding, deduplicated and sorted (for the picker). */
export function knownSubjects(data: RbacData): Subject[] {
  const found = new Map<string, Subject>();
  const add = (binding: KubeObject) => {
    for (const entry of subjectsOf(binding)) {
      const subject = subjectOfEntry(entry, binding.metadata?.namespace ?? null);
      found.set(subjectKey(subject), subject);
    }
  };
  for (const b of data.clusterRoleBindings ?? []) add(b);
  for (const b of data.roleBindings ?? []) add(b);
  const order: Record<SubjectKind, number> = { User: 0, Group: 1, ServiceAccount: 2 };
  return [...found.values()].sort(
    (a, b) =>
      order[a.kind] - order[b.kind] ||
      (a.namespace ?? "").localeCompare(b.namespace ?? "") ||
      a.name.localeCompare(b.name),
  );
}

// ---------- Effective permissions ----------

export interface Permissions {
  grants: Grant[];
  warnings: RbacWarning[];
}

/** Whether every resource a rule names is cluster-scoped (so a RoleBinding grants nothing of it). */
function onlyClusterScoped(rule: PolicyRule, clusterScoped: ClusterScoped): boolean {
  return rule.resources.every((r) => {
    const [resource] = splitResource(r);
    return resource !== "*" && rule.apiGroups.every((g) => clusterScoped(g, resource));
  });
}

/**
 * The rules `subject` holds: everywhere through ClusterRoleBindings, and through the RoleBindings of `namespace` (or
 * of every namespace for `null`, each grant scoped to its binding's namespace). A RoleBinding grants only namespaced
 * resources: a rule that names only cluster-scoped ones (`clusterScoped`, from discovery) is left out.
 */
export function permissionsOf(
  index: RbacIndex,
  subject: Subject,
  namespace: string | null,
  clusterScoped: ClusterScoped = notClusterScoped,
): Permissions {
  const identity = identityOf(subject);
  const grants: Grant[] = [];
  const warnings: RbacWarning[] = [];
  const visit = (binding: KubeObject, scope: string | null) => {
    const matchedBy = subjectsOf(binding).find((entry) => subjectApplies(entry, identity, scope));
    if (!matchedBy) return;
    const role = roleRefOf(binding);
    if (!role) return;
    const rules = index.rulesOfRole(role);
    if (!rules) {
      if (index.isMissing(role)) warnings.push({ type: "missingRole", binding: refOf(binding), role });
      return;
    }
    for (const rule of rules) {
      // A RoleBinding cannot grant non-resource URLs: only the resource part of a rule counts there.
      if (scope !== null && rule.rule.resources.length === 0) continue;
      if (scope !== null && onlyClusterScoped(rule.rule, clusterScoped)) continue;
      grants.push({ ...rule, role, binding: refOf(binding), scope, matchedBy });
    }
  };
  for (const b of index.data.clusterRoleBindings ?? []) visit(b, null);
  for (const b of index.data.roleBindings ?? []) {
    const ns = b.metadata?.namespace ?? "";
    if (namespace === null || ns === namespace) visit(b, ns);
  }
  return { grants, warnings };
}

// ---------- Matching ----------

const matchesValue = (values: readonly string[], value: string) => values.includes("*") || values.includes(value);

// The authorizer's resource match: `*`, `resource[/subresource]` exactly, or `*/subresource`.
export function resourceMatches(rule: PolicyRule, resource: string, subresource = ""): boolean {
  const combined = subresource ? `${resource}/${subresource}` : resource;
  return rule.resources.some(
    (r) => r === "*" || r === combined || (subresource !== "" && r === `*/${subresource}`),
  );
}

/** The authorizer's non-resource URL match: `*`, exact, or a prefix ending in `*`. */
export function urlMatches(rule: PolicyRule, url: string): boolean {
  return rule.nonResourceURLs.some(
    (u) => u === "*" || u === url || (u.endsWith("*") && url.startsWith(u.slice(0, -1))),
  );
}

export interface ResourceRequest {
  verb: string;
  group: string;
  resource: string;
  subresource?: string;
  /** One object's name; none for any object (`list`, `create`, "all secrets"). */
  name?: string;
}

/**
 * How a rule covers a request: `full`, `names` (only the objects in `resourceNames`, while the request names none),
 * or `none`. As in Kubernetes, `resourceNames` cannot restrict `create` or `deletecollection` (they name no object),
 * so a rule with names never allows them; `list` and `watch` only with a field selector naming one of the objects.
 */
export function ruleCovers(rule: PolicyRule, req: ResourceRequest): "full" | "names" | "none" {
  if (rule.resources.length === 0) return "none";
  if (!matchesValue(rule.verbs, req.verb) || !matchesValue(rule.apiGroups, req.group)) return "none";
  if (!resourceMatches(rule, req.resource, req.subresource ?? "")) return "none";
  if (rule.resourceNames.length === 0) return "full";
  if (req.verb === "create" || req.verb === "deletecollection") return "none";
  if (req.name) return rule.resourceNames.includes(req.name) ? "full" : "none";
  return "names";
}

// ---------- Matrix ----------

export interface MatrixCell {
  grant: Grant;
  /** The grant covers only these objects. */
  onlyNames?: string[];
}

export interface MatrixRow {
  key: string;
  /** API group (`""` core, `"*"` all). */
  group: string;
  // `pods`, `pods/exec`, `*`, `*/scale`.
  resource: string;
  /** By verb (a column), the grants that allow it. */
  cells: Map<string, MatrixCell[]>;
}

export interface UrlRow {
  url: string;
  cells: Map<string, MatrixCell[]>;
}

export interface Matrix {
  verbs: string[];
  rows: MatrixRow[];
  urls: UrlRow[];
  truncated: boolean;
}

function splitResource(resource: string): [string, string] {
  const slash = resource.indexOf("/");
  return slash < 0 ? [resource, ""] : [resource.slice(0, slash), resource.slice(slash + 1)];
}

/** Columns: the standard verbs, then other verbs the rules name, then `*` when a rule names every verb. */
function verbColumns(grants: readonly Grant[]): string[] {
  const extra = new Set<string>();
  let all = false;
  for (const g of grants) {
    for (const v of g.rule.verbs) {
      if (v === "*") all = true;
      else if (!(STANDARD_VERBS as readonly string[]).includes(v)) extra.add(v);
    }
  }
  return [...STANDARD_VERBS, ...[...extra].sort(), ...(all ? ["*"] : [])];
}

/**
 * Verbs × resources: a row for each (API group, resource) any grant names, each cell the grants allowing that verb on
 * it, including wider ones (a `*` rule fills every row). Non-resource URLs get rows of their own. A grant through a
 * RoleBinding fills no row of a cluster-scoped resource (`clusterScoped`); a row nothing fills is left out.
 */
export function buildMatrix(grants: readonly Grant[], clusterScoped: ClusterScoped = notClusterScoped): Matrix {
  const verbs = verbColumns(grants);
  const rowKeys = new Map<string, { group: string; resource: string }>();
  const urls = new Set<string>();
  for (const g of grants) {
    for (const group of g.rule.apiGroups) {
      for (const resource of g.rule.resources) rowKeys.set(`${group}|${resource}`, { group, resource });
    }
    for (const url of g.rule.nonResourceURLs) if (g.rule.resources.length === 0) urls.add(url);
  }
  const sorted = [...rowKeys.entries()].sort(
    ([, a], [, b]) =>
      Number(b.group === "*") - Number(a.group === "*") ||
      a.group.localeCompare(b.group) ||
      Number(b.resource === "*") - Number(a.resource === "*") ||
      a.resource.localeCompare(b.resource),
  );
  const filled: MatrixRow[] = sorted.map(([key, { group, resource }]) => {
    const [res, sub] = splitResource(resource);
    const scoped = res !== "*" && clusterScoped(group, res);
    const cells = new Map<string, MatrixCell[]>();
    for (const verb of verbs) {
      const list: MatrixCell[] = [];
      for (const grant of grants) {
        if (scoped && grant.binding.kind === "RoleBinding") continue;
        const covers = ruleCovers(grant.rule, { verb, group, resource: res, subresource: sub });
        if (covers === "full") list.push({ grant });
        else if (covers === "names") list.push({ grant, onlyNames: grant.rule.resourceNames });
      }
      if (list.length > 0) cells.set(verb, list);
    }
    return { key, group, resource, cells };
  });
  const nonEmpty = filled.filter((r) => r.cells.size > 0);
  const truncated = nonEmpty.length > MAX_MATRIX_ROWS;
  const rows = nonEmpty.slice(0, MAX_MATRIX_ROWS);
  const urlRows: UrlRow[] = [...urls].sort().map((url) => {
    const cells = new Map<string, MatrixCell[]>();
    for (const verb of verbs) {
      const list = grants
        .filter((g) => g.rule.resources.length === 0 && matchesValue(g.rule.verbs, verb) && urlMatches(g.rule, url))
        .map((grant) => ({ grant }));
      if (list.length > 0) cells.set(verb, list);
    }
    return { url, cells };
  });
  return { verbs, rows, urls: urlRows, truncated };
}

/** The rules of an API server's rules review, in the shape of RBAC rules. */
export function rulesOfReview(review: RulesReview): PolicyRule[] {
  return [
    ...review.resourceRules.map((r) => ({
      verbs: [...r.verbs],
      apiGroups: [...r.apiGroups],
      resources: [...r.resources],
      resourceNames: [...r.resourceNames],
      nonResourceURLs: [],
    })),
    ...review.nonResourceRules.map((r) => ({
      verbs: [...r.verbs],
      apiGroups: [],
      resources: [],
      resourceNames: [],
      nonResourceURLs: [...r.nonResourceUrls],
    })),
  ];
}

/** Grants made from the API server's rules review (no bindings: it does not say which granted what). */
export function grantsOfReview(rules: readonly PolicyRule[], namespace: string): Grant[] {
  const none: RbacRef = { kind: "Role", name: "", namespace };
  return rules.map((rule) => ({ rule, role: none, binding: none, scope: namespace, matchedBy: { kind: "", name: "" } }));
}

// ---------- Reverse query ----------

export type WhoCanQuery =
  | (ResourceRequest & {
      /** `null` for any namespace. */
      namespace: string | null;
      /** A cluster-scoped resource (Nodes, Namespaces): only ClusterRoleBindings can grant it. */
      clusterScoped: boolean;
    })
  | { verb: string; nonResourceURL: string };

export interface WhoCanAnswer extends SourcedRule {
  subject: Subject;
  /** The binding's entry (a group, when the subject is one). */
  entry: BindingSubject;
  binding: RbacRef;
  role: RbacRef;
  scope: string | null;
  onlyNames?: string[];
}

export interface WhoCanResult {
  answers: WhoCanAnswer[];
  warnings: RbacWarning[];
  truncated: boolean;
}

/** Who may perform the request, and the binding and role that grant it (one answer per subject, binding and rule). */
export function whoCan(index: RbacIndex, query: WhoCanQuery): WhoCanResult {
  const answers: WhoCanAnswer[] = [];
  const warnings: RbacWarning[] = [];
  let truncated = false;
  const covers = (rule: PolicyRule): "full" | "names" | "none" => {
    if ("nonResourceURL" in query) {
      return rule.resources.length === 0 && matchesValue(rule.verbs, query.verb) && urlMatches(rule, query.nonResourceURL)
        ? "full"
        : "none";
    }
    return ruleCovers(rule, query);
  };
  const visit = (binding: KubeObject, scope: string | null) => {
    const role = roleRefOf(binding);
    if (!role) return;
    const rules = index.rulesOfRole(role);
    if (!rules) {
      if (index.isMissing(role)) warnings.push({ type: "missingRole", binding: refOf(binding), role });
      return;
    }
    const entries = subjectsOf(binding);
    for (const sourced of rules) {
      const how = covers(sourced.rule);
      if (how === "none") continue;
      for (const entry of entries) {
        if (answers.length >= MAX_WHO_CAN) {
          truncated = true;
          return;
        }
        answers.push({
          ...sourced,
          subject: subjectOfEntry(entry, scope),
          entry,
          binding: refOf(binding),
          role,
          scope,
          ...(how === "names" ? { onlyNames: sourced.rule.resourceNames } : {}),
        });
      }
    }
  };
  for (const b of index.data.clusterRoleBindings ?? []) visit(b, null);
  const namespaced = !("nonResourceURL" in query) && !query.clusterScoped;
  if (namespaced) {
    for (const b of index.data.roleBindings ?? []) {
      const ns = b.metadata?.namespace ?? "";
      if (query.namespace === null || ns === query.namespace) visit(b, ns);
    }
  }
  return { answers, warnings, truncated };
}

// ---------- Explanations ----------

/** One plain-language note about a rule: an i18n key under `rbac:explain` and its values. */
export interface Explanation {
  key:
    | "allVerbs"
    | "allGroups"
    | "allResources"
    | "anySubresource"
    | "subresource"
    | "onlyNames"
    | "allUrls"
    | "urlPrefix"
    | "escalating"
    | "pending";
  values?: Record<string, string>;
  /** Names or verbs the note lists (`{{list}}`, joined in the UI language). */
  list?: string[];
}

/** What a rule's wildcards, subresources, names and dangerous verbs mean. */
export function explainRule(rule: SourcedRule): Explanation[] {
  const { verbs, apiGroups, resources, resourceNames, nonResourceURLs } = rule.rule;
  const out: Explanation[] = [];
  if (verbs.includes("*")) out.push({ key: "allVerbs" });
  if (apiGroups.includes("*")) out.push({ key: "allGroups" });
  if (resources.includes("*")) out.push({ key: "allResources" });
  for (const r of resources) {
    if (r.startsWith("*/")) out.push({ key: "anySubresource", values: { subresource: r.slice(2) } });
    else if (r.includes("/")) {
      const [resource, subresource] = splitResource(r);
      out.push({ key: "subresource", values: { resource, subresource } });
    }
  }
  if (resourceNames.length > 0) out.push({ key: "onlyNames", list: resourceNames });
  if (nonResourceURLs.includes("*")) out.push({ key: "allUrls" });
  for (const u of nonResourceURLs) {
    if (u !== "*" && u.endsWith("*")) out.push({ key: "urlPrefix", values: { prefix: u.slice(0, -1) } });
  }
  const escalating = (ESCALATING_VERBS as readonly string[]).filter((v) => verbs.includes(v));
  if (escalating.length > 0) out.push({ key: "escalating", list: escalating });
  if (rule.pending) out.push({ key: "pending", values: { source: rule.via ?? "" } });
  return out;
}

/** The bindings that reference a role (RoleBindings of its namespace for a Role; every binding for a ClusterRole). */
export function bindingsOfRole(data: RbacData, ref: RbacRef): KubeObject[] {
  const refers = (b: KubeObject) => {
    const r = roleRefOf(b);
    return !!r && r.kind === ref.kind && r.name === ref.name && (ref.kind === "ClusterRole" || r.namespace === ref.namespace);
  };
  const cluster = ref.kind === "ClusterRole" ? (data.clusterRoleBindings ?? []).filter(refers) : [];
  return [...cluster, ...(data.roleBindings ?? []).filter(refers)];
}
