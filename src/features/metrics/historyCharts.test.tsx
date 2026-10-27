// Charts from metrics-server in the details (#280): without a Prometheus-compatible source the Metrics section draws a
// pod's, a workload's or a node's CPU and memory from the polled values since it was opened, says so, asks for no
// Prometheus chart, shows the recent past on a quick reopen, and passes axe.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KubeObject, MetricsStatus, NodeUsage, PodUsage } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { getDetailsSections } from "../../layout/details/registry";
import "../../resources";
import { axeViolations } from "../../test/axe";
import { useClustersStore } from "../clusters/clustersStore";
import deploymentJson from "../details/fixtures/deployment.json";
import nodeJson from "../details/fixtures/node.json";
import "../details/index";
import { watchBackend, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore } from "../namespaces";
import { historySeries, resetHistory } from "./history";
import { POLL_INTERVAL_MS, resetMetricsCache } from "./hooks";
import "./index";

const NODE = { group: "", version: "v1", kind: "Node" };
const DEPLOYMENT = { group: "apps", version: "v1", kind: "Deployment" };
const NODE_NAME = "sextant-test-control-plane";

const METRICS_SERVER_ONLY: MetricsStatus = {
  metricsServer: true,
  prometheus: null,
  mode: { mode: "auto" },
  usageSource: "auto",
  effectiveUsageSource: "metricsServer",
};

let wb: WatchBackend;
let cpu = 1000;

function serve(current: MetricsStatus, pods: () => PodUsage[] = () => []) {
  wb.backend.on("metrics_status", () => current);
  wb.backend.on("metrics_nodes", (): NodeUsage[] => [{ name: NODE_NAME, usage: { cpuMillicores: cpu, memoryBytes: 2 * 1024 ** 3 } }]);
  wb.backend.on("metrics_pods", pods);
  wb.backend.on("metrics_charts", () => []);
}

function section(kind: typeof NODE) {
  return getDetailsSections(kind).find((s) => s.id === "metrics")!.Component;
}

const calls = (cmd: string) => wb.backend.calls.filter((c) => c.cmd === cmd);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  resetAppStore();
  resetNamespaceRestore();
  resetMetricsCache();
  resetHistory();
  useClustersStore.setState({ settingsFor: null });
  useAppStore.getState().setActiveCluster("c1");
  wb = watchBackend();
  cpu = 1000;
});

afterEach(() => {
  wb.backend.restore();
  resetMetricsCache();
  resetHistory();
  vi.useRealTimers();
});

describe("charts from metrics-server", () => {
  it("draw a node's CPU and memory since opened, sample every poll and ask for no Prometheus chart", async () => {
    serve(METRICS_SERVER_ONLY);
    const Section = section(NODE);
    const ref = { kind: NODE, namespace: null, name: NODE_NAME };
    const view = render(<Section clusterId="c1" objectRef={ref} obj={nodeJson as KubeObject} />);
    expect(await screen.findByText("Since opened · metrics-server, no history")).toBeInTheDocument();
    const chart = await screen.findByRole("figure", { name: "CPU" });
    expect(within(chart).getByText("1000m")).toBeInTheDocument();
    expect(screen.getByRole("figure", { name: "Memory" })).toHaveTextContent("2.00GiB");
    // metrics-server has no pod counts or disk: those charts are not drawn.
    expect(screen.queryByRole("figure", { name: "Pods" })).toBeNull();
    expect(await axeViolations(view.container)).toEqual([]);

    cpu = 1500;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    await waitFor(() => expect(within(screen.getByRole("figure", { name: "CPU" })).getByText("1500m")).toBeInTheDocument());
    const key = JSON.stringify({ type: "node", name: NODE_NAME });
    expect(historySeries("c1", key).cpu.map((p) => p[1])).toEqual([1000, 1500]);
    expect(calls("metrics_charts")).toHaveLength(0);

    // Closed and opened again soon: the samples are still there.
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    render(<Section clusterId="c1" objectRef={ref} obj={nodeJson as KubeObject} />);
    await waitFor(() => expect(historySeries("c1", key).cpu.length).toBeGreaterThanOrEqual(3));
    expect(historySeries("c1", key).cpu.slice(0, 2).map((p) => p[1])).toEqual([1000, 1500]);
  });

  it("draw a Deployment as the sum of its pods, picked by the names its controller gives them", async () => {
    const pod = (name: string, millicores: number): PodUsage => ({
      namespace: "sextant-demo",
      name,
      usage: { cpuMillicores: millicores, memoryBytes: 1024 ** 2 },
      containers: [],
    });
    serve(METRICS_SERVER_ONLY, () => [pod("nginx-9f755754d-g85tv", 3), pod("nginx-9f755754d-x2b4z", 4), pod("other-7f9c6d5b8-q9w8r", 50)]);
    const Section = section(DEPLOYMENT);
    const ref = { kind: DEPLOYMENT, namespace: "sextant-demo", name: "nginx" };
    const view = render(<Section clusterId="c1" objectRef={ref} obj={deploymentJson as KubeObject} />);
    const chart = await screen.findByRole("figure", { name: "CPU" });
    expect(within(chart).getByText("7m")).toBeInTheDocument();
    expect(screen.getByRole("figure", { name: "Memory" })).toHaveTextContent("2.00MiB");
    expect(calls("metrics_pods").at(-1)!.args).toEqual({ clusterId: "c1", namespaces: null });
    expect(await axeViolations(view.container)).toEqual([]);
  });

  it("wait for the first values before drawing", async () => {
    serve(METRICS_SERVER_ONLY);
    wb.backend.on("metrics_nodes", () => new Promise(() => undefined));
    const Section = section(NODE);
    render(<Section clusterId="c1" objectRef={{ kind: NODE, namespace: null, name: NODE_NAME }} obj={nodeJson as KubeObject} />);
    expect(await screen.findByText("Waiting for the first values from metrics-server…")).toBeInTheDocument();
    expect(screen.queryByRole("figure")).toBeNull();
  });
});
