import { describe, expect, it } from "vitest";
import type { AccessAnswer, ReviewResourceRule, RulesReview } from "../../api";
import {
  batches,
  candidatesOf,
  inScope,
  kindAccessIn,
  kindAnswerOf,
  kindQuery,
  MAX_CHECKED_NAMESPACES,
  MAX_SCOPE_NAMESPACES,
  namespaceAccessOf,
  namespaceQuery,
  rulesAllowList,
  scopeOf,
  type FoundBy,
  type KindFacts,
  type NamespaceAccess,
} from "./access";
import { isNamespaceName, MAX_KNOWN_NAMESPACES, withKnown } from "./known";

const answer = (patch: Partial<AccessAnswer>): AccessAnswer => ({
  allowed: false,
  denied: false,
  reason: "",
  evaluationError: "",
  ...patch,
});

const rule = (verbs: string[], apiGroups: string[], resources: string[], resourceNames: string[] = []): ReviewResourceRule => ({
  verbs,
  apiGroups,
  resources,
  resourceNames,
});

const review = (namespace: string, rules: ReviewResourceRule[], incomplete = false): RulesReview => ({
  namespace,
  resourceRules: rules,
  nonResourceRules: [],
  incomplete,
  evaluationError: "",
});

const POD = { kind: { group: "", kind: "Pod" }, plural: "pods", namespaced: true };
const DEPLOY = { kind: { group: "apps", kind: "Deployment" }, plural: "deployments", namespaced: true };
const NODE = { kind: { group: "", kind: "Node" }, plural: "nodes", namespaced: false };

describe("the questions", () => {
  it("asks list pods in a namespace and list of a cluster-scoped kind cluster-wide", () => {
    expect(namespaceQuery("team-a")).toMatchObject({ verb: "list", group: "", resource: "pods", namespace: "team-a" });
    expect(
      kindQuery({ kindRef: { group: "storage.k8s.io", version: "v1", kind: "StorageClass" }, plural: "storageclasses", namespaced: false, verbs: ["list"], printerColumns: [] }),
    ).toMatchObject({ verb: "list", group: "storage.k8s.io", resource: "storageclasses", namespace: "" });
  });

  it("splits questions into calls of at most 64", () => {
    const sizes = batches(Array.from({ length: 150 }, (_, i) => i)).map((b) => b.length);
    expect(sizes).toEqual([64, 64, 22]);
    expect(batches([])).toEqual([]);
  });
});

describe("the API server's answers", () => {
  it.each([
    [answer({ allowed: true }), "accessible", true],
    [answer({ denied: true }), "noAccess", false],
    [answer({}), "noAccess", false],
    [answer({ evaluationError: "webhook down" }), "unknown", null],
    [undefined, "unknown", null],
  ] as const)("%o → %s", (a, mark, kind) => {
    expect(namespaceAccessOf(a)).toBe(mark);
    expect(kindAnswerOf(a)).toBe(kind);
  });
});

describe("rules of a rules review", () => {
  it.each([
    [[rule(["get", "list", "watch"], [""], ["pods"])], "", "pods", true],
    [[rule(["*"], ["*"], ["*"])], "apps", "deployments", true],
    [[rule(["list"], ["apps"], ["*"])], "apps", "deployments", true],
    [[rule(["get", "watch"], [""], ["pods"])], "", "pods", false],
    [[rule(["list"], [""], ["pods"])], "apps", "pods", false],
    [[rule(["list"], ["apps"], ["deployments"], ["web"])], "apps", "deployments", false],
    [[rule(["list"], [""], ["pods/log"])], "", "pods", false],
    [[rule(["create"], ["authorization.k8s.io"], ["selfsubjectaccessreviews"])], "", "pods", false],
  ] as const)("%j grants list %s/%s: %s", (rules, group, plural, allowed) => {
    expect(rulesAllowList(review("ns", [...rules]), group, plural)).toBe(allowed);
  });
});

