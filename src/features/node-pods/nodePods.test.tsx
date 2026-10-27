// The Node details tabs "Pods" (#279) and "Resources" (#280): a full table of the node's pods from one watch by
// spec.nodeName (no "Show more"), searched over every column, and "Allocated resources" with each pod's requests,
// limits and usage; both pass axe.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KubeObject, MetricsStatus, PodUsage } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { getDetailsSections } from "../../layout/details/registry";
import "../../resources";
import { axeViolations } from "../../test/axe";
import "../details/index";
import { emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetHistory } from "../metrics/history";
import { resetMetricsCache } from "../metrics/hooks";
import "../metrics/index";
import { resetNamespaceRestore } from "../namespaces";
import "./index";
import { NodePodsTab } from "./PodsTab";
import { NodeResourcesTab } from "./ResourcesTab";

const NODE = { group: "", version: "v1", kind: "Node" };
const POD = { group: "", version: "v1", kind: "Pod" };
const REF = { kind: NODE, namespace: null, name: "n1" };
const node: KubeObject = {
  apiVersion: "v1",
  kind: "Node",
  metadata: { name: "n1", uid: "node-uid" },
  status: { allocatable: { cpu: "4", memory: "8Gi", pods: "110" } },
};

function pod(i: number, phase: string, resources: object, namespace = `ns-${i % 2}`): KubeObject {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: `pod-${i}`, namespace, uid: `uid-${i}`, creationTimestamp: "2026-10-01T10:00:00Z" },
    spec: { nodeName: "n1", containers: [{ name: "app", image: "web:1", resources }] },
    status: { phase, containerStatuses: [{ name: "app", ready: phase === "Running", restartCount: i }] },
  };
}

const PODS = [
  pod(1, "Running", { requests: { cpu: "500m", memory: "1Gi" }, limits: { cpu: "1", memory: "2Gi" } }),
  pod(2, "Pending", { requests: { cpu: "250m" } }),
  pod(3, "Succeeded", { requests: { cpu: "2", memory: "4Gi" } }),
  ...Array.from({ length: 60 }, (_, i) => pod(10 + i, "Running", {})),
];

const STATUS: MetricsStatus = {
  metricsServer: true,
  prometheus: null,
  mode: { mode: "auto" },
  usageSource: "auto",
  effectiveUsageSource: "metricsServer",
};
const usage = (i: number, cpu: number): PodUsage => ({
  namespace: `ns-${i % 2}`,
  name: `pod-${i}`,
  usage: { cpuMillicores: cpu, memoryBytes: 300 * 1024 ** 2 },
  containers: [],
});

let wb: WatchBackend;

beforeEach(() => {
  resetAppStore();
  resetNamespaceRestore();
  resetMetricsCache();
  resetHistory();
  useAppStore.getState().setActiveCluster("c1");
  wb = watchBackend();
  wb.backend.on("metrics_status", () => STATUS);
  wb.backend.on("metrics_pods", () => [usage(1, 120), usage(2, 30)]);
  wb.backend.on("metrics_nodes", () => [{ name: "n1", usage: { cpuMillicores: 900, memoryBytes: 2 * 1024 ** 3 } }]);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("rt__scroll") ? 4000 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("rt__scroll") ? 1600 : 0;
  });
});

afterEach(() => {
  wb.backend.restore();
  resetMetricsCache();
  vi.restoreAllMocks();
});

async function podsWatch(): Promise<string> {
  const id = await watchOf(wb, "Pod", (s) => s.fieldSelector === "spec.nodeName=n1");
  expect(wb.specs.get(id)!.namespaces).toBeNull();
  emitSnapshot(wb, id, PODS);
  return id;
}

const bodyRows = () =>
  within(screen.getByRole("table", { name: /Pods on this node|Non-terminated pods/ }))
    .getAllByRole("row")
    .filter((r) => r.getAttribute("aria-rowindex") !== "1");

describe("the Node details tabs", () => {
  it("are tabs of Node details only, right after Overview", () => {
    const tabs = getDetailsSections(NODE).filter((s) => s.placement === "tab");
    expect(tabs.slice(0, 2).map((s) => s.id)).toEqual(["nodePods", "nodeResources"]);
    expect(getDetailsSections(POD).map((s) => s.id)).not.toContain("nodePods");
  });
});

describe("Pods tab", () => {
  it("lists every pod of the node in the resource table, without the Node column and without a cut", async () => {
    const view = render(<NodePodsTab clusterId="c1" objectRef={REF} obj={node} />);
    await podsWatch();
    expect(await screen.findByText("63 items")).toBeInTheDocument();
    expect(bodyRows().length).toBe(63);
    const headers = within(screen.getByRole("table", { name: "Pods on this node" }))
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toContain("Restarts");
    expect(headers).not.toContain("Node");
    expect(screen.queryByText(/Show \d+ more/)).toBeNull();
    // The usage comes from the node's own poll of its pods' namespaces.
    await waitFor(() => expect(screen.getAllByText("120m").length).toBeGreaterThan(0));
    expect(wb.backend.calls.find((c) => c.cmd === "metrics_pods")!.args).toEqual({ clusterId: "c1", namespaces: null });
    expect(await axeViolations(view.container)).toEqual([]);
  });

  it("searches every column: a status, not only a name", async () => {
    render(<NodePodsTab clusterId="c1" objectRef={REF} obj={node} />);
    await podsWatch();
    await screen.findByText("63 items");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "pending" } });
    await waitFor(() => expect(bodyRows().length).toBe(1));
    expect(bodyRows()[0]!.textContent).toContain("pod-2");
  });
});

describe("Resources tab", () => {
  it("sums the non-terminated pods against allocatable and lists each pod's requests, limits and usage", async () => {
    const view = render(<NodeResourcesTab clusterId="c1" objectRef={REF} obj={node} />);
    await podsWatch();
    const block = screen.getByRole("heading", { name: "Allocated resources" }).closest(".dt-block") as HTMLElement;
    await waitFor(() => expect(within(block).getByText("750m (19%)")).toBeInTheDocument());
    // Limits: only pod-1 sets one on every container; the others are told apart.
    expect(within(block).getByText("1000m (25%)")).toBeInTheDocument();
    expect(within(block).getByText("4000m")).toBeInTheDocument();
    await waitFor(() => expect(within(block).getByText("900m (23%)")).toBeInTheDocument());
    expect(within(block).getByText("Pods: 62 of 110 allowed")).toBeInTheDocument();
    expect(within(block).getByText("61 pods have no limit on every container: the limits above are at least these sums.")).toBeInTheDocument();

    // The terminated pod is not in the table.
    expect(await screen.findByText("62 of 63")).toBeInTheDocument();
    const row = bodyRows().find((r) => r.textContent?.startsWith("pod-1ns-"))!;
    for (const text of ["500m", "1000m", "120m", "1.00GiB", "2.00GiB", "300MiB"]) expect(row.textContent).toContain(text);
    const pending = bodyRows().find((r) => r.textContent?.startsWith("pod-2ns-"))!;
    expect(pending.textContent).toContain("no limit");
    expect(await axeViolations(view.container)).toEqual([]);
  });
});
