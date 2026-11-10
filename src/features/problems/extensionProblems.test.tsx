// Problems of extensions (ADR-0137): rules registered from a manifest run on the store's watches, only for the kinds
// and namespaces Rust allows, under a category titled with the extension's name; they go with the extension.
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JudgedFact, JudgedObject, KubeObject, ProblemContribution, ProblemJudgeContribution, ProblemScope, ResourceKind } from "../../api";
import { setJudgesClock } from "../../extensions/problemJudges";
import { resetAppStore } from "../../app/store";
import "../../resources";
import { resetClusterKinds } from "../../resources/useKinds";
import { emitDelta, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore } from "../namespaces";
import { resetNotifier } from "../notifications/notifier";
import { categoriesOfExtension, registerExtensionProblems } from "./extensionCategories";
import { isOptIn } from "./model";
import { setCategory } from "../notifications/prefs";
import { updateSettings } from "../../api";
import { useClusterProblems, useExtensionSectionCount, useProblemCount } from "./hooks";
import "./index";
import { ProblemsPage } from "./ProblemsPage";
import { acquireSource, getSource, resetProblemSources } from "./store";
import { sourceKey } from "./sources";
import { resetProblemsUi } from "./ui";

const CEPH_CLUSTER: ResourceKind = {
  kindRef: { group: "ceph.rook.io", version: "v1", kind: "CephCluster" },
  plural: "cephclusters",
  namespaced: true,
  verbs: ["list", "watch"],
  printerColumns: [],
};
const NODE: ResourceKind = { kindRef: { group: "", version: "v1", kind: "Node" }, plural: "nodes", namespaced: false, verbs: ["list", "watch"], printerColumns: [] };

const RULES: ProblemContribution[] = [
  {
    id: "health-error",
    title: "Ceph health error",
    kind: { group: "ceph.rook.io", kind: "CephCluster" },
    when: { type: "equals", path: ".status.ceph.health", value: "HEALTH_ERR" },
    graceMinutes: 0,
    notify: true,
    toldThroughOwner: false,
    message: "Ceph reports {{.status.ceph.health}}",
  },
  {
    id: "node-down",
    title: "Node down",
    kind: { group: "", kind: "Node" },
    when: { type: "condition", conditionType: "Ready", status: "False" },
    graceMinutes: 0,
    notify: true,
    toldThroughOwner: false,
    message: "{{.metadata.name}}",
  },
];

function ceph(health: string): KubeObject {
  return {
    apiVersion: "ceph.rook.io/v1",
    kind: "CephCluster",
    metadata: { name: "rook-ceph", namespace: "rook-ceph", uid: "u-ceph" },
    status: { ceph: { health } },
  };
}

let wb: WatchBackend;
let scopes: ProblemScope[];
let asked: number;
let unregister: (() => void) | undefined;

beforeEach(() => {
  resetAppStore();
  resetProblemSources();
  resetProblemsUi();
  resetNotifier();
  resetClusterKinds();
  resetNamespaceRestore();
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => [CEPH_CLUSTER, NODE]);
  asked = 0;
  // The extension may read CephClusters in `rook-ceph` only, and Nodes only… nowhere cluster-wide: a cluster-scoped
  // kind with a namespace list runs nowhere.
  scopes = [
    { kind: { group: "ceph.rook.io", kind: "CephCluster" }, namespaces: { type: "only", namespaces: ["rook-ceph"] } },
    { kind: { group: "", kind: "Node" }, namespaces: { type: "only", namespaces: ["rook-ceph"] } },
  ];
  wb.backend.on("extension_problem_scopes", (args) => {
    asked += 1;
    expect(args).toEqual({ id: "rook-ceph-ext", clusterId: "c1" });
    return scopes;
  });
});

afterEach(() => {
  unregister?.();
  unregister = undefined;
  setJudgesClock(null);
  resetProblemSources();
  wb.backend.restore();
});

