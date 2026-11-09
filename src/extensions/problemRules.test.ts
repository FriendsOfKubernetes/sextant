import { describe, expect, it } from "vitest";
import type { KubeObject, ProblemCondition, ProblemContribution } from "../api";
import { compileRules, detectRule, evaluate, fillTemplate, MAX_MESSAGE_CHARS, MAX_VALUE_CHARS, renderMessage, sameValue, valueAt } from "./problemRules";

const cluster: KubeObject = {
  apiVersion: "ceph.rook.io/v1",
  kind: "CephCluster",
  metadata: { name: "rook-ceph", namespace: "rook-ceph", uid: "u1", labels: { "app.kubernetes.io/name": "ceph" } },
  status: {
    phase: "Ready",
    message: "Cluster created successfully",
    ceph: { health: "HEALTH_ERR", lastChanged: "2026-10-30T10:00:00Z", capacity: { usedPercent: "87.5" }, osds: 3 },
    conditions: [
      { type: "Ready", status: "False", reason: "ReconcileFailed", lastTransitionTime: "2026-10-30T09:00:00Z" },
      { type: "Progressing", status: "True" },
    ],
    items: [{ name: "a" }, { name: "b" }],
  },
};

const holds = (condition: ProblemCondition) => evaluate(condition, cluster).holds;

