import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChartTarget, ClusterInfo, KubeObject, MetricsStatus, NodeUsage, PodUsage, PrometheusTarget, Series } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { ResourceTable } from "../../components/Table";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { getDetailsSections } from "../../layout/details/registry";
import "../../resources";
import { useClustersStore } from "../clusters/clustersStore";
import { getClusterSettingsSections } from "../clusters/settingsRegistry";
import deploymentJson from "../details/fixtures/deployment.json";
import nodeJson from "../details/fixtures/node.json";
import podJson from "../details/fixtures/pod.json";
import "../details/index";
import { copy, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore } from "../namespaces";
import { resetHistory } from "./history";
import { IDLE_TTL_MS, MAX_IDLE_ENTRIES, metricsCacheStats, POLL_INTERVAL_MS, resetMetricsCache, usePodUsage } from "./hooks";
import "./index";
import { presetOf } from "./SettingsSection";

const pod = podJson as KubeObject;
const node = nodeJson as KubeObject;
const deployment = deploymentJson as KubeObject;
const POD = { group: "", version: "v1", kind: "Pod" };
const NODE = { group: "", version: "v1", kind: "Node" };
const DEPLOYMENT = { group: "apps", version: "v1", kind: "Deployment" };

const PROMETHEUS: PrometheusTarget = {
  type: "service",
  namespace: "monitoring",
  service: "prometheus-operated",
  port: 9090,
  pathPrefix: "",
};

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

const NOTHING = status({ metricsServer: false, prometheus: null, effectiveUsageSource: null });

const nginxUsage: PodUsage = {
  namespace: "sextant-demo",
  name: "nginx-9f755754d-g85tv",
  usage: { cpuMillicores: 3.4, memoryBytes: 34 * 1024 * 1024 },
  containers: [["nginx", { cpuMillicores: 3.4, memoryBytes: 34 * 1024 * 1024 }]],
};

/** 1.6 of 16 cores (10%), 7 GiB of 28578828Ki (~25%). */
const nodeUsage: NodeUsage = {
  name: "sextant-test-control-plane",
  usage: { cpuMillicores: 1600, memoryBytes: 7 * 1024 ** 3 },
};

function series(metric: string, values: number[]): Series {
  return { metric, points: values.map((v, i) => [1_700_000_000 + i * 60, v] as [number, number]) };
}

let wb: WatchBackend;

function serve(current: MetricsStatus, opts: { pods?: PodUsage[]; nodes?: NodeUsage[]; charts?: Series[] } = {}) {
  wb.backend.on("metrics_status", () => current);
  wb.backend.on("metrics_pods", () => {
    if (!current.effectiveUsageSource) throw { code: "notFound", message: "metrics are unavailable" };
    return opts.pods ?? [];
  });
  wb.backend.on("metrics_nodes", () => {
    if (!current.effectiveUsageSource) throw { code: "notFound", message: "metrics are unavailable" };
    return opts.nodes ?? [];
  });
  wb.backend.on("metrics_charts", () => opts.charts ?? []);
}

function calls(cmd: string) {
  return wb.backend.calls.filter((c) => c.cmd === cmd);
}

beforeEach(() => {
  resetAppStore();
  resetNamespaceRestore();
  resetMetricsCache();
  resetHistory();
  useClustersStore.setState({ settingsFor: null });
  useAppStore.getState().setActiveCluster("c1");
  wb = watchBackend();
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("rt__scroll") ? 660 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("rt__scroll") ? 1600 : 0;
  });
});

