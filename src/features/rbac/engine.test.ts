import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import {
  buildIndex,
  rulesOfReview,
  type ClusterScoped,
  buildMatrix,
  explainRule,
  identityOf,
  knownSubjects,
  MAX_WHO_CAN,
  parseRule,
  permissionsOf,
  ruleCovers,
  selectorMatches,
  subjectApplies,
  whoCan,
  type PolicyRule,
  type RbacData,
  type Subject,
} from "./engine";

const RBAC = "rbac.authorization.k8s.io/v1";

type RawRule = { readonly [K in keyof PolicyRule]?: readonly string[] };

function clusterRole(name: string, rules: RawRule[], extra: Record<string, unknown> = {}, labels?: Record<string, string>): KubeObject {
  return { apiVersion: RBAC, kind: "ClusterRole", metadata: { name, uid: `cr-${name}`, labels }, rules, ...extra };
}

function role(namespace: string, name: string, rules: RawRule[]): KubeObject {
  return { apiVersion: RBAC, kind: "Role", metadata: { name, namespace, uid: `r-${namespace}-${name}` }, rules };
}

type RawSubject = { kind: string; name: string; namespace?: string };

function crb(name: string, roleName: string, subjects: RawSubject[]): KubeObject {
  return {
    apiVersion: RBAC,
    kind: "ClusterRoleBinding",
    metadata: { name, uid: `crb-${name}` },
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: roleName },
    subjects,
  };
}

function rb(namespace: string, name: string, roleKind: "Role" | "ClusterRole", roleName: string, subjects: RawSubject[]): KubeObject {
  return {
    apiVersion: RBAC,
    kind: "RoleBinding",
    metadata: { name, namespace, uid: `rb-${namespace}-${name}` },
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: roleKind, name: roleName },
    subjects,
  };
}

const rule = (r: RawRule): PolicyRule => parseRule(r);

const VIEW_PODS: RawRule = { verbs: ["get", "list", "watch"], apiGroups: [""], resources: ["pods", "pods/log"] };

const DATA: RbacData = {
  clusterRoles: [
    clusterRole("pod-reader", [VIEW_PODS]),
    clusterRole("secret-deleter", [{ verbs: ["delete"], apiGroups: [""], resources: ["secrets"] }]),
    clusterRole("admin-all", [{ verbs: ["*"], apiGroups: ["*"], resources: ["*"] }, { verbs: ["*"], nonResourceURLs: ["*"] }]),
    clusterRole("healthz", [{ verbs: ["get"], nonResourceURLs: ["/healthz", "/metrics/*"] }]),
    clusterRole("scaler", [{ verbs: ["update"], apiGroups: ["*"], resources: ["*/scale"] }]),
  ],
  roles: [
    role("prod", "web-config", [{ verbs: ["get", "update"], apiGroups: [""], resources: ["configmaps"], resourceNames: ["web"] }]),
    role("dev", "exec", [{ verbs: ["create"], apiGroups: [""], resources: ["pods/exec"] }]),
  ],
  clusterRoleBindings: [
    crb("everyone-healthz", "healthz", [{ kind: "Group", name: "system:authenticated" }]),
    crb("ops-admin", "admin-all", [{ kind: "Group", name: "ops" }]),
    crb("ci-scaler", "scaler", [{ kind: "ServiceAccount", name: "ci", namespace: "build" }]),
    crb("dangling", "no-such-role", [{ kind: "User", name: "alice" }]),
  ],
  roleBindings: [
    // A RoleBinding to a ClusterRole grants it only in prod.
    rb("prod", "alice-pods", "ClusterRole", "pod-reader", [{ kind: "User", name: "alice" }]),
    rb("prod", "web-config", "Role", "web-config", [{ kind: "ServiceAccount", name: "web" }]),
    rb("prod", "sa-secrets", "ClusterRole", "secret-deleter", [{ kind: "Group", name: "system:serviceaccounts:prod" }]),
    rb("dev", "alice-exec", "Role", "exec", [{ kind: "User", name: "alice" }]),
    rb("dev", "all-sa", "ClusterRole", "pod-reader", [{ kind: "Group", name: "system:serviceaccounts" }]),
    rb("dev", "missing", "Role", "gone", [{ kind: "User", name: "bob" }]),
    // The SA as a user name.
    rb("dev", "web-as-user", "Role", "exec", [{ kind: "User", name: "system:serviceaccount:prod:web" }]),
  ],
};

