import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import { allowsNoDisruption, evaluate, evaluateAll, indexLimits, indexPlacements, type Context } from "./checks";
import { hpaInfo, limitDefaults, pdbInfo, placementOf, workloadInfo, type CheckId, type WorkloadInfo } from "./model";
import { schedulingNode, type SchedulingNode } from "./taps";

const good = {
  name: "app",
  image: "registry.example/app:1.4.2",
  ports: [{ containerPort: 8080 }],
  readinessProbe: { httpGet: { path: "/ready", port: 8080 } },
  livenessProbe: { httpGet: { path: "/live", port: 8080 } },
  resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { memory: "256Mi" } },
};

function workload(kind: string, spec: Record<string, unknown> = {}, pod: Record<string, unknown> = {}, name = "web"): KubeObject {
  const template = { metadata: { labels: { app: name } }, spec: { containers: [good], ...pod } };
  const base = kind === "CronJob" ? { jobTemplate: { spec: { template } } } : { template };
  return {
    apiVersion: kind.endsWith("Job") ? "batch/v1" : "apps/v1",
    kind,
    metadata: { name, namespace: "shop", uid: `${kind}-${name}` },
    spec: { selector: { matchLabels: { app: name } }, ...(kind === "Deployment" || kind === "StatefulSet" ? { replicas: 3 } : {}), ...base, ...spec },
  };
}

const info = (obj: KubeObject): WorkloadInfo => workloadInfo(obj.kind!, obj)!;
const node = (name: string, spec: Record<string, unknown> = {}, labels: Record<string, string> = {}): SchedulingNode | null =>
  schedulingNode({ apiVersion: "v1", kind: "Node", metadata: { name, labels: { "kubernetes.io/hostname": name, ...labels } }, spec });
const plainNodes = (...names: string[]) => names.map((n) => node(n)!);
/** Everything is known and nothing surrounds the workload. */
const known: Context = { hpas: [], pdbs: [], limits: new Map(), nodes: new Map(), schedulableNodes: plainNodes("n1", "n2", "n3") };
const pdb = (spec: Record<string, unknown>, extra: Record<string, unknown> = {}): KubeObject => ({
  apiVersion: "policy/v1",
  kind: "PodDisruptionBudget",
  metadata: { name: "web-pdb", namespace: "shop" },
  spec: { selector: { matchLabels: { app: "web" } }, ...spec },
  ...extra,
});
const withPdb: Context = { ...known, pdbs: [pdbInfo(pdb({ maxUnavailable: 1 }))] };
const checksOf = (obj: KubeObject, ctx: Context = withPdb): CheckId[] => evaluate(info(obj), ctx).map((f) => f.check).sort();

