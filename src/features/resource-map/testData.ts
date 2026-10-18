// Objects of one namespace ("shop") for the resource map's tests (Vitest only; never imported by application code):
// a Deployment with its ReplicaSet and two pods, a Service with its EndpointSlice, an Ingress, an HTTPRoute, an HPA,
// a PDB, a deny-all NetworkPolicy, a StatefulSet whose pod mounts a bound claim, and a CronJob with a run.
import type { KindRef, KubeObject } from "../../api";
import { HTTP_ROUTE } from "../gateway-api/model";
import type { GraphInput } from "./relations";
import {
  CRON_JOB,
  DEPLOYMENT,
  ENDPOINT_SLICE,
  HPA,
  INGRESS,
  JOB,
  NETWORK_POLICY,
  PDB,
  POD,
  PV,
  PVC,
  REPLICA_SET,
  SERVICE,
  STATEFUL_SET,
} from "./kinds";

const NS = "shop";

const owner = (kind: KindRef, name: string, controller = true) => ({
  apiVersion: kind.group ? `${kind.group}/${kind.version}` : kind.version,
  kind: kind.kind,
  name,
  uid: `uid-${name}`,
  controller,
});

const meta = (name: string, extra: Record<string, unknown> = {}, namespace: string | null = NS) => ({
  name,
  ...(namespace ? { namespace } : {}),
  uid: `uid-${name}`,
  ...extra,
});

export const webPodSpec = {
  serviceAccountName: "web",
  imagePullSecrets: [{ name: "regcred" }],
  volumes: [
    { name: "config", configMap: { name: "web-config" } },
    { name: "flags", configMap: { name: "flags", optional: true } },
    { name: "certs", projected: { sources: [{ secret: { name: "web-certs" } }] } },
  ],
  containers: [
    {
      name: "app",
      envFrom: [{ secretRef: { name: "web-env" } }],
      env: [{ name: "MODE", valueFrom: { configMapKeyRef: { name: "web-config", key: "mode" } } }],
    },
  ],
};

export const deployment: KubeObject = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: meta("web"),
  spec: { replicas: 2, selector: { matchLabels: { app: "web" } }, template: { metadata: { labels: { app: "web" } }, spec: webPodSpec } },
  status: { replicas: 2, readyReplicas: 2, availableReplicas: 2, updatedReplicas: 2 },
};

export const replicaSet: KubeObject = {
  apiVersion: "apps/v1",
  kind: "ReplicaSet",
  metadata: meta("web-7d9f8c6b5", { ownerReferences: [owner(DEPLOYMENT, "web")], labels: { app: "web" } }),
  spec: { template: { spec: webPodSpec } },
  status: { replicas: 2, readyReplicas: 2 },
};

export function webPod(name: string, extra: Partial<KubeObject> = {}): KubeObject {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: meta(name, { labels: { app: "web" }, ownerReferences: [owner(REPLICA_SET, "web-7d9f8c6b5")] }),
    spec: { ...webPodSpec, nodeName: "node-1" },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
    ...extra,
  };
}

export const pods = [webPod("web-7d9f8c6b5-a1"), webPod("web-7d9f8c6b5-b2")];

export const service: KubeObject = {
  apiVersion: "v1",
  kind: "Service",
  metadata: meta("web"),
  spec: { selector: { app: "web" }, ports: [{ port: 80 }] },
};

export const headless: KubeObject = {
  apiVersion: "v1",
  kind: "Service",
  metadata: meta("legacy"),
  spec: { ports: [{ port: 80 }] },
};

export const endpointSlice: KubeObject = {
  apiVersion: "discovery.k8s.io/v1",
  kind: "EndpointSlice",
  metadata: meta("web-x7k2p", { labels: { "kubernetes.io/service-name": "web" }, ownerReferences: [owner(SERVICE, "web")] }),
  endpoints: pods.map((p) => ({ addresses: ["10.0.0.1"], targetRef: { kind: "Pod", name: p.metadata?.name, namespace: NS } })),
};

export const ingress: KubeObject = {
  apiVersion: "networking.k8s.io/v1",
  kind: "Ingress",
  metadata: meta("shop"),
  spec: {
    ingressClassName: "nginx",
    tls: [{ hosts: ["shop.example.com"], secretName: "shop-tls" }],
    rules: [{ host: "shop.example.com", http: { paths: [{ path: "/", backend: { service: { name: "web", port: { number: 80 } } } }] } }],
  },
};

export const httpRoute: KubeObject = {
  apiVersion: "gateway.networking.k8s.io/v1",
  kind: "HTTPRoute",
  metadata: meta("web"),
  spec: {
    parentRefs: [{ name: "public-gw", namespace: "infra" }],
    rules: [{ backendRefs: [{ name: "web", port: 80 }, { name: "gone", port: 80 }] }],
  },
};

export const hpa: KubeObject = {
  apiVersion: "autoscaling/v2",
  kind: "HorizontalPodAutoscaler",
  metadata: meta("web"),
  spec: { scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: "web" }, minReplicas: 2, maxReplicas: 5 },
};