const alice: Subject = { kind: "User", name: "alice" };
const webSa: Subject = { kind: "ServiceAccount", name: "web", namespace: "prod" };

describe("ruleCovers (the authorizer's matching)", () => {
  it.each([
    ["exact", VIEW_PODS, { verb: "get", group: "", resource: "pods" }, "full"],
    ["other verb", VIEW_PODS, { verb: "delete", group: "", resource: "pods" }, "none"],
    ["other group", VIEW_PODS, { verb: "get", group: "apps", resource: "pods" }, "none"],
    ["pods does not cover pods/exec", VIEW_PODS, { verb: "get", group: "", resource: "pods", subresource: "exec" }, "none"],
    ["pods/log listed", VIEW_PODS, { verb: "get", group: "", resource: "pods", subresource: "log" }, "full"],
    ["* covers subresources", { verbs: ["*"], apiGroups: ["*"], resources: ["*"] }, { verb: "create", group: "", resource: "pods", subresource: "exec" }, "full"],
    ["*/scale", { verbs: ["update"], apiGroups: ["*"], resources: ["*/scale"] }, { verb: "update", group: "apps", resource: "deployments", subresource: "scale" }, "full"],
    ["*/scale is not the resource", { verbs: ["update"], apiGroups: ["*"], resources: ["*/scale"] }, { verb: "update", group: "apps", resource: "deployments" }, "none"],
    ["names: the named object", { verbs: ["get"], apiGroups: [""], resources: ["configmaps"], resourceNames: ["web"] }, { verb: "get", group: "", resource: "configmaps", name: "web" }, "full"],
    ["names: another object", { verbs: ["get"], apiGroups: [""], resources: ["configmaps"], resourceNames: ["web"] }, { verb: "get", group: "", resource: "configmaps", name: "db" }, "none"],
    ["names: list only by a field selector", { verbs: ["list"], apiGroups: [""], resources: ["configmaps"], resourceNames: ["web"] }, { verb: "list", group: "", resource: "configmaps" }, "names"],
    ["names never allow create", { verbs: ["create"], apiGroups: [""], resources: ["configmaps"], resourceNames: ["web"] }, { verb: "create", group: "", resource: "configmaps", name: "web" }, "none"],
    ["names never allow deletecollection", { verbs: ["*"], apiGroups: [""], resources: ["configmaps"], resourceNames: ["web"] }, { verb: "deletecollection", group: "", resource: "configmaps" }, "none"],
    ["names: any object", { verbs: ["get"], apiGroups: [""], resources: ["configmaps"], resourceNames: ["web"] }, { verb: "get", group: "", resource: "configmaps" }, "names"],
    ["a URL rule covers no resource", { verbs: ["*"], nonResourceURLs: ["*"] }, { verb: "get", group: "", resource: "pods" }, "none"],
  ] as const)("%s", (_name, raw, req, expected) => {
    expect(ruleCovers(rule(raw), req)).toBe(expected);
  });
});

