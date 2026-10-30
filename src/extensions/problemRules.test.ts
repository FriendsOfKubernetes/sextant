import { describe, expect, it } from "vitest";
import type { KubeObject, ProblemCondition, ProblemContribution } from "../api";
import { compileRules, detectRule, evaluate, MAX_MESSAGE_CHARS, MAX_VALUE_CHARS, renderMessage, valueAt } from "./problemRules";

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
  it("read field paths of the custom columns' grammar, nothing else", () => {
    expect(valueAt(cluster, ".status.ceph.health")).toBe("HEALTH_ERR");
    expect(valueAt(cluster, "status.items[1].name")).toBe("b");
    expect(valueAt(cluster, '.metadata.labels["app.kubernetes.io/name"]')).toBe("ceph");
    expect(valueAt(cluster, ".status.items[9].name")).toBeUndefined();
    // No wildcards or filters: such a path leads nowhere (Rust refuses the manifest before).
    expect(valueAt(cluster, ".status.items[*].name")).toBeUndefined();
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

  it("fill a message with scalar values only, clipped and cleaned like other cluster text", () => {
    expect(renderMessage("Ceph reports {{.status.ceph.health}}: {{ .status.message }}", cluster)).toBe(
      "Ceph reports HEALTH_ERR: Cluster created successfully",
    );
    // An object or a missing value shows nothing.
    expect(renderMessage("[{{.status.ceph}}][{{.status.none}}]", cluster)).toBe("[][]");
    const long = { ...cluster, status: { message: "x".repeat(500) } };
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