export const pdb: KubeObject = {
  apiVersion: "policy/v1",
  kind: "PodDisruptionBudget",
  metadata: meta("web"),
  spec: { minAvailable: 1, selector: { matchLabels: { app: "web" } } },
};

export const denyAll: KubeObject = {
  apiVersion: "networking.k8s.io/v1",
  kind: "NetworkPolicy",
  metadata: meta("deny-all"),
  spec: { podSelector: {}, policyTypes: ["Ingress"] },
};

export const statefulSet: KubeObject = {
  apiVersion: "apps/v1",
  kind: "StatefulSet",
  metadata: meta("db"),
  spec: { replicas: 1, selector: { matchLabels: { app: "db" } }, template: { spec: { containers: [{ name: "db" }] } } },
  status: { replicas: 1, readyReplicas: 1 },
};

export const dbPod: KubeObject = {
  apiVersion: "v1",
  kind: "Pod",
  metadata: meta("db-0", { labels: { app: "db" }, ownerReferences: [owner(STATEFUL_SET, "db")] }),
  spec: { nodeName: "node-2", serviceAccountName: "default", volumes: [{ name: "data", persistentVolumeClaim: { claimName: "data-db-0" } }], containers: [{ name: "db" }] },
  status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
};

export const claim: KubeObject = {
  apiVersion: "v1",
  kind: "PersistentVolumeClaim",
  metadata: meta("data-db-0"),
  spec: { volumeName: "pv-1", storageClassName: "standard" },
  status: { phase: "Bound" },
};

export const volume: KubeObject = {
  apiVersion: "v1",
  kind: "PersistentVolume",
  metadata: meta("pv-1", {}, null),
  spec: { claimRef: { namespace: NS, name: "data-db-0" }, storageClassName: "standard" },
  status: { phase: "Bound" },
};

export const cronJob: KubeObject = {
  apiVersion: "batch/v1",
  kind: "CronJob",
  metadata: meta("report"),
  spec: { schedule: "0 * * * *", jobTemplate: { spec: { template: { spec: { containers: [{ name: "r", envFrom: [{ configMapRef: { name: "report-config" } }] }] } } } } },
};

export const job: KubeObject = {
  apiVersion: "batch/v1",
  kind: "Job",
  metadata: meta("report-29000000", { ownerReferences: [owner(CRON_JOB, "report")] }),
  spec: { template: { spec: { containers: [{ name: "r", envFrom: [{ configMapRef: { name: "report-config" } }] }] } } },
  status: { succeeded: 1, conditions: [{ type: "Complete", status: "True" }] },
};

export const jobPod: KubeObject = {
  apiVersion: "v1",
  kind: "Pod",
  metadata: meta("report-29000000-q8x", { ownerReferences: [owner(JOB, "report-29000000")] }),
  spec: { nodeName: "node-1", serviceAccountName: "default", containers: [{ name: "r", envFrom: [{ configMapRef: { name: "report-config" } }] }] },
  status: { phase: "Succeeded" },
};

/** Every object of the namespace by kind, as the watches would bring them. */
export const SHOP: { kind: KindRef; items: KubeObject[] }[] = [
  { kind: DEPLOYMENT, items: [deployment] },
  { kind: REPLICA_SET, items: [replicaSet] },
  { kind: POD, items: [...pods, dbPod, jobPod] },
  { kind: SERVICE, items: [service, headless] },
  { kind: ENDPOINT_SLICE, items: [endpointSlice] },
  { kind: INGRESS, items: [ingress] },
  { kind: HTTP_ROUTE, items: [httpRoute] },
  { kind: HPA, items: [hpa] },
  { kind: PDB, items: [pdb] },
  { kind: NETWORK_POLICY, items: [denyAll] },
  { kind: STATEFUL_SET, items: [statefulSet] },
  { kind: PVC, items: [claim] },
  { kind: CRON_JOB, items: [cronJob] },
  { kind: JOB, items: [job] },
];

export const SHOP_WITH_PV: GraphInput[] = [...SHOP, { kind: PV, items: [volume] }];

/** `count` pods of one ReplicaSet (the big-namespace test), every tenth crash-looping. */
export function manyPods(count: number, namespace = NS): KubeObject[] {
  return Array.from({ length: count }, (_, i) => ({
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: `big-5c8d7f9b6-${i}`,
      namespace,
      uid: `uid-big-${i}`,
      labels: { app: "big" },
      creationTimestamp: "2026-01-01T00:00:00Z",
      ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "big-5c8d7f9b6", uid: "uid-rs-big", controller: true }],
    },
    spec: { nodeName: `node-${i % 7}`, volumes: [{ name: "c", configMap: { name: "big-config" } }], containers: [{ name: "app" }] },
    status:
      i % 10 === 0
        ? {
            phase: "Running",
            containerStatuses: [
              {
                name: "app",
                restartCount: 9,
                state: { waiting: { reason: "CrashLoopBackOff" } },
                lastState: { terminated: { reason: "Error", finishedAt: "2026-01-01T00:00:00Z" } },
              },
            ],
          }
        : { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
  }));
}