describe("problem rules of extensions", () => {
  it("fall back to a literal reason and to later time paths (#404, #407)", () => {
    const rule = {
      id: "failed",
      title: "Failed",
      kind: { group: "ray.io", kind: "RayJob" },
      when: { type: "exists", path: ".status.jobStatus" },
      message: "",
      reason: "{{.status.reason}}",
      reasonOr: "JobFailed",
      since: ".status.endTime",
      sinceOr: [".status.startTime", ".metadata.creationTimestamp"],
      graceMinutes: 0,
      notify: true,
      toldThroughOwner: false,
    } as unknown as ProblemContribution;
    const job = (status: Record<string, unknown>) =>
      ({ metadata: { name: "j", creationTimestamp: "2026-11-01T00:00:00Z" }, status: { jobStatus: "FAILED", ...status } }) as KubeObject;
    expect(detectRule(rule, job({}))[0]).toMatchObject({ reason: "JobFailed", since: "2026-11-01T00:00:00Z" });
    expect(detectRule(rule, job({ reason: "DeadlineExceeded", startTime: "2026-11-02T00:00:00Z" }))[0]).toMatchObject({
      reason: "DeadlineExceeded",
      since: "2026-11-02T00:00:00Z",
    });
    expect(detectRule(rule, job({ endTime: "2026-11-03T00:00:00Z", startTime: "x" }))[0]!.since).toBe("2026-11-03T00:00:00Z");
  });

  it("test a text by what it holds or begins with, in any case when asked (#405)", () => {
    const cluster = { metadata: { name: "pg" }, status: { phase: "Waiting for user action", reason: "FailedToPull" } } as KubeObject;
    expect(evaluate({ type: "contains", path: ".status.phase", values: ["waiting for user"], ignoreCase: true }, cluster).holds).toBe(true);
    expect(evaluate({ type: "contains", path: ".status.phase", values: ["waiting for user"], ignoreCase: false }, cluster).holds).toBe(false);
    expect(evaluate({ type: "startsWith", path: ".status.reason", values: ["Failed"], ignoreCase: false }, cluster).holds).toBe(true);
    expect(evaluate({ type: "startsWith", path: ".status.reason", values: ["ToPull"], ignoreCase: false }, cluster).holds).toBe(false);
    // Only a text: a number or a missing value never holds.
    expect(evaluate({ type: "contains", path: ".status.missing", values: ["x"], ignoreCase: false }, cluster).holds).toBe(false);
  });

  it("tell a problem about another object, and restart its grace when its progress moves (#405)", () => {
    const base = { title: "T", when: { type: "exists", path: ".metadata.name" }, message: "", graceMinutes: 0, notify: true, toldThroughOwner: false };
    const plan = {
      ...base,
      id: "plan",
      kind: { group: "operators.coreos.com", kind: "Subscription" },
      about: { kind: { group: "operators.coreos.com", version: "v1alpha1", kind: "InstallPlan" }, namePath: ".status.installPlanRef.name" },
      stamp: [".status.state"],
    } as unknown as ProblemContribution;
    const sub = { metadata: { name: "etcd", namespace: "ops" }, status: { installPlanRef: { name: "install-abc" }, state: "UpgradePending" } } as KubeObject;
    expect(detectRule(plan, sub)[0]).toMatchObject({
      object: { kind: { kind: "InstallPlan", version: "v1alpha1" }, namespace: "ops", name: "install-abc" },
      notifyAs: "operators.coreos.com/InstallPlan/ops/install-abc",
      stamp: '["UpgradePending"]',
    });
    // Without the name it stays about the judged object.
    expect(detectRule(plan, { metadata: { name: "etcd", namespace: "ops" } } as KubeObject)[0]!.object).toBeUndefined();
    const report = {
      ...base,
      id: "report",
      kind: { group: "wgpolicyk8s.io", kind: "PolicyReport" },
      about: { apiVersionPath: ".scope.apiVersion", kindPath: ".scope.kind", namePath: ".scope.name", namespacePath: ".scope.namespace" },
    } as unknown as ProblemContribution;
    const pr = { metadata: { name: "uid-1", namespace: "web" }, scope: { apiVersion: "apps/v1", kind: "Deployment", name: "shop", namespace: "web" } } as unknown as KubeObject;
    expect(detectRule(report, pr)[0]!.object).toEqual({ kind: { group: "apps", version: "v1", kind: "Deployment" }, namespace: "web", name: "shop" });
    const policy = {
      ...base,
      id: "policy",
      kind: { group: "apps", kind: "DaemonSet" },
      about: { kind: { group: "nvidia.com", version: "v1", kind: "ClusterPolicy" }, namePath: ".metadata.ownerReferences[0].name", clusterScoped: true },
    } as unknown as ProblemContribution;
    const ds = { metadata: { name: "nvidia-dcgm", namespace: "gpu-operator", ownerReferences: [{ name: "cluster-policy" }] } } as KubeObject;
    expect(detectRule(policy, ds)[0]!.object).toMatchObject({ namespace: null, name: "cluster-policy" });
  });

  it("read field paths of the custom columns' grammar, nothing else", () => {
    expect(valueAt(cluster, ".status.ceph.health")).toBe("HEALTH_ERR");
    expect(valueAt(cluster, "status.items[1].name")).toBe("b");
    expect(valueAt(cluster, '.metadata.labels["app.kubernetes.io/name"]')).toBe("ceph");
    expect(valueAt(cluster, ".status.items[9].name")).toBeUndefined();
    // No wildcards or filters: such a path leads nowhere (Rust refuses the manifest before).
    expect(valueAt(cluster, ".status.items[*].name")).toBeUndefined();
    // A list item by a field (ADR-0161).
    expect(valueAt(cluster, '.status.conditions[type="Ready"].reason')).toBe("ReconcileFailed");
    expect(valueAt(cluster, '.status.conditions[type="Missing"].reason')).toBeUndefined();
    expect(valueAt(cluster, '.status[type="Ready"]')).toBeUndefined();
    // An array is not walked by a key, an object not by an index.
    expect(valueAt(cluster, ".status.items.name")).toBeUndefined();
    expect(valueAt(cluster, ".status.ceph[0]")).toBeUndefined();
  });

  it("compare values by type, numbers above and below also from numeric text", () => {
    expect(holds({ type: "equals", path: ".status.ceph.health", value: "HEALTH_ERR" })).toBe(true);
    expect(holds({ type: "equals", path: ".status.ceph.osds", value: "3" })).toBe(false);
    expect(holds({ type: "equals", path: ".status.ceph.osds", value: 3 })).toBe(true);
    expect(holds({ type: "in", path: ".status.phase", values: ["Failure", "Ready"] })).toBe(true);
    expect(holds({ type: "exists", path: ".status.message" })).toBe(true);
    expect(holds({ type: "absent", path: ".status.reason" })).toBe(true);
    expect(holds({ type: "above", path: ".status.ceph.capacity.usedPercent", value: 85 })).toBe(true);
    expect(holds({ type: "below", path: ".status.ceph.capacity.usedPercent", value: 85 })).toBe(false);
    expect(holds({ type: "above", path: ".status.phase", value: 0 })).toBe(false);
  });

  it("read a condition by type, status and reason, with its transition time", () => {
    expect(evaluate({ type: "condition", conditionType: "Ready", status: "False", reason: "ReconcileFailed" }, cluster)).toEqual({
      holds: true,
      since: "2026-10-30T09:00:00Z",
    });
    expect(holds({ type: "condition", conditionType: "Ready", status: "False", reason: "Other" })).toBe(false);
    expect(holds({ type: "condition", conditionType: "Missing", status: "True" })).toBe(false);
  });

  it("count an old enough time from the moment it becomes old enough, with no clock", () => {
    const verdict = evaluate({ type: "olderThan", path: ".status.ceph.lastChanged", minutes: 30 }, cluster);
    expect(verdict).toEqual({ holds: true, activeFrom: Date.parse("2026-10-30T10:30:00Z") });
    expect(holds({ type: "olderThan", path: ".status.message", minutes: 1 })).toBe(false);
  });

  it("combine: all holds from its latest branch, any from its earliest", () => {
    const later = { type: "olderThan", path: ".status.ceph.lastChanged", minutes: 60 } as const;
    const earlier = { type: "olderThan", path: ".status.ceph.lastChanged", minutes: 10 } as const;
    const now = { type: "exists", path: ".status" } as const;
    expect(evaluate({ type: "all", of: [earlier, later, now] }, cluster).activeFrom).toBe(Date.parse("2026-10-30T11:00:00Z"));
    expect(evaluate({ type: "any", of: [later, earlier] }, cluster).activeFrom).toBe(Date.parse("2026-10-30T10:10:00Z"));
    expect(evaluate({ type: "any", of: [later, now] }, cluster)).toEqual({ holds: true });
    expect(holds({ type: "all", of: [now, { type: "absent", path: ".status" }] })).toBe(false);
  });

  it("compare two fields with same, and count a list as its length (ADR-0161)", () => {
    const rollout = { ...cluster, status: { currentPodHash: "abc", stableRS: "abc", steps: [{}, {}, {}] } } as KubeObject;
    expect(evaluate({ type: "same", path: ".status.currentPodHash", otherPath: ".status.stableRS" }, rollout).holds).toBe(true);
    expect(holds({ type: "same", path: ".status.phase", otherPath: ".status.message" })).toBe(false);
    // Two missing fields are not the same value.
    expect(holds({ type: "same", path: ".status.none", otherPath: ".status.nothing" })).toBe(false);
    expect(evaluate({ type: "above", path: ".status.steps", value: 2 }, rollout).holds).toBe(true);
    expect(holds({ type: "below", path: ".status.items", value: 2 })).toBe(false);
  });

  it("negate with not: the other branches, and a time not yet old enough counts until it is (ADR-0152)", () => {
    expect(holds({ type: "not", of: { type: "in", path: ".status.phase", values: ["Progressing", "Pending"] } })).toBe(true);
    expect(holds({ type: "not", of: { type: "equals", path: ".status.phase", value: "Ready" } })).toBe(false);
    // A missing field is no match, so `not` holds: `not equals .spec.suspend true` holds where suspend is unset.
    expect(holds({ type: "not", of: { type: "equals", path: ".spec.suspend", value: true } })).toBe(true);
    const recent = { type: "not", of: { type: "olderThan", path: ".status.ceph.lastChanged", minutes: 1440 } } as const;
    expect(evaluate(recent, cluster)).toEqual({ holds: true, until: Date.parse("2026-10-31T10:00:00Z") });
    // Within all: from the latest start to the earliest end; a window closing before it opens never holds.
    const old = { type: "olderThan", path: ".status.ceph.lastChanged", minutes: 60 } as const;
    expect(evaluate({ type: "all", of: [recent, old] }, cluster)).toEqual({
      holds: true,
      activeFrom: Date.parse("2026-10-30T11:00:00Z"),
      until: Date.parse("2026-10-31T10:00:00Z"),
    });
    const tooOld = { type: "olderThan", path: ".status.ceph.lastChanged", minutes: 2000 } as const;
    expect(holds({ type: "all", of: [recent, tooOld] })).toBe(false);
    // Within any: holding for good wins, then the later end.
    const shorter = { type: "not", of: { type: "olderThan", path: ".status.ceph.lastChanged", minutes: 60 } } as const;
    expect(evaluate({ type: "any", of: [shorter, recent] }, cluster).until).toBe(Date.parse("2026-10-31T10:00:00Z"));
    expect(evaluate({ type: "any", of: [recent, { type: "exists", path: ".status" }] }, cluster)).toEqual({ holds: true });
    // The problem stops counting at the end.
    const rule: ProblemContribution = {
      id: "recent",
      title: "Recent",
      kind: { group: "ceph.rook.io", kind: "CephCluster" },
      when: recent,
      graceMinutes: 0,
      notify: true,
      message: "x",
      toldThroughOwner: false,
    };
    expect(detectRule(rule, cluster)[0]!.until).toBe(Date.parse("2026-10-31T10:00:00Z"));
    // Rules of one group notify as one (ADR-0161); a rule alone is its own group.
    expect(detectRule(rule, cluster)[0]!.group).toBe("recent");
    expect(detectRule({ ...rule, group: "rollout" }, cluster)[0]!.group).toBe("rollout");
  });

  it("fill a message with scalar values only, clipped and cleaned like other cluster text", () => {
    expect(renderMessage("Ceph reports {{.status.ceph.health}}: {{ .status.message }}", cluster)).toBe(
      "Ceph reports HEALTH_ERR: Cluster created successfully",
    );
    // An object or a missing value shows nothing.
    expect(renderMessage("[{{.status.ceph}}][{{.status.none}}]", cluster)).toBe("[][]");
    const long = { ...cluster, status: { message: "x".repeat(MAX_VALUE_CHARS + 500) } };
    expect(renderMessage("{{.status.message}}", long)).toBe(`${"x".repeat(MAX_VALUE_CHARS)}…`);
    expect(Array.from(renderMessage("{{.status.message}}".repeat(5), long)).length).toBe(MAX_MESSAGE_CHARS + 1);
    const leaky = { ...cluster, status: { message: "pull from https://u:secret@registry.example.com/x?sig=abc failed" } };
    expect(renderMessage("{{.status.message}}", leaky)).toBe("pull from https://registry.example.com/x failed");
  });

  it("find one problem per rule that holds, titled by the rule", () => {
    const rule: ProblemContribution = {
      id: "health-error",
      title: "Ceph health error",
      kind: { group: "ceph.rook.io", kind: "CephCluster" },
      when: { type: "condition", conditionType: "Ready", status: "False" },
      graceMinutes: 5,
      notify: false,
      toldThroughOwner: false,
      message: "{{.status.ceph.health}}",
    };
    expect(detectRule(rule, cluster)).toEqual([
      {
        reason: "Ceph health error",
        group: "health-error",
        message: "HEALTH_ERR",
        since: "2026-10-30T09:00:00Z",
        graceMs: 5 * 60_000,
        activeFrom: undefined,
        notify: false,
      },
    ]);
    // A rule's own `since` wins over the condition's time; a value that is not a time is left out.
    expect(detectRule({ ...rule, since: ".status.ceph.lastChanged" }, cluster)[0]!.since).toBe("2026-10-30T10:00:00Z");
    expect(detectRule({ ...rule, since: ".status.phase" }, cluster)[0]!.since).toBeUndefined();
    expect(detectRule({ ...rule, when: { type: "absent", path: ".status" } }, cluster)).toEqual([]);

    const detectors = compileRules([rule, { ...rule, id: "other", title: "Other", kind: { group: "CEPH.rook.io", kind: "cephcluster" } }]);
    expect([...detectors.keys()]).toEqual(["ceph.rook.io/cephcluster"]);
    expect(detectors.get("ceph.rook.io/cephcluster")!(cluster).map((d) => d.reason)).toEqual(["Ceph health error", "Other"]);
  });
});

