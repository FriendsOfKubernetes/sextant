import { describe, expect, it } from "vitest";
import type { KindRef, KubeObject } from "../../api";
import { ROLLOUT } from "../argo-rollouts/model";
import { restartPatch, rfc3339Seconds } from "../argo-rollouts/patches";
import { canRestart, planRestart, POD, REPLICA_SET } from "./model";

const DEPLOYMENT: KindRef = { group: "apps", version: "v1", kind: "Deployment" };
const STATEFUL_SET: KindRef = { group: "apps", version: "v1", kind: "StatefulSet" };
const DAEMON_SET: KindRef = { group: "apps", version: "v1", kind: "DaemonSet" };
const CONFIG_MAP: KindRef = { group: "", version: "v1", kind: "ConfigMap" };

function owner(apiVersion: string, kind: string, name: string, controller = true) {
  return { apiVersion, kind, name, uid: `${kind}-${name}`, controller };
}

function obj(name: string, meta: Record<string, unknown> = {}): KubeObject {
  return { metadata: { name, namespace: "demo", uid: `uid-${name}`, ...meta } } as KubeObject;
}

const rsOf = (name: string, ...owners: ReturnType<typeof owner>[]) => obj(name, { ownerReferences: owners });

describe("which objects Restart is offered for", () => {
  it("offers the workloads kubectl rollout restart knows and Argo Rollouts", () => {
    for (const kind of [DEPLOYMENT, STATEFUL_SET, DAEMON_SET, ROLLOUT]) expect(canRestart(obj("w"), kind)).toBe(true);
    expect(canRestart(obj("c"), CONFIG_MAP)).toBe(false);
    expect(canRestart(obj("w", { deletionTimestamp: "2026-10-23T10:00:00Z" }), DEPLOYMENT)).toBe(false);
  });

  it("offers a ReplicaSet of a Deployment or a Rollout, or without a controller, never of another owner", () => {
    expect(canRestart(rsOf("web-1", owner("apps/v1", "Deployment", "web")), REPLICA_SET)).toBe(true);
    expect(canRestart(rsOf("ro-1", owner("argoproj.io/v1alpha1", "Rollout", "ro")), REPLICA_SET)).toBe(true);
    expect(canRestart(rsOf("bare"), REPLICA_SET)).toBe(true);
    // Not a controller reference: the ReplicaSet counts as unowned.
    expect(canRestart(rsOf("adopted", owner("apps/v1", "Deployment", "web", false)), REPLICA_SET)).toBe(true);
    expect(canRestart(rsOf("kruise", owner("apps.kruise.io/v1alpha1", "CloneSet", "c")), REPLICA_SET)).toBe(false);
  });

  it("offers a pod only when a controller recreates it", () => {
    expect(canRestart(rsOf("p1", owner("apps/v1", "ReplicaSet", "web-1")), POD)).toBe(true);
    expect(canRestart(rsOf("p2", owner("apps/v1", "StatefulSet", "db")), POD)).toBe(true);
    expect(canRestart(rsOf("p3", owner("apps/v1", "DaemonSet", "agent")), POD)).toBe(true);
    expect(canRestart(rsOf("p4", owner("v1", "ReplicationController", "rc")), POD)).toBe(true);
    // A bare pod, a Job's pod, a mirror pod and an unknown controller's pod would not (surely) come back.
    expect(canRestart(obj("bare"), POD)).toBe(false);
    expect(canRestart(rsOf("job-x", owner("batch/v1", "Job", "job")), POD)).toBe(false);
    expect(canRestart(rsOf("etcd-n1", owner("v1", "Node", "n1")), POD)).toBe(false);
    const mirror = obj("kube-proxy", {
      annotations: { "kubernetes.io/config.mirror": "abc" },
      ownerReferences: [owner("apps/v1", "DaemonSet", "x")],
    });
    expect(canRestart(mirror, POD)).toBe(false);
    expect(canRestart(rsOf("wf-1", owner("argoproj.io/v1alpha1", "Workflow", "wf")), POD)).toBe(false);
  });

  it("never offers Sextant's node shells or debug copies, even with an owner", () => {
    const rs = owner("apps/v1", "ReplicaSet", "web-1");
    expect(canRestart(obj("sextant-node-shell-n1-abcde", { ownerReferences: [rs] }), POD)).toBe(false);
    expect(canRestart(obj("x", { labels: { "sextant.dev/owner": "me" }, ownerReferences: [rs] }), POD)).toBe(false);
    const debug = { "app.kubernetes.io/managed-by": "sextant", "sextant.dev/debug-copy": "true" };
    expect(canRestart(obj("web-debug-x", { labels: debug, ownerReferences: [rs] }), POD)).toBe(false);
  });
});

describe("planRestart", () => {
  it("restarts the owner once for several of its ReplicaSets and keeps the order", () => {
    const steps = planRestart(
      [
        rsOf("web-1", owner("apps/v1", "Deployment", "web")),
        rsOf("bare"),
        rsOf("web-2", owner("apps/v1", "Deployment", "web")),
        rsOf("ro-1", owner("argoproj.io/v1alpha1", "Rollout", "ro")),
        rsOf("kruise", owner("apps.kruise.io/v1alpha1", "CloneSet", "c")),
      ],
      REPLICA_SET,
    );
    expect(steps.map((s) => [s.type, s.target.kind.kind, s.target.name])).toEqual([
      ["owner", "Deployment", "web"],
      ["pods", "ReplicaSet", "bare"],
      ["owner", "Rollout", "ro"],
    ]);
    const [first] = steps;
    expect(first?.type === "owner" && first.replicaSets.map((r) => r.ref.name)).toEqual(["web-1", "web-2"]);
    expect(first?.type === "owner" && first.uid).toBe("Deployment-web");
  });
});

describe("the Rollout's restart patch", () => {
  it("is kubectl argo rollouts restart's: spec.restartAt as Go's RFC 3339 in UTC", () => {
    expect(restartPatch(new Date("2026-10-23T10:11:12.345Z"))).toEqual({ spec: { restartAt: "2026-10-23T10:11:12Z" } });
    expect(rfc3339Seconds(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe("2026-01-02T03:04:05Z");
  });
});
