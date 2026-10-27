import { describe, expect, it } from "vitest";
import type { FieldManager, KubeObject } from "../../api";
import { buildGraph } from "../resource-map/relations";
import { CONFIG_MAP, DEPLOYMENT, HPA, POD, REPLICA_SET } from "../resource-map/kinds";
import { correlate, CORRELATION_WINDOW_MS, dependents, MAX_CORRELATIONS, type Signal } from "./correlate";
import {
  canonical,
  changedManagers,
  diffObjects,
  friendlyManager,
  isOwnedRun,
  isRecordedKind,
  MAX_CHANGES,
  MAX_VALUE_KEPT,
  projection,
} from "./model";

const DEPLOY = { group: "apps", kind: "Deployment" };
const SECRET = { group: "", kind: "Secret" };

function deployment(image: string, replicas: number, extra: Record<string, unknown> = {}): KubeObject {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: "web",
      namespace: "shop",
      uid: "u1",
      resourceVersion: "10",
      generation: 3,
      managedFields: [{ manager: "kubectl" }],
      labels: { app: "web", "app.kubernetes.io/version": "1" },
      annotations: { "deployment.kubernetes.io/revision": "4", "kubectl.kubernetes.io/restartedAt": "2026-01-01T00:00:00Z" },
      ...extra,
    },
    spec: {
      replicas,
      template: { spec: { containers: [{ name: "web", image }, { name: "sidecar", image: "envoy:1" }] } },
    },
    status: { readyReplicas: replicas, observedGeneration: 3 },
  };
}

const diff = (kind: typeof DEPLOY, a: KubeObject, b: KubeObject) =>
  diffObjects(kind, JSON.parse(canonical(projection(kind, a))), JSON.parse(canonical(projection(kind, b))));

