import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DiagnosticAnswer, DiagnosticRequest, KubeObject, ReadRule, WatchSpec, WatchUpdate } from "../../api";
import { resetClusterKinds } from "../../resources";
import { resetClustersStore } from "../clusters/clustersStore";
import { emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { evaluate, type World } from "../netpol/engine";
import { NETWORK_POLICY, policiesOf, type ServedPolicyKinds } from "../netpol/hooks";
import { podInfo } from "../netpol/model";
import { resetProblemSources } from "../problems/store";
import { observe, resetRecorder } from "../timeline/recorder";
import { analyzeHpa } from "../autoscaling/hpa";
import type { ClusterView } from "../diagnose/model";
import { hpaOut, pendingOut } from "./autoscaling";
import { recentChanges } from "./changes";
import { restrictView } from "./diagnose";
import { DiagnosticsHost } from "./DiagnosticsHost";
import { parseDestinationRule } from "../mesh/istio";
import { DESTINATION_RULE, VIRTUAL_SERVICE } from "../mesh/kinds";
import { resetSharedWatches, setWatchLinger } from "../resource-map/watches";
import { acquireSource } from "../problems/store";
import { CATEGORY_SOURCES } from "../problems/sources";
import { agentMeshProblems, meshRefs, MESH_KINDS, type MeshList } from "./mesh";
import { restrictWorld } from "./netpol";
import { rbacNeeds } from "./permissions";
import { planProblems } from "./problems";
import { canRead } from "./scope";

const TEAM_A: ReadRule[] = [{ namespaces: { type: "only", namespaces: ["team-a"] }, kinds: { type: "all" } }];
const EVERYTHING: ReadRule[] = [{ namespaces: { type: "all" }, kinds: { type: "all" } }];
const POD = { group: "", kind: "Pod" };

function pod(namespace: string, name: string, labels: Record<string, string> = {}, waiting?: string): KubeObject {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, namespace, uid: `${namespace}-${name}`, labels, creationTimestamp: "2026-01-01T00:00:00Z" },
    spec: { containers: [{ name: "app" }] },
    status: {
      phase: "Running",
      podIPs: [{ ip: "10.0.0.1" }],
      conditions: [{ type: "Ready", status: waiting ? "False" : "True" }],
      containerStatuses: [{ name: "app", restartCount: 9, state: waiting ? { waiting: { reason: waiting } } : { running: {} } }],
    },
  };
}

describe("what an agent may read", () => {
  it("matches the backend's rules: kinds ignoring case, a namespace only from the list, nothing cluster-wide without all", () => {
    expect(canRead(TEAM_A, POD, "team-a")).toBe(true);
    expect(canRead(TEAM_A, POD, "team-b")).toBe(false);
    expect(canRead(TEAM_A, { group: "", kind: "Node" }, null)).toBe(false);
    expect(canRead(EVERYTHING, { group: "", kind: "Node" }, null)).toBe(true);
    const pods: ReadRule[] = [{ namespaces: { type: "all" }, kinds: { type: "only", kinds: [{ group: "", kind: "pod" }] } }];
    expect(canRead(pods, POD, "x")).toBe(true);
    expect(canRead(pods, { group: "", kind: "Secret" }, "x")).toBe(false);
    expect(canRead([], POD, "team-a")).toBe(false);
  });

  it("asks only for the RBAC lists the agent may read", () => {
    expect(rbacNeeds(TEAM_A, "team-a")).toMatchObject({ roles: true, roleBindings: true, clusterRoles: false, clusterRoleBindings: false });
    expect(rbacNeeds(TEAM_A, null)).toMatchObject({ roles: false, roleBindings: false });
    expect(rbacNeeds(EVERYTHING, null)).toMatchObject({ roles: true, clusterRoles: true, namespaces: null });
  });
});