describe("whether a kind can be listed", () => {
  const facts: KindFacts = {
    clusterKinds: new Map([
      ["/Node", false],
      ["storage.k8s.io/StorageClass", true],
      ["/PersistentVolume", null],
    ]),
    rules: new Map<string, RulesReview | null>([
      ["team-a", review("team-a", [rule(["list"], [""], ["pods"])])],
      ["team-b", review("team-b", [rule(["list"], ["apps"], ["deployments"])])],
      ["webhooked", review("webhooked", [], true)],
      ["failed", null],
    ]),
  };

  it("reads cluster-scoped kinds from their access review", () => {
    expect(kindAccessIn(facts, NODE, ["team-a"])).toBe("noAccess");
    expect(kindAccessIn(facts, { ...NODE, kind: { group: "storage.k8s.io", kind: "StorageClass" } }, null)).toBe("readable");
    expect(kindAccessIn(facts, { ...NODE, kind: { group: "", kind: "PersistentVolume" } }, null)).toBe("unknown");
    expect(kindAccessIn(facts, { ...NODE, kind: { group: "", kind: "Never" } }, null)).toBe("unknown");
  });

  it("is readable when any namespace grants it, no access only when every namespace was reviewed completely", () => {
    expect(kindAccessIn(facts, POD, ["team-a", "team-b"])).toBe("readable");
    expect(kindAccessIn(facts, DEPLOY, ["team-a"])).toBe("noAccess");
    expect(kindAccessIn(facts, DEPLOY, ["team-a", "team-b"])).toBe("readable");
    // An incomplete review, a failed one or a namespace never reviewed cannot say "no".
    expect(kindAccessIn(facts, DEPLOY, ["team-a", "webhooked"])).toBe("unknown");
    expect(kindAccessIn(facts, DEPLOY, ["team-a", "failed"])).toBe("unknown");
    expect(kindAccessIn(facts, DEPLOY, ["team-a", "elsewhere"])).toBe("unknown");
    expect(kindAccessIn(facts, POD, null)).toBe("unknown");
    expect(kindAccessIn(facts, POD, [])).toBe("unknown");
  });
});

describe("the namespaces of “All accessible”", () => {
  const found = new Map<string, FoundBy[]>([
    ["team-c", ["serviceAccount"]],
    ["dev", ["context", "project"]],
  ]);

  it("are the found and the known ones answered and not refused, sorted, at most 20", () => {
    const marks = new Map<string, NamespaceAccess>([
      ["team-b", "noAccess"],
      ["team-a", "accessible"],
      ["team-c", "unknown"],
      ["dev", "accessible"],
    ]);
    expect(scopeOf(["team-b", "team-a", "dev"], found, marks)).toEqual(["dev", "team-a", "team-c"]);
    // A name not answered yet (typed a moment ago) is left out until its answer comes.
    expect(scopeOf(["team-b", "team-a", "dev", "typed"], found, marks)).toEqual(["dev", "team-a", "team-c"]);
    expect(inScope(undefined)).toBe(false);
    expect(inScope("unknown")).toBe(true);
    expect(inScope("noAccess")).toBe(false);
    const many = Array.from({ length: 30 }, (_, i) => `ns-${String(i).padStart(2, "0")}`);
    const scope = scopeOf(many, new Map(), new Map(many.map((ns) => [ns, "accessible" as const])));
    expect(scope).toHaveLength(MAX_SCOPE_NAMESPACES);
    expect(scope[0]).toBe("ns-00");
  });

  it("asks about the found ones first, then the known ones, at most 200", () => {
    expect(candidatesOf(["team-a", "dev"], found)).toEqual(["dev", "team-c", "team-a"]);
    const many = Array.from({ length: 250 }, (_, i) => `ns-${i}`);
    expect(candidatesOf(many, found)).toHaveLength(MAX_CHECKED_NAMESPACES);
  });
});

describe("known namespaces", () => {
  it.each([
    ["team-a", true],
    ["a", true],
    ["a1-b2", true],
    ["Team-A", false],
    ["-a", false],
    ["a-", false],
    ["a.b", false],
    ["a b", false],
    ["", false],
    ["x".repeat(63), true],
    ["x".repeat(64), false],
  ])("%s is a namespace name: %s", (name, ok) => {
    expect(isNamespaceName(name)).toBe(ok);
  });

  it("adds new names at the end, keeps the same list when nothing is new, and drops the oldest past the cap", () => {
    const known = ["a", "b"];
    expect(withKnown(known, ["b", "Bad", "c", "c"])).toEqual(["a", "b", "c"]);
    expect(withKnown(known, ["a"])).toBe(known);
    const full = Array.from({ length: MAX_KNOWN_NAMESPACES }, (_, i) => `ns-${i}`);
    const next = withKnown(full, ["new"]);
    expect(next).toHaveLength(MAX_KNOWN_NAMESPACES);
    expect(next[0]).toBe("ns-1");
    expect(next.at(-1)).toBe("new");
  });
});
