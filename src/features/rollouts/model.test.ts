import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import {
  matchesLive,
  revisionsOf,
  revisionsWatchSpec,
  rollbackBlocker,
  rollbackPatch,
  rolloutStatus,
  selectorOf,
  templateYaml,
} from "./model";
import { controllerRevision, deployment, daemonSet, replicaSet, statefulSet, template } from "./fixtures";

describe("revisions", () => {
  it("a Deployment's revisions are the ReplicaSets it controls, oldest first, the current one marked", () => {
    const dep = deployment();
    const sets = [
      replicaSet(3, "nginx:1.27", "third"),
      replicaSet(1, "nginx:1.25", "first"),
      replicaSet(2, "nginx:1.26"),
      replicaSet(9, "busybox", "stranger", "someone-else"),
      { ...replicaSet(4, "x"), metadata: { ...replicaSet(4, "x").metadata, annotations: {} } },
    ];
    const revisions = revisionsOf(dep, "Deployment", sets);
    expect(revisions.map((r) => [r.revision, r.changeCause, r.images, r.current])).toEqual([
      [1, "first", ["nginx:1.25"], false],
      [2, null, ["nginx:1.26"], false],
      [3, "third", ["nginx:1.27"], true],
    ]);
    // Without the hash label the ReplicaSet's template is the Deployment's.
    expect(revisions[2]!.template).toEqual(template("nginx:1.27"));
    expect(matchesLive(dep, revisions[2]!)).toBe(true);
    expect(matchesLive(dep, revisions[0]!)).toBe(false);
  });

  it("a StatefulSet's and a DaemonSet's revisions are ControllerRevisions", () => {
    const revisions = [controllerRevision("StatefulSet", "web-b", 2, "redis:7.2"), controllerRevision("StatefulSet", "web-a", 1, "redis:7.0")];
    const sts = revisionsOf(statefulSet({ updateRevision: "web-a" }), "StatefulSet", revisions);
    expect(sts.map((r) => [r.revision, r.name, r.current])).toEqual([
      [1, "web-a", true],
      [2, "web-b", false],
    ]);
    expect(sts[0]!.template).toEqual({ ...template("redis:7.0"), metadata: { creationTimestamp: null, labels: { app: "web" } } });
    expect(templateYaml(sts[0]!.template)).not.toContain("creationTimestamp");
    const ds = revisionsOf(daemonSet(), "DaemonSet", [
      controllerRevision("DaemonSet", "web-a", 1, "redis:7.0"),
      controllerRevision("DaemonSet", "web-b", 2, "redis:7.2"),
    ]);
    expect(ds.map((r) => r.current)).toEqual([false, true]);
  });

  it("the watch takes the namespace and the selector", () => {
    const dep = deployment();
    dep.spec = {
      ...(dep.spec as object),
      selector: { matchLabels: { app: "web" }, matchExpressions: [{ key: "tier", operator: "In", values: ["a", "b"] }] },
    };
    expect(selectorOf(dep)).toBe("app=web,tier in (a,b)");
    expect(revisionsWatchSpec(dep, "Deployment")).toEqual({
      kind: { group: "apps", version: "v1", kind: "ReplicaSet" },
      namespaces: ["shop"],
      labelSelector: "app=web,tier in (a,b)",
      fieldSelector: null,
    });
    expect(revisionsWatchSpec(statefulSet(), "StatefulSet")?.kind.kind).toBe("ControllerRevision");
    expect(revisionsWatchSpec({ metadata: { name: "x", namespace: "shop" }, spec: {} }, "Deployment")).toBeNull();
  });
});