describe("problems judged across objects for an agent", () => {
  const meta = (kind: string, namespace: string, name: string) => ({
    apiVersion: "networking.istio.io/v1",
    kind,
    metadata: { name, namespace, uid: `${namespace}-${name}`, creationTimestamp: "2026-01-01T00:00:00Z" },
  });
  // A team-a VirtualService routes to subset v2 of a team-b host whose DestinationRule (in team-b) has only v1.
  const vs: KubeObject = {
    ...meta("VirtualService", "team-a", "reviews"),
    spec: { hosts: ["reviews"], http: [{ route: [{ destination: { host: "reviews.team-b.svc.cluster.local", subset: "v2" } }] }] },
  };
  const dr: KubeObject = { ...meta("DestinationRule", "team-b", "reviews-rule"), spec: { host: "reviews.team-b.svc.cluster.local", subsets: [{ name: "v1", labels: { v: "1" } }] } };
  const service: KubeObject = { apiVersion: "v1", kind: "Service", metadata: { name: "reviews", namespace: "team-b", uid: "svc" } };
  const lists = (known: (ns: string | null) => boolean): MeshList[] =>
    MESH_KINDS.map((kind) => {
      const items = kind === VIRTUAL_SERVICE ? [vs] : kind === DESTINATION_RULE ? [dr] : [];
      // What the agent could not read is not in the lists either.
      return { kind, served: true, items: items.filter((o) => known(o.metadata?.namespace ?? null)), known };
    });
  const services = (known: (ns: string | null) => boolean): MeshList => ({ kind: { group: "", kind: "Service" }, served: true, items: known("team-b") ? [service] : [], known });

  it("finds nothing — and no sign of team-b — from what a team-a agent may read", () => {
    const teamA = (ns: string | null) => ns === "team-a";
    const found = agentMeshProblems(lists(teamA), services(teamA));
    expect(found).toEqual([]);
    // With everything read, the same objects give the finding that names team-b's DestinationRule.
    const everything = () => true;
    const all = agentMeshProblems(lists(everything), services(everything));
    expect(all.map((p) => [p.reason, p.params.rule])).toEqual([["MissingSubset", "reviews-rule"]]);
    expect(meshRefs(all[0]!)).toContainEqual({ group: "networking.istio.io", kind: "DestinationRule", namespace: "team-b", name: "reviews-rule" });
    expect(parseDestinationRule(dr).namespace).toBe("team-b");
  });

  it("plans watches only where the agent may read, and names what it cannot look at", () => {
    const kinds = [
      { kindRef: { ...VIRTUAL_SERVICE }, plural: "virtualservices", namespaced: true, verbs: ["list", "watch"], printerColumns: [] },
    ];
    const plan = planProblems(["nodes", "pods", "events", "disk", "practices", "mesh"], kinds, TEAM_A, null);
    expect(plan.shared).toEqual([]);
    expect(plan.watched.map((w) => [w.spec.kind.kind, w.spec.namespaces, w.spec.fieldSelector])).toEqual([
      ["Pod", ["team-a"], null],
      ["Event", ["team-a"], "type=Warning"],
    ]);
    expect(plan.notChecked).toEqual(["nodes", "disk"]);
    expect(plan.practices).toEqual(["team-a"]);
    expect(plan.mesh).toBe(true);
    // Read on everything: the problems store's shared, cluster-wide sources (the screen's own).
    const all = planProblems(["nodes", "pods", "disk", "practices"], kinds, EVERYTHING, null);
    expect(all.watched).toEqual([]);
    expect(all.shared.map((d) => `${d.category}/${d.kind.kind}`)).toEqual(["nodes/Node", "pods/Pod", "disk/PersistentVolumeClaim", "practices/Deployment"]);
    expect(all.notChecked).toEqual([]);
    // One namespace asked: nodes are not in it, so not "not checked".
    expect(planProblems(["nodes"], kinds, TEAM_A, "team-a").notChecked).toEqual([]);
  });
});