afterEach(() => {
  wb.backend.restore();
  resetMetricsCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Header texts and the cells of the first data row, by header. */
function firstRow(): Record<string, string> {
  const table = screen.getByRole("table");
  const headers = within(table)
    .getAllByRole("columnheader")
    .map((h) => h.textContent ?? "");
  const row = within(table)
    .getAllByRole("row")
    .find((r) => r.getAttribute("aria-rowindex") === "2")!;
  const cells = within(row).getAllByRole("cell");
  return Object.fromEntries(headers.map((h, i) => [h, cells[i]?.textContent ?? ""]));
}

/** Header labels (without sort arrows), in order. */
function headers(): string[] {
  return within(screen.getByRole("table"))
    .getAllByRole("columnheader")
    .map((h) => (h.textContent ?? "").replace(/[^\p{L} ]/gu, "").trim())
    .filter(Boolean);
}

async function showTable(kind: typeof POD, obj: KubeObject) {
  render(<ResourceTable clusterId="c1" kind={kind} />);
  const id = await watchOf(wb, kind.kind);
  emitSnapshot(wb, id, [copy(obj)]);
}

describe("CPU and Memory columns", () => {
  it("pods: values from the current source, after Containers", async () => {
    serve(status(), { pods: [nginxUsage] });
    await showTable(POD, pod);
    await waitFor(() => expect(firstRow()["CPU"]).toBe("3m"));
    expect(firstRow()["Memory"]).toBe("34.0MiB");
    const h = headers();
    expect(h.indexOf("CPU")).toBe(h.indexOf("Containers") + 1);
    expect(h.indexOf("Memory")).toBe(h.indexOf("CPU") + 1);
    // One request for the whole table, for the selected namespaces (all).
    expect(calls("metrics_pods")).toHaveLength(1);
    expect(calls("metrics_pods")[0]!.args).toEqual({ clusterId: "c1", namespaces: null });
  });

  it("nodes: usage against allocatable, after Name", async () => {
    serve(status(), { nodes: [nodeUsage] });
    await showTable(NODE, node);
    await waitFor(() => expect(firstRow()["CPU"]).toBe("10%"));
    expect(firstRow()["Memory"]).toBe("26%");
    const h = headers();
    expect(h.indexOf("CPU")).toBe(h.indexOf("Name") + 1);
    const cpuCell = screen.getByTitle("1600m of 16000m");
    expect(cpuCell).toBeInTheDocument();
  });

  it("without any source the cells say n/a and open the cluster settings", async () => {
    serve(NOTHING);
    await showTable(POD, pod);
    await waitFor(() => expect(firstRow()["CPU"]).toBe("n/a"));
    const cell = screen.getAllByTitle("Metrics are unavailable")[0]!;
    fireEvent.click(cell);
    expect(useClustersStore.getState().settingsFor).toBe("c1");
    // The click does not open the row's details.
    expect(useAppStore.getState().details).toBeNull();
  });
});

function Usage() {
  const usage = usePodUsage("c1");
  return <div data-testid="usage">{usage.data ? usage.data.size : "-"}</div>;
}

describe("polling", () => {
  it("refreshes every 30 seconds while shown and stops when nothing shows it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve(status(), { pods: [nginxUsage] });
    const view = render(<Usage />);
    await waitFor(() => expect(screen.getByTestId("usage").textContent).toBe("1"));
    expect(calls("metrics_pods")).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(calls("metrics_pods")).toHaveLength(2);
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    });
    expect(calls("metrics_pods")).toHaveLength(2);
  });
});

describe("memory (#120)", () => {
  it("opening and closing the details of 200 different pods leaves nothing behind", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve(status({ prometheus: PROMETHEUS }), { pods: [nginxUsage], charts: [] });
    for (let i = 0; i < 200; i++) {
      const ref = { kind: POD, namespace: "sextant-demo", name: `pod-${i}` };
      const view = render(<DetailsPanel clusterId="c1" objectRef={ref} />);
      const id = await watchOf(wb, "Pod", (s) => s.fieldSelector === `metadata.name=${ref.name}`);
      const obj = copy(pod);
      obj.metadata = { ...obj.metadata, name: ref.name, uid: `uid-${i}` };
      emitSnapshot(wb, id, [obj]);
      await waitFor(() => expect(calls("metrics_charts")).toHaveLength(i + 1));
      view.unmount();
    }
    // A quick reopen reuses what was fetched; idle values are bounded meanwhile and gone after a while.
    expect(metricsCacheStats().entries).toBeLessThanOrEqual(MAX_IDLE_ENTRIES);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDLE_TTL_MS * 3);
    });
    expect(metricsCacheStats()).toEqual({ entries: 0, podClusters: 0, nodeClusters: 0 });
  }, 60_000);

  it("a quick reopen reuses the value without asking again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve(status(), { pods: [nginxUsage] });
    const first = render(<Usage />);
    await waitFor(() => expect(screen.getByTestId("usage").textContent).toBe("1"));
    first.unmount();
    render(<Usage />);
    expect(screen.getByTestId("usage").textContent).toBe("1");
    expect(calls("metrics_pods")).toHaveLength(1);
  });
});

