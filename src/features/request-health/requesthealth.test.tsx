import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoldenMetrics, KubeObject, MetricsStatus, RequestHealth, UsageHistory } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { getDetailsSections } from "../../layout/details/registry";
import { axeViolations } from "../../test/axe";
import { useClustersStore } from "../clusters/clustersStore";
import { emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetMetricsCache } from "../metrics/hooks";
import { resetNamespaceRestore } from "../namespaces";
import { resetSharedWatches } from "../resource-map/watches";
import { REQUEST_HEALTH_POLL_MS, revealRequestHealth } from "./hooks";
import "./index";
import { RequestHealthSection } from "./RequestHealthSection";

const NOW_S = Math.floor(Date.now() / 1000);
const WEEK = 7 * 24 * 3600;
const MI = 2 ** 20;

const WEB_REF = { kind: { group: "apps", version: "v1", kind: "Deployment" }, namespace: "shop", name: "web" };
const DEPLOYMENT: KubeObject = {
  metadata: { namespace: "shop", name: "web", uid: "d1" },
  spec: {
    selector: { matchLabels: { app: "web" } },
    template: {
      metadata: { labels: { app: "web" } },
      spec: {
        containers: [
          { name: "app", resources: { requests: { cpu: "400m" }, limits: { cpu: "500m" } } },
          { name: "sidecar", resources: {} },
        ],
      },
    },
  },
};

function golden(patch: Partial<GoldenMetrics> = {}): GoldenMetrics {
  return {
    source: "istio",
    via: "cluster",
    requestRate: 12.5,
    errorRatio: 0.02,
    latencyMs: { p50: 8.2, p95: 45, p99: 1250 },
    rateSeries: [
      [NOW_S - 120, 12],
      [NOW_S - 60, 12.5],
    ],
    errorSeries: [
      [NOW_S - 120, 0.2],
      [NOW_S - 60, 0.25],
    ],
    ...patch,
  };
}

function health(patch: Partial<RequestHealth> = {}): RequestHealth {
  return {
    evaluatedAt: NOW_S,
    prometheus: true,
    sources: [{ kind: "istio", via: "cluster", latency: true }],
    golden: [golden()],
    failed: [],
    throttling: [
      { container: "app", throttledRatio: 0.42 },
      { container: "sidecar", throttledRatio: 0 },
    ],
    throttlingKnown: true,
    seriesStepSecs: 60,
    ...patch,
  };
}

let wb: WatchBackend;
const asked = () => wb.backend.calls.filter((c) => c.cmd === "metrics_request_health");

beforeEach(() => {
  resetAppStore();
  resetNamespaceRestore();
  resetMetricsCache();
  useClustersStore.setState({ settingsFor: null });
  useAppStore.getState().setActiveCluster("c1");
  wb = watchBackend();
});

afterEach(() => {
  vi.useRealTimers();
  resetSharedWatches();
  wb.backend.restore();
  resetMetricsCache();
});

describe("registration", () => {
  it("adds the section after the metrics and before right-sizing, for workloads and pods", () => {
    const sections = (group: string, kind: string) => getDetailsSections({ group, version: "v1", kind }).map((s) => s.id);
    for (const [group, kind] of [
      ["apps", "Deployment"],
      ["apps", "StatefulSet"],
      ["apps", "DaemonSet"],
      ["", "Pod"],
    ] as const)
      expect(sections(group, kind)).toContain("requestHealth");
    expect(sections("apps", "ReplicaSet")).not.toContain("requestHealth");
    expect(sections("", "Node")).not.toContain("requestHealth");
    const def = getDetailsSections({ group: "", version: "v1", kind: "Pod" }).find((s) => s.id === "requestHealth");
    expect(def?.order).toBeGreaterThan(50);
    expect(def?.order).toBeLessThan(55);
  });
});