describe("the connectivity engine for an agent", () => {
  const denyAll: KubeObject = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "deny-all", namespace: "team-b", uid: "np" },
    spec: { podSelector: {}, policyTypes: ["Ingress"] },
  };
  const served: ServedPolicyKinds = {
    networkPolicy: NETWORK_POLICY,
    cilium: null,
    ciliumClusterwide: null,
    calico: null,
    calicoGlobal: null,
    unevaluated: [],
    discoveryFailed: false,
  };
  const world: World = {
    policies: policiesOf(NETWORK_POLICY, denyAll),
    unreadable: [],
    namespaceLabels: (name) => ({ "kubernetes.io/metadata.name": name }),
  };
  const from = { type: "pod" as const, pod: podInfo(pod("team-a", "web")) };
  const to = { type: "pod" as const, pod: podInfo(pod("team-b", "db")) };
  const traffic = { protocol: "TCP" as const, port: 5432 };

  it("says unknown, never allowed, where a policy list it may not read could decide", () => {
    expect(evaluate(from, to, traffic, world).verdict).toBe("denied");
    const restricted = restrictWorld(world, served, ["team-a", "team-b"], TEAM_A);
    expect(restricted.policies).toEqual([]);
    expect(restricted.unreadable).toEqual([{ kind: "NetworkPolicy", namespace: "team-b" }]);
    expect(restricted.namespaceLabels("team-a")).toBeUndefined();
    const result = evaluate(from, to, traffic, restricted);
    expect(result.verdict).toBe("unknown");
    expect(result.ingress.verdict).toBe("unknown");
  });

  it("keeps everything for an agent that may read everything", () => {
    const same = restrictWorld(world, served, ["team-a", "team-b"], EVERYTHING);
    expect(evaluate(from, to, traffic, same).verdict).toBe("denied");
  });
});

describe("the window's side of the diagnostic tools", () => {
  let wb: WatchBackend;
  let answers: { id: string; answer: DiagnosticAnswer }[];

  beforeEach(() => {
    resetProblemSources();
    resetSharedWatches();
    setWatchLinger(0);
    resetClusterKinds();
    resetRecorder(() => Date.parse("2026-10-20T10:00:00Z"));
    wb = watchBackend();
    answers = [];
    wb.backend.on("mcp_diagnostic_answer", (args) => {
      answers.push(args as unknown as { id: string; answer: DiagnosticAnswer });
      return undefined;
    });
    wb.backend.on("timeline_managers", () => []);
  });

  afterEach(() => {
    resetProblemSources();
    resetSharedWatches();
    setWatchLinger(null);
    resetClustersStore();
    resetRecorder(null);
    wb.backend.restore();
  });

  const request = (over: Partial<DiagnosticRequest>): DiagnosticRequest => ({
    id: "diagnostic-1",
    tool: "problems",
    clusterId: "c1",
    reads: TEAM_A,
    args: {},
    ...over,
  });

  it("computes problems from the shared sources and answers only with what the agent may read", async () => {
    render(<DiagnosticsHost />);
    await waitFor(() => expect(wb.backend.listenerCount("mcp-diagnostic")).toBe(1));
    // The screen holds the cluster-wide Pod source, still listing: a team-a agent's answer neither waits for it nor
    // tells of it (its own watch covers team-a only).
    const screen = acquireSource("c1", CATEGORY_SOURCES.pods[0]!);
    act(() => wb.backend.emit("mcp-diagnostic", request({ args: { namespace: null, categories: ["pods"] } })));
    const id = await watchOf(wb, "Pod", (s) => s.namespaces !== null);
    expect(wb.specs.get(id)!.namespaces).toEqual(["team-a"]);
    emitSnapshot(wb, id, [
      pod("team-a", "web-1", {}, "CrashLoopBackOff"),
      pod("team-b", "hidden-1", {}, "CrashLoopBackOff"),
      pod("team-a", "fine"),
    ]);
    await waitFor(() => expect(answers).toHaveLength(1));
    const { id: answered, answer } = answers[0]!;
    expect(answered).toBe("diagnostic-1");
    expect(answer.type).toBe("ok");
    const result = (answer as { result: { problems: { object: { name: string }; message?: string }[]; incomplete: boolean } }).result;
    expect(result.problems.map((p) => p.object.name)).toEqual(["web-1"]);
    expect(result.incomplete).toBe(false);
    expect((result as unknown as { loading: string[] }).loading).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("team-b");
    screen();
  });

  it("drops a request the backend no longer waits for, queued or running", async () => {
    render(<DiagnosticsHost />);
    await waitFor(() => expect(wb.backend.listenerCount("mcp-diagnostic-cancel")).toBe(1));
    act(() => wb.backend.emit("mcp-diagnostic", request({ id: "gone", args: { namespace: null, categories: ["pods"] } })));
    const id = await watchOf(wb, "Pod");
    act(() => wb.backend.emit("mcp-diagnostic-cancel", { id: "gone" }));
    // The worker is gone: its watch is let go, and nothing answers when the list comes.
    await waitFor(() => expect(wb.backend.listenerCount(`watch:${id}`)).toBe(0), { timeout: 8000 });
    expect(answers).toEqual([]);
  }, 10_000);

  it("answers recent changes from the recorder's memory only, newest first, without a watch of its own", async () => {
    const spec: WatchSpec = { kind: { group: "", version: "v1", kind: "ConfigMap" }, namespaces: null, labelSelector: null, fieldSelector: null };
    const cm = (namespace: string, rv: number, value: string): KubeObject => ({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "cfg", namespace, uid: `${namespace}-cfg`, resourceVersion: String(rv), creationTimestamp: "2025-01-01T00:00:00Z" },
      data: { mode: value },
    });
    const update = (items: KubeObject[], type: "snapshot" | "delta"): WatchUpdate =>
      type === "snapshot" ? { type, items: items as never[] } : { type, upserted: items as never[], deleted: [] };
    observe("c1", spec, update([cm("team-a", 1, "a"), cm("team-b", 1, "a")], "snapshot"));
    observe("c1", spec, update([cm("team-a", 2, "b"), cm("team-b", 2, "secret plan")], "delta"));
    const out = recentChanges("c1", TEAM_A, { namespace: null, kind: null, group: null, name: null, limit: 10 });
    expect(out.changes.map((c) => `${c.object.namespace}/${c.object.name} ${c.action}`)).toEqual(["team-a/cfg updated"]);
    expect(out.changes[0]!.changes).toEqual([{ path: "data.mode", op: "changed", before: "a", after: "b", long: false }]);
    expect(JSON.stringify(out)).not.toContain("secret plan");
    const starts = wb.backend.calls.filter((c) => c.cmd === "watch_start").length;
    expect(starts).toBe(0);
  });

  it("answers with the error when a worker cannot compute", async () => {
    render(<DiagnosticsHost />);
    await waitFor(() => expect(wb.backend.listenerCount("mcp-diagnostic")).toBe(1));
    act(() =>
      wb.backend.emit(
        "mcp-diagnostic",
        request({ tool: "permissions", reads: EVERYTHING, args: { namespace: null, whoCan: { verb: "get", resource: "" } } }),
      ),
    );
    // Every RBAC list the agent may read is listed (empty), then the engine is asked about no resource at all.
    for (const kind of ["Role", "ClusterRole", "RoleBinding", "ClusterRoleBinding"]) emitSnapshot(wb, await watchOf(wb, kind), []);
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0]!.answer).toEqual({ type: "error", message: "no resource to ask about" });
  });
});

