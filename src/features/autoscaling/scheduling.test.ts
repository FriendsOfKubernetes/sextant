import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import {
  boundPodRow,
  checkNodes,
  claimNames,
  isUnscheduled,
  MAX_NODES,
  needsPeers,
  nodeRow,
  parseReasonList,
  parseSchedulerMessage,
  podRequests,
  termMatches,
  tolerates,
  usedByNode,
  type NodeRow,
  type PeerPod,
} from "./scheduling";

interface Expected {
  available?: number;
  total?: number;
  reasons: { count?: number; code: string; detail?: string }[];
  preemption?: boolean;
}

describe("the scheduler's message", () => {
  it.each<[string, Expected]>([
    [
      "0/5 nodes are available: 2 Insufficient cpu, 3 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }. preemption: 0/5 nodes are available: 2 No preemption victims found for incoming pod, 3 Preemption is not helpful for scheduling.",
      {
        available: 0,
        total: 5,
        reasons: [
          { count: 2, code: "insufficient", detail: "cpu" },
          { count: 3, code: "taint", detail: "node-role.kubernetes.io/control-plane:" },
        ],
        preemption: true,
      },
    ],
    [
      "0/3 nodes are available: 1 node(s) didn't match Pod's node affinity/selector, 1 node(s) didn't match pod topology spread constraints, 1 node(s) were unschedulable.",
      {
        available: 0,
        total: 3,
        reasons: [
          { count: 1, code: "nodeAffinity" },
          { count: 1, code: "topologySpread" },
          { count: 1, code: "unschedulable" },
        ],
      },
    ],
    [
      "0/4 nodes are available: 1 Insufficient memory, 1 Too many pods, 1 node(s) had volume node affinity conflict, 1 node(s) didn't match pod anti-affinity rules.",
      {
        available: 0,
        total: 4,
        reasons: [
          { count: 1, code: "insufficient", detail: "memory" },
          { count: 1, code: "insufficient", detail: "pods" },
          { count: 1, code: "volumeAffinity" },
          { count: 1, code: "podAntiAffinity" },
        ],
      },
    ],
    [
      "0/2 nodes are available: pod has unbound immediate PersistentVolumeClaims. preemption: 0/2 nodes are available: 2 Preemption is not helpful for scheduling.",
      { available: 0, total: 2, reasons: [{ code: "unboundPvc" }], preemption: true },
    ],
    [
      "0/6 nodes are available: 1 node(s) had untolerated taint {node.kubernetes.io/unschedulable: }, 2 node(s) had untolerated taint {node.kubernetes.io/not-ready: }, 3 Insufficient nvidia.com/gpu.",
      {
        available: 0,
        total: 6,
        reasons: [
          { count: 1, code: "unschedulable" },
          { count: 2, code: "notReady", detail: "node.kubernetes.io/not-ready: " },
          { count: 3, code: "insufficient", detail: "nvidia.com/gpu" },
        ],
      },
    ],
    [
      "0/3 nodes are available: 3 node(s) had taint {dedicated: gpu}, that the pod didn't tolerate.",
      { available: 0, total: 3, reasons: [{ count: 3, code: "taint", detail: "dedicated: gpu" }] },
    ],
    ["no nodes available to schedule pods", { reasons: [{ code: "noNodes" }] }],
  ])("%s", (message, expected) => {
    const parsed = parseSchedulerMessage(message)!;
    expect(parsed.available).toBe(expected.available);
    expect(parsed.total).toBe(expected.total);
    expect(parsed.reasons.map(({ count, code, detail }) => ({ ...(count !== undefined ? { count } : {}), code, ...(detail !== undefined ? { detail } : {}) }))).toEqual(
      expected.reasons,
    );
    expect(parsed.preemption !== undefined).toBe(Boolean(expected.preemption));
  });

  it("another shape is not parsed", () => {
    expect(parseSchedulerMessage("binding rejected: running Bind plugin")).toBeUndefined();
    expect(parseSchedulerMessage(undefined)).toBeUndefined();
  });

  it("Cluster Autoscaler's reasons use the same list", () => {
    expect(parseReasonList(" 2 max node group size reached, 1 node(s) didn't match Pod's node affinity/selector, 1 in backoff after failed scale-up").map((r) => [r.count, r.code])).toEqual([
      [2, "maxGroupSize"],
      [1, "nodeAffinity"],
      [1, "backoff"],
    ]);
    expect(parseReasonList("1 something new")[0]).toEqual({ count: 1, code: "other", detail: "something new", text: "something new" });
  });
});