describe("subjects", () => {
  it("a ServiceAccount is its user name and in the implicit groups", () => {
    expect(identityOf(webSa)).toEqual({
      user: "system:serviceaccount:prod:web",
      groups: ["system:serviceaccounts", "system:serviceaccounts:prod", "system:authenticated"],
    });
  });

  it.each([
    ["User", { kind: "User", name: "alice" }, alice, null, true],
    ["another user", { kind: "User", name: "bob" }, alice, null, false],
    ["system:authenticated for a user", { kind: "Group", name: "system:authenticated" }, alice, null, true],
    ["a user's own group", { kind: "Group", name: "ops" }, { kind: "User", name: "carol", groups: ["ops"] }, null, true],
    ["anonymous is unauthenticated", { kind: "Group", name: "system:authenticated" }, { kind: "User", name: "system:anonymous" }, null, false],
    ["SA without namespace in a RoleBinding", { kind: "ServiceAccount", name: "web" }, webSa, "prod", true],
    ["SA without namespace in another namespace", { kind: "ServiceAccount", name: "web" }, webSa, "dev", false],
    ["SA without namespace in a ClusterRoleBinding", { kind: "ServiceAccount", name: "web" }, webSa, null, false],
    ["SA by user name", { kind: "User", name: "system:serviceaccount:prod:web" }, webSa, "dev", true],
    ["SA namespace group", { kind: "Group", name: "system:serviceaccounts:prod" }, webSa, "prod", true],
    ["another namespace's SA group", { kind: "Group", name: "system:serviceaccounts:dev" }, webSa, "prod", false],
    ["Group subject is only that group", { kind: "Group", name: "system:authenticated" }, { kind: "Group", name: "ops" }, null, false],
  ] as const)("%s", (_name, entry, subject, ns, expected) => {
    expect(subjectApplies(entry, identityOf(subject as Subject), ns)).toBe(expected);
  });

  it("lists every subject named by a binding once, SA user names as ServiceAccounts", () => {
    const names = knownSubjects(DATA).map((s) => `${s.kind}:${s.namespace ?? ""}:${s.name}`);
    expect(names).toContain("ServiceAccount:prod:web");
    expect(names.filter((n) => n === "ServiceAccount:prod:web")).toHaveLength(1);
    expect(names).toContain("Group::system:serviceaccounts");
    expect(names[0]).toBe("User::alice");
  });
});

describe("permissionsOf", () => {
  const index = buildIndex(DATA);
  const where = (subject: Subject, ns: string | null) =>
    permissionsOf(index, subject, ns).grants.map((g) => `${g.binding.kind}/${g.binding.name}@${g.scope ?? "*"}`).sort();

  it.each([
    ["alice in prod", alice, "prod", ["ClusterRoleBinding/everyone-healthz@*", "RoleBinding/alice-pods@prod"]],
    ["alice in dev: the prod RoleBinding does not apply", alice, "dev", ["ClusterRoleBinding/everyone-healthz@*", "RoleBinding/alice-exec@dev"]],
    [
      "alice everywhere",
      alice,
      null,
      ["ClusterRoleBinding/everyone-healthz@*", "RoleBinding/alice-exec@dev", "RoleBinding/alice-pods@prod"],
    ],
    [
      "web SA everywhere (implicit groups, SA user name)",
      webSa,
      null,
      [
        "ClusterRoleBinding/everyone-healthz@*",
        "RoleBinding/all-sa@dev",
        "RoleBinding/sa-secrets@prod",
        "RoleBinding/web-as-user@dev",
        "RoleBinding/web-config@prod",
      ],
    ],
    ["group ops", { kind: "Group", name: "ops" } as Subject, "prod", ["ClusterRoleBinding/ops-admin@*", "ClusterRoleBinding/ops-admin@*"]],
  ] as const)("%s", (_name, subject, ns, expected) => {
    expect(where(subject as Subject, ns)).toEqual(expected);
  });

  it("a RoleBinding to a ClusterRole drops its non-resource URLs", () => {
    const data: RbacData = {
      clusterRoles: [clusterRole("mixed", [VIEW_PODS, { verbs: ["get"], nonResourceURLs: ["/healthz"] }])],
      roleBindings: [rb("prod", "m", "ClusterRole", "mixed", [{ kind: "User", name: "alice" }])],
      clusterRoleBindings: [],
      roles: [],
    };
    const grants = permissionsOf(buildIndex(data), alice, "prod").grants;
    expect(grants).toHaveLength(1);
    expect(grants[0]?.rule.resources).toEqual(["pods", "pods/log"]);
  });

  it("warns about a binding whose role does not exist, only when the role list is known", () => {
    const { warnings } = permissionsOf(index, alice, null);
    expect(warnings).toEqual([
      {
        type: "missingRole",
        binding: { kind: "ClusterRoleBinding", name: "dangling", namespace: null },
        role: { kind: "ClusterRole", name: "no-such-role", namespace: null },
      },
    ]);
    const bob = permissionsOf(index, { kind: "User", name: "bob" }, "dev").warnings;
    expect(bob.map((w) => w.role)).toEqual([{ kind: "Role", name: "gone", namespace: "dev" }]);
    const unknown = buildIndex({ ...DATA, clusterRoles: undefined });
    expect(permissionsOf(unknown, alice, null).warnings).toEqual([]);
  });
});

