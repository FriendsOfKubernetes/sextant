import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import { indexPods, labelSelector, mapSelector, matches, podSelectorOf, selectPods, type Labels } from "./selectors";

const WEB: Labels = { app: "web", tier: "frontend", env: "prod" };

describe("label selectors", () => {
  const cases: [string, unknown, Labels, boolean][] = [
    ["matchLabels equal", { matchLabels: { app: "web" } }, WEB, true],
    ["matchLabels differ", { matchLabels: { app: "api" } }, WEB, false],
    ["matchLabels key absent", { matchLabels: { team: "a" } }, WEB, false],
    ["In hit", { matchExpressions: [{ key: "env", operator: "In", values: ["prod", "stage"] }] }, WEB, true],
    ["In miss", { matchExpressions: [{ key: "env", operator: "In", values: ["dev"] }] }, WEB, false],
    ["In on a missing key", { matchExpressions: [{ key: "team", operator: "In", values: ["a"] }] }, WEB, false],
    ["NotIn hit", { matchExpressions: [{ key: "env", operator: "NotIn", values: ["dev"] }] }, WEB, true],
    ["NotIn miss", { matchExpressions: [{ key: "env", operator: "NotIn", values: ["prod"] }] }, WEB, false],
    ["NotIn on a missing key matches", { matchExpressions: [{ key: "team", operator: "NotIn", values: ["a"] }] }, WEB, true],
    ["Exists", { matchExpressions: [{ key: "tier", operator: "Exists" }] }, WEB, true],
    ["Exists miss", { matchExpressions: [{ key: "team", operator: "Exists" }] }, WEB, false],
    ["DoesNotExist", { matchExpressions: [{ key: "team", operator: "DoesNotExist" }] }, WEB, true],
    ["DoesNotExist miss", { matchExpressions: [{ key: "app", operator: "DoesNotExist" }] }, WEB, false],
    ["unknown operator fails closed", { matchExpressions: [{ key: "app", operator: "Gt", values: ["1"] }] }, WEB, false],
    [
      "labels and expressions together",
      { matchLabels: { app: "web" }, matchExpressions: [{ key: "env", operator: "In", values: ["prod"] }] },
      WEB,
      true,
    ],
    ["empty selector selects everything", {}, WEB, true],
    ["empty selector selects unlabelled", {}, {}, true],
    ["null selects nothing", null, WEB, false],
    ["undefined selects nothing", undefined, WEB, false],
  ];
  it.each(cases)("%s", (_name, selector, labels, expected) => {
    expect(matches(labelSelector(selector), labels)).toBe(expected);
  });

  it("a map selector selects by equality; an empty or missing map selects nothing", () => {
    expect(matches(mapSelector({ app: "web" }), WEB)).toBe(true);
    expect(matches(mapSelector({ app: "web", env: "dev" }), WEB)).toBe(false);
    expect(matches(mapSelector({}), WEB)).toBe(false);
    expect(matches(mapSelector(undefined), WEB)).toBe(false);
  });
});

describe("empty selectors per kind", () => {
  const SERVICE = { group: "", kind: "Service" };
  const NETPOL = { group: "networking.k8s.io", kind: "NetworkPolicy" };
  const PDB_V1 = { group: "policy", version: "v1", kind: "PodDisruptionBudget" };
  const PDB_BETA = { group: "policy", version: "v1beta1", kind: "PodDisruptionBudget" };
  const cases: [string, { group: string; kind: string; version?: string }, KubeObject, Labels, boolean][] = [
    ["Service with an empty selector selects nothing", SERVICE, { spec: { selector: {} } }, WEB, false],
    ["Service without a selector selects nothing", SERVICE, { spec: {} }, WEB, false],
    ["Service selects by its map", SERVICE, { spec: { selector: { app: "web" } } }, WEB, true],
    ["ExternalName Service selects nothing", SERVICE, { spec: { type: "ExternalName", selector: { app: "web" } } }, WEB, false],
    ["NetworkPolicy with an empty podSelector selects every pod", NETPOL, { spec: { podSelector: {} } }, WEB, true],
    ["NetworkPolicy without a podSelector selects every pod", NETPOL, { spec: {} }, {}, true],
    ["NetworkPolicy selects by its podSelector", NETPOL, { spec: { podSelector: { matchLabels: { app: "api" } } } }, WEB, false],
    ["PDB policy/v1 with an empty selector selects every pod", PDB_V1, { spec: { selector: {} } }, WEB, true],
    ["PDB policy/v1 without a selector selects nothing", PDB_V1, { spec: {} }, WEB, false],
    ["PDB policy/v1beta1 with an empty selector selects nothing", PDB_BETA, { spec: { selector: {} } }, WEB, false],
    [
      "PDB version read from the object when the kind has none",
      { group: "policy", kind: "PodDisruptionBudget" },
      { apiVersion: "policy/v1beta1", spec: { selector: {} } },
      WEB,
      false,
    ],
    ["PDB selects with matchExpressions", PDB_V1, { spec: { selector: { matchExpressions: [{ key: "app", operator: "In", values: ["web"] }] } } }, WEB, true],
  ];
  it.each(cases)("%s", (_name, kind, obj, labels, expected) => {
    const selector = podSelectorOf(kind, obj);
    expect(selector).not.toBeNull();
    expect(matches(selector!, labels)).toBe(expected);
  });

  it("other kinds do not select pods by labels", () => {
    expect(podSelectorOf({ group: "apps", kind: "Deployment" }, { spec: { selector: {} } })).toBeNull();
  });
});

describe("pod index", () => {
  const pod = (name: string, namespace: string, labels: Record<string, string>): KubeObject => ({
    metadata: { name, namespace, labels },
  });
  const pods = [
    pod("web-1", "shop", { app: "web" }),
    pod("web-2", "shop", { app: "web", canary: "true" }),
    pod("api-1", "shop", { app: "api" }),
    pod("web-x", "other", { app: "web" }),
  ];
  const index = indexPods(pods);
  const names = (list: KubeObject[]) => list.map((p) => p.metadata?.name).sort();

  it("selects within the namespace only", () => {
    expect(names(selectPods(index, "shop", mapSelector({ app: "web" })))).toEqual(["web-1", "web-2"]);
  });
  it("narrows by matchLabels and checks the expressions", () => {
    const selector = labelSelector({ matchLabels: { app: "web" }, matchExpressions: [{ key: "canary", operator: "DoesNotExist" }] });
    expect(names(selectPods(index, "shop", selector))).toEqual(["web-1"]);
  });
  it("an expressions-only selector scans the namespace", () => {
    const selector = labelSelector({ matchExpressions: [{ key: "app", operator: "NotIn", values: ["web"] }] });
    expect(names(selectPods(index, "shop", selector))).toEqual(["api-1"]);
  });
  it("everything and nothing", () => {
    expect(selectPods(index, "shop", labelSelector({}))).toHaveLength(3);
    expect(selectPods(index, "shop", mapSelector({}))).toHaveLength(0);
  });
});