describe("connectivity and the traffic diagnosis for an agent", () => {
  let wb: WatchBackend;
  let answers: { id: string; answer: DiagnosticAnswer }[];
  const kind = (group: string, version: string, k: string, plural: string, namespaced = true) => ({
    kindRef: { group, version, kind: k },
    plural,
    namespaced,
    verbs: ["list", "watch"],
    printerColumns: [],
  });

  beforeEach(() => {
    resetProblemSources();
    resetSharedWatches();
    setWatchLinger(0);
    resetClusterKinds();
    wb = watchBackend();
    answers = [];
    wb.backend.on("mcp_diagnostic_answer", (args) => {
      answers.push(args as unknown as { id: string; answer: DiagnosticAnswer });
      return undefined;
    });
    wb.backend.on("cluster_kinds", () => [
      kind("", "v1", "Pod", "pods"),
      kind("", "v1", "Service", "services"),
      kind("", "v1", "Namespace", "namespaces", false),
      kind("networking.k8s.io", "v1", "NetworkPolicy", "networkpolicies"),
    ]);
  });

  afterEach(() => {
    resetSharedWatches();
    setWatchLinger(null);
    resetClustersStore();
    wb.backend.restore();
  });

  it("checks a Service port with the page's own check, on what the agent may read", async () => {
    render(<DiagnosticsHost />);
    await waitFor(() => expect(wb.backend.listenerCount("mcp-diagnostic")).toBe(1));
    const args = {
      from: { type: "pod", namespace: "team-a", value: "web" },
      to: { type: "service", namespace: "team-a", value: "db" },
      port: "5432",
      protocol: "TCP",
    };
    act(() => wb.backend.emit("mcp-diagnostic", { id: "d2", tool: "connectivity", clusterId: "c1", reads: TEAM_A, args }));
    const inTeamA = (spec: WatchSpec) => spec.namespaces?.[0] === "team-a";
    emitSnapshot(wb, await watchOf(wb, "Pod", (s) => inTeamA(s) && !s.labelSelector), [
      pod("team-a", "web", { app: "web" }),
      { ...pod("team-a", "db-0", { app: "db" }), spec: { containers: [{ name: "db", ports: [{ containerPort: 5432 }] }] } },
    ]);
    emitSnapshot(wb, await watchOf(wb, "NetworkPolicy", inTeamA), []);
    emitSnapshot(wb, await watchOf(wb, "Service", inTeamA), [
      {
        apiVersion: "v1",
        kind: "Service",
        metadata: { name: "db", namespace: "team-a", uid: "svc" },
        spec: { selector: { app: "db" }, ports: [{ name: "pg", port: 5432, targetPort: 5432, protocol: "TCP" }] },
      },
    ]);
    await waitFor(() => expect(answers).toHaveLength(1));
    // Nothing a team-a agent may not read is watched: no Namespaces, no DNS pods in kube-system.
    expect([...wb.specs.values()].filter((s) => s.namespaces === null || s.namespaces.some((ns) => ns !== "team-a"))).toEqual([]);
    const answer = answers[0]!.answer as { type: "ok"; result: Record<string, unknown> };
    expect(answer.type).toBe("ok");
    expect(answer.result.verdict).toBe("allowed");
    expect(answer.result.backends).toEqual([
      { pod: { group: "", kind: "Pod", namespace: "team-a", name: "db-0" }, port: 5432, verdict: "allowed" },
    ]);
    expect(answer.result.summary).toBe("Allowed to every pod behind the Service.");
  });

  it("answers team-a to team-b as unknown without watching team-b's policies", async () => {
    render(<DiagnosticsHost />);
    await waitFor(() => expect(wb.backend.listenerCount("mcp-diagnostic")).toBe(1));
    const inTeamA = (spec: WatchSpec) => spec.namespaces?.[0] === "team-a";
    const ask = (id: string, from: Record<string, string>, to: Record<string, string>) =>
      act(() => wb.backend.emit("mcp-diagnostic", { id, tool: "connectivity", clusterId: "c1", reads: TEAM_A, args: { from, to, port: "80", protocol: "TCP" } }));
    const web = { ...pod("team-a", "web", { app: "web" }), spec: { containers: [{ name: "web", ports: [{ containerPort: 80 }] }] } };

    // A team-a pod to a team-b pod: team-b is neither listed nor its policies watched.
    ask("c1", { type: "pod", namespace: "team-a", value: "web" }, { type: "pod", namespace: "team-b", value: "api" });
    emitSnapshot(wb, await watchOf(wb, "Pod", inTeamA), [web]);
    emitSnapshot(wb, await watchOf(wb, "NetworkPolicy", inTeamA), []);
    await waitFor(() => expect(answers).toHaveLength(1), { timeout: 8000 });
    expect((answers[0]!.answer as { result: { verdict: string } }).result.verdict).toBe("unknown");

    // Pods of team-b by labels to the team-a pod: the engine judges the egress from team-b, whose policies it may
    // not read, as unknown — never allowed.
    ask("c2", { type: "labels", namespace: "team-b", value: "app=api" }, { type: "pod", namespace: "team-a", value: "web" });
    await waitFor(() => expect(answers).toHaveLength(2), { timeout: 8000 });
    const second = (answers[1]!.answer as { result: { verdict: string; egress: { verdict: string } } }).result;
    expect(second.verdict).toBe("unknown");
    expect(second.egress.verdict).toBe("unknown");

    const outside = [...wb.specs.values()].filter((s) => s.namespaces === null || s.namespaces.some((ns) => ns !== "team-a"));
    expect(outside).toEqual([]);
  });
});

