// Problems of extensions (ADR-0137): rules registered from a manifest run on the store's watches, only for the kinds
// and namespaces Rust allows, under a category titled with the extension's name; they go with the extension.
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KubeObject, ProblemContribution, ProblemScope, ResourceKind } from "../../api";
import { resetAppStore } from "../../app/store";
import "../../resources";
import { resetClusterKinds } from "../../resources/useKinds";
import { emitDelta, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore } from "../namespaces";
import { resetNotifier } from "../notifications/notifier";
import { registerExtensionProblems } from "./extensionCategories";
import { useExtensionSectionCount, useProblemCount } from "./hooks";
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
    const every = renderHook(() => useExtensionSectionCount("c1", "ext:rook-ceph-ext", []));
    const warnings = renderHook(() => useExtensionSectionCount("c1", "ext:rook-ceph-ext", ["warn"]));
    emitSnapshot(wb, await watchOf(wb, "CephCluster"), [ceph("HEALTH_ERR")]);
    // Two rules hold for the one cluster: it counts once.
    await waitFor(() => expect(every.result.current).toBe(1));
    expect(warnings.result.current).toBe(0);
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
});