describe("the rollback patch", () => {
  it("of a Deployment: the template and the ReplicaSet's annotations, keeping the Deployment's own bookkeeping", () => {
    const dep = deployment();
    const [first] = revisionsOf(dep, "Deployment", [replicaSet(1, "nginx:1.25", "first"), replicaSet(3, "nginx:1.27")]);
    expect(rollbackPatch(dep, "Deployment", first!)).toEqual([
      { op: "replace", path: "/spec/template", value: template("nginx:1.25") },
      {
        op: "replace",
        path: "/metadata/annotations",
        value: {
          "deployment.kubernetes.io/revision": "3",
          "kubectl.kubernetes.io/last-applied-configuration": "{}",
          "kubernetes.io/change-cause": "first",
          team: "shop",
        },
      },
    ]);
  });

  it("of a StatefulSet or DaemonSet: the template stored in the ControllerRevision", () => {
    const [first] = revisionsOf(statefulSet(), "StatefulSet", [
      controllerRevision("StatefulSet", "web-a", 1, "redis:7.0"),
      controllerRevision("StatefulSet", "web-b", 2, "redis:7.2"),
    ]);
    const patch = rollbackPatch(statefulSet(), "StatefulSet", first!);
    expect(patch).toEqual([{ op: "replace", path: "/spec/template", value: first!.template }]);
    expect(JSON.stringify(patch)).not.toContain("$patch");
  });

  it("a paused Deployment cannot be rolled back", () => {
    expect(rollbackBlocker(deployment({ paused: true }), "Deployment")).toBe("paused");
    expect(rollbackBlocker(deployment(), "Deployment")).toBeNull();
    expect(rollbackBlocker(statefulSet(), "StatefulSet")).toBeNull();
  });
});

describe("rollout status", () => {
  const withStatus = (obj: KubeObject, status: unknown, extra: Record<string, unknown> = {}): KubeObject => ({
    ...obj,
    ...extra,
    status,
  });

  it("a Deployment: progressing, complete, paused and stuck with the reason", () => {
    const dep = deployment();
    expect(
      rolloutStatus(withStatus(dep, { observedGeneration: 4, replicas: 4, updatedReplicas: 2, readyReplicas: 3, availableReplicas: 3 }), "Deployment"),
    ).toMatchObject({ state: "progressing", desired: 3, updated: 2, ready: 3, available: 3 });
    expect(
      rolloutStatus(withStatus(dep, { observedGeneration: 4, replicas: 3, updatedReplicas: 3, readyReplicas: 3, availableReplicas: 3 }), "Deployment"),
    ).toMatchObject({ state: "complete", pendingObservation: false });
    expect(rolloutStatus(withStatus(dep, { observedGeneration: 3, replicas: 3, updatedReplicas: 3, availableReplicas: 3 }), "Deployment")).toMatchObject(
      { state: "progressing", pendingObservation: true },
    );
    expect(rolloutStatus(withStatus(deployment({ paused: true }), { observedGeneration: 4 }), "Deployment").state).toBe("paused");
    const stuck = withStatus(dep, {
      observedGeneration: 4,
      replicas: 4,
      updatedReplicas: 1,
      conditions: [
        { type: "Available", status: "True" },
        { type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded", message: 'ReplicaSet "web-7" has timed out progressing.' },
      ],
    });
    expect(rolloutStatus(stuck, "Deployment")).toMatchObject({
      state: "failed",
      reason: "ProgressDeadlineExceeded",
      message: 'ReplicaSet "web-7" has timed out progressing.',
    });
  });

  it("a StatefulSet and a DaemonSet", () => {
    const sts = statefulSet({ observedGeneration: 2, replicas: 2, readyReplicas: 2, updatedReplicas: 1, currentRevision: "web-a", updateRevision: "web-b" });
    expect(rolloutStatus(sts, "StatefulSet")).toMatchObject({ state: "progressing", desired: 2, updated: 1, ready: 2 });
    const done = statefulSet({ observedGeneration: 2, replicas: 2, readyReplicas: 2, updatedReplicas: 2, currentRevision: "web-b", updateRevision: "web-b" });
    expect(rolloutStatus(done, "StatefulSet").state).toBe("complete");
    const ds = withStatus(daemonSet(), { observedGeneration: 1, desiredNumberScheduled: 3, updatedNumberScheduled: 2, numberReady: 3, numberAvailable: 3 });
    expect(rolloutStatus(ds, "DaemonSet")).toMatchObject({ state: "progressing", desired: 3, updated: 2, ready: 3, available: 3 });
  });
});