describe("what a pod asks of a node", () => {
  it("containers and sidecars, or the biggest init container, plus overhead", () => {
    const pod = {
      spec: {
        initContainers: [
          { name: "sidecar", restartPolicy: "Always", resources: { requests: { cpu: "100m", memory: "64Mi" } } },
          { name: "migrate", resources: { requests: { cpu: "2", memory: "128Mi" } } },
        ],
        containers: [
          { name: "app", resources: { requests: { cpu: "500m", memory: "256Mi" } } },
          { name: "gpu", resources: { limits: { "nvidia.com/gpu": "1" } } },
        ],
        overhead: { cpu: "10m" },
      },
    };
    const r = podRequests(pod);
    // cpu: max(0.5 + 0.1, 2 + 0.1) + 0.01; memory: max(256 + 64, 128 + 64) Mi.
    expect(r.cpu).toBeCloseTo(2.11);
    expect(r.memory).toBe(320 * 2 ** 20);
    expect(r["nvidia.com/gpu"]).toBe(1);
    expect(r.pods).toBe(1);
  });

  it("bound pods hold their requests until they finish", () => {
    const pod = (phase: string, nodeName?: string): KubeObject => ({
      spec: { ...(nodeName ? { nodeName } : {}), containers: [{ resources: { requests: { cpu: "1" } } }] },
      status: { phase },
    });
    expect(boundPodRow(pod("Running", "n1"))?.node).toBe("n1");
    expect(boundPodRow(pod("Pending"))).toBeNull();
    expect(boundPodRow(pod("Succeeded", "n1"))).toBeNull();
    const used = usedByNode([boundPodRow(pod("Running", "n1")), boundPodRow(pod("Running", "n1")), null]);
    expect(used.get("n1")).toEqual({ cpu: 2, pods: 2 });
  });
});

describe("tolerations (the API's ToleratesTaint)", () => {
  const taint = { key: "dedicated", value: "gpu", effect: "NoSchedule" };
  it.each([
    [{ key: "dedicated", operator: "Equal", value: "gpu", effect: "NoSchedule" }, true],
    [{ key: "dedicated", operator: "Equal", value: "gpu", effect: "" }, true],
    [{ key: "dedicated", operator: "Equal", value: "cpu", effect: "NoSchedule" }, false],
    [{ key: "dedicated", operator: "Exists", value: "", effect: "NoSchedule" }, true],
    [{ key: "", operator: "Exists", value: "", effect: "" }, true],
    [{ key: "dedicated", operator: "Exists", value: "", effect: "NoExecute" }, false],
    [{ key: "other", operator: "Exists", value: "", effect: "" }, false],
  ])("%j → %s", (toleration, expected) => {
    expect(tolerates(toleration, taint)).toBe(expected);
  });
});

describe("node selector terms", () => {
  const node = { name: "n1", labels: { zone: "a", size: "8", "kubernetes.io/os": "linux" } };
  it.each([
    [{ matchExpressions: [{ key: "zone", operator: "In", values: ["a", "b"] }] }, true],
    [{ matchExpressions: [{ key: "zone", operator: "NotIn", values: ["a"] }] }, false],
    [{ matchExpressions: [{ key: "gpu", operator: "DoesNotExist" }] }, true],
    [{ matchExpressions: [{ key: "zone", operator: "Exists" }, { key: "size", operator: "Gt", values: ["4"] }] }, true],
    [{ matchExpressions: [{ key: "size", operator: "Lt", values: ["4"] }] }, false],
    [{ matchFields: [{ key: "metadata.name", operator: "In", values: ["n1"] }] }, true],
    [{ matchFields: [{ key: "metadata.name", operator: "NotIn", values: ["n1"] }] }, false],
    [{}, false],
  ])("%j → %s", (term, expected) => {
    expect(termMatches(term, node)).toBe(expected);
  });
});

// ---------- The local check ----------

const GI = 2 ** 30;