describe("sameValue and templates (#368, #369, #370)", () => {
  it("read a number written as text as that number, but compare two strings as text", () => {
    expect(sameValue(3, "3")).toBe(true);
    expect(sameValue("3", 3)).toBe(true);
    expect(sameValue(3, "4")).toBe(false);
    expect(sameValue("07", "7")).toBe(false);
    expect(sameValue(7, "5d8f9c")).toBe(false);
    expect(sameValue("abc", "abc")).toBe(true);
    expect(sameValue(null, null)).toBe(false);
    const ro = { apiVersion: "argoproj.io/v1alpha1", kind: "Rollout", metadata: { name: "r", generation: 3 }, status: { observedGeneration: "3" } };
    expect(evaluate({ type: "same", path: ".metadata.generation", otherPath: ".status.observedGeneration" }, ro).holds).toBe(true);
  });

  it("compare two numbers with atLeast, a list as its length, never a non-number (#386)", () => {
    const ro = { apiVersion: "v1", kind: "X", metadata: { name: "r", generation: 3 }, status: { observedGeneration: "4", at: 2 }, spec: { steps: [1, 2] } };
    const atLeast = (path: string, otherPath: string) => evaluate({ type: "atLeast", path, otherPath }, ro).holds;
    expect(atLeast(".status.observedGeneration", ".metadata.generation")).toBe(true);
    expect(atLeast(".metadata.generation", ".status.observedGeneration")).toBe(false);
    expect(atLeast(".status.at", ".spec.steps")).toBe(true);
    expect(atLeast(".status.none", ".spec.steps")).toBe(false);
    expect(atLeast(".metadata.name", ".spec.steps")).toBe(false);
  });

  it("hold enteredWithin from when the store saw the object enter, for its minutes (#393)", () => {
    const obj = { apiVersion: "v1", kind: "X", metadata: { name: "x" } };
    expect(evaluate({ type: "enteredWithin", minutes: 60 }, obj).holds).toBe(false);
    const at = Date.parse("2026-11-07T10:00:00Z");
    expect(evaluate({ type: "enteredWithin", minutes: 60 }, obj, { enteredAt: at })).toEqual({
      holds: true,
      since: "2026-11-07T10:00:00.000Z",
      until: at + 3_600_000,
    });
  });

  it("notify as the owner a rule's notifyAs names, else as the object (#394)", () => {
    const rule: ProblemContribution = {
      id: "failed",
      title: "Failed",
      kind: { group: "argoproj.io", kind: "Workflow" },
      when: { type: "exists", path: ".metadata.name" },
      graceMinutes: 0,
      notify: true,
      message: "x",
      toldThroughOwner: false,
      notifyAs: '.metadata.labels["workflows.argoproj.io/cron-workflow"]',
    };
    const run = (name: string, cron?: string) => ({
      apiVersion: "argoproj.io/v1alpha1",
      kind: "Workflow",
      metadata: { name, namespace: "ci", uid: name, ...(cron ? { labels: { "workflows.argoproj.io/cron-workflow": cron } } : {}) },
    });
    expect(detectRule(rule, run("nightly-1", "nightly"))[0]!.notifyAs).toBe("argoproj.io/Workflow/ci/nightly");
    expect(detectRule(rule, run("nightly-2", "nightly"))[0]!.notifyAs).toBe("argoproj.io/Workflow/ci/nightly");
    expect(detectRule(rule, run("by-hand"))[0]!.notifyAs).toBeUndefined();
  });

  it("fill a template only when every placeholder has a value", () => {
    const obj = { apiVersion: "v1", kind: "X", metadata: { name: "x" }, spec: { sourceRef: { kind: "GitRepository", name: "podinfo" } } };
    expect(fillTemplate("{{.spec.sourceRef.kind}}/{{.spec.sourceRef.name}}", obj)).toBe("GitRepository/podinfo");
    expect(fillTemplate("{{.spec.sourceRef.kind}}/{{.spec.sourceRef.namespace}}", obj)).toBeNull();
    expect(fillTemplate("{{.spec.sourceRef}}", obj)).toBeNull();
  });

  it("take a rule's reason from the object, else its title", () => {
    const rule: ProblemContribution = {
      id: "not-ready",
      title: "Not ready",
      kind: { group: "kustomize.toolkit.fluxcd.io", kind: "Kustomization" },
      when: { type: "exists", path: ".metadata.name" },
      graceMinutes: 0,
      notify: true,
      message: "x",
      toldThroughOwner: false,
      reason: "{{.status.conditions[type=\"Ready\"].reason}}",
    };
    const failing = { apiVersion: "v1", kind: "Kustomization", metadata: { name: "k" }, status: { conditions: [{ type: "Ready", status: "False", reason: "BuildFailed" }] } };
    expect(detectRule(rule, failing)[0]!.reason).toBe("BuildFailed");
    expect(detectRule(rule, { ...failing, status: {} })[0]!.reason).toBe("Not ready");
  });
});