describe("the best-practice checks", () => {
  it.each<[string, KubeObject, CheckId[], Context?]>([
    ["a well-configured Deployment", workload("Deployment"), []],
    ["no probes at all", workload("Deployment", {}, { containers: [{ ...good, readinessProbe: undefined, livenessProbe: undefined }] }), ["livenessProbe", "readinessProbe"]],
    ["a worker without ports needs no readiness probe", workload("Deployment", {}, { containers: [{ ...good, ports: undefined, readinessProbe: undefined }] }), []],
    ["a sidecar without probes is fine when the main container has them", workload("Deployment", {}, { containers: [good, { name: "proxy", image: "envoy:1.30", ports: [{ containerPort: 15001 }], resources: good.resources }] }), []],
    ["a DaemonSet needs no liveness probe", workload("DaemonSet", {}, { containers: [{ ...good, livenessProbe: undefined }] }), []],
    ["a DaemonSet serving a port needs a readiness probe", workload("DaemonSet", {}, { containers: [{ ...good, readinessProbe: undefined }] }), ["readinessProbe"]],
    ["Jobs and CronJobs need no probes", workload("CronJob", {}, { containers: [{ ...good, readinessProbe: undefined, livenessProbe: undefined }] }), []],
    ["init containers need no probes", workload("Deployment", {}, { initContainers: [{ name: "migrate", image: "migrate:2", resources: good.resources }] }), []],
    ["a :latest image", workload("Deployment", {}, { containers: [{ ...good, image: "nginx:latest" }] }), ["mutableImage"]],
    ["an untagged image in an init container", workload("Job", {}, { initContainers: [{ name: "i", image: "busybox" }] }), ["mutableImage"]],
    ["an image on a registry port without a tag", workload("Deployment", {}, { containers: [{ ...good, image: "registry:5000/app" }] }), ["mutableImage"]],
    ["a digest-pinned image", workload("Deployment", {}, { containers: [{ ...good, image: "nginx@sha256:abc" }] }), []],
    ["Always on a digest", workload("Deployment", {}, { containers: [{ ...good, image: "nginx:1.27@sha256:abc", imagePullPolicy: "Always" }] }), ["pullAlwaysDigest"]],
    ["Always on a tag", workload("Deployment", {}, { containers: [{ ...good, imagePullPolicy: "Always" }] }), []],
    ["one replica", workload("Deployment", { replicas: 1 }), ["singleReplica"]],
    ["zero replicas", workload("Deployment", { replicas: 0 }), []],
    ["one replica with Recreate", workload("Deployment", { replicas: 1, strategy: { type: "Recreate" } }), []],
    ["one replica, HPA-managed with min 2", workload("Deployment", { replicas: 1 }), [], { ...withPdb, hpas: [hpaInfo({ metadata: { name: "web", namespace: "shop" }, spec: { scaleTargetRef: { kind: "Deployment", name: "web" }, minReplicas: 2, maxReplicas: 5 } })] }],
    ["an HPA with min 1", workload("Deployment"), ["singleReplica"], { ...withPdb, hpas: [hpaInfo({ metadata: { name: "web", namespace: "shop" }, spec: { scaleTargetRef: { kind: "Deployment", name: "web" }, maxReplicas: 5 } })] }],
    ["an HPA with min == max", workload("Deployment"), ["hpaMinEqualsMax"], { ...withPdb, hpas: [hpaInfo({ metadata: { name: "web", namespace: "shop" }, spec: { scaleTargetRef: { kind: "Deployment", name: "web" }, minReplicas: 3, maxReplicas: 3 } })] }],
    ["unknown HPAs: replicas are not judged", workload("Deployment", { replicas: 1 }), [], { ...withPdb, hpas: undefined }],
    ["several replicas without a PDB", workload("Deployment"), ["noPdb"], known],
    ["one replica needs no PDB", workload("StatefulSet", { replicas: 1 }), ["singleReplica"], known],
    ["unknown PDBs are not judged", workload("Deployment"), [], { ...known, pdbs: undefined }],
    ["a PDB of another app does not count", workload("Deployment", {}, {}, "api"), ["noPdb"]],
    ["no requests", workload("Deployment", {}, { containers: [{ ...good, resources: {} }] }), ["noMemoryLimit", "noRequests"]],
    ["a limit alone is also the request", workload("Deployment", {}, { containers: [{ ...good, resources: { limits: { cpu: "1", memory: "1Gi" } } }] }), []],
    ["LimitRange defaults count as set", workload("Deployment", {}, { containers: [{ ...good, resources: {} }] }), [], { ...withPdb, limits: indexLimits([limitDefaults({ metadata: { namespace: "shop" }, spec: { limits: [{ type: "Container", default: { cpu: "500m", memory: "512Mi" } }] } })]) }],
    ["unknown LimitRanges: resources are not judged", workload("Deployment", {}, { containers: [{ ...good, resources: {} }] }), [], { ...withPdb, limits: undefined }],
    ["a native sidecar without requests", workload("Deployment", {}, { initContainers: [{ name: "log", image: "fluent-bit:3.1", restartPolicy: "Always" }] }), ["noMemoryLimit", "noRequests"]],
  ])("%s", (_name, obj, expected, ctx) => {
    expect(checksOf(obj, ctx)).toEqual(expected);
  });

  it("skips the Jobs a CronJob runs and objects being deleted", () => {
    const owned = workload("Job");
    owned.metadata!.ownerReferences = [{ apiVersion: "batch/v1", kind: "CronJob", name: "nightly", uid: "c", controller: true }];
    expect(workloadInfo("Job", owned)).toBeNull();
    expect(workloadInfo("Deployment", { ...workload("Deployment"), metadata: { name: "x", deletionTimestamp: "2026-01-01T00:00:00Z" } })).toBeNull();
    expect(workloadInfo("Pod", { metadata: { name: "p" } })).toBeNull();
  });

  it("gives the exact field and a fix under the template", () => {
    const [f] = evaluate(info(workload("CronJob", {}, { containers: [{ ...good, image: "nginx" }] })), withPdb);
    expect(f).toMatchObject({
      check: "mutableImage",
      path: "spec.jobTemplate.spec.template.spec.containers[0].image",
      value: "nginx",
      container: "app",
      fix: { spec: { jobTemplate: { spec: { template: { spec: { containers: [{ name: "app", image: "nginx:<version>" }] } } } } } },
    });
    const [noPdb] = evaluate(info(workload("Deployment")), known);
    expect(noPdb).toMatchObject({ fixType: "create", fix: { kind: "PodDisruptionBudget", spec: { maxUnavailable: 1, selector: { matchLabels: { app: "web" } } } } });
  });
});