function node(name: string, extra: Partial<NodeRow> = {}): NodeRow {
  return {
    name,
    labels: { "kubernetes.io/hostname": name, "topology.kubernetes.io/zone": "a", ...extra.labels },
    taints: extra.taints ?? [],
    unschedulable: extra.unschedulable ?? false,
    allocatable: { cpu: 4, memory: 16 * GI, pods: 110, ...extra.allocatable },
  };
}

function pending(spec: Record<string, unknown> = {}, labels: Record<string, string> = { app: "web" }): KubeObject {
  return {
    metadata: { name: "web-1", namespace: "shop", labels },
    spec: { containers: [{ name: "app", resources: { requests: { cpu: "1", memory: "1Gi" } } }], ...spec },
    status: { phase: "Pending", conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable" }] },
  };
}

const keys = (r: ReturnType<typeof checkNodes>) => Object.fromEntries(r.verdicts.map((v) => [v.node, v.reasons.map((p) => p.key)]));

describe("the local check against nodes", () => {
  it("resources: allocatable minus the requests already bound", () => {
    const result = checkNodes({
      pod: pending(),
      nodes: [node("full"), node("free"), node("tiny", { allocatable: { cpu: 0.5 } })],
      used: new Map([["full", { cpu: 3.5, memory: GI, pods: 3 }]]),
    });
    expect(keys(result)).toEqual({ free: [], full: ["node.insufficient"], tiny: ["node.insufficient"] });
    const full = result.verdicts.find((v) => v.node === "full")!;
    expect(full.reasons[0]?.params).toMatchObject({ resource: "cpu", requested: "1", free: "500m", allocatable: "4" });
    expect(result.byReason.get("insufficient")).toBe(2);
  });

  it("cordoned nodes, taints, nodeSelector and required node affinity", () => {
    const affinity = {
      nodeAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: {
          nodeSelectorTerms: [{ matchExpressions: [{ key: "topology.kubernetes.io/zone", operator: "In", values: ["a"] }] }],
        },
      },
    };
    const pod = pending({
      nodeSelector: { "kubernetes.io/os": "linux" },
      affinity,
      tolerations: [{ key: "spot", operator: "Exists" }],
    });
    const linux = { "kubernetes.io/os": "linux" };
    const result = checkNodes({
      pod,
      nodes: [
        node("cordoned", { unschedulable: true, labels: linux }),
        node("tainted", { taints: [{ key: "dedicated", value: "gpu", effect: "NoSchedule" }], labels: linux }),
        node("spot", { taints: [{ key: "spot", effect: "NoSchedule" }], labels: linux }),
        node("soft", { taints: [{ key: "x", effect: "PreferNoSchedule" }], labels: linux }),
        node("windows", { labels: { "kubernetes.io/os": "windows" } }),
        node("zone-b", { labels: { ...linux, "topology.kubernetes.io/zone": "b" } }),
      ],
      used: new Map(),
    });
    expect(keys(result)).toEqual({
      cordoned: ["node.unschedulable"],
      soft: [],
      spot: [],
      tainted: ["node.taint"],
      windows: ["node.nodeSelector"],
      "zone-b": ["node.nodeAffinity"],
    });
    expect(result.verdicts.find((v) => v.node === "tainted")?.reasons[0]?.params).toEqual({ taint: "dedicated=gpu:NoSchedule" });
  });

  it("topology spread (DoNotSchedule) over zones, with the pod's namespace", () => {
    const pod = pending({
      topologySpreadConstraints: [
        { maxSkew: 1, topologyKey: "topology.kubernetes.io/zone", whenUnsatisfiable: "DoNotSchedule", labelSelector: { matchLabels: { app: "web" } } },
        { maxSkew: 1, topologyKey: "kubernetes.io/hostname", whenUnsatisfiable: "ScheduleAnyway", labelSelector: { matchLabels: { app: "web" } } },
      ],
    });
    expect(needsPeers(pod)).toBe(true);
    const zone = (z: string) => ({ labels: { "topology.kubernetes.io/zone": z } });
    const nodes = [node("a1", zone("a")), node("b1", zone("b")), node("nolabel", { labels: {} })];
    nodes[2]!.labels = { "kubernetes.io/hostname": "nolabel" };
    const peers: PeerPod[] = [
      { name: "web-0", node: "a1", labels: { app: "web" } },
      { name: "web-2", node: "a1", labels: { app: "web" } },
      { name: "web-3", node: "b1", labels: { app: "web" } },
      { name: "db", node: "b1", labels: { app: "db" } },
    ];
    const result = checkNodes({ pod, nodes, used: new Map(), peers });
    // Zone a has 2, zone b 1: a pod in a makes the skew 3 − 1 = 2 > 1.
    expect(keys(result)).toEqual({ a1: ["node.topologySkew"], b1: [], nolabel: ["node.missingTopologyLabel"] });
    expect(result.verdicts[0]?.reasons[0]?.params).toEqual({ key: "topology.kubernetes.io/zone", skew: 2, maxSkew: 1 });
  });

  it("required pod affinity and anti-affinity", () => {
    const pod = pending({
      affinity: {
        podAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: [{ topologyKey: "topology.kubernetes.io/zone", labelSelector: { matchLabels: { app: "cache" } } }],
        },
        podAntiAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: [{ topologyKey: "kubernetes.io/hostname", labelSelector: { matchLabels: { app: "web" } } }],
        },
      },
    });
    const zone = (z: string) => ({ labels: { "topology.kubernetes.io/zone": z } });
    const nodes = [node("a1", zone("a")), node("a2", zone("a")), node("b1", zone("b"))];
    const peers: PeerPod[] = [
      { name: "cache-0", node: "a2", labels: { app: "cache" } },
      { name: "web-0", node: "a2", labels: { app: "web" } },
    ];
    expect(keys(checkNodes({ pod, nodes, used: new Map(), peers }))).toEqual({
      a1: [],
      a2: ["node.podAntiAffinity"],
      b1: ["node.podAffinity"],
    });
    // Without the namespace's pods neither is judged, and the result says so.
    const blind = checkNodes({ pod, nodes, used: new Map() });
    expect(keys(blind)).toEqual({ a1: [], a2: [], b1: [] });
    expect(blind.unchecked.map((p) => p.key)).toContain("check.uncheckedPeers");
  });

  it("a bound PersistentVolume's node affinity", () => {
    const pod = pending({ volumes: [{ name: "data", persistentVolumeClaim: { claimName: "data-web-1" } }] });
    expect(claimNames(pod)).toEqual(["data-web-1"]);
    const required = { nodeSelectorTerms: [{ matchExpressions: [{ key: "topology.kubernetes.io/zone", operator: "In", values: ["b"] }] }] };
    const result = checkNodes({
      pod,
      nodes: [node("a1"), node("b1", { labels: { "topology.kubernetes.io/zone": "b" } })],
      used: new Map(),
      volumes: [{ pv: "pv-1", required }],
    });
    expect(keys(result)).toEqual({ a1: ["node.volumeAffinity"], b1: [] });
  });

  it(`looks at ${MAX_NODES} nodes at most`, () => {
    const nodes = Array.from({ length: MAX_NODES + 50 }, (_, i) => node(`n${String(i).padStart(4, "0")}`));
    const result = checkNodes({ pod: pending(), nodes, used: new Map() });
    expect(result.verdicts).toHaveLength(MAX_NODES);
    expect(result.total).toBe(MAX_NODES + 50);
  });

  it("reads a Node object into a row", () => {
    const row = nodeRow({
      metadata: { name: "n1", labels: { zone: "a" } },
      spec: { unschedulable: true, taints: [{ key: "k", value: "v", effect: "NoExecute" }] },
      status: { allocatable: { cpu: "3920m", memory: "15Gi", pods: "110" } },
    });
    expect(row).toEqual({
      name: "n1",
      labels: { zone: "a" },
      taints: [{ key: "k", value: "v", effect: "NoExecute" }],
      unschedulable: true,
      allocatable: { cpu: 3.92, memory: 15 * GI, pods: 110 },
    });
  });
});

describe("which pods wait for a node", () => {
  it.each([
    [{ status: { phase: "Pending", conditions: [{ type: "PodScheduled", status: "False" }] } }, true],
    [{ status: { phase: "Pending" } }, true],
    [{ spec: { nodeName: "n1" }, status: { phase: "Pending" } }, false],
    [{ status: { phase: "Pending", conditions: [{ type: "PodScheduled", status: "True" }] } }, false],
    [{ status: { phase: "Running" } }, false],
  ])("%j → %s", (pod, expected) => {
    expect(isUnscheduled(pod as KubeObject)).toBe(expected);
  });
});
