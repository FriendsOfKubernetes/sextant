import { describe, expect, it } from "vitest";
import type { DriftObject, KindRef, KubeObject } from "../../api";
import { driftOf } from "./HelmDrift";
import { bucketize, countBuckets, driftChanges, fieldChanges, objectDrift } from "./model";
import { differentSecrets } from "./namespaceRun";
import { normalize, type NormalizeOptions } from "./normalize";
import { cleanIgnorePaths, formatPath, MAX_IGNORE_PATHS, parsePath, removeAt } from "./paths";

const deployment: KindRef = { group: "apps", version: "v1", kind: "Deployment" };
const service: KindRef = { group: "", version: "v1", kind: "Service" };
const secret: KindRef = { group: "", version: "v1", kind: "Secret" };
const pod: KindRef = { group: "", version: "v1", kind: "Pod" };
const off: NormalizeOptions = { hideDefaults: false, ignorePaths: [] };
const defaults: NormalizeOptions = { hideDefaults: true, ignorePaths: [] };

describe("normalize", () => {
  const cases: Array<{ name: string; kind: KindRef; input: KubeObject; options?: NormalizeOptions; expected: unknown }> = [
    {
      name: "drops status and server-written metadata",
      kind: service,
      input: {
        apiVersion: "v1",
        kind: "Service",
        metadata: {
          name: "web",
          namespace: "prod",
          uid: "u1",
          resourceVersion: "9",
          generation: 3,
          creationTimestamp: "2026-01-01T00:00:00Z",
          selfLink: "/api/v1/x",
          managedFields: [{}],
          labels: { app: "web" },
        },
        spec: { ports: [{ port: 80 }] },
        status: { loadBalancer: {} },
      },
      expected: { apiVersion: "v1", kind: "Service", metadata: { name: "web", labels: { app: "web" } }, spec: { ports: [{ port: 80 }] } },
    },
    {
      name: "removes generated names, hash labels, owner uids and noise annotations",
      kind: { group: "apps", version: "v1", kind: "ReplicaSet" },
      input: {
        metadata: {
          name: "web-7c9f8d6b5",
          generateName: "web-",
          labels: { app: "web", "pod-template-hash": "7c9f8d6b5" },
          annotations: {
            "deployment.kubernetes.io/revision": "4",
            "kubectl.kubernetes.io/last-applied-configuration": "{}",
            team: "a",
          },
          ownerReferences: [{ kind: "Deployment", name: "web", uid: "x" }],
        },
        spec: {
          selector: { matchLabels: { app: "web", "pod-template-hash": "7c9f8d6b5" } },
          template: { metadata: { creationTimestamp: null, labels: { app: "web", "pod-template-hash": "7c9f8d6b5" } } },
        },
      },
      expected: {
        metadata: {
          name: "web-",
          generateName: "web-",
          labels: { app: "web" },
          annotations: { team: "a" },
          ownerReferences: [{ kind: "Deployment", name: "web" }],
        },
        spec: { selector: { matchLabels: { app: "web" } }, template: { metadata: { labels: { app: "web" } } } },
      },
    },
    {
      name: "never keeps Secret data or the hidden-values marker",
      kind: secret,
      input: {
        metadata: { name: "s", annotations: { "sextant.dev/values-hidden": "true" } },
        type: "Opaque",
        data: { a: "" },
        stringData: { b: "" },
      },
      expected: { metadata: { name: "s" }, type: "Opaque" },
    },
    {
      name: "keeps defaulted fields while 'hide defaults' is off",
      kind: deployment,
      input: { spec: { revisionHistoryLimit: 10, template: { spec: { dnsPolicy: "ClusterFirst" } } } },
      expected: { spec: { revisionHistoryLimit: 10, template: { spec: { dnsPolicy: "ClusterFirst" } } } },
    },
    {
      name: "hides defaults that hold the default value only",
      kind: deployment,
      options: defaults,
      input: {
        spec: {
          revisionHistoryLimit: 10,
          progressDeadlineSeconds: 900,
          strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: "25%", maxUnavailable: "25%" } },
          template: {
            spec: {
              dnsPolicy: "ClusterFirst",
              restartPolicy: "Always",
              containers: [
                {
                  name: "app",
                  imagePullPolicy: "Always",
                  terminationMessagePath: "/dev/termination-log",
                  ports: [{ containerPort: 80, protocol: "TCP" }],
                  livenessProbe: { periodSeconds: 10, timeoutSeconds: 5 },
                },
              ],
              initContainers: [{ name: "init", terminationMessagePolicy: "File" }],
            },
          },
        },
      },
      expected: {
        spec: {
          progressDeadlineSeconds: 900,
          template: {
            spec: {
              containers: [{ name: "app", imagePullPolicy: "Always", ports: [{ containerPort: 80 }], livenessProbe: { timeoutSeconds: 5 } }],
              initContainers: [{ name: "init" }],
            },
          },
        },
      },
    },
    {
      name: "hides a Service's assigned IPs and defaults",
      kind: service,
      options: defaults,
      input: { spec: { type: "ClusterIP", clusterIP: "10.0.0.1", clusterIPs: ["10.0.0.1"], sessionAffinity: "None", ports: [{ port: 80, protocol: "UDP" }] } },
      expected: { spec: { ports: [{ port: 80, protocol: "UDP" }] } },
    },
    {
      name: "applies pod defaults to a Pod's own spec",
      kind: pod,
      options: defaults,
      input: { spec: { schedulerName: "default-scheduler", containers: [{ name: "c", resources: {} }] } },
      expected: { spec: { containers: [{ name: "c" }] } },
    },
    {
      name: "removes the ignore paths, with * for any key or item",
      kind: deployment,
      options: { hideDefaults: false, ignorePaths: ["/spec/replicas", "/spec/template/spec/containers/*/image", "/metadata/labels/app.kubernetes.io~1version", "not a path"] },
      input: {
        metadata: { labels: { "app.kubernetes.io/version": "1.2", app: "web" } },
        spec: { replicas: 3, template: { spec: { containers: [{ name: "a", image: "x:1" }, { name: "b", image: "y:2" }] } } },
      },
      expected: { metadata: { labels: { app: "web" } }, spec: { template: { spec: { containers: [{ name: "a" }, { name: "b" }] } } } },
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const before = structuredClone(c.input);
      expect(normalize(c.input, c.kind, c.options ?? off)).toEqual(c.expected);
      expect(c.input).toEqual(before);
    });
  }
});