describe("PodDisruptionBudgets that allow no disruption", () => {
  it.each<[string, Record<string, unknown>, number, boolean | undefined]>([
    ["maxUnavailable 0", { maxUnavailable: 0 }, 3, true],
    ["maxUnavailable 0%", { maxUnavailable: "0%" }, 3, true],
    ["maxUnavailable 10% of 3 rounds up to 1", { maxUnavailable: "10%" }, 3, false],
    ["minAvailable equal to the replicas", { minAvailable: 3 }, 3, true],
    ["minAvailable below the replicas", { minAvailable: 2 }, 3, false],
    ["minAvailable 100%", { minAvailable: "100%" }, 3, true],
    ["minAvailable 50% of 3 rounds up to 2", { minAvailable: "50%" }, 3, false],
    ["no pods", { minAvailable: 1 }, 0, false],
    ["a value that does not read", { minAvailable: "lots" }, 3, undefined],
  ])("%s", (_name, spec, expected, blocks) => {
    expect(allowsNoDisruption(pdbInfo(pdb(spec)), expected)).toBe(blocks);
  });

  const blocking = (spec: Record<string, unknown>, extra: Record<string, unknown> = {}, ...more: KubeObject[]) => {
    const workloads = [workload("Deployment"), ...more].map(info);
    const ctx: Context = { ...known, pdbs: [pdbInfo(pdb(spec, extra))] };
    return evaluateAll(workloads, ctx).get("Deployment-web")!.filter((f) => f.check === "pdbBlocksDisruption");
  };

  it("reports a budget that blocks every eviction on the workloads it selects, with the fix on the budget", () => {
    expect(blocking({ minAvailable: 3 })).toMatchObject([
      { path: "spec.minAvailable", value: "3", on: { kind: "PodDisruptionBudget", name: "web-pdb" }, fix: { spec: { minAvailable: null, maxUnavailable: 1 } } },
    ]);
  });

  it("counts the pods of every workload a budget selects, and its own expected pods", () => {
    const canary = workload("Deployment", { replicas: 1 }, { metadata: { labels: { app: "web", track: "canary" } } }, "web-canary");
    (canary.spec as Record<string, unknown>).template = { metadata: { labels: { app: "web", track: "canary" } }, spec: { containers: [good] } };
    expect(blocking({ minAvailable: 3 }, {}, canary)).toEqual([]);
    expect(blocking({ minAvailable: 3 }, { status: { expectedPods: 5 } })).toEqual([]);
  });
});