describe("Requests section", () => {
  it("asks for the object as a typed target and shows rate, errors and latency per source", async () => {
    wb.backend.on("metrics_request_health", () => health());
    const { container } = render(<RequestHealthSection clusterId="c1" objectRef={WEB_REF} obj={DEPLOYMENT} />);
    const section = await screen.findByRole("region", { name: "Requests" });
    await within(section).findByText("From Istio");
    // Only names, from the details' own reference; no text typed by the user.
    expect(asked()[0]!.args).toEqual({
      clusterId: "c1",
      target: { type: "workload", namespace: "shop", kind: "Deployment", name: "web" },
    });
    const fact = (label: string) => within(section).getByText(label).nextElementSibling!.textContent;
    expect(fact("Request rate")).toBe("12.5 req/s");
    expect(fact("Error rate")).toBe("2.0%");
    expect(fact("Latency")).toBe("p50 8.2 ms · p95 45 ms · p99 1.25 s");
    expect(within(section).getByRole("figure", { name: "Requests per second, last hour" })).toBeTruthy();
    expect(within(section).getByRole("figure", { name: "Failed requests per second, last hour" })).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("says when the source had no requests and has no histogram", async () => {
    wb.backend.on("metrics_request_health", () =>
      health({
        sources: [{ kind: "linkerd", via: "linkerdViz", latency: false }],
        golden: [golden({ source: "linkerd", via: "linkerdViz", requestRate: null, errorRatio: null, latencyMs: { p50: null, p95: null, p99: null } })],
      }),
    );
    render(<RequestHealthSection clusterId="c1" objectRef={WEB_REF} obj={DEPLOYMENT} />);
    expect(await screen.findByText("From Linkerd")).toBeTruthy();
    expect(screen.getByText("Read from the Prometheus of linkerd-viz.")).toBeTruthy();
    expect(screen.getByText("No requests in the last 5 minutes.")).toBeTruthy();
    expect(screen.getByText("No requests to count errors of.")).toBeTruthy();
    expect(screen.getByText("This source has no latency histogram.")).toBeTruthy();
  });

  it("without Prometheus names what would provide the metrics and links to the settings", async () => {
    wb.backend.on("metrics_request_health", () =>
      health({ prometheus: false, sources: [], golden: [], throttling: [], throttlingKnown: false }),
    );
    const { container } = render(<RequestHealthSection clusterId="c1" objectRef={WEB_REF} obj={DEPLOYMENT} />);
    expect(await screen.findByText(/none is set up or found for this cluster/)).toBeTruthy();
    expect(screen.getByText(/Any of these would provide them: an Istio mesh/)).toBeTruthy();
    // Throttling needs Prometheus too: nothing more is said about it.
    expect(screen.queryByText("CPU throttling")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cluster settings" }));
    expect(useClustersStore.getState().settingsFor).toBe("c1");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("tells no source apart from a source without data for these pods", async () => {
    wb.backend.on("metrics_request_health", () => health({ sources: [], golden: [] }));
    const first = render(<RequestHealthSection clusterId="c1" objectRef={WEB_REF} obj={DEPLOYMENT} />);
    expect(await screen.findByText(/Prometheus has no request metrics/)).toBeTruthy();
    expect(screen.getByText(/Any of these would provide them/)).toBeTruthy();
    first.unmount();
    resetMetricsCache();

    wb.backend.on("metrics_request_health", () =>
      health({
        sources: [
          { kind: "istio", via: "cluster", latency: true },
          { kind: "hubble", via: "cluster", latency: true },
          { kind: "beyla", via: "cluster", latency: false },
        ],
        failed: ["beyla"],
        golden: [],
      }),
    );
    render(<RequestHealthSection clusterId="c1" objectRef={WEB_REF} obj={DEPLOYMENT} />);
    expect(await screen.findByText("Prometheus has metrics of Istio, Cilium Hubble, but none for these pods.")).toBeTruthy();
    expect(screen.getByText("Could not read the metrics of Grafana Beyla.")).toBeTruthy();
  });

  it("shows an error from the core", async () => {
    wb.backend.on("metrics_request_health", () => {
      throw { code: "unreachable", message: "Prometheus did not answer in 20 seconds" };
    });
    render(<RequestHealthSection clusterId="c1" objectRef={WEB_REF} obj={DEPLOYMENT} />);
    expect(await screen.findByText(/Prometheus did not answer/)).toBeTruthy();
  });
});

function metricsStatus(): MetricsStatus {
  return {
    metricsServer: true,
    prometheus: { type: "service", namespace: "monitoring", service: "prometheus-operated", port: 9090, pathPrefix: "" },
    mode: { mode: "auto" },
    usageSource: "auto",
    effectiveUsageSource: "metricsServer",
  };
}

function webPod(name: string): KubeObject {
  return {
    metadata: {
      namespace: "shop",
      name,
      uid: name,
      creationTimestamp: "2026-10-01T00:00:00Z",
      labels: { "pod-template-hash": "7d9f8c6b5", app: "web" },
      ownerReferences: [{ kind: "ReplicaSet", name: "web-7d9f8c6b5", controller: true }],
    },
    spec: (DEPLOYMENT.spec as { template: { spec: unknown } }).template.spec as KubeObject["spec"],
    status: { phase: "Running" },
  };
}

const POD_NAME = "web-7d9f8c6b5-bcdfg";
const HISTORY: UsageHistory = {
  windowSecs: WEEK,
  evaluatedAt: NOW_S,
  truncated: false,
  coverageKnown: true,
  liveKnown: true,
  containers: [
    {
      namespace: "shop",
      pod: POD_NAME,
      container: "app",
      cpuP95Millicores: 400,
      memoryMaxBytes: 100 * MI,
      throttledRatio: 0.42,
      firstSeen: NOW_S - WEEK,
      lastSeen: NOW_S,
    },
  ],
};

describe("CPU throttling", () => {
  it("points at the CPU limit when a container with one is throttled, with right-sizing's suggestion", async () => {
    wb.backend.on("metrics_request_health", () => health());
    wb.backend.on("metrics_status", () => metricsStatus());
    wb.backend.on("metrics_usage_history", () => HISTORY);
    wb.backend.on("metrics_pods", () => []);
    const { container } = render(<RequestHealthSection clusterId="c1" objectRef={WEB_REF} obj={DEPLOYMENT} />);
    const section = await screen.findByRole("region", { name: "Requests" });
    expect(await within(section).findByText("CPU throttling")).toBeTruthy();
    expect(within(section).getByText("42.0%")).toBeTruthy();
    expect(within(section).getByText("0%")).toBeTruthy();
    expect(
      within(section).getByText(
        "Throttled in 42.0% of CPU periods with a CPU limit of 500m: the limit is the likely cause of slow responses.",
      ),
    ).toBeTruthy();
    // Only the throttled container with a limit gets a hint.
    expect(within(section).getAllByText(/the limit is the likely cause/)).toHaveLength(1);
    expect(await within(section).findByText("The Right-sizing section suggests a limit once it has enough usage history.")).toBeTruthy();
    // The workload's pods come from the shared right-sizing watch.
    const id = await watchOf(wb, "Pod");
    expect(wb.specs.get(id)).toMatchObject({ namespaces: ["shop"], labelSelector: "app=web" });
    emitSnapshot(wb, id, [webPod(POD_NAME)]);
    // p95 400m × 2 = 800m, above the throttled limit × 1.5 = 750m.
    expect(await within(section).findByText("Right-sizing suggests a CPU limit of 800m from its usage history.")).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("says when throttling is unknown or there are no counters", async () => {
    wb.backend.on("metrics_request_health", () => health({ throttlingKnown: false, throttling: [] }));
    const first = render(<RequestHealthSection clusterId="c1" objectRef={WEB_REF} obj={DEPLOYMENT} />);
    expect(await screen.findByText("CPU throttling could not be read from Prometheus.")).toBeTruthy();
    first.unmount();
    resetMetricsCache();
    wb.backend.on("metrics_request_health", () => health({ throttling: [] }));
    render(<RequestHealthSection clusterId="c1" objectRef={WEB_REF} obj={DEPLOYMENT} />);
    expect(await screen.findByText("Prometheus has no CPU throttling counters for these containers.")).toBeTruthy();
    // No throttled container with a limit: right-sizing is not asked.
    expect(wb.backend.calls.some((c) => c.cmd === "metrics_usage_history")).toBe(false);
  });
});

describe("polling", () => {
  it("reads once a minute while shown and stops when the section goes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    wb.backend.on("metrics_request_health", () => health({ throttling: [] }));
    const pod = { kind: { group: "", version: "v1", kind: "Pod" }, namespace: "shop", name: "web-0" };
    const view = render(<RequestHealthSection clusterId="c1" objectRef={pod} obj={null} />);
    await screen.findByText("From Istio");
    expect(asked()).toHaveLength(1);
    expect(asked()[0]!.args.target).toEqual({ type: "pod", namespace: "shop", name: "web-0" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REQUEST_HEALTH_POLL_MS);
    });
    expect(asked()).toHaveLength(2);
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REQUEST_HEALTH_POLL_MS * 3);
    });
    expect(asked()).toHaveLength(2);
  });

  it("asks nothing for an object without a namespace", async () => {
    const ref = { kind: { group: "apps", version: "v1", kind: "Deployment" }, namespace: null, name: "web" };
    const { container } = render(<RequestHealthSection clusterId="c1" objectRef={ref} obj={null} />);
    await act(async () => Promise.resolve());
    expect(container.textContent).toBe("");
    expect(asked()).toHaveLength(0);
  });
});

describe("the Linkerd block's link", () => {
  it("brings the Requests section into view and focuses its heading", async () => {
    wb.backend.on("metrics_request_health", () => health());
    render(
      <div>
        <button type="button" onClick={(e) => revealRequestHealth(e.currentTarget)}>
          go
        </button>
        <RequestHealthSection clusterId="c1" objectRef={WEB_REF} obj={DEPLOYMENT} />
      </div>,
    );
    await screen.findByText("From Istio");
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Requests"));
  });
});