describe("what counts as a change", () => {
  it("leaves out status, bookkeeping and noisy annotations, keeps restartedAt", () => {
    const p = projection(DEPLOY, deployment("web:1", 2)) as Record<string, Record<string, unknown>>;
    expect(p.status).toBeUndefined();
    expect(p.metadata).toEqual({
      labels: { app: "web", "app.kubernetes.io/version": "1" },
      annotations: { "kubectl.kubernetes.io/restartedAt": "2026-01-01T00:00:00Z" },
    });
    // A status-only update or a new resourceVersion is no change at all.
    const later = deployment("web:1", 2, { resourceVersion: "11", generation: 4 });
    (later.status as Record<string, unknown>).readyReplicas = 0;
    (later.metadata!.annotations as Record<string, string>)["deployment.kubernetes.io/revision"] = "5";
    expect(canonical(projection(DEPLOY, later))).toBe(canonical(projection(DEPLOY, deployment("web:1", 2))));
  });

  it("names changed fields by path, list items by name", () => {
    const after = deployment("web:2", 3);
    (after.metadata!.labels as Record<string, string>)["app.kubernetes.io/version"] = "2";
    const { changes, more } = diff(DEPLOY, deployment("web:1", 2), after);
    expect(more).toBe(0);
    expect(changes).toEqual([
      { path: 'metadata.labels["app.kubernetes.io/version"]', op: "changed", before: "1", after: "2" },
      { path: "spec.replicas", op: "changed", before: "2", after: "3" },
      { path: "spec.template.spec.containers[web].image", op: "changed", before: "web:1", after: "web:2" },
    ]);
  });

  it("clips: long values are kept as a hash, many changes are counted", () => {
    const big = (v: string) => ({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "c" }, data: { blob: v.repeat(MAX_VALUE_KEPT + 1) } });
    const cm = { group: "", kind: "ConfigMap" };
    expect(canonical(projection(cm, big("a"))).length).toBeLessThan(200);
    expect(diff(cm, big("a"), big("b")).changes).toEqual([{ path: "data.blob", op: "changed", long: true }]);
    const many = (n: number) => ({ metadata: { name: "c" }, data: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, `${n}`])) });
    const result = diff(cm, many(1), many(2));
    expect(result.changes).toHaveLength(MAX_CHANGES);
    expect(result.more).toBe(40 - MAX_CHANGES);
  });

  it("never carries a Secret's values, only its key names", () => {
    const secret = (data: Record<string, string>): KubeObject => ({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "db", annotations: { "sextant.dev/values-hidden": "true" } },
      data,
    });
    // Even if a value reached the window, the projection keeps only the key.
    const before = secret({ password: "c2VjcmV0", user: "" });
    const after = secret({ password: "b3RoZXI=", token: "" });
    expect(canonical(projection(SECRET, before))).not.toContain("c2VjcmV0");
    const { changes } = diff(SECRET, before, after);
    expect(changes).toEqual([
      { path: "data.token", op: "added" },
      { path: "data.user", op: "removed" },
    ]);
  });

  it("never keeps or shows secret material other kinds hold inline, but sees that it changed", () => {
    const ROUTE = { group: "route.openshift.io", kind: "Route" };
    const route = (key: string, host: string): KubeObject => ({
      apiVersion: "route.openshift.io/v1",
      kind: "Route",
      metadata: { name: "web", namespace: "a" },
      spec: { host, tls: { termination: "edge", key, certificate: "CERT" } },
    });
    const before = route("-----BEGIN PRIVATE KEY-----old", "a.example.com");
    const after = route("-----BEGIN PRIVATE KEY-----new", "b.example.com");
    const text = canonical(projection(ROUTE, before));
    expect(text).not.toContain("PRIVATE KEY");
    expect(text).toContain("CERT");
    expect(diff(ROUTE, before, after).changes).toEqual([
      { path: "spec.host", op: "changed", before: "a.example.com", after: "b.example.com" },
      { path: "spec.tls.key", op: "changed" },
    ]);
    // Only the key changed: still a change, without its value.
    expect(diff(ROUTE, before, route("-----BEGIN PRIVATE KEY-----new", "a.example.com")).changes).toEqual([
      { path: "spec.tls.key", op: "changed" },
    ]);

    const NODE = { group: "", kind: "Node" };
    const node = (args: string): KubeObject => ({
      apiVersion: "v1",
      kind: "Node",
      metadata: { name: "server-0", annotations: { "k3s.io/node-args": args, "k3s.io/node-config-hash": "A" } },
    });
    const added = diffObjects(NODE, projection(NODE, node("[]")), {
      metadata: { annotations: { "k3s.io/node-args": "x" } },
    });
    expect(JSON.stringify(added)).not.toContain('"x"');
    expect(canonical(projection(NODE, node('["--token","K10s3cret"]')))).not.toContain("s3cret");
    const { changes } = diff(NODE, node('["--token","t1"]'), node('["--token","t2"]'));
    expect(changes).toEqual([{ path: 'metadata.annotations["k3s.io/node-args"]', op: "changed" }]);
  });

  it("does not record churn: Pods, ReplicaSets, Events, Leases, a CronJob's runs", () => {
    for (const kind of [POD, REPLICA_SET, { group: "", kind: "Event" }, { group: "coordination.k8s.io", kind: "Lease" }]) {
      expect(isRecordedKind(kind)).toBe(false);
    }
    expect(isRecordedKind(DEPLOY)).toBe(true);
    const run = { metadata: { name: "nightly-29000000", ownerReferences: [{ kind: "CronJob", name: "nightly", controller: true }] } };
    expect(isOwnedRun({ group: "batch", kind: "Job" }, run)).toBe(true);
    expect(isOwnedRun({ group: "batch", kind: "Job" }, { metadata: { name: "once" } })).toBe(false);
  });
});

describe("who changed it", () => {
  const m = (manager: string, time: string, subresource: string | null = null, operation = "Update"): FieldManager => ({
    manager,
    operation,
    subresource,
    time,
  });

  it("names the managers whose time moved since the last look", () => {
    const before = [m("helm", "2026-03-01T10:00:00Z"), m("kube-controller-manager", "2026-03-01T10:00:05Z", "status")];
    const now = [m("helm", "2026-03-01T10:00:00Z"), m("kubectl-edit", "2026-03-02T09:00:00Z"), m("kube-controller-manager", "2026-03-02T09:00:01Z", "status")];
    expect(changedManagers(before, now)).toEqual({ managers: [m("kubectl-edit", "2026-03-02T09:00:00Z")], exact: true });
  });

  it("without a previous look, takes the most recent non-status manager as likely", () => {
    const now = [m("helm", "2026-03-01T10:00:00Z"), m("argocd-controller", "2026-03-02T09:00:00Z", null, "Apply"), m("x", "2026-03-03T00:00:00Z", "status")];
    expect(changedManagers(undefined, now)).toEqual({ managers: [now[1]], exact: false });
    expect(changedManagers(undefined, [m("x", "2026-03-03T00:00:00Z", "status")])).toBeNull();
  });

  it("knows the usual managers by the names people use", () => {
    expect(friendlyManager("kubectl-client-side-apply")).toBe("kubectl apply");
    expect(friendlyManager("kubectl-edit")).toBe("kubectl edit");
    expect(friendlyManager("helm")).toBe("Helm");
    expect(friendlyManager("argocd-controller")).toBe("Argo CD");
    expect(friendlyManager("kustomize-controller")).toBe("Flux (kustomize-controller)");
    expect(friendlyManager("my-operator")).toBeUndefined();
  });
});