describe("replicas on one node", () => {
  const pod = (name: string, node: string, phase = "Running"): KubeObject => ({
    metadata: { name, namespace: "shop", labels: { "pod-template-hash": "7d9c6b8f5d" }, ownerReferences: [{ kind: "ReplicaSet", name: "web-7d9c6b8f5d", controller: true }] },
    spec: { nodeName: node },
    status: { phase },
  });
  const nodes = (...pods: KubeObject[]) => indexPlacements(pods.map(placementOf));
  const onN1 = nodes(pod("a", "n1"), pod("b", "n1"));
  const cp = (name: string) => node(name, { taints: [{ key: "node-role.kubernetes.io/control-plane", effect: "NoSchedule" }] })!;
  const dedicated = (name: string) => node(name, { taints: [{ key: "dedicated", value: "gpu", effect: "NoExecute" }] })!;

  it.each<[string, KubeObject, Context, boolean]>([
    ["all on one node", workload("Deployment"), { ...withPdb, nodes: nodes(pod("a", "n1"), pod("b", "n1"), pod("c", "n1")) }, true],
    ["spread over nodes", workload("Deployment"), { ...withPdb, nodes: nodes(pod("a", "n1"), pod("b", "n2")) }, false],
    ["a finished pod does not count", workload("Deployment"), { ...withPdb, nodes: nodes(pod("a", "n1"), pod("b", "n2", "Failed")) }, false],
    ["a single-node cluster", workload("Deployment"), { ...withPdb, schedulableNodes: plainNodes("n1"), nodes: nodes(pod("a", "n1"), pod("b", "n1")) }, false],
    ["the other nodes are tainted", workload("Deployment"), { ...withPdb, schedulableNodes: [node("n1")!, cp("cp1"), cp("cp2"), dedicated("gpu1")], nodes: onN1 }, false],
    ["the taints are tolerated", workload("Deployment", {}, { tolerations: [{ key: "node-role.kubernetes.io/control-plane", operator: "Exists", effect: "NoSchedule" }] }), { ...withPdb, schedulableNodes: [node("n1")!, cp("cp1")], nodes: onN1 }, true],
    ["every taint tolerated by an empty-key Exists", workload("Deployment", {}, { tolerations: [{ operator: "Exists" }] }), { ...withPdb, schedulableNodes: [cp("cp1"), dedicated("gpu1")], nodes: onN1 }, true],
    ["a PreferNoSchedule taint does not keep pods off", workload("Deployment"), { ...withPdb, schedulableNodes: [node("n1")!, node("n2", { taints: [{ key: "spot", effect: "PreferNoSchedule" }] })!], nodes: onN1 }, true],
    ["a cordoned node does not count", workload("Deployment"), { ...withPdb, schedulableNodes: [node("n1")!, node("n2", { unschedulable: true })].filter((n) => n !== null), nodes: onN1 }, false],
    ["the nodeSelector matches one node", workload("Deployment", {}, { nodeSelector: { pool: "web" } }), { ...withPdb, schedulableNodes: [node("n1", {}, { pool: "web" })!, node("n2", {}, { pool: "db" })!], nodes: onN1 }, false],
    ["the nodeSelector matches two nodes", workload("Deployment", {}, { nodeSelector: { pool: "web" } }), { ...withPdb, schedulableNodes: [node("n1", {}, { pool: "web" })!, node("n2", {}, { pool: "web" })!], nodes: onN1 }, true],
    ["required node affinity matches one node", workload("Deployment", {}, { affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchExpressions: [{ key: "kubernetes.io/hostname", operator: "In", values: ["n1"] }] }] } } } }), { ...withPdb, nodes: onN1 }, false],
    ["unknown nodes", workload("Deployment"), { ...withPdb, schedulableNodes: undefined, nodes: nodes(pod("a", "n1"), pod("b", "n1")) }, false],
    ["with topology spread", workload("Deployment", {}, { topologySpreadConstraints: [{ maxSkew: 1 }] }), { ...withPdb, nodes: nodes(pod("a", "n1"), pod("b", "n1")) }, false],
    ["with pod anti-affinity", workload("Deployment", {}, { affinity: { podAntiAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [] } } }), { ...withPdb, nodes: nodes(pod("a", "n1"), pod("b", "n1")) }, false],
  ])("%s", (_name, obj, ctx, found) => {
    expect(checksOf(obj, ctx).includes("sameNode")).toBe(found);
  });
});

describe("limits far above the right-sizing recommendation", () => {
  const rec = { cpuRequest: 50, memoryRequest: 96 * 2 ** 20, memoryLimit: 128 * 2 ** 20, cpuLimit: 200 };
  const recommendations = new Map([["shop/Deployment/web", new Map([["app", rec]])]]);
  const limits = (l: Record<string, string>) => workload("Deployment", {}, { containers: [{ ...good, resources: { requests: good.resources.requests, limits: l } }] });

  it.each<[string, Record<string, string>, string[]]>([
    ["memory four times the recommendation", { memory: "512Mi" }, ["512Mi"]],
    ["memory close to it", { memory: "192Mi" }, []],
    ["CPU five times the recommendation", { memory: "192Mi", cpu: "1" }, ["1"]],
  ])("%s", (_name, l, values) => {
    const found = evaluate(info(limits(l)), { ...withPdb, recommendations }).filter((f) => f.check === "limitsAboveRecommendation");
    expect(found.map((f) => f.value)).toEqual(values);
  });

  it("says nothing without history", () => {
    expect(checksOf(limits({ memory: "4Gi" }))).toEqual([]);
  });
});
