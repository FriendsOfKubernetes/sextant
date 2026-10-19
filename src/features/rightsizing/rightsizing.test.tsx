import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContainerHistory, KubeObject, MetricsStatus, PodUsage, UsageHistory } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { getDetailsSections } from "../../layout/details/registry";
import { getPage } from "../../layout/pages";
import { useClustersStore } from "../clusters/clustersStore";
import { emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetMetricsCache } from "../metrics/hooks";
import { resetNamespaceRestore } from "../namespaces";
import { resetSharedWatches } from "../resource-map/watches";
import { RightsizingDetailsSection } from "./DetailsSection";
import "./index";
import { RIGHTSIZING_PAGE_ID, RightsizingPage } from "./RightsizingPage";
import { MI } from "./units";

const WEEK = 7 * 24 * 3600;
const NOW_S = Math.floor(Date.now() / 1000);

function status(patch: Partial<MetricsStatus> = {}): MetricsStatus {
  return {
    metricsServer: true,
    prometheus: { type: "service", namespace: "monitoring", service: "prometheus-operated", port: 9090, pathPrefix: "" },
    mode: { mode: "auto" },
    usageSource: "auto",
    effectiveUsageSource: "metricsServer",
    ...patch,
  };
}

function pod(namespace: string, name: string, owner: string | null, resources: { cpu: string; memory: string; limit?: string }): KubeObject {
  return {
    metadata: {
      namespace,
      name,
      uid: `${namespace}/${name}`,
      creationTimestamp: "2026-10-01T00:00:00Z",
      labels: owner ? { "pod-template-hash": "7d9f8c6b5", app: owner } : {},
      ownerReferences: owner ? [{ kind: "ReplicaSet", name: `${owner}-7d9f8c6b5`, controller: true }] : [],
    },
    spec: {
      containers: [
        {
          name: "app",
          resources: {
            requests: { cpu: resources.cpu, memory: resources.memory },
            limits: resources.limit ? { memory: resources.limit } : {},
          },
        },
      ],
    },
    status: { phase: "Running" },
  };
}

function hist(namespace: string, podName: string, patch: Partial<ContainerHistory> = {}): ContainerHistory {
  return {
    namespace,
    pod: podName,
    container: "app",
    cpuP95Millicores: 100,
    memoryMaxBytes: 100 * MI,
    throttledRatio: null,
    firstSeen: NOW_S - WEEK,
    lastSeen: NOW_S,
    ...patch,
  };
}

const PODS = [
  pod("shop", "web-7d9f8c6b5-aaaaa", "web", { cpu: "1", memory: "1Gi", limit: "1Gi" }),
  pod("shop", "web-7d9f8c6b5-bbbbb", "web", { cpu: "1", memory: "1Gi", limit: "1Gi" }),
  pod("shop", "cache-7d9f8c6b5-ccccc", "cache", { cpu: "100m", memory: "128Mi", limit: "128Mi" }),
  pod("tools", "debug", null, { cpu: "50m", memory: "64Mi" }),
];

const HISTORY: UsageHistory = {
  windowSecs: WEEK,
  evaluatedAt: NOW_S,
  truncated: false,
  coverageKnown: true,
  liveKnown: true,
  containers: [
    hist("shop", "web-7d9f8c6b5-aaaaa"),
    hist("shop", "web-7d9f8c6b5-bbbbb"),
    hist("shop", "cache-7d9f8c6b5-ccccc", { cpuP95Millicores: 90, memoryMaxBytes: 125 * MI }),
    hist("tools", "debug", { firstSeen: NOW_S - 3600 }),
  ],
};

let wb: WatchBackend;

function serve(current: MetricsStatus, opts: { history?: UsageHistory; pods?: PodUsage[] } = {}) {
  wb.backend.on("metrics_status", () => current);
  wb.backend.on("metrics_usage_history", () => opts.history ?? HISTORY);
  wb.backend.on("metrics_pods", () => opts.pods ?? []);
}

const calls = (cmd: string) => wb.backend.calls.filter((c) => c.cmd === cmd);

beforeEach(() => {
  resetAppStore();
  resetNamespaceRestore();
  resetMetricsCache();
  useClustersStore.setState({ settingsFor: null });
  useAppStore.getState().setActiveCluster("c1");
  useAppStore.getState().setNamespaces("c1", ["shop", "tools"]);
  wb = watchBackend();
});