describe("what went wrong after a change", () => {
  const at = Date.parse("2026-03-02T10:00:00Z");
  const signal = (kind: string, name: string, minutes: number, reason = "CrashLoopBackOff"): Signal => ({
    type: "problem",
    reason,
    object: { kind: { group: kind === "Pod" ? "" : "apps", version: "v1", kind }, namespace: "shop", name },
    at: at + minutes * 60_000,
  });

  it("follows owners and references to dependents", () => {
    const rs = { metadata: { name: "web-5d4f", namespace: "shop", uid: "rs1", ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "web", uid: "d1", controller: true }] } };
    const pod = {
      metadata: { name: "web-5d4f-abcde", namespace: "shop", uid: "p1", ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "web-5d4f", uid: "rs1", controller: true }] },
      spec: { containers: [{ name: "web", envFrom: [{ configMapRef: { name: "settings" } }] }] },
    };
    const deploy = { metadata: { name: "web", namespace: "shop", uid: "d1" }, spec: { selector: { matchLabels: {} } } };
    const hpa = { metadata: { name: "web", namespace: "shop" }, spec: { scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: "web" } } };
    const graph = buildGraph([
      { kind: DEPLOYMENT, items: [deploy] },
      { kind: REPLICA_SET, items: [rs] },
      { kind: POD, items: [pod] },
      { kind: HPA, items: [hpa] },
      { kind: CONFIG_MAP, items: [{ metadata: { name: "settings", namespace: "shop" } }] },
    ]);
    const podKey = "/Pod/shop/web-5d4f-abcde";
    expect(dependents(graph, { kind: DEPLOY, namespace: "shop", name: "web" }).has(podKey)).toBe(true);
    expect(dependents(graph, { kind: { group: "", kind: "ConfigMap" }, namespace: "shop", name: "settings" }).has(podKey)).toBe(true);
    expect(dependents(graph, { kind: { group: "autoscaling", kind: "HorizontalPodAutoscaler" }, namespace: "shop", name: "web" }).has(podKey)).toBe(true);
    expect(dependents(null, { kind: DEPLOY, namespace: "shop", name: "web" }).size).toBe(0);
  });

  it("matches signals in the window, on the object or its dependents, once per object and reason", () => {
    const subject = { at, kind: DEPLOY, namespace: "shop", name: "web" };
    const signals = [
      signal("Pod", "web-5d4f-abcde", 2),
      signal("Pod", "web-5d4f-abcde", 5),
      signal("Pod", "other-1", 3),
      signal("Pod", "web-5d4f-xyz12", -10),
      signal("Pod", "web-5d4f-late1", CORRELATION_WINDOW_MS / 60_000 + 1),
      signal("Deployment", "web", 4, "ProgressDeadlineExceeded"),
    ];
    // Without a graph, pods named after the workload count.
    const found = correlate(subject, signals);
    expect(found.map((c) => [c.signal.object.name, c.delayMs / 60_000, c.via])).toEqual([
      ["web-5d4f-abcde", 2, "dependent"],
      ["web", 4, "same"],
    ]);
    // With the graph, a dependent of another name counts too.
    const related = correlate(subject, signals, new Set(["/Pod/shop/other-1"]));
    expect(related.map((c) => c.signal.object.name)).toEqual(["web-5d4f-abcde", "other-1", "web"]);
    const lots = Array.from({ length: 20 }, (_, i) => signal("Pod", `web-x-${i}`, 1));
    expect(correlate(subject, lots)).toHaveLength(MAX_CORRELATIONS);
  });
});
