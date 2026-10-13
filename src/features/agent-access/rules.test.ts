import { describe, expect, it } from "vitest";
import type { AccessRule } from "../../api";
import {
  allKinds,
  allNamespaces,
  cleanRule,
  makeAccess,
  newRule,
  onlyKinds,
  onlyNamespaces,
  parseKindInput,
  parseNamespaceInput,
  toggleAction,
  withKinds,
  withNamespaces,
} from "./rules";

describe("rule shapes (the core rejects any field a variant does not have)", () => {
  it("a new rule asks before running and may only read, in the exact shape", () => {
    expect(JSON.parse(JSON.stringify(newRule()))).toEqual({
      namespaces: { type: "all" },
      kinds: { type: "all" },
      actions: ["read"],
      confirm: true,
    });
  });

  it("Only → All → Only leaves no field of the other variant behind", () => {
    const base = newRule();
    const only = withNamespaces(base, onlyNamespaces(["team-a", "team-b"]));
    expect(Object.keys(only.namespaces).sort()).toEqual(["namespaces", "type"]);

    const all = withNamespaces(only, allNamespaces());
    expect(all.namespaces).toStrictEqual({ type: "all" });
    expect(Object.keys(all.namespaces)).toEqual(["type"]);

    const again = withNamespaces(all, onlyNamespaces([]));
    expect(again.namespaces).toStrictEqual({ type: "only", namespaces: [] });

    const kindsOnly = withKinds(again, onlyKinds([{ group: "apps", kind: "Deployment" }]));
    const kindsAll = withKinds(kindsOnly, allKinds());
    expect(kindsAll.kinds).toStrictEqual({ type: "all" });
    expect(withKinds(kindsAll, onlyKinds([])).kinds).toStrictEqual({ type: "only", kinds: [] });
  });

  it("a scope built from a value that carries foreign fields is cleaned", () => {
    const dirty = {
      namespaces: { type: "all", namespaces: ["old"] },
      kinds: { type: "all", kinds: [{ group: "", kind: "Pod" }] },
      actions: ["modify", "read"],
      confirm: false,
      extra: 1,
    } as unknown as AccessRule;
    expect(cleanRule(dirty)).toStrictEqual({
      namespaces: { type: "all" },
      kinds: { type: "all" },
      actions: ["read", "modify"],
      confirm: false,
    });
    const dirtyKind = {
      namespaces: { type: "only", namespaces: ["a"], kinds: [] },
      kinds: { type: "only", kinds: [{ group: "apps", kind: "Deployment", version: "v1" }], namespaces: ["x"] },
      actions: [],
      confirm: true,
    } as unknown as AccessRule;
    expect(cleanRule(dirtyKind)).toStrictEqual({
      namespaces: { type: "only", namespaces: ["a"] },
      kinds: { type: "only", kinds: [{ group: "apps", kind: "Deployment" }] },
      actions: [],
      confirm: true,
    });
  });

  it("the saved top level is exactly { preset, rules }", () => {
    const access = makeAccess("custom", [newRule()]);
    expect(Object.keys(access).sort()).toEqual(["preset", "rules"]);
    expect(Object.keys(access.rules[0]!).sort()).toEqual(["actions", "confirm", "kinds", "namespaces"]);
  });

  it("actions are kept without duplicates in a fixed order", () => {
    let rule = newRule();
    rule = toggleAction(rule, "secretValues", true);
    rule = toggleAction(rule, "modify", true);
    rule = toggleAction(rule, "modify", true);
    expect(rule.actions).toEqual(["read", "modify", "secretValues"]);
    expect(toggleAction(rule, "read", false).actions).toEqual(["modify", "secretValues"]);
  });
});

describe("names typed by hand", () => {
  it("kinds: Kind or group/Kind", () => {
    expect(parseKindInput("Pod")).toEqual({ group: "", kind: "Pod" });
    expect(parseKindInput(" apps/Deployment ")).toEqual({ group: "apps", kind: "Deployment" });
    expect(parseKindInput("helm.sh/Release")).toEqual({ group: "helm.sh", kind: "Release" });
    expect(parseKindInput("")).toBeNull();
    expect(parseKindInput("apps/")).toBeNull();
    expect(parseKindInput("a/b/C")).toBeNull();
    expect(parseKindInput("pods list")).toBeNull();
  });

  it("namespaces: a DNS label", () => {
    expect(parseNamespaceInput(" team-a ")).toBe("team-a");
    expect(parseNamespaceInput("Team")).toBeNull();
    expect(parseNamespaceInput("-a")).toBeNull();
    expect(parseNamespaceInput("a/b")).toBeNull();
    expect(parseNamespaceInput("a".repeat(64))).toBeNull();
  });
});
