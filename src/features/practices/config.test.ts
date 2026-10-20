import { describe, expect, it } from "vitest";
import { defaultAppSettings, type AppSettings } from "../../api";
import { parseNamespaceList, practicesConfigOf, savePractices } from "./config";
import type { PracticeFinding, WorkloadInfo } from "./model";
import { practiceProblems } from "./problems";

const withPractices = (practices: unknown) => ({ practices }) as unknown as Pick<AppSettings, "practices">;

describe("the settings of the best-practice checks", () => {
  it.each<[string, unknown, string[], string[]]>([
    ["missing", undefined, [], ["kube-system", "kube-public", "kube-node-lease"]],
    ["not an object", [1], [], ["kube-system", "kube-public", "kube-node-lease"]],
    ["lists of the wrong type", { disabledChecks: "noPdb", excludedNamespaces: 3 }, [], ["kube-system", "kube-public", "kube-node-lease"]],
    ["unknown ids and bad entries", { disabledChecks: ["noPdb", "future", 1, " sameNode "], excludedNamespaces: ["batch", "", 2] }, ["noPdb", "sameNode"], ["batch"]],
    ["an empty exclusion list", { excludedNamespaces: [] }, [], []],
  ])("reads %s tolerantly", (_name, value, disabled, excluded) => {
    const config = practicesConfigOf(withPractices(value));
    expect([...config.disabled].sort()).toEqual(disabled);
    expect([...config.excluded]).toEqual(excluded);
  });

  it("keeps check ids of another version when saving", () => {
    const before = { ...defaultAppSettings(), practices: { disabledChecks: ["future", "noPdb"], excludedNamespaces: [] } };
    expect(savePractices(["sameNode"], ["a"])(before).practices).toEqual({ disabledChecks: ["future", "sameNode"], excludedNamespaces: ["a"] });
  });

  it("reads namespace names from free text", () => {
    expect(parseNamespaceList(" shop, batch\nshop\n\n  web ")).toEqual(["shop", "batch", "web"]);
  });
});

describe("best-practice problems", () => {
  const w = (namespace: string, uid: string): WorkloadInfo => ({
    kind: "Deployment",
    namespace,
    name: uid,
    uid,
    recreate: false,
    templateLabels: {},
    spread: false,
    scheduling: { nodeSelector: {}, requiredAffinity: undefined, tolerations: [] },
    prefix: ["spec", "template"],
    containers: [],
  });
  const f = (check: PracticeFinding["check"], severity: PracticeFinding["severity"]): PracticeFinding => ({
    check,
    severity,
    path: "spec.replicas",
    fixType: "patch",
    fix: {},
  });

  it("is one problem per workload and check; only High and Medium notify; exclusions and toggles apply", () => {
    const findings = new Map([
      ["a", [f("noRequests", "medium"), f("noRequests", "medium"), f("noMemoryLimit", "low")]],
      ["b", [f("singleReplica", "medium")]],
    ]);
    const config = practicesConfigOf(withPractices({ disabledChecks: ["singleReplica"], excludedNamespaces: ["kube-system"] }));
    const firstSeen = new Map<string, number>();
    const { problems } = practiceProblems([w("shop", "a"), w("kube-system", "c"), w("shop", "b")], findings, config, firstSeen, 1000);
    expect(problems.map((p) => [p.reason, p.notify, p.object.name])).toEqual([
      ["NoResourceRequests", true, "a"],
      ["NoMemoryLimit", false, "a"],
    ]);
    // First seen is kept across looks, and forgotten once the problem is gone.
    const again = practiceProblems([w("shop", "a")], new Map([["a", [f("noRequests", "medium")]]]), config, firstSeen, 5000);
    expect(again.problems[0]!.firstSeen).toBe(1000);
    expect([...firstSeen.keys()]).toEqual(["a|NoResourceRequests"]);
  });
});