describe("aggregated ClusterRoles", () => {
  const AGG = { "rbac.example.com/aggregate-to-monitoring": "true" };
  const aggregation = { aggregationRule: { clusterRoleSelectors: [{ matchLabels: AGG }] } };
  const sources = [
    clusterRole("mon-pods", [VIEW_PODS], {}, AGG),
    clusterRole("mon-nodes", [{ verbs: ["get"], apiGroups: [""], resources: ["nodes"] }], {}, AGG),
    clusterRole("unrelated", [{ verbs: ["delete"], apiGroups: [""], resources: ["nodes"] }]),
  ];

  it.each([
    ["not aggregated yet: rules come from the sources, pending", [], ["mon-nodes", "mon-pods"], [true, true]],
    [
      "aggregated by the controller: the stored rules, attributed",
      [VIEW_PODS, { verbs: ["get"], apiGroups: [""], resources: ["nodes"] }],
      ["mon-pods", "mon-nodes"],
      [false, false],
    ],
    ["half done: the missing one pending", [VIEW_PODS], ["mon-pods", "mon-nodes"], [false, true]],
  ] as const)("%s", (_name, stored, via, pending) => {
    const data: RbacData = { clusterRoles: [...sources, clusterRole("monitoring", [...stored], aggregation)] };
    const index = buildIndex(data);
    const rules = index.rulesOfRole({ kind: "ClusterRole", name: "monitoring", namespace: null }) ?? [];
    expect(index.aggregatedFrom("monitoring")).toEqual(["mon-nodes", "mon-pods"]);
    expect(rules.map((r) => r.via)).toEqual(via);
    expect(rules.map((r) => r.pending ?? false)).toEqual(pending);
    expect(rules.some((r) => r.rule.verbs.includes("delete"))).toBe(false);
  });

  it("a stored rule no source has stays (the authorizer uses it) without a source", () => {
    const own = { verbs: ["list"], apiGroups: ["apps"], resources: ["deployments"] };
    const index = buildIndex({ clusterRoles: [...sources, clusterRole("monitoring", [own], aggregation)] });
    const rules = index.rulesOfRole({ kind: "ClusterRole", name: "monitoring", namespace: null }) ?? [];
    expect(rules[0]).toEqual({ rule: rule(own) });
    expect(rules).toHaveLength(3);
  });

  it.each([
    ["matchLabels", { matchLabels: { a: "1" } }, { a: "1", b: "2" }, true],
    ["matchLabels miss", { matchLabels: { a: "1" } }, { a: "2" }, false],
    ["In", { matchExpressions: [{ key: "a", operator: "In", values: ["1", "2"] }] }, { a: "2" }, true],
    ["NotIn", { matchExpressions: [{ key: "a", operator: "NotIn", values: ["1"] }] }, { a: "1" }, false],
    ["Exists", { matchExpressions: [{ key: "a", operator: "Exists" }] }, {}, false],
    ["DoesNotExist", { matchExpressions: [{ key: "a", operator: "DoesNotExist" }] }, {}, true],
    ["empty selector", {}, { x: "y" }, true],
  ] as const)("selector %s", (_name, selector, labels, expected) => {
    expect(selectorMatches(selector, labels)).toBe(expected);
  });
});