function section(kind: typeof POD) {
  const def = getDetailsSections(kind).find((s) => s.id === "metrics");
  expect(def).toBeDefined();
  return def!.Component;
}

/** Lets uPlot run in jsdom: matchMedia and a 2D context that accepts every call. */
function fakeCanvas() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  );
  // Every Path2D method is a no-op.
  vi.stubGlobal(
    "Path2D",
    class {
      constructor() {
        return new Proxy(this, { get: (target, prop) => (prop in target ? Reflect.get(target, prop) : () => undefined) });
      }
    },
  );
  const ctx: Record<string | symbol, unknown> = {};
  const proxy = new Proxy(ctx, {
    get: (target, prop) => (prop in target ? target[prop] : () => ({ width: 10 })),
    set: (target, prop, value) => {
      target[prop] = value;
      return true;
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(proxy as unknown as CanvasRenderingContext2D);
}

describe("Metrics section of the details panel", () => {
  it("is placed between conditions and events, for pods, nodes and Deployments/StatefulSets/DaemonSets", () => {
    const ids = (kind: typeof POD) => getDetailsSections(kind).map((s) => s.id);
    expect(ids(POD)).toContain("metrics");
    expect(ids(NODE)).toContain("metrics");
    for (const kind of ["Deployment", "StatefulSet", "DaemonSet"]) expect(ids({ ...DEPLOYMENT, kind })).toContain("metrics");
    expect(ids({ group: "", version: "v1", kind: "ConfigMap" })).not.toContain("metrics");
    const order = getDetailsSections(POD).find((s) => s.id === "metrics")!.order;
    expect(order).toBeGreaterThan(30);
    expect(order).toBeLessThan(80);
  });

  it("with Prometheus draws the last hour of a Deployment (sum of its pods)", async () => {
    fakeCanvas();
    serve(status({ prometheus: PROMETHEUS }), { charts: [series("cpu", [10, 20, 30]), series("memory", [1024 ** 2, 2 * 1024 ** 2])] });
    const Section = section(DEPLOYMENT);
    const ref = { kind: DEPLOYMENT, namespace: "sextant-demo", name: "nginx" };
    const view = render(<Section clusterId="c1" objectRef={ref} obj={deployment} />);
    const cpu = await screen.findByRole("figure", { name: "CPU" });
    expect(within(cpu).getByText("30m")).toBeInTheDocument();
    expect(within(screen.getByRole("figure", { name: "Memory" })).getByText("2.00MiB")).toBeInTheDocument();
    expect(calls("metrics_charts")[0]!.args).toEqual({
      clusterId: "c1",
      chart: { type: "workload", namespace: "sextant-demo", kind: "Deployment", name: "nginx" } satisfies ChartTarget,
      rangeSecs: 3600,
    });
    // uPlot drew into the figure.
    await waitFor(() => expect(view.container.querySelectorAll(".uplot")).toHaveLength(2));
  });

  it("for a pod shows the current values and its charts", async () => {
    serve(status({ prometheus: PROMETHEUS }), { pods: [nginxUsage], charts: [series("cpu", [1, 2]), series("memory", [5, 6])] });
    const Section = section(POD);
    render(<Section clusterId="c1" objectRef={{ kind: POD, namespace: "sextant-demo", name: "nginx-9f755754d-g85tv" }} obj={pod} />);
    expect(await screen.findByText("34.0MiB")).toBeInTheDocument();
    expect(screen.getByText("3m")).toBeInTheDocument();
    await screen.findByRole("figure", { name: "CPU" });
    expect(calls("metrics_charts")[0]!.args.chart).toEqual({ type: "pod", namespace: "sextant-demo", name: "nginx-9f755754d-g85tv" });
  });

  it("for a node shows usage of allocatable and CPU, memory, pods and disk charts", async () => {
    serve(status({ prometheus: PROMETHEUS }), {
      nodes: [nodeUsage],
      charts: ["cpu", "memory", "pods", "disk"].map((m) => series(m, [1, 2, 3])),
    });
    const Section = section(NODE);
    render(<Section clusterId="c1" objectRef={{ kind: NODE, namespace: null, name: "sextant-test-control-plane" }} obj={node} />);
    expect(await screen.findByText("10% · 1600m of 16000m")).toBeInTheDocument();
    for (const name of ["CPU", "Memory", "Pods", "Disk"]) expect(await screen.findByRole("figure", { name })).toBeInTheDocument();
    expect(calls("metrics_charts")[0]!.args.chart).toEqual({ type: "node", name: "sextant-test-control-plane" });
  });

  it("without Prometheus (off or not found) draws from metrics-server since opened and does not query charts", async () => {
    serve(status({ mode: { mode: "off" } }), { pods: [nginxUsage] });
    const Section = section(POD);
    render(<Section clusterId="c1" objectRef={{ kind: POD, namespace: "sextant-demo", name: "nginx-9f755754d-g85tv" }} obj={pod} />);
    expect(await screen.findByText("Since opened · metrics-server, no history")).toBeInTheDocument();
    expect(await screen.findByRole("figure", { name: "Memory" })).toHaveTextContent("34.0MiB");
    expect(calls("metrics_charts")).toHaveLength(0);
  });

  it("without any source says Metrics are unavailable with a link to the cluster settings", async () => {
    serve(NOTHING);
    const Section = section(NODE);
    render(<Section clusterId="c1" objectRef={{ kind: NODE, namespace: null, name: "sextant-test-control-plane" }} obj={node} />);
    expect(await screen.findByText("Metrics are unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("figure")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open cluster settings" }));
    expect(useClustersStore.getState().settingsFor).toBe("c1");
    expect(calls("metrics_charts")).toHaveLength(0);
  });
});

const cluster: ClusterInfo = {
  id: "c1",
  context: "kind-sextant-test",
  clusterName: "kind-sextant-test",
  server: "https://127.0.0.1:6443",
  user: "admin",
  namespace: null,
  sourceId: "default",
};

function settingsSection() {
  const def = getClusterSettingsSections().find((s) => s.id === "metrics");
  expect(def?.titleKey).toBe("metrics:settings.title");
  const Section = def!.Component;
  render(<Section clusterId="c1" cluster={cluster} />);
}

const saved = () => wb.backend.settings.clusters["c1"];

describe("Metrics cluster settings", () => {
  it("shows what was found automatically and where current values come from", async () => {
    serve(status({ prometheus: PROMETHEUS }));
    settingsSection();
    expect(await screen.findByText("Found automatically: monitoring/prometheus-operated:9090")).toBeInTheDocument();
    const detected = screen.getByLabelText("Found");
    expect(within(detected).getByText("Available")).toBeInTheDocument();
    // Both sources in auto: current values from metrics-server.
    expect(within(detected).getByText("metrics-server", { selector: "dd" })).toBeInTheDocument();
  });

  it("a manual service address replaces the automatic search", async () => {
    serve(status());
    settingsSection();
    fireEvent.click(await screen.findByRole("radio", { name: "Manual address" }));
    const input = screen.getByRole("textbox", { name: "Service (namespace/service:port)" });

    fireEvent.change(input, { target: { value: "prometheus-operated" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this address" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Expected namespace/service:port");
    expect(saved()?.prometheus).toBeUndefined();

    fireEvent.change(input, { target: { value: "monitoring/prometheus-operated:9090" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Path prefix" }), { target: { value: "/prom" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this address" }));
    await waitFor(() =>
      expect(saved()?.prometheus).toEqual({ mode: "manual", target: { ...PROMETHEUS, pathPrefix: "/prom" } }),
    );
    // The status is asked again for the new settings.
    await waitFor(() => expect(calls("metrics_status").length).toBeGreaterThanOrEqual(2));
  });

  it("says what kind of Prometheus-compatible source was found", async () => {
    serve(
      status({
        prometheus: { type: "service", namespace: "vm", service: "vmsingle-vm", port: 8429, pathPrefix: "" },
        prometheusKind: "victoriaMetricsSingle",
      }),
    );
    settingsSection();
    expect(await screen.findByText("Found automatically: vm/vmsingle-vm:8429")).toBeInTheDocument();
    const detected = screen.getByLabelText("Found");
    expect(within(detected).getByText("VictoriaMetrics single-node", { selector: "dd" })).toBeInTheDocument();
  });

  it("an answering source of unknown kind is a Prometheus-compatible API", async () => {
    serve(status({ prometheus: { type: "url", url: "http://10.0.0.5:9090" } }));
    settingsSection();
    const detected = await screen.findByLabelText("Found");
    expect(await within(detected).findByText("Prometheus-compatible API", { selector: "dd" })).toBeInTheDocument();
  });

  it("the VictoriaMetrics presets fill in the port and the vmselect path with its tenant", async () => {
    serve(status());
    settingsSection();
    fireEvent.click(await screen.findByRole("radio", { name: "Manual address" }));
    const kind = screen.getByRole("combobox", { name: "Kind" });
    const address = screen.getByRole("textbox", { name: "Service (namespace/service:port)" });
    const prefix = screen.getByRole("textbox", { name: "Path prefix" });
    expect(kind).toHaveValue("prometheus");

    fireEvent.change(address, { target: { value: "vm/vmsingle-vm:9090" } });
    fireEvent.change(kind, { target: { value: "victoriaMetricsSingle" } });
    expect(address).toHaveValue("vm/vmsingle-vm:8428");
    expect(prefix).toHaveValue("");
    expect(screen.queryByRole("textbox", { name: /Tenant/ })).toBeNull();

    fireEvent.change(address, { target: { value: "vm/vmselect-vm" } });
    fireEvent.change(kind, { target: { value: "victoriaMetricsCluster" } });
    expect(address).toHaveValue("vm/vmselect-vm:8481");
    expect(prefix).toHaveValue("/select/0/prometheus");
    const tenant = screen.getByRole("textbox", { name: "Tenant (accountID or accountID:projectID)" });
    expect(tenant).toHaveValue("0");

    fireEvent.change(tenant, { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this address" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Expected a tenant such as 0 or 12:34.");
    expect(saved()?.prometheus).toBeUndefined();

    fireEvent.change(tenant, { target: { value: "12:34" } });
    expect(prefix).toHaveValue("/select/12:34/prometheus");
    fireEvent.click(screen.getByRole("button", { name: "Use this address" }));
    await waitFor(() =>
      expect(saved()?.prometheus).toEqual({
        mode: "manual",
        target: { type: "service", namespace: "vm", service: "vmselect-vm", port: 8481, pathPrefix: "/select/12:34/prometheus" },
      }),
    );
    // Under the VictoriaMetrics cluster kind another prefix is refused; "Other" takes it.
    fireEvent.change(prefix, { target: { value: "/prom" } });
    fireEvent.blur(prefix);
    expect(kind).toHaveValue("victoriaMetricsCluster");
    fireEvent.click(screen.getByRole("button", { name: "Use this address" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Expected a tenant such as 0 or 12:34.");
    fireEvent.change(kind, { target: { value: "custom" } });
    expect(prefix).toHaveValue("/prom");
    fireEvent.click(screen.getByRole("button", { name: "Use this address" }));
    await waitFor(() =>
      expect(saved()?.prometheus).toEqual({
        mode: "manual",
        target: { type: "service", namespace: "vm", service: "vmselect-vm", port: 8481, pathPrefix: "/prom" },
      }),
    );
  });

  it("a tenant with a slash is shown as typed and refused, not saved as another path", async () => {
    serve(status());
    settingsSection();
    fireEvent.click(await screen.findByRole("radio", { name: "Manual address" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Service (namespace/service:port)" }), {
      target: { value: "vm/vmselect-vm" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), { target: { value: "victoriaMetricsCluster" } });
    const tenant = screen.getByRole("textbox", { name: "Tenant (accountID or accountID:projectID)" });
    for (const typed of ["1/", "0/../x"]) {
      fireEvent.change(tenant, { target: { value: typed } });
      expect(tenant).toHaveValue(typed);
      fireEvent.click(screen.getByRole("button", { name: "Use this address" }));
      expect(screen.getByRole("alert")).toHaveTextContent("Expected a tenant such as 0 or 12:34.");
    }
    expect(saved()?.prometheus).toBeUndefined();
  });

  it("the kind is judged when the address is left, not while its port is typed", async () => {
    serve(status());
    settingsSection();
    fireEvent.click(await screen.findByRole("radio", { name: "Manual address" }));
    const kind = screen.getByRole("combobox", { name: "Kind" });
    const address = screen.getByRole("textbox", { name: "Service (namespace/service:port)" });
    fireEvent.change(address, { target: { value: "vm/vmselect-vm" } });
    fireEvent.change(kind, { target: { value: "victoriaMetricsCluster" } });
    fireEvent.change(address, { target: { value: "vm/vmselect-vm:84" } });
    expect(kind).toHaveValue("victoriaMetricsCluster");
    expect(screen.getByRole("textbox", { name: "Tenant (accountID or accountID:projectID)" })).toBeInTheDocument();
    fireEvent.change(address, { target: { value: "vm/vmselect-vm:8481" } });
    fireEvent.blur(address);
    expect(kind).toHaveValue("victoriaMetricsCluster");
    // Another port, once left: no longer vmselect's.
    fireEvent.change(address, { target: { value: "monitoring/prometheus-server:80" } });
    fireEvent.blur(address);
    expect(kind).toHaveValue("custom");
  });

  it("prometheus-server on port 80 is the Prometheus kind", () => {
    expect(presetOf(80, "")).toBe("prometheus");
    expect(presetOf(9090, "")).toBe("prometheus");
    expect(presetOf(8481, "/select/0/prometheus")).toBe("victoriaMetricsCluster");
    expect(presetOf(8481, "/select/1//prometheus")).toBe("custom");
  });

  it("a manual URL is saved as a direct address", async () => {
    serve(status());
    settingsSection();
    fireEvent.click(await screen.findByRole("radio", { name: "Manual address" }));
    fireEvent.click(screen.getByRole("radio", { name: "URL" }));
    fireEvent.change(screen.getByRole("textbox", { name: "URL of the Prometheus-compatible API" }), { target: { value: "http://10.0.0.5:9090" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this address" }));
    await waitFor(() =>
      expect(saved()?.prometheus).toEqual({ mode: "manual", target: { type: "url", url: "http://10.0.0.5:9090" } }),
    );
  });

  it("Off turns Prometheus off", async () => {
    serve(status());
    settingsSection();
    fireEvent.click(await screen.findByRole("radio", { name: "Off" }));
    await waitFor(() => expect(saved()?.prometheus).toEqual({ mode: "off" }));
  });

  it("the source of current values switches, and the columns ask again", async () => {
    serve(status(), { pods: [nginxUsage] });
    render(<Usage />);
    settingsSection();
    await waitFor(() => expect(calls("metrics_pods")).toHaveLength(1));
    fireEvent.change(await screen.findByRole("combobox", { name: "Current CPU and memory from" }), {
      target: { value: "prometheus" },
    });
    await waitFor(() => expect(saved()?.usageSource).toBe("prometheus"));
    // New settings → new values right away, not after the next 30 s tick.
    await waitFor(() => expect(calls("metrics_pods")).toHaveLength(2));
  });
});

describe("requests and limits in the Metrics section of a pod", () => {
  const REF = {
    kind: POD,
    namespace: "sextant-demo",
    name: "nginx-9f755754d-g85tv",
  };

  /** The pod fixture with these containers (name and `resources`) in place of its own. */
  function podWith(containers: Array<{ name: string; resources?: unknown }>): KubeObject {
    const obj = copy(pod);
    (obj.spec as { containers: unknown[] }).containers = containers.map((c) => ({ image: "busybox", ...c }));
    return obj;
  }

  function usageOf(...containers: Array<[string, number, number]>): PodUsage {
    const sum = (i: 1 | 2) => containers.reduce((acc, c) => acc + c[i], 0);
    return {
      ...nginxUsage,
      usage: { cpuMillicores: sum(1), memoryBytes: sum(2) },
      containers: containers.map(([name, cpu, memory]) => [name, { cpuMillicores: cpu, memoryBytes: memory }]),
    };
  }

  /** The value cell of the "CPU" / "Memory" / container row of the current values. */
  function valueOf(label: string): HTMLElement {
    const term = screen.getByText(label, { selector: "dt" });
    return term.nextElementSibling as HTMLElement;
  }

  async function show(obj: KubeObject) {
    const Section = section(POD);
    render(<Section clusterId="c1" objectRef={REF} obj={obj} />);
  }

  const MIB = 1024 ** 2;

  it("shows request and limit next to the usage, and the usage as a share of the limit", async () => {
    serve(status(), { pods: [usageOf(["app", 25, 32 * MIB])] });
    await show(
      podWith([
        {
          name: "app",
          resources: {
            requests: { cpu: "100m", memory: "64Mi" },
            limits: { cpu: "200m", memory: "128Mi" },
          },
        },
      ]),
    );
    expect(await screen.findByText("32.0MiB", { selector: ".mx-current *" })).toBeInTheDocument();
    const cpu = valueOf("CPU");
    expect(within(cpu).getByText("25m")).toBeInTheDocument();
    expect(within(cpu).getByText("request 100m")).toBeInTheDocument();
    expect(within(cpu).getByText("limit 200m")).toBeInTheDocument();
    expect(within(cpu).getByText("13% of limit")).toBeInTheDocument();
    const memory = valueOf("Memory");
    expect(within(memory).getByText("request 64.0MiB")).toBeInTheDocument();
    expect(within(memory).getByText("limit 128MiB")).toBeInTheDocument();
    expect(within(memory).getByText("25% of limit")).toBeInTheDocument();
    expect(within(cpu).queryByText("no limit")).toBeNull();
  });

  it("without a limit says so and measures the usage against the request, even above it", async () => {
    serve(status(), { pods: [usageOf(["app", 150, 32 * MIB])] });
    await show(
      podWith([
        {
          name: "app",
          resources: { requests: { cpu: "100m", memory: "64Mi" } },
        },
      ]),
    );
    await screen.findByText("150m", { selector: ".mx-current *" });
    const cpu = valueOf("CPU");
    expect(within(cpu).getByText("request 100m")).toBeInTheDocument();
    expect(within(cpu).getByText("no limit")).toBeInTheDocument();
    expect(within(cpu).getByText("150% of request")).toBeInTheDocument();
    expect(within(valueOf("Memory")).getByText("50% of request")).toBeInTheDocument();
    // The bar itself never grows past its track.
    expect(cpu.querySelector<HTMLElement>(".mx-bar__fill")!.style.width).toBe("100%");
  });

  it("tells a share below 1 % as <1%, never 1% or 0%, and 0% only for no usage (#276)", async () => {
    // 5m of a 1000m request is 0.5 %; 0 bytes of memory is 0 %.
    serve(status(), { pods: [usageOf(["app", 5, 0])] });
    await show(podWith([{ name: "app", resources: { requests: { cpu: "1", memory: "64Mi" } } }]));
    await screen.findByText("5m", { selector: ".mx-current *" });
    expect(within(valueOf("CPU")).getByText("<1% of request")).toBeInTheDocument();
    expect(within(valueOf("CPU")).queryByText("1% of request")).toBeNull();
    expect(within(valueOf("Memory")).getByText("0% of request")).toBeInTheDocument();
  });

  it("says when the request or the limit is not set on every container", async () => {
    serve(status(), { pods: [usageOf(["app", 10, MIB], ["sidecar", 5, MIB])] });
    await show(
      podWith([
        {
          name: "app",
          resources: {
            requests: { cpu: "100m" },
            limits: { cpu: "300m", memory: "64Mi" },
          },
        },
        {
          name: "sidecar",
          resources: { requests: { cpu: "50m", memory: "16Mi" } },
        },
      ]),
    );
    await screen.findByText("15m", { selector: ".mx-current *" });
    const cpu = valueOf("CPU");
    expect(within(cpu).getByText("request 150m")).toBeInTheDocument();
    expect(within(cpu).getByText("no limit")).toBeInTheDocument();
    // Only the limit is partial: the note stands next to "no limit", the request is on both containers.
    expect(within(cpu).getByText("no limit").textContent).toContain("(set on 1 of 2 containers)");
    expect(within(cpu).getByText("request 150m").textContent).not.toContain("set on");
    const memory = valueOf("Memory");
    expect(within(memory).getByText("request 16.0MiB")).toBeInTheDocument();
    // Memory: the request is on one container (sidecar) and so is the limit (app).
    expect(within(memory).getAllByText("(set on 1 of 2 containers)")).toHaveLength(2);
    // The limit is on one container only, but every container has a request: the bar measures against that.
    expect(within(cpu).getByText("10% of request")).toBeInTheDocument();
    // A share of a request that only some containers have would be misleading.
    expect(memory.querySelector(".mx-bar")).toBeNull();
  });

  it("lists each container with its usage, request and limit", async () => {
    serve(status(), {
      pods: [usageOf(["app", 10, 8 * MIB], ["sidecar", 5, 2 * MIB])],
    });
    await show(
      podWith([
        {
          name: "app",
          resources: {
            requests: { cpu: "100m", memory: "64Mi" },
            limits: { cpu: "200m", memory: "128Mi" },
          },
        },
        { name: "sidecar" },
      ]),
    );
    await screen.findByText("15m", { selector: ".mx-current *" });
    const app = valueOf("app");
    expect(app.textContent).toContain("10m · 8.00MiB");
    expect(app.textContent).toContain("CPU request 100m, limit 200m");
    expect(app.textContent).toContain("Memory request 64.0MiB, limit 128MiB");
    const sidecar = valueOf("sidecar");
    expect(sidecar.textContent).toContain("5m · 2.00MiB");
    expect(sidecar.textContent).not.toMatch(/request|limit/);
  });

  it("shows nothing about requests and limits when no container has any", async () => {
    serve(status(), { pods: [usageOf(["app", 25, 32 * MIB])] });
    await show(podWith([{ name: "app" }]));
    expect(await screen.findByText("25m", { selector: ".mx-current *" })).toBeInTheDocument();
    expect(screen.queryByText(/request|limit/)).toBeNull();
  });

  it("shows them without any metrics, next to the notice that metrics are unavailable", async () => {
    serve(NOTHING);
    await show(
      podWith([
        {
          name: "app",
          resources: {
            requests: { cpu: "100m", memory: "64Mi" },
            limits: { cpu: "200m" },
          },
        },
        {
          name: "sidecar",
          resources: { requests: { cpu: "50m" }, limits: { cpu: "100m" } },
        },
      ]),
    );
    expect(await screen.findByText("Metrics are unavailable")).toBeInTheDocument();
    const cpu = valueOf("CPU");
    expect(within(cpu).getByText("request 150m")).toBeInTheDocument();
    expect(within(cpu).getByText("limit 300m")).toBeInTheDocument();
    expect(cpu.querySelector(".mx-bar")).toBeNull();
    expect(within(valueOf("Memory")).getByText("request 64.0MiB")).toBeInTheDocument();
    expect(valueOf("sidecar").textContent).toContain("CPU request 50m, limit 100m");
  });
});