describe("ignore paths", () => {
  it("parses JSON-pointer-like paths with escapes and refuses what is not one", () => {
    expect(parsePath("/metadata/labels/a~1b~0c")).toEqual(["metadata", "labels", "a/b~c"]);
    expect(formatPath(["metadata", "labels", "a/b~c"])).toBe("/metadata/labels/a~1b~0c");
    for (const bad of ["", "/", "spec", "/a//b", `/${"x".repeat(300)}`, "/a\u0007"]) expect(parsePath(bad)).toBeNull();
  });

  it("removes list items by index and every item with *", () => {
    const value = { items: [{ a: 1, b: 2 }, { a: 3 }] };
    removeAt(value, ["items", "*", "a"]);
    expect(value).toEqual({ items: [{ b: 2 }, {}] });
    removeAt(value, ["items", "0"]);
    expect(value).toEqual({ items: [{}] });
  });

  it("cleans saved paths: invalid, repeated and past the cap are left out", () => {
    const many = Array.from({ length: MAX_IGNORE_PATHS + 5 }, (_, i) => `/p${i}`);
    expect(cleanIgnorePaths(["/a", "/a", "b", 7, " /c "])).toEqual(["/a", "/c"]);
    expect(cleanIgnorePaths(many)).toHaveLength(MAX_IGNORE_PATHS);
  });
});