describe("buildMatrix", () => {
  it("rows per (group, resource), cells with the granting binding, wider rules fill narrower rows", () => {
    const index = buildIndex(DATA);
    const ops = permissionsOf(index, { kind: "Group", name: "ops" }, "prod").grants;
    const alicePerms = permissionsOf(index, alice, "prod").grants;
    const matrix = buildMatrix([...alicePerms, ...ops]);
    expect(matrix.verbs).toEqual(["get", "list", "watch", "create", "update", "patch", "delete", "deletecollection", "*"]);
    const pods = matrix.rows.find((r) => r.group === "" && r.resource === "pods");
    expect(pods?.cells.get("get")?.map((c) => c.grant.binding.name).sort()).toEqual(["alice-pods", "ops-admin"]);
    expect(pods?.cells.get("delete")?.map((c) => c.grant.binding.name)).toEqual(["ops-admin"]);
    expect(matrix.rows[0]).toMatchObject({ group: "*", resource: "*" });
    expect(matrix.urls.map((u) => u.url)).toEqual(["*", "/healthz", "/metrics/*"]);
    expect(matrix.urls.find((u) => u.url === "/healthz")?.cells.get("get")?.length).toBe(2);
  });

  it("marks cells limited to named objects", () => {
    const grants = permissionsOf(buildIndex(DATA), webSa, "prod").grants;
    const cm = buildMatrix(grants).rows.find((r) => r.resource === "configmaps");
    expect(cm?.cells.get("get")?.[0]?.onlyNames).toEqual(["web"]);
    expect(cm?.cells.has("list")).toBe(false);
  });
});

describe("whoCan", () => {
  const index = buildIndex(DATA);
  const who = (q: Parameters<typeof whoCan>[1]) =>
    whoCan(index, q).answers.map((a) => `${a.subject.kind}:${a.subject.namespace ?? ""}:${a.subject.name} via ${a.binding.name}`).sort();

  it.each([
    [
      "delete secrets in prod",
      { verb: "delete", group: "", resource: "secrets", namespace: "prod", clusterScoped: false },
      ["Group::ops via ops-admin", "Group::system:serviceaccounts:prod via sa-secrets"],
    ],
    ["delete secrets in dev", { verb: "delete", group: "", resource: "secrets", namespace: "dev", clusterScoped: false }, ["Group::ops via ops-admin"]],
    [
      "exec into pods in any namespace",
      { verb: "create", group: "", resource: "pods", subresource: "exec", namespace: null, clusterScoped: false },
      ["Group::ops via ops-admin", "ServiceAccount:prod:web via web-as-user", "User::alice via alice-exec"],
    ],
    [
      "nodes are cluster-scoped: RoleBindings do not count",
      { verb: "get", group: "", resource: "nodes", namespace: null, clusterScoped: true },
      ["Group::ops via ops-admin"],
    ],
    ["scale deployments", { verb: "update", group: "apps", resource: "deployments", subresource: "scale", namespace: "x", clusterScoped: false }, ["Group::ops via ops-admin", "ServiceAccount:build:ci via ci-scaler"]],
    ["a URL by prefix", { verb: "get", nonResourceURL: "/metrics/cadvisor" }, ["Group::ops via ops-admin", "Group::system:authenticated via everyone-healthz"]],
  ] as const)("%s", (_name, query, expected) => {
    expect(who(query)).toEqual(expected);
  });

  it("a grant limited to named objects says so", () => {
    const answers = whoCan(index, { verb: "update", group: "", resource: "configmaps", namespace: "prod", clusterScoped: false }).answers;
    expect(answers.find((a) => a.binding.name === "web-config")?.onlyNames).toEqual(["web"]);
  });

  it("stops at the cap", () => {
    const subjects = Array.from({ length: MAX_WHO_CAN + 5 }, (_, i) => ({ kind: "User", name: `u${i}` }));
    const data: RbacData = { clusterRoles: [clusterRole("pod-reader", [VIEW_PODS])], clusterRoleBindings: [crb("many", "pod-reader", subjects)] };
    const result = whoCan(buildIndex(data), { verb: "get", group: "", resource: "pods", namespace: null, clusterScoped: false });
    expect(result.answers).toHaveLength(MAX_WHO_CAN);
    expect(result.truncated).toBe(true);
  });
});