describe("problems of extensions", () => {
  it("run on a watch narrowed to the namespaces the extension may read, under its name", async () => {
    unregister = registerExtensionProblems("rook-ceph-ext", "Rook Ceph", RULES);
    render(<ProblemsPage clusterId="c1" />);
    const id = await watchOf(wb, "CephCluster");
    expect(wb.specs.get(id)!.namespaces).toEqual(["rook-ceph"]);
    emitSnapshot(wb, id, [ceph("HEALTH_ERR")]);

    const section = await screen.findByRole("region", { name: "Rook Ceph" });
    expect(within(section).getByText("Ceph health error")).toBeInTheDocument();
    expect(within(section).getByText("Ceph reports HEALTH_ERR")).toBeInTheDocument();
    // The cluster-scoped Node is not judged by the extension: it may read it only in a namespace.
    const nodeSource = (namespaces?: string[]) =>
      getSource(sourceKey("c1", { category: "ext:rook-ceph-ext", kind: NODE.kindRef, fieldSelector: null, namespaces }));
    expect(nodeSource()).toBeUndefined();
    expect(nodeSource(["rook-ceph"])).toBeUndefined();
    expect(asked).toBe(1);

    // The extension goes (disabled, removed): its category and problems go with it.
    act(() => {
      unregister?.();
      unregister = undefined;
    });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Rook Ceph" })).not.toBeInTheDocument());
  });

  it("watch only what a rule's source picks: by its label selector, metadata only (ADR-0152)", async () => {
    const sourced = RULES.map((rule) =>
      rule.kind.kind === "CephCluster"
        ? {
            ...rule,
            source: { labelSelector: "app in (ceph,rook)", metadataOnly: true },
            when: { type: "exists", path: ".metadata.name" } as const,
            message: "{{.metadata.name}}",
          }
        : rule,
    );
    unregister = registerExtensionProblems("rook-ceph-ext", "Rook Ceph", sourced);
    render(<ProblemsPage clusterId="c1" />);
    const id = await watchOf(wb, "CephCluster");
    expect(wb.specs.get(id)).toMatchObject({ namespaces: ["rook-ceph"], labelSelector: "app in (ceph,rook)", metadataOnly: true });
    emitSnapshot(wb, id, [{ apiVersion: "ceph.rook.io/v1", kind: "CephCluster", metadata: { name: "rook-ceph", namespace: "rook-ceph", uid: "m1" } }]);
    const section = await screen.findByRole("region", { name: "Rook Ceph" });
    expect(within(section).getAllByText("rook-ceph").length).toBeGreaterThan(0);
  });

  it("tell an object that entered a label-selected source after the first list, for the minutes given (#393)", async () => {
    const entering = RULES.map((rule) =>
      rule.kind.kind === "CephCluster"
        ? {
            ...rule,
            source: { labelSelector: "phase in (Failed)", metadataOnly: true },
            when: { type: "enteredWithin", minutes: 60 } as const,
            message: "{{.metadata.name}}",
          }
        : rule,
    );
    unregister = registerExtensionProblems("rook-ceph-ext", "Rook Ceph", entering);
    const { result } = renderHook(() => useProblemCount("c1"));
    const id = await watchOf(wb, "CephCluster");
    const object = (uid: string, name: string): KubeObject => ({
      apiVersion: "ceph.rook.io/v1",
      kind: "CephCluster",
      metadata: { name, namespace: "rook-ceph", uid },
    });
    // Already there when the list was first read: not counted.
    emitSnapshot(wb, id, [object("old", "was-failed")]);
    await waitFor(() => expect(getSource(sourceKey("c1", { category: "ext:rook-ceph-ext", kind: CEPH_CLUSTER.kindRef, fieldSelector: null, namespaces: ["rook-ceph"], labelSelector: "phase in (Failed)", metadataOnly: true }))?.status).toBe("ready"));
    expect(result.current).toBe(0);
    // Came in later: a problem.
    emitDelta(wb, id, [object("new", "failed-now")], []);
    await waitFor(() => expect(result.current).toBe(1));
  });

  it("count in the sidebar badge like Sextant's own", async () => {
    unregister = registerExtensionProblems("rook-ceph-ext", "Rook Ceph", RULES);
    const { result } = renderHook(() => useProblemCount("c1"));
    emitSnapshot(wb, await watchOf(wb, "CephCluster"), [ceph("HEALTH_ERR")]);
    await waitFor(() => expect(result.current).toBe(1));
  });

  it("count on the extension's own section: objects with problems of every rule, or of the rules it names", async () => {
    unregister = registerExtensionProblems("rook-ceph-ext", "Rook Ceph", [
      ...RULES,
      { ...RULES[0]!, id: "health-error-again", title: "Ceph health error, again" },
      { ...RULES[0]!, id: "warn", title: "Ceph health warning", when: { type: "equals", path: ".status.ceph.health", value: "HEALTH_WARN" } },
    ]);
    const every = renderHook(() => useExtensionSectionCount("c1", ["ext:rook-ceph-ext"], []));
    const warnings = renderHook(() => useExtensionSectionCount("c1", ["ext:rook-ceph-ext"], ["warn"]));
    emitSnapshot(wb, await watchOf(wb, "CephCluster"), [ceph("HEALTH_ERR")]);
    // Two rules hold for the one cluster: it counts once.
    await waitFor(() => expect(every.result.current).toBe(1));
    expect(warnings.result.current).toBe(0);
  });

  it("put a rule of a category of the extension's own there; an opt-in one counts only once turned on (#410)", async () => {
    const main = registerExtensionProblems("rook-ceph-ext", "Rook Ceph", [RULES[0]!]);
    const own = registerExtensionProblems("rook-ceph-ext", "Rook Ceph warnings", [{ ...RULES[0]!, id: "warn", title: "Warn", category: "warnings" }], {
      id: "warnings",
      optIn: true,
    });
    unregister = () => {
      own();
      main();
    };
    expect(isOptIn("ext:rook-ceph-ext:warnings")).toBe(true);
    expect(isOptIn("ext:rook-ceph-ext")).toBe(false);
    expect(categoriesOfExtension("rook-ceph-ext")).toEqual(["ext:rook-ceph-ext", "ext:rook-ceph-ext:warnings"]);
    const count = renderHook(() => useExtensionSectionCount("c1", ["ext:rook-ceph-ext", "ext:rook-ceph-ext:warnings"], ["warn"]));
    emitSnapshot(wb, await watchOf(wb, "CephCluster"), [ceph("HEALTH_ERR")]);
    // Off: the opt-in category is not watched, so its problem is not counted.
    await waitFor(() => expect(count.result.current).toBe(0));
    const before = new Set(wb.specs.keys());
    await act(() => updateSettings(setCategory("ext:rook-ceph-ext:warnings", true)));
    // On: its own source opens, and its rule counts.
    const opened = await watchOf(wb, "CephCluster");
    expect(before.has(opened)).toBe(false);
    emitSnapshot(wb, opened, [ceph("HEALTH_ERR")]);
    await waitFor(() => expect(count.result.current).toBe(1));
  });

  it("judge across objects: a reference to an object that is not there, told only once its list is read", async () => {
    const LOCAL_QUEUE: ResourceKind = { ...CEPH_CLUSTER, kindRef: { group: "kueue.x-k8s.io", version: "v1beta1", kind: "LocalQueue" }, plural: "localqueues" };
    const CLUSTER_QUEUE: ResourceKind = {
      ...CEPH_CLUSTER,
      kindRef: { group: "kueue.x-k8s.io", version: "v1beta1", kind: "ClusterQueue" },
      plural: "clusterqueues",
      namespaced: false,
    };
    wb.backend.on("cluster_kinds", () => [LOCAL_QUEUE, CLUSTER_QUEUE]);
    scopes = [
      { kind: { group: "kueue.x-k8s.io", kind: "LocalQueue" }, namespaces: { type: "all" } },
      { kind: { group: "kueue.x-k8s.io", kind: "ClusterQueue" }, namespaces: { type: "all" } },
    ];
    unregister = registerExtensionProblems("rook-ceph-ext", "Kueue", [
      {
        id: "queue-missing",
        title: "ClusterQueue missing",
        kind: { group: "kueue.x-k8s.io", kind: "LocalQueue" },
        when: { type: "missing", path: ".spec.clusterQueue", kind: { group: "kueue.x-k8s.io", kind: "ClusterQueue" } },
        graceMinutes: 0,
        notify: true,
        toldThroughOwner: false,
        message: "{{.spec.clusterQueue}} does not exist",
      },
    ]);
    const { result } = renderHook(() => useProblemCount("c1"));
    const local = {
      apiVersion: "kueue.x-k8s.io/v1beta1",
      kind: "LocalQueue",
      metadata: { name: "team-a", namespace: "team-a", uid: "u-lq" },
      spec: { clusterQueue: "gpu" },
    };
    const queue = (name: string) => ({ apiVersion: "kueue.x-k8s.io/v1beta1", kind: "ClusterQueue", metadata: { name, uid: `u-${name}` } });
    emitSnapshot(wb, await watchOf(wb, "LocalQueue"), [local]);
    const queues = await watchOf(wb, "ClusterQueue");
    // The ClusterQueues are not read yet: it cannot tell.
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(result.current).toBe(0);
    emitSnapshot(wb, queues, [queue("cpu")]);
    await waitFor(() => expect(result.current).toBe(1));
    // The queue it names comes: the problem goes.
    emitDelta(wb, queues, [queue("gpu")]);
    await waitFor(() => expect(result.current).toBe(0));
  });

  it("judge across objects: a named object that exists with its own condition holding (#409)", async () => {
    const POD: ResourceKind = { ...CEPH_CLUSTER, kindRef: { group: "", version: "v1", kind: "Pod" }, plural: "pods" };
    const CLAIM: ResourceKind = { ...CEPH_CLUSTER, kindRef: { group: "resource.k8s.io", version: "v1", kind: "ResourceClaim" }, plural: "resourceclaims" };
    wb.backend.on("cluster_kinds", () => [POD, CLAIM]);
    scopes = [
      { kind: { group: "", kind: "Pod" }, namespaces: { type: "all" } },
      { kind: { group: "resource.k8s.io", kind: "ResourceClaim" }, namespaces: { type: "all" } },
    ];
    unregister = registerExtensionProblems("rook-ceph-ext", "DRA", [
      {
        id: "waiting",
        title: "Waiting for a device",
        kind: { group: "", kind: "Pod" },
        when: {
          type: "all",
          of: [
            { type: "equals", path: ".status.phase", value: "Pending" },
            {
              type: "related",
              path: ".spec.resourceClaims[0].resourceClaimName",
              kind: { group: "resource.k8s.io", kind: "ResourceClaim" },
              when: { type: "absent", path: ".status.allocation" },
            },
          ],
        },
        graceMinutes: 0,
        notify: true,
        toldThroughOwner: false,
        message: "{{.spec.resourceClaims[0].resourceClaimName}} is not allocated",
      },
    ]);
    const { result } = renderHook(() => useProblemCount("c1"));
    const pod = { apiVersion: "v1", kind: "Pod", metadata: { name: "trainer", namespace: "ml", uid: "u-pod" }, spec: { resourceClaims: [{ resourceClaimName: "gpu" }] }, status: { phase: "Pending" } };
    const claim = (allocated: boolean) => ({
      apiVersion: "resource.k8s.io/v1",
      kind: "ResourceClaim",
      metadata: { name: "gpu", namespace: "ml", uid: "u-claim" },
      status: allocated ? { allocation: { devices: {} } } : {},
    });
    emitSnapshot(wb, await watchOf(wb, "Pod"), [pod]);
    const claims = await watchOf(wb, "ResourceClaim");
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(result.current).toBe(0);
    // The claim is there but not allocated: the pod waits for a device.
    emitSnapshot(wb, claims, [claim(false)]);
    await waitFor(() => expect(result.current).toBe(1));
    // Allocated: the problem goes.
    emitDelta(wb, claims, [claim(true)]);
    await waitFor(() => expect(result.current).toBe(0));
  });

  it("run nowhere when Rust says the extension may read nothing there", async () => {
    scopes = [];
    unregister = registerExtensionProblems("rook-ceph-ext", "Rook Ceph", RULES);
    render(<ProblemsPage clusterId="c1" />);
    await waitFor(() => expect(asked).toBe(1));
    expect([...wb.specs.values()].some((s) => s.kind.group === "ceph.rook.io")).toBe(false);
  });

  it("never watch every namespace for a source whose own namespaces are none", async () => {
    const def = {
      category: "ext:rook-ceph-ext" as const,
      kind: CEPH_CLUSTER.kindRef,
      fieldSelector: null,
      discovered: true,
      namespaces: [] as string[],
    };
    const release = acquireSource("c1", def);
    await waitFor(() => expect(getSource(sourceKey("c1", def))?.status).toBe("ready"));
    expect(wb.specs.size).toBe(0);
    release();
  });

  it("tell what an extension's backend judged, from the declared fields only, and nothing it cannot tell (ADR-0168)", async () => {
    const VS: ResourceKind = { ...CEPH_CLUSTER, kindRef: { group: "networking.istio.io", version: "v1", kind: "VirtualService" }, plural: "virtualservices" };
    const SERVICE: ResourceKind = { ...CEPH_CLUSTER, kindRef: { group: "", version: "v1", kind: "Service" }, plural: "services" };
    wb.backend.on("cluster_kinds", () => [VS, SERVICE]);
    wb.backend.on("extension_problem_scopes", () => [
      { kind: { group: "networking.istio.io", kind: "VirtualService" }, namespaces: { type: "all" } },
      { kind: { group: "", kind: "Service" }, namespaces: { type: "only", namespaces: ["shop"] } },
    ]);
    const judge: ProblemJudgeContribution = {
      id: "routing",
      reads: [
        { kind: { group: "networking.istio.io", kind: "VirtualService" }, paths: [".spec.hosts"] },
        // Read only where the extension may read Services: in part (ADR-0168 amendment).
        { kind: { group: "", kind: "Service" }, paths: [".metadata.labels"], partial: true },
      ],
      facts: [{ id: "unknown-host", values: ["host"] }],
    };
    let answer: () => JudgedFact[] = () => [{ uid: "u-vs", fact: "unknown-host", values: { host: "reviews" } }];
    const sent: JudgedObject[][] = [];
    const partials: unknown[] = [];
    wb.backend.on("extension_problem_judge", (args) => {
      const { id, judge: judgeId, clusterId, objects, partial } = args as { id: string; judge: string; clusterId: string; objects: JudgedObject[]; partial?: unknown };
      expect([id, judgeId, clusterId]).toEqual(["mesh-ext", "routing", "c1"]);
      sent.push(objects);
      partials.push(partial);
      return answer();
    });
    unregister = registerExtensionProblems(
      "mesh-ext",
      "Mesh",
      [
        {
          id: "unknown-host",
          title: "Unknown host",
          kind: { group: "networking.istio.io", kind: "VirtualService" },
          when: { type: "all", of: [{ type: "exists", path: ".spec.hosts" }, { type: "judged", judge: "routing", fact: "unknown-host" }] },
          graceMinutes: 0,
          notify: true,
          toldThroughOwner: false,
          message: "{{fact:host}} is no host {{.metadata.name}} can reach",
        },
      ],
      undefined,
      [judge],
    );
    const { result } = renderHook(() => useProblemCount("c1"));
    const vs = (gen: number) => ({
      apiVersion: "networking.istio.io/v1",
      kind: "VirtualService",
      metadata: { name: "web", namespace: "shop", uid: "u-vs", creationTimestamp: "2026-01-01T00:00:00Z", generation: gen },
      spec: { hosts: ["reviews"], http: [{ route: [] }] },
    });
    const svc = { apiVersion: "v1", kind: "Service", metadata: { name: "api", namespace: "shop", uid: "u-svc", labels: { app: "api" } }, spec: { selector: { app: "api" } } };
    const services = await watchOf(wb, "Service");
    expect(wb.specs.get(services)!.namespaces).toEqual(["shop"]);
    emitSnapshot(wb, await watchOf(wb, "VirtualService"), [vs(1)]);
    // The Services are not read yet: the judge is not asked and nothing is told.
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(sent).toEqual([]);
    expect(result.current).toBe(0);
    emitSnapshot(wb, services, [svc]);
    await waitFor(() => expect(result.current).toBe(1));
    // By uid; only the declared paths, and of the metadata only name, namespace, uid and creation time.
    expect(sent[0]).toEqual([
      { apiVersion: "v1", kind: "Service", metadata: { name: "api", namespace: "shop", uid: "u-svc" }, values: { ".metadata.labels": { app: "api" } } },
      {
        apiVersion: "networking.istio.io/v1",
        kind: "VirtualService",
        metadata: { name: "web", namespace: "shop", uid: "u-vs", creationTimestamp: "2026-01-01T00:00:00Z" },
        values: { ".spec.hosts": ["reviews"] },
      },
    ]);
    expect(partials[0]).toEqual([{ kind: { group: "", kind: "Service" }, readNamespaces: ["shop"], unreadNamespaces: [] }]);
    const source = () =>
      getSource(sourceKey("c1", { category: "ext:mesh-ext", kind: VS.kindRef, fieldSelector: null }))?.problems ?? [];
    expect(source()[0]?.message).toBe("reviews is no host web can reach");

    // A change of a field the judge does not read sends nothing again.
    const vsWatch = await watchOf(wb, "VirtualService");
    emitDelta(wb, vsWatch, [vs(2)]);
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(sent).toHaveLength(1);

    // A failed call: the problem goes at once, never kept from the answer before.
    setJudgesClock(() => Date.now() + 60_000);
    answer = () => {
      throw { code: "timeout", message: "the backend ran out of time" };
    };
    emitDelta(wb, services, [{ ...svc, metadata: { ...svc.metadata, labels: { app: "api2" } } }]);
    await waitFor(() => expect(sent).toHaveLength(2));
    await waitFor(() => expect(result.current).toBe(0));
  });

  it("list a looked-up kind of `narrowLookups` only in the namespaces the judged objects' lookups name", async () => {
    const SEALED: ResourceKind = { ...CEPH_CLUSTER, kindRef: { group: "bitnami.com", version: "v1alpha1", kind: "SealedSecret" }, plural: "sealedsecrets" };
    const SECRET: ResourceKind = { ...CEPH_CLUSTER, kindRef: { group: "", version: "v1", kind: "Secret" }, plural: "secrets" };
    wb.backend.on("cluster_kinds", () => [SEALED, SECRET]);
    wb.backend.on("extension_problem_scopes", () => [
      { kind: { group: "bitnami.com", kind: "SealedSecret" }, namespaces: { type: "all" } },
      { kind: { group: "", kind: "Secret" }, namespaces: { type: "all" } },
    ]);
    unregister = registerExtensionProblems(
      "sealed-ext",
      "Sealed Secrets",
      [
        {
          id: "target-missing",
          title: "Target missing",
          kind: { group: "bitnami.com", kind: "SealedSecret" },
          when: { type: "missing", path: ".metadata.name", kind: { group: "", kind: "Secret" } },
          graceMinutes: 0,
          notify: true,
          toldThroughOwner: false,
          message: "{{.metadata.name}} has no Secret",
        },
      ],
      undefined,
      [],
      [{ group: "", kind: "Secret" }],
    );
    const { result } = renderHook(() => useProblemCount("c1"));
    const sealed = (name: string, namespace: string) => ({
      apiVersion: "bitnami.com/v1alpha1",
      kind: "SealedSecret",
      metadata: { name, namespace, uid: `u-${namespace}-${name}` },
    });
    const secretWatches = () => [...wb.specs.entries()].filter(([, spec]) => spec.kind.kind === "Secret");
    const sealedWatch = await watchOf(wb, "SealedSecret");
    // Before any SealedSecret said where its Secret is, no Secret is listed at all.
    expect(secretWatches()).toEqual([]);
    emitSnapshot(wb, sealedWatch, [sealed("db", "team-a"), sealed("api", "team-b")]);
    await waitFor(() => expect(secretWatches().length).toBeGreaterThan(0), { timeout: 3000 });
    const [secrets, spec] = secretWatches()[0]!;
    expect(spec.namespaces).toEqual(["team-a", "team-b"]);
    expect(spec.metadataOnly).toBe(true);
    emitSnapshot(wb, secrets, [{ apiVersion: "v1", kind: "Secret", metadata: { name: "db", namespace: "team-a", uid: "s1" } }]);
    await waitFor(() => expect(result.current).toBe(1));
    // A SealedSecret in another namespace: the Secrets are listed there too.
    emitDelta(wb, sealedWatch, [sealed("web", "team-c")]);
    await waitFor(() => expect(secretWatches().some(([, sp]) => sp.namespaces?.includes("team-c"))).toBe(true), { timeout: 3000 });
  });

  it("judge rules of kinds from definitions on the kinds Rust says are defined, and ask again when the definitions change", async () => {
    const XRD: ResourceKind = { ...CEPH_CLUSTER, kindRef: { group: "apiextensions.crossplane.io", version: "v1", kind: "CompositeResourceDefinition" }, plural: "compositeresourcedefinitions", namespaced: false };
    const XDB: ResourceKind = { ...CEPH_CLUSTER, kindRef: { group: "example.org", version: "v1", kind: "XDatabase" }, plural: "xdatabases", namespaced: false };
    const DB: ResourceKind = { ...CEPH_CLUSTER, kindRef: { group: "example.org", version: "v1", kind: "Database" }, plural: "databases" };
    wb.backend.on("cluster_kinds", () => [XRD, XDB, DB]);
    const definedBy = { group: "apiextensions.crossplane.io", kind: "CompositeResourceDefinition" };
    let found: ProblemScope[] = [
      { kind: definedBy, namespaces: { type: "all" } },
      { kind: { group: "example.org", kind: "XDatabase" }, namespaces: { type: "all" }, definedBy },
    ];
    let scopeCalls = 0;
    wb.backend.on("extension_problem_scopes", () => {
      scopeCalls += 1;
      return found;
    });
    const kindsFrom = { kind: definedBy, groupPath: ".spec.group", kindPaths: [".spec.names.kind", ".spec.claimNames.kind"], max: 20 };
    unregister = registerExtensionProblems("crossplane-ext", "Crossplane", [
      {
        id: "not-synced",
        title: "Not synced",
        kind: { group: "", kind: "" },
        kindsFrom,
        when: { type: "condition", conditionType: "Synced", status: "False" },
        graceMinutes: 0,
        notify: true,
        toldThroughOwner: false,
        message: "{{.metadata.name}} is not synced",
      },
    ]);
    const { result } = renderHook(() => useProblemCount("c1"));
    const failing = (kind: string, name: string, namespace?: string) => ({
      apiVersion: "example.org/v1",
      kind,
      metadata: { name, uid: `u-${name}`, ...(namespace ? { namespace } : {}) },
      status: { conditions: [{ type: "Synced", status: "False", lastTransitionTime: "2026-01-01T00:00:00Z" }] },
    });
    const xrd = (claim?: string) => ({
      apiVersion: "apiextensions.crossplane.io/v1",
      kind: "CompositeResourceDefinition",
      metadata: { name: "xdatabases.example.org", uid: "u-xrd" },
      spec: { group: "example.org", names: { kind: "XDatabase" }, ...(claim ? { claimNames: { kind: claim } } : {}) },
    });
    // The definitions are watched whole (their `spec` names the kinds), and only the defined kind gets the rule.
    const definitions = await watchOf(wb, "CompositeResourceDefinition");
    expect(wb.specs.get(definitions)!.metadataOnly).toBeFalsy();
    emitSnapshot(wb, definitions, [xrd()]);
    emitSnapshot(wb, await watchOf(wb, "XDatabase"), [failing("XDatabase", "db-1")]);
    await waitFor(() => expect(result.current).toBe(1));
    expect([...wb.specs.values()].some((spec) => spec.kind.kind === "Database")).toBe(false);
    const asked = scopeCalls;

    // A definition now names a claim kind too: Rust is asked again, and the kind it now finds defined is judged.
    found = [...found, { kind: { group: "example.org", kind: "Database" }, namespaces: { type: "only", namespaces: ["team"] }, definedBy }];
    emitDelta(wb, definitions, [xrd("Database")]);
    await waitFor(() => expect(scopeCalls).toBeGreaterThan(asked), { timeout: 3000 });
    const claims = await watchOf(wb, "Database");
    expect(wb.specs.get(claims)!.namespaces).toEqual(["team"]);
    emitSnapshot(wb, claims, [failing("Database", "db", "team")]);
    await waitFor(() => expect(result.current).toBe(2));
    const sources = renderHook(() => useClusterProblems("c1", ["ext:crossplane-ext"]));
    expect(sources.result.current.sources.some((s) => s.truncated)).toBe(false);

    // More definitions than the `kindsFrom` reads (Rust counted them): the category judges a part.
    found = [{ ...found[0]!, moreDefinitions: true }, ...found.slice(1)];
    emitDelta(wb, definitions, [xrd("Database"), { ...xrd(), metadata: { name: "xcaches.example.org", uid: "u-xrd-2" }, spec: { group: "example.org", names: { kind: "XCache" } } }]);
    await waitFor(() => expect(sources.result.current.sources.some((s) => s.truncated)).toBe(true), { timeout: 3000 });
    await waitFor(() => expect(result.current).toBe(2));
  });

  it("tell a problem for each entry a judge gives, with an optional read not served sent as none (ADR-0168 amendment)", async () => {
    const VS: ResourceKind = { ...CEPH_CLUSTER, kindRef: { group: "networking.istio.io", version: "v1", kind: "VirtualService" }, plural: "virtualservices" };
    wb.backend.on("cluster_kinds", () => [VS]);
    wb.backend.on("extension_problem_scopes", () => [
      { kind: { group: "networking.istio.io", kind: "VirtualService" }, namespaces: { type: "all" } },
      { kind: { group: "networking.istio.io", kind: "ServiceEntry" }, namespaces: { type: "all" } },
    ]);
    const judge: ProblemJudgeContribution = {
      id: "hosts",
      reads: [
        { kind: { group: "networking.istio.io", kind: "VirtualService" }, paths: [".spec.hosts"] },
        // Not served by this cluster: no ServiceEntry CRD.
        { kind: { group: "networking.istio.io", kind: "ServiceEntry" }, paths: [".spec.hosts"], optional: true },
      ],
      facts: [{ id: "unknown-host", values: ["host"] }],
    };
    let hosts = ["a", "b"];
    const sent: JudgedObject[][] = [];
    wb.backend.on("extension_problem_judge", (args) => {
      const { objects } = args as { objects: JudgedObject[] };
      sent.push(objects);
      return hosts.map((host) => ({ uid: "u-vs", fact: "unknown-host", values: { host } }));
    });
    unregister = registerExtensionProblems(
      "mesh-ext",
      "Mesh",
      [
        {
          id: "unknown-host",
          title: "Unknown host",
          kind: { group: "networking.istio.io", kind: "VirtualService" },
          when: { type: "judged", judge: "hosts", fact: "unknown-host", each: true },
          graceMinutes: 0,
          notify: true,
          toldThroughOwner: false,
          message: "{{fact:host}} is not known",
        },
      ],
      undefined,
      [judge],
    );
    const { result } = renderHook(() => ({
      problems: useExtensionSectionCount("c1", ["ext:mesh-ext"], [], "problems"),
      objects: useExtensionSectionCount("c1", ["ext:mesh-ext"], []),
    }));
    const vs = { apiVersion: "networking.istio.io/v1", kind: "VirtualService", metadata: { name: "web", namespace: "shop", uid: "u-vs" }, spec: { hosts: ["x"] } };
    const vsWatch = await watchOf(wb, "VirtualService");
    emitSnapshot(wb, vsWatch, [vs]);
    await waitFor(() => expect(result.current.problems).toBe(2));
    expect(result.current.objects).toBe(1);
    expect(sent[0]!.map((o) => o.kind)).toEqual(["VirtualService"]);
    const source = () => getSource(sourceKey("c1", { category: "ext:mesh-ext", kind: VS.kindRef, fieldSelector: null }))?.problems ?? [];
    const first = source();
    expect(first.map((p) => p.message)).toEqual(["a is not known", "b is not known"]);
    expect(new Set(first.map((p) => p.key)).size).toBe(2);
    expect(new Set(first.map((p) => p.notifyKey)).size).toBe(2);
    const keyOfB = first[1]!.key;
    // `a` goes, `c` comes: `b` keeps its identity.
    hosts = ["b", "c"];
    setJudgesClock(() => Date.now() + 60_000);
    emitDelta(wb, vsWatch, [{ ...vs, spec: { hosts: ["y"] } }]);
    await waitFor(() => expect(source().map((p) => p.message)).toEqual(["b is not known", "c is not known"]));
    expect(source()[0]!.key).toBe(keyOfB);
    expect(source()[1]!.key).not.toBe(first[0]!.key);
  });
});