describe("what the window reads for an agent", () => {
  let wb: WatchBackend;
  const kind = (group: string, version: string, k: string, plural: string, namespaced = true) => ({
    kindRef: { group, version, kind: k },
    plural,
    namespaced,
    verbs: ["list", "watch"],
    printerColumns: [],
  });

  beforeEach(() => {
    resetProblemSources();
    resetSharedWatches();
    setWatchLinger(0);
    resetClusterKinds();
    wb = watchBackend();
    wb.backend.on("mcp_diagnostic_answer", () => undefined);
    wb.backend.on("tls_certificate_info", () => ({ chain: [] }));
    wb.backend.on("cluster_kinds", () => [
      kind("", "v1", "Pod", "pods"),
      kind("", "v1", "Service", "services"),
      kind("", "v1", "Namespace", "namespaces", false),
      kind("discovery.k8s.io", "v1", "EndpointSlice", "endpointslices"),
      kind("networking.k8s.io", "v1", "Ingress", "ingresses"),
      kind("networking.k8s.io", "v1", "IngressClass", "ingressclasses", false),
      kind("networking.k8s.io", "v1", "NetworkPolicy", "networkpolicies"),
      kind("networking.istio.io", "v1", "VirtualService", "virtualservices"),
      kind("networking.istio.io", "v1", "DestinationRule", "destinationrules"),
      kind("networking.istio.io", "v1", "ServiceEntry", "serviceentries"),
    ]);
  });

  afterEach(() => {
    resetProblemSources();
    resetSharedWatches();
    setWatchLinger(null);
    resetClustersStore();
    wb.backend.restore();
  });

  const ingress: KubeObject = {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: { name: "web", namespace: "team-a", uid: "ing", resourceVersion: "1" },
    spec: { tls: [{ hosts: ["shop.example.com"], secretName: "web-tls" }], rules: [{ host: "shop.example.com" }] },
  };

  const diagnoseIngress = async (id: string, checkCertificates: boolean) => {
    act(() =>
      wb.backend.emit("mcp-diagnostic", {
        id,
        tool: "diagnoseService",
        clusterId: "c1",
        reads: TEAM_A,
        args: { kind: { group: "networking.k8s.io", kind: "Ingress" }, namespace: "team-a", name: "web", checkCertificates },
      }),
    );
    emitSnapshot(wb, await watchOf(wb, "Ingress"), [ingress]);
    // Whatever else it reads, it reads after the Ingress came; give it the time to start.
    await watchOf(wb, "EndpointSlice");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };

  it("reads a TLS Secret's certificate only when the agent may have Secret values read", async () => {
    render(<DiagnosticsHost />);
    await waitFor(() => expect(wb.backend.listenerCount("mcp-diagnostic")).toBe(1));
    await diagnoseIngress("d1", false);
    expect(wb.backend.calls.filter((c) => c.cmd === "tls_certificate_info")).toEqual([]);
    // Nothing cluster-wide for a team-a agent: no IngressClasses, no controller pods across the cluster.
    expect([...wb.specs.values()].filter((s) => s.kind.kind === "IngressClass")).toEqual([]);
    expect([...wb.specs.values()].filter((s) => s.kind.kind === "Pod" && s.labelSelector)).toEqual([]);
    // Network policies (and every other list) only in team-a; not even the Namespaces cluster-wide.
    await watchOf(wb, "NetworkPolicy", (s) => s.namespaces?.[0] === "team-a");
    expect([...wb.specs.values()].filter((s) => s.namespaces === null || s.namespaces.some((ns) => ns !== "team-a"))).toEqual([]);
    act(() => wb.backend.emit("mcp-diagnostic-cancel", { id: "d1" }));

    await diagnoseIngress("d2", true);
    await waitFor(() => expect(wb.backend.calls.filter((c) => c.cmd === "tls_certificate_info")).toHaveLength(1));
  });

  it("watches the Istio configuration only in the namespaces a team-a agent may read", async () => {
    render(<DiagnosticsHost />);
    await waitFor(() => expect(wb.backend.listenerCount("mcp-diagnostic")).toBe(1));
    act(() =>
      wb.backend.emit("mcp-diagnostic", { id: "m1", tool: "problems", clusterId: "c1", reads: TEAM_A, args: { namespace: null, categories: ["mesh"] } }),
    );
    for (const k of ["VirtualService", "DestinationRule", "ServiceEntry"]) {
      const id = await watchOf(wb, k);
      expect(wb.specs.get(id)!.namespaces).toEqual(["team-a"]);
    }
  });
});