describe("namespace comparison buckets", () => {
  const cm = (name: string, data: Record<string, string>, extra: Record<string, unknown> = {}): KubeObject => ({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name, namespace: "x", uid: `${name}-${Math.random()}`, ...extra },
    data,
  });
  const configMap: KindRef = { group: "", version: "v1", kind: "ConfigMap" };

  it("sorts objects into only-left, only-right, differ and same, honouring ignore paths", () => {
    const left = [cm("a", { k: "1" }), cm("b", { k: "1" }), cm("c", { k: "1", v: "1" }), cm("left", {})];
    const right = [cm("a", { k: "1" }, { resourceVersion: "7" }), cm("b", { k: "2" }), cm("c", { k: "1", v: "2" }), cm("right", {})];
    const rows = bucketize(configMap, left, right, { hideDefaults: false, ignorePaths: { "/ConfigMap": ["/data/v"] } });
    expect(rows.map((r) => [r.name, r.bucket])).toEqual([
      ["a", "same"],
      ["b", "differ"],
      ["c", "same"],
      ["left", "onlyLeft"],
      ["right", "onlyRight"],
    ]);
    expect(countBuckets(rows)).toEqual({ onlyLeft: 1, onlyRight: 1, differ: 1, same: 2 });
  });

  it("counts Secrets with other values as different although their YAML is the same", () => {
    const s = (name: string): KubeObject => ({ kind: "Secret", metadata: { name }, type: "Opaque", data: { k: "" } });
    const different = differentSecrets({
      truncated: false,
      secrets: [
        { name: "same", keys: [{ key: "k", onLeft: true, onRight: true, equal: true }] },
        { name: "other", keys: [{ key: "k", onLeft: true, onRight: true, equal: false }] },
      ],
    });
    const rows = bucketize(secret, [s("same"), s("other")], [s("same"), s("other")], { hideDefaults: false, ignorePaths: {}, differentSecrets: different });
    expect(rows.map((r) => [r.name, r.bucket])).toEqual([
      ["other", "differ"],
      ["same", "same"],
    ]);
  });
});

describe("drift", () => {
  it("lists every differing leaf between two objects", () => {
    expect(fieldChanges({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 3] }, d: true })).toEqual([
      { path: "/b/c/1", left: 2, right: 3 },
      { path: "/d", left: undefined, right: true },
    ]);
  });

  it("counts only what the desired configuration sets", () => {
    const desired = { spec: { replicas: 2, template: { spec: { containers: [{ name: "a", image: "x:1" }] } } } };
    const live = {
      spec: { replicas: 3, revisionHistoryLimit: 10, template: { spec: { dnsPolicy: "ClusterFirst", containers: [{ name: "a", image: "x:1", imagePullPolicy: "IfNotPresent" }] } } },
    };
    expect(driftChanges(desired, live)).toEqual([{ path: "/spec/replicas", left: 2, right: 3 }]);
  });

  /** A Helm manifest object and the live objects as `compare_helm_drift` returns them. */
  const fixture: DriftObject[] = [
    {
      object: { kind: { group: "apps", version: "v1", kind: "Deployment" }, namespace: "team", name: "web" },
      rendered: { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web", labels: { app: "web" } }, spec: { replicas: 2 } },
      live: {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: "web", namespace: "team", uid: "u", labels: { app: "web" }, annotations: { "deployment.kubernetes.io/revision": "3" } },
        spec: { replicas: 5, progressDeadlineSeconds: 600 },
      },
      error: null,
    },
    {
      object: { kind: { group: "", version: "v1", kind: "ConfigMap" }, namespace: "team", name: "cfg" },
      rendered: { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "cfg" }, data: { a: "1" } },
      live: { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "cfg", namespace: "team" }, data: { a: "1", added: "x" } },
      error: null,
    },
    {
      object: { kind: { group: "", version: "v1", kind: "Secret" }, namespace: "team", name: "creds" },
      rendered: { apiVersion: "v1", kind: "Secret", metadata: { name: "creds" }, data: { k: "" } },
      live: { apiVersion: "v1", kind: "Secret", metadata: { name: "creds", namespace: "team" }, data: { k: "" } },
      error: null,
      secretKeys: [{ key: "k", onLeft: true, onRight: true, equal: false }],
    },
    {
      object: { kind: { group: "", version: "v1", kind: "Service" }, namespace: "team", name: "gone" },
      rendered: { apiVersion: "v1", kind: "Service", metadata: { name: "gone" } },
      live: null,
      error: null,
    },
  ];

  it("tells each object of a release fixture apart: drifted, in sync, Secret by hash, missing", () => {
    const states = fixture.map((o) => driftOf(o, off));
    expect(states.map((s) => s.state)).toEqual(["drifted", "inSync", "drifted", "missing"]);
    expect(states[0]?.changes).toEqual([{ path: "/spec/replicas", left: 2, right: 5 }]);
    expect(states[2]?.secretKeys).toBe(1);
  });

  it("honours ignore paths in drift", () => {
    const first = fixture[0] as DriftObject;
    expect(objectDrift(first.rendered, first.live, deployment, { hideDefaults: false, ignorePaths: ["/spec/replicas"] })).toEqual([]);
  });
});