describe("explainRule", () => {
  it.each([
    ["wildcards", { verbs: ["*"], apiGroups: ["*"], resources: ["*"] }, ["allVerbs", "allGroups", "allResources"]],
    ["subresources", { verbs: ["get"], apiGroups: [""], resources: ["pods/exec", "*/scale"] }, ["subresource", "anySubresource"]],
    ["names", { verbs: ["get"], apiGroups: [""], resources: ["secrets"], resourceNames: ["a"] }, ["onlyNames"]],
    ["URLs", { verbs: ["get"], nonResourceURLs: ["*", "/metrics/*"] }, ["allUrls", "urlPrefix"]],
    ["escalation", { verbs: ["bind", "escalate"], apiGroups: ["rbac.authorization.k8s.io"], resources: ["roles"] }, ["escalating"]],
    ["plain", VIEW_PODS, ["subresource"]],
  ] as const)("%s", (_name, raw, keys) => {
    expect(explainRule({ rule: rule(raw) }).map((e) => e.key)).toEqual(keys);
  });

  it("a pending aggregated rule names its source", () => {
    expect(explainRule({ rule: rule(VIEW_PODS), via: "mon", pending: true }).at(-1)).toEqual({ key: "pending", values: { source: "mon" } });
  });
});

describe("review fixes", () => {
  const nodes: RawRule = { verbs: ["get", "list"], apiGroups: [""], resources: ["nodes", "pods"] };
  const nodesOnly: RawRule = { verbs: ["get"], apiGroups: [""], resources: ["nodes", "persistentvolumes"] };
  const scoped: ClusterScoped = (group, resource) => group === "" && (resource === "nodes" || resource === "persistentvolumes");
  const data: RbacData = {
    clusterRoles: [clusterRole("mixed", [nodes]), clusterRole("node-reader", [nodesOnly])],
    roleBindings: [
      rb("prod", "mixed", "ClusterRole", "mixed", [{ kind: "User", name: "alice" }]),
      rb("prod", "nodes", "ClusterRole", "node-reader", [{ kind: "User", name: "alice" }]),
    ],
    clusterRoleBindings: [crb("cluster-nodes", "node-reader", [{ kind: "User", name: "bob" }])],
  };

  it("a RoleBinding to a ClusterRole grants no cluster-scoped resource", () => {
    const index = buildIndex(data);
    const alicePerms = permissionsOf(index, alice, "prod", scoped).grants;
    expect(alicePerms.map((g) => g.binding.name)).toEqual(["mixed"]);
    const rows = buildMatrix(alicePerms, scoped).rows.map((r) => r.resource);
    expect(rows).toEqual(["pods"]);
    // Through a ClusterRoleBinding the same role does grant nodes.
    const bob = buildMatrix(permissionsOf(index, { kind: "User", name: "bob" }, null, scoped).grants, scoped);
    expect(bob.rows.map((r) => r.resource)).toEqual(["nodes", "persistentvolumes"]);
  });

  it("a Role in a namespace whose Roles cannot be read is unknown, not missing", () => {
    const partial: RbacData = {
      roles: [],
      rolesUnreadableIn: ["dev"],
      roleBindings: [rb("dev", "b", "Role", "hidden", [{ kind: "User", name: "alice" }]), rb("qa", "c", "Role", "gone", [{ kind: "User", name: "alice" }])],
      clusterRoleBindings: [],
      clusterRoles: [],
    };
    const warnings = permissionsOf(buildIndex(partial), alice, null).warnings;
    expect(warnings.map((w) => w.role.name)).toEqual(["gone"]);
  });

  it("reads the non-resource rules of a rules review (nonResourceUrls)", () => {
    const rules = rulesOfReview({
      namespace: "default",
      resourceRules: [{ verbs: ["get"], apiGroups: [""], resources: ["pods"], resourceNames: [] }],
      nonResourceRules: [{ verbs: ["get"], nonResourceUrls: ["/healthz", "/metrics"] }],
      incomplete: false,
      evaluationError: "",
    });
    expect(rules[1]).toEqual({ verbs: ["get"], apiGroups: [], resources: [], resourceNames: [], nonResourceURLs: ["/healthz", "/metrics"] });
    const matrix = buildMatrix(rules.map((rule) => ({ rule, role: { kind: "Role", name: "", namespace: "default" }, binding: { kind: "Role", name: "", namespace: "default" }, scope: "default", matchedBy: { kind: "", name: "" } })));
    expect(matrix.urls.map((u) => u.url)).toEqual(["/healthz", "/metrics"]);
    expect(matrix.urls[0]?.cells.has("get")).toBe(true);
  });
});
