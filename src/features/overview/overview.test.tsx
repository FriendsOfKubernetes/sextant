import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KubeObject, MetricsStatus, NodeUsage } from "../../api";
import { resetAppStore } from "../../app/store";
import { MainView } from "../../layout/main/MainView";
import { getPages } from "../../layout/pages";
import "../../resources";
import deploymentJson from "../details/fixtures/deployment.json";
import eventsJson from "../details/fixtures/events.json";
import nodeJson from "../details/fixtures/node.json";
import podJson from "../details/fixtures/pod.json";
import { copy, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import "../events";
import { resetMetricsCache } from "../metrics";
import "../metrics";
import { resetNamespaceRestore, selectNamespaces } from "../namespaces";
import "./index";

const node = nodeJson as KubeObject;
const pod = podJson as KubeObject;
const deployment = deploymentJson as KubeObject;
const events = (eventsJson as { items: KubeObject[] }).items;

function status(patch: Partial<MetricsStatus> = {}): MetricsStatus {
  return {
    metricsServer: true,
    prometheus: null,
    mode: { mode: "auto" },
    usageSource: "auto",
    effectiveUsageSource: "metricsServer",
    ...patch,
  };
}

let wb: WatchBackend;

beforeEach(() => {
  resetAppStore();
  resetNamespaceRestore();
  resetMetricsCache();
  wb = watchBackend();
});

afterEach(() => {
  wb.backend.restore();
  resetMetricsCache();
});

function named(obj: KubeObject, name: string, patch: (o: KubeObject) => void = () => undefined): KubeObject {
  const o = copy(obj);
  o.metadata = { ...o.metadata, name, uid: `uid-${name}` };
  patch(o);
  return o;
}

function withPhase(name: string, phase: string): KubeObject {
  return named(pod, name, (o) => {
    o.status = { ...(o.status as object), phase };
  });
}

function warning(name: string, reason: string, at: string): KubeObject {
  return named(events[0]!, name, (e) => Object.assign(e, { type: "Warning", reason, message: `${reason} happened`, lastTimestamp: at }));
}

async function snapshot(kind: string, items: KubeObject[]) {
  emitSnapshot(wb, await watchOf(wb, kind), items);
}

function serveMetrics(current: MetricsStatus, nodes: NodeUsage[] = []) {
  wb.backend.on("metrics_status", () => current);
  wb.backend.on("metrics_nodes", () => {
    if (!current.effectiveUsageSource) throw { code: "notFound", message: "metrics are unavailable" };
    return nodes;
  });
  wb.backend.on("metrics_charts", () => [
    { metric: "cpu", points: [[1, 100], [2, 200]] },
    { metric: "pods", points: [[1, 12], [2, 14]] },
  ]);
}

describe("Cluster overview", () => {
  it("is the page of the Cluster section, opened when no section is chosen", async () => {
    const pages = getPages("cluster");
    expect(pages.map((p) => p.id)).toEqual(["overview"]);
    expect(pages[0]!.labelKey).toBe("metrics:overview.sidebar");
    serveMetrics(status());
    render(<MainView clusterId="c1" />);
    expect(await screen.findByRole("heading", { name: "Cluster overview" })).toBeInTheDocument();
  });

  it("while the cluster answers slowly shows what loads, the seconds and after 5 s that the cluster is slow", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      serveMetrics(status());
      wb.backend.on("metrics_nodes", () => new Promise<NodeUsage[]>(() => undefined));
      render(<MainView clusterId="c1" />);
      const nodes = within(await screen.findByRole("region", { name: "Nodes" })).getByRole("status");
      const pods = within(screen.getByRole("region", { name: "Pods" })).getByRole("status");
      const warnings = within(screen.getByRole("region", { name: "Warnings" })).getByRole("status");
      expect(nodes).toHaveTextContent(/^Loading Nodes…/);
      expect(pods).toHaveTextContent(/^Loading Pods…/);
      expect(warnings).toHaveTextContent(/^Loading warnings…/);
      await waitFor(() => expect(screen.getByText("Loading metrics…")).toBeInTheDocument());
      expect(screen.queryByText("The cluster is slow to respond")).not.toBeInTheDocument();

      act(() => vi.advanceTimersByTime(6_000));
      expect(nodes).toHaveTextContent(/^Loading Nodes…\s*[67] s\s*The cluster is slow to respond$/);
      expect(warnings).toHaveTextContent(/^Loading warnings…\s*[67] s\s*The cluster is slow to respond$/);
      expect(screen.getByText("Loading metrics…").closest("[role=status]")).toHaveTextContent(/[67] s/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows nodes, pods by phase, workload statuses and the latest warnings", async () => {
    serveMetrics(status());
    render(<MainView clusterId="c1" />);

    await snapshot("Node", [node, named(node, "worker-1", (n) => {
      n.status = { ...(n.status as object), conditions: [{ type: "Ready", status: "False" }] };
    })]);
    await snapshot("Pod", [
      withPhase("a", "Running"),
      withPhase("b", "Running"),
      withPhase("c", "Pending"),
      withPhase("d", "Failed"),
      withPhase("e", "Succeeded"),
    ]);
    await snapshot("Deployment", [
      deployment,
      named(deployment, "broken", (d) => {
        d.status = { ...(d.status as object), readyReplicas: 0 };
      }),
    ]);
    await snapshot("StatefulSet", []);
    await snapshot("DaemonSet", []);
    await snapshot("Job", [
      named(deployment, "done", (j) => Object.assign(j, { kind: "Job", status: { conditions: [{ type: "Complete", status: "True" }] } })),
    ]);
    const eventsWatch = await watchOf(wb, "Event");
    expect(wb.specs.get(eventsWatch)?.fieldSelector).toBe("type=Warning");
    emitSnapshot(wb, eventsWatch, [
      warning("w-old", "FailedMount", "2026-10-11T10:00:00Z"),
      warning("w-new", "BackOff", "2026-10-11T12:00:00Z"),
    ]);

    expect(screen.getByTestId("ov-nodes")).toHaveTextContent("2");
    expect(screen.getByText("1 of 2 ready")).toBeInTheDocument();
    expect(screen.getByTestId("ov-pods")).toHaveTextContent("5");

    const workloads = screen.getByRole("region", { name: "Workloads" });
    const row = (kind: string) => workloads.querySelector(`tr[data-kind="${kind}"]`) as HTMLElement;
    const state = (kind: string, s: string) => row(kind).querySelector(`[data-state="${s}"]`)?.textContent;
    expect(state("pods", "Running")).toBe("Running2");
    expect(state("pods", "Pending")).toBe("Pending1");
    expect(state("pods", "Failed")).toBe("Failed1");
    expect(state("pods", "Succeeded")).toBe("Succeeded1");
    expect(state("deployments", "ready")).toBe("Ready1");
    expect(state("deployments", "pending")).toBe("Not ready1");
    expect(state("jobs", "succeeded")).toBe("Succeeded1");
    expect(within(row("statefulsets")).getByText("0")).toBeInTheDocument();

    const warnings = within(screen.getByRole("region", { name: "Warnings" })).getAllByRole("listitem");
    expect(warnings.map((w) => w.querySelector(".events-item__reason")?.textContent)).toEqual(["BackOff", "FailedMount"]);
    expect(within(warnings[0]!).getByText("BackOff happened")).toBeInTheDocument();
  });

  it("pods, workloads and warnings follow the namespace filter; nodes are cluster-wide", async () => {
    serveMetrics(status());
    await selectNamespaces("c1", ["sextant-demo"]);
    render(<MainView clusterId="c1" />);
    for (const kind of ["Pod", "Deployment", "StatefulSet", "DaemonSet", "Job", "Event"]) {
      expect(wb.specs.get(await watchOf(wb, kind))?.namespaces).toEqual(["sextant-demo"]);
    }
    expect(wb.specs.get(await watchOf(wb, "Node"))?.namespaces).toBeNull();
  });

  it("shows cluster CPU and memory against allocatable capacity", async () => {
    serveMetrics(status(), [{ name: "sextant-test-control-plane", usage: { cpuMillicores: 4000, memoryBytes: 7 * 1024 ** 3 } }]);
    render(<MainView clusterId="c1" />);
    await snapshot("Node", [node]);
    const usage = screen.getByRole("region", { name: "Usage" });
    expect(await within(usage).findByText("4000m of 16000m allocatable")).toBeInTheDocument();
    expect(within(usage).getByText("25%")).toBeInTheDocument();
    expect(within(usage).getByText("7.00GiB of 27.3GiB allocatable")).toBeInTheDocument();
    // No Prometheus: no charts are asked for.
    expect(within(screen.getByRole("region", { name: "Last hour" })).getByText("Charts of the last hour need Prometheus.")).toBeInTheDocument();
    expect(wb.backend.calls.filter((c) => c.cmd === "metrics_charts")).toHaveLength(0);
  });

  it("draws the cluster charts of the last hour when Prometheus is there", async () => {
    serveMetrics(
      status({ prometheus: { type: "service", namespace: "monitoring", service: "prometheus-operated", port: 9090, pathPrefix: "" } }),
    );
    render(<MainView clusterId="c1" />);
    const charts = await screen.findByRole("region", { name: "Last hour" });
    expect(await within(charts).findByRole("figure", { name: "CPU" })).toBeInTheDocument();
    expect(within(charts).getByRole("figure", { name: "Pods" })).toHaveTextContent("14");
    const call = wb.backend.calls.find((c) => c.cmd === "metrics_charts");
    expect(call?.args).toEqual({ clusterId: "c1", chart: { type: "cluster" }, rangeSecs: 3600 });
  });

  it("without any metrics source says so and links to the cluster settings", async () => {
    serveMetrics(status({ metricsServer: false, effectiveUsageSource: null }));
    render(<MainView clusterId="c1" />);
    const usage = await screen.findByRole("region", { name: "Usage" });
    expect(await within(usage).findByText("Metrics are unavailable")).toBeInTheDocument();
    expect(within(usage).getByRole("button", { name: "Open cluster settings" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("region", { name: "Last hour" })).toBeNull());
  });
});