describe("the traffic diagnosis and autoscaling for an agent", () => {
  it("hides from the diagnosis every list the agent may not read", () => {
    const svc = [pod("team-b", "x")];
    const view: ClusterView = {
      now: 0,
      services: () => svc,
      pods: () => svc,
      endpointSlices: () => svc,
      world: undefined,
      ingressClasses: [],
      controllerPods: () => ({ selector: "app=ingress", pods: [pod("ingress-nginx", "controller")] }),
      certificates: () => ({ state: "notFound" }),
      gateways: () => null,
      grants: () => [],
    };
    const restricted = restrictView(view, TEAM_A, ["team-a"], undefined, true);
    expect(restricted.services("team-a")).toBe(svc);
    expect(restricted.services("team-b")).toBeUndefined();
    expect(restricted.pods("team-b")).toBeUndefined();
    expect(restricted.ingressClasses).toBeUndefined();
    expect(restricted.controllerPods("k8s.io/ingress-nginx")).toBeUndefined();
    expect(restricted.certificates("team-b", "tls")).toBeUndefined();
    expect(restricted.certificates("team-a", "tls")).toEqual({ state: "notFound" });
    expect(restricted.gateways("team-a")).toBeNull();
    expect(restrictView(view, EVERYTHING, ["team-a"], undefined, true).controllerPods("x")?.pods).toHaveLength(1);
  });

  it("finds a controller's pods only with Read on Pods everywhere, even when none were found", () => {
    // An empty list from a cluster-wide search would say "no controller pods" about namespaces the agent may not
    // read; it is unknown instead.
    const view = {
      controllerPods: () => ({ selector: "app.kubernetes.io/name=ingress-nginx", pods: [] }),
    } as unknown as ClusterView;
    expect(restrictView(view, TEAM_A, ["team-a"], undefined, true).controllerPods("k8s.io/ingress-nginx")).toBeUndefined();
    expect(restrictView(view, EVERYTHING, ["team-a"], undefined, true).controllerPods("k8s.io/ingress-nginx")?.pods).toEqual([]);
    const unknownController = { controllerPods: () => null } as unknown as ClusterView;
    expect(restrictView(unknownController, TEAM_A, ["team-a"], undefined, true).controllerPods("x")).toBeNull();
  });

  it("reads no certificate without the Secret values permission", () => {
    const view = { certificates: () => ({ state: "notFound" }) } as unknown as ClusterView;
    expect(restrictView(view, EVERYTHING, ["team-a"], undefined, false).certificates("team-a", "tls")).toBeUndefined();
    expect(restrictView(view, EVERYTHING, ["team-a"], undefined, true).certificates("team-a", "tls")).toEqual({ state: "notFound" });
  });

  it("explains an HPA and a pending pod in words", () => {
    const hpa: KubeObject = {
      apiVersion: "autoscaling/v2",
      kind: "HorizontalPodAutoscaler",
      metadata: { name: "web", namespace: "team-a", uid: "h" },
      spec: {
        minReplicas: 2,
        maxReplicas: 5,
        scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: "web" },
        metrics: [{ type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 50 } } }],
      },
      status: {
        currentReplicas: 2,
        desiredReplicas: 2,
        currentMetrics: [{ type: "Resource", resource: { name: "cpu", current: { averageUtilization: 100 } } }],
      },
    };
    const out = hpaOut(hpa, analyzeHpa(hpa));
    expect(out.target).toEqual({ group: "apps", kind: "Deployment", namespace: "team-a", name: "web" });
    expect(out.metrics[0]).toMatchObject({ metric: "Resource cpu", current: "100%", target: "50% (Utilization)", proposes: 4 });
    expect(out.verdict).not.toMatch(/autoscaling:/);
    const pending: KubeObject = {
      ...pod("team-a", "big"),
      status: {
        phase: "Pending",
        conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/3 nodes are available: 3 Insufficient cpu." }],
      },
    };
    expect(pendingOut(pending)).toMatchObject({
      reason: "Unschedulable",
      nodesTotal: 3,
      reasons: [{ nodes: 3, code: "insufficient", text: "Insufficient cpu" }],
    });
  });
});