afterEach(() => {
  resetSharedWatches();
  wb.backend.restore();
  resetMetricsCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function rowOf(workload: string): HTMLElement {
  const link = screen.getByRole("button", { name: new RegExp(workload) });
  return link.closest("tr")!;
}

describe("registration", () => {
  it("adds the page to the Workloads section and a details section for workloads and pods", () => {
    expect(getPage(RIGHTSIZING_PAGE_ID)).toMatchObject({ section: "workloads", labelKey: "rightsizing:sidebar" });
    const has = (group: string, kind: string) =>
      getDetailsSections({ group, version: "v1", kind }).some((s) => s.id === "rightsizing");
    expect(has("apps", "Deployment")).toBe(true);
    expect(has("apps", "StatefulSet")).toBe(true);
    expect(has("apps", "DaemonSet")).toBe(true);
    expect(has("", "Pod")).toBe(true);
    expect(has("", "Node")).toBe(false);
    expect(has("batch", "Job")).toBe(false);
  });
});

describe("Right-sizing page", () => {
  it("sets requests against a week of Prometheus history, totals namespaces and sorts by waste", async () => {
    serve(status());
    render(<RightsizingPage clusterId="c1" />);
    const id = await watchOf(wb, "Pod");
    expect(wb.specs.get(id)!.namespaces).toEqual(["shop", "tools"]);
    emitSnapshot(wb, id, PODS);

    await screen.findByText(/Usage from Prometheus over the last 7 days/);
    await waitFor(() => expect(screen.getByRole("button", { name: /Deployment.*web/ })).toBeTruthy());
    expect(calls("metrics_usage_history")[0]!.args).toEqual({
      clusterId: "c1",
      scope: { type: "namespaces", namespaces: ["shop", "tools"] },
      window: "week",
    });

    const web = rowOf("web");
    // 1 CPU and 1 GiB requested; p95 100m → 120m, peak 100Mi → 128Mi request, 144Mi limit.
    expect(within(web).getByText("→ 120m")).toBeTruthy();
    expect(within(web).getByText("→ 128MiB · → limit 144MiB")).toBeTruthy();
    expect(within(web).getByText("CPU over-provisioned")).toBeTruthy();
    expect(within(web).getByText("Memory over-provisioned")).toBeTruthy();

    const cache = rowOf("cache");
    expect(within(cache).getByText("Memory near limit")).toBeTruthy();

    // The debug pod has an hour of history: no recommendation, and it says why.
    const debug = rowOf("debug");
    expect(within(debug).getByText(/Not enough history: 1 hour of the last 7 days/)).toBeTruthy();
    expect((within(debug).getByRole("button", { name: "Copy resources YAML" }) as HTMLButtonElement).disabled).toBe(true);

    // Namespaces by wasted CPU: shop (2 × 880m) before tools.
    const sections = screen.getAllByRole("region");
    expect(sections.map((s) => s.getAttribute("aria-label"))).toEqual(["shop", "tools"]);
    expect(within(sections[0]!).getByText(/Wasted: 1760m CPU/)).toBeTruthy();
  });

  it("with all namespaces asks for a choice and reads nothing", async () => {
    useAppStore.getState().setNamespaces("c1", []);
    serve(status());
    render(<RightsizingPage clusterId="c1" />);
    expect(await screen.findByText("Choose a namespace")).toBeTruthy();
    expect([...wb.specs.values()].some((s) => s.kind.kind === "Pod")).toBe(false);
    expect(calls("metrics_usage_history")).toHaveLength(0);
  });

  it("looks at the first namespaces of a long filter only", async () => {
    const many = Array.from({ length: 12 }, (_, i) => `ns-${i}`);
    useAppStore.getState().setNamespaces("c1", many);
    serve(status());
    render(<RightsizingPage clusterId="c1" />);
    const id = await watchOf(wb, "Pod");
    expect(wb.specs.get(id)!.namespaces).toEqual(many.slice(0, 10));
    expect(await screen.findByText("Only the first 10 namespaces of the filter are shown.")).toBeTruthy();
    await waitFor(() => expect(calls("metrics_usage_history")[0]!.args.scope).toEqual({ type: "namespaces", namespaces: many.slice(0, 10) }));
  });

  it("copies the resources snippet of a row", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    serve(status());
    render(<RightsizingPage clusterId="c1" />);
    emitSnapshot(wb, await watchOf(wb, "Pod"), PODS);
    await waitFor(() => expect(screen.getByRole("button", { name: /Deployment.*web/ })).toBeTruthy());
    await waitFor(() => expect(within(rowOf("web")).getByText("→ 120m")).toBeTruthy());
    fireEvent.click(within(rowOf("web")).getByRole("button", { name: "Copy resources YAML" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText).toHaveBeenCalledWith(
      "resources:\n  requests:\n    cpu: 120m\n    memory: 128Mi\n  limits:\n    memory: 144Mi\n",
    );
    expect(await screen.findByText("Copied")).toBeTruthy();
    // Nothing is sent to the cluster.
    expect(wb.backend.calls.some((c) => /patch|replace|apply|scale/.test(c.cmd))).toBe(false);
  });

  it("switches to a day of history", async () => {
    serve(status());
    render(<RightsizingPage clusterId="c1" />);
    emitSnapshot(wb, await watchOf(wb, "Pod"), PODS);
    const select = await screen.findByRole("combobox", { name: /History/ });
    fireEvent.change(select, { target: { value: "day" } });
    await waitFor(() => expect(calls("metrics_usage_history").some((c) => c.args.window === "day")).toBe(true));
  });

  it("with metrics-server only shows a labelled snapshot and recommends nothing", async () => {
    serve(status({ prometheus: null }), {
      pods: [
        {
          namespace: "shop",
          name: "cache-7d9f8c6b5-ccccc",
          usage: { cpuMillicores: 3, memoryBytes: 120 * MI },
          containers: [["app", { cpuMillicores: 3, memoryBytes: 120 * MI }]],
        },
      ],
    });
    render(<RightsizingPage clusterId="c1" />);
    emitSnapshot(wb, await watchOf(wb, "Pod"), PODS);
    await screen.findByText(/Only current values are available \(a snapshot from metrics-server\)/);
    await waitFor(() => expect(within(rowOf("cache")).getByText("now 120MiB")).toBeTruthy());
    expect(within(rowOf("cache")).getByText("Snapshot")).toBeTruthy();
    expect(within(rowOf("cache")).getByText("Memory near limit")).toBeTruthy();
    expect(screen.queryByText(/^→/)).toBeNull();
    expect(calls("metrics_usage_history")).toHaveLength(0);
    expect(screen.queryByRole("combobox", { name: /History/ })).toBeNull();
  });

  it("without any metrics still checks the specs", async () => {
    serve(status({ prometheus: null, metricsServer: false, effectiveUsageSource: null }));
    render(<RightsizingPage clusterId="c1" />);
    emitSnapshot(wb, await watchOf(wb, "Pod"), [pod("tools", "bare", null, { cpu: "", memory: "" })]);
    await screen.findByText(/No metrics are available/);
    expect(within(rowOf("bare")).getByText("No CPU request")).toBeTruthy();
    expect(calls("metrics_pods")).toHaveLength(0);
  });
});

describe("Right-sizing details section", () => {
  it("watches the workload's pods by its selector and asks for its history only", async () => {
    serve(status());
    const deployment: KubeObject = {
      metadata: { namespace: "shop", name: "web" },
      spec: { selector: { matchLabels: { app: "web" } } },
    };
    render(
      <RightsizingDetailsSection
        clusterId="c1"
        objectRef={{ kind: { group: "apps", version: "v1", kind: "Deployment" }, namespace: "shop", name: "web" }}
        obj={deployment}
      />,
    );
    const id = await watchOf(wb, "Pod");
    expect(wb.specs.get(id)).toMatchObject({ namespaces: ["shop"], labelSelector: "app=web" });
    // Pods with look-alike names that the Deployment does not own: a StatefulSet's and a DaemonSet's.
    const others = [
      { ...pod("shop", "web-api-0", null, { cpu: "1", memory: "1Gi" }), metadata: { namespace: "shop", name: "web-api-0", uid: "s", ownerReferences: [{ kind: "StatefulSet", name: "web-api", controller: true }] } },
      { ...pod("shop", "web-agent-x7k2p", null, { cpu: "1", memory: "1Gi" }), metadata: { namespace: "shop", name: "web-agent-x7k2p", uid: "d", ownerReferences: [{ kind: "DaemonSet", name: "web-agent", controller: true }] } },
    ];
    wb.backend.on("metrics_usage_history", () => ({
      ...HISTORY,
      containers: [
        ...HISTORY.containers,
        hist("shop", "web-api-0", { cpuP95Millicores: 5000 }),
        hist("shop", "web-agent-x7k2p", { cpuP95Millicores: 5000, lastSeen: null }),
      ],
    }));
    emitSnapshot(wb, id, [...PODS, ...others]);
    await waitFor(() => expect(screen.getByText("→ 120m")).toBeTruthy());
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.queryByText(/p95 5000m/)).toBeNull();
    expect(calls("metrics_usage_history")[0]!.args.scope).toEqual({
      type: "workload",
      namespace: "shop",
      kind: "Deployment",
      name: "web",
    });
  });
});
