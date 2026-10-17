// Objects for the rollout tests (Vitest only; never imported by application code): a Deployment `shop/web` at revision
// 3 with its ReplicaSets, and a StatefulSet / DaemonSet `shop/web` with their ControllerRevisions.
import type { KubeObject } from "../../api";

export function template(image: string, labels: Record<string, string> = {}): Record<string, unknown> {
  return {
    metadata: { labels: { app: "web", ...labels } },
    spec: { containers: [{ name: "web", image }] },
  };
}

export function deployment({ paused = false, image = "nginx:1.27" } = {}): KubeObject {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: "web",
      namespace: "shop",
      uid: "dep-uid",
      generation: 4,
      annotations: {
        "deployment.kubernetes.io/revision": "3",
        "kubectl.kubernetes.io/last-applied-configuration": "{}",
        team: "shop",
      },
    },
    spec: {
      replicas: 3,
      paused,
      selector: { matchLabels: { app: "web" } },
      template: template(image),
    },
    status: { observedGeneration: 4, replicas: 3, updatedReplicas: 3, readyReplicas: 3, availableReplicas: 3 },
  };
}

export function replicaSet(revision: number, image: string, cause?: string, owner = "dep-uid"): KubeObject {
  const annotations: Record<string, string> = {
    "deployment.kubernetes.io/revision": String(revision),
    "deployment.kubernetes.io/desired-replicas": "3",
    team: "shop",
  };
  if (cause) annotations["kubernetes.io/change-cause"] = cause;
  return {
    apiVersion: "apps/v1",
    kind: "ReplicaSet",
    metadata: {
      name: owner === "dep-uid" ? `web-${revision}` : `other-${revision}`,
      namespace: "shop",
      uid: `rs-${owner}-${revision}`,
      creationTimestamp: "2026-10-01T10:00:00Z",
      annotations,
      ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "web", uid: owner, controller: true }],
    },
    spec: { selector: { matchLabels: { app: "web" } }, template: template(image, { "pod-template-hash": `h${revision}` }) },
  };
}

export function controllerRevision(ownerKind: string, name: string, revision: number, image: string): KubeObject {
  const stored = template(image);
  return {
    apiVersion: "apps/v1",
    kind: "ControllerRevision",
    metadata: {
      name,
      namespace: "shop",
      uid: `cr-${name}`,
      creationTimestamp: "2026-10-02T10:00:00Z",
      labels: { app: "web" },
      ownerReferences: [{ apiVersion: "apps/v1", kind: ownerKind, name: "web", uid: "set-uid", controller: true }],
    },
    revision,
    // As the controller writes it: the whole template, replacing.
    data: {
      spec: { template: { ...stored, metadata: { creationTimestamp: null, labels: { app: "web" } }, $patch: "replace" } },
    },
  };
}

export function statefulSet(status: Record<string, unknown> = {}): KubeObject {
  return {
    apiVersion: "apps/v1",
    kind: "StatefulSet",
    metadata: { name: "web", namespace: "shop", uid: "set-uid", generation: 2 },
    spec: {
      replicas: 2,
      serviceName: "web",
      selector: { matchLabels: { app: "web" } },
      template: { ...template("redis:7.2"), metadata: { creationTimestamp: null, labels: { app: "web" } } },
      updateStrategy: { type: "RollingUpdate" },
    },
    status: {
      observedGeneration: 2,
      replicas: 2,
      readyReplicas: 2,
      updatedReplicas: 2,
      currentRevision: "web-b",
      updateRevision: "web-b",
      ...status,
    },
  };
}

export function daemonSet(): KubeObject {
  return {
    apiVersion: "apps/v1",
    kind: "DaemonSet",
    metadata: { name: "web", namespace: "shop", uid: "set-uid", generation: 1 },
    spec: { selector: { matchLabels: { app: "web" } }, template: template("redis:7.2") },
    status: { observedGeneration: 1, desiredNumberScheduled: 1, updatedNumberScheduled: 1, numberReady: 1, numberAvailable: 1 },
  };
}
