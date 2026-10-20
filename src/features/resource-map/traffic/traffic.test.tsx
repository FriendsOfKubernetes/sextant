import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObjectRef, TrafficGraph } from "../../../api";
import { resetAppStore, useAppStore } from "../../../app/store";
import { axeViolations } from "../../../test/axe";
import { useClustersStore } from "../../clusters/clustersStore";
import { watchBackend, type WatchBackend } from "../../details/testing";
import { resetMetricsCache } from "../../metrics/hooks";
import { resetNamespaceRestore, selectNamespaces } from "../../namespaces";
import { resetClusterKinds } from "../../../resources";
import { MapPage, resetMapFilters } from "../MapPage";
import { resetSharedWatches } from "../watches";
import { edge, graph, SHOP_EDGES } from "./fixtures";
import { TRAFFIC_POLL_MS } from "./hooks";
import { NOT_FOUND_TTL_MS, resetResolved, resolvePeer } from "./resolve";

let wb: WatchBackend;
const asked = () => wb.backend.calls.filter((c) => c.cmd === "metrics_traffic_graph");

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetNamespaceRestore();
  resetSharedWatches();
  resetMapFilters();
  resetMetricsCache();
  resetResolved();
  useClustersStore.setState({ settingsFor: null });
  useAppStore.getState().setActiveCluster("c1");
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => []);
});

afterEach(() => {
  vi.useRealTimers();
  resetSharedWatches();
  wb.backend.restore();
  resetMetricsCache();
});

/** The map page in the "Traffic" mode with `namespaces` chosen (the object map never draws). */
async function openTraffic(answer: TrafficGraph | (() => TrafficGraph) = graph(), namespaces = ["shop", "pay"]) {
  wb.backend.on("metrics_traffic_graph", typeof answer === "function" ? answer : () => answer);
  const view = render(<MapPage clusterId="c1" />);
  fireEvent.click(screen.getByRole("tab", { name: "Traffic" }));
  await act(() => selectNamespaces("c1", namespaces));
  return view;
}

const nodeButton = (name: string) => screen.findByRole("button", { name: `Workload ${name}: show its calls` });

describe("the Traffic mode of the map", () => {
  it("asks the core for the chosen namespaces only, opens no watch, and draws the calls", async () => {
    const { container } = await openTraffic();
    await nodeButton("frontend (shop)");
    expect(asked()[0]!.args).toEqual({ clusterId: "c1", namespaces: ["shop", "pay"], window: "minutes5" });
    // Only the namespace filter's own list: the traffic graph reads Prometheus through the core, not the cluster.
    expect([...wb.specs.values()].map((s) => s.kind.kind)).toEqual(["Namespace"]);
    expect(screen.getByRole("button", { name: "Unknown Outside the mesh or unlabelled: show its calls" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Service api.example.com: show its calls" })).toBeTruthy();
    const lines = container.querySelectorAll(".traffic-link");
    expect(lines).toHaveLength(5);
    const line = (id: string) => container.querySelector(`[data-link="${id}"]`)!;
    expect(line("workload|shop|frontend>workload|shop|web")).toHaveClass("traffic-link--bad");
    expect(line("workload|shop|web>workload|pay|db")).toHaveClass("traffic-link--warn");
    expect(line("workload|shop|web>workload|cache|redis")).toHaveClass("traffic-link--unknown");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("takes at most five namespaces and says so", async () => {
    await openTraffic(graph(), ["a", "b", "c", "d", "e", "f", "g"]);
    await nodeButton("frontend (shop)");
    expect(screen.getByText("The traffic graph covers at most 5 namespaces at once: it shows the first ones chosen.")).toBeTruthy();
    expect(asked()[0]!.args.namespaces).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("a node lists its calls, and a call shows both ends with ways to open them", async () => {
    await openTraffic();
    fireEvent.click(await nodeButton("web (shop)"));
    const panel = screen.getByRole("complementary", { name: "web (shop)" });
    expect(within(panel).getByText("2 callers")).toBeTruthy();
    expect(within(panel).getByText("3 callees")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "frontend (shop): 12.0 req/s" }));
    const call = screen.getByRole("complementary", { name: "Calls from frontend (shop) to web (shop)" });
    const fact = (label: string) => within(call).getByText(label).nextElementSibling!.textContent;
    expect(within(call).getByText("From Istio, HTTP")).toBeTruthy();
    expect(fact("Rate")).toBe("12.0 req/s");
    expect(fact("Error rate")).toBe("10.0%");
    expect(fact("Latency")).toBe("p50 10 ms · p95 50 ms");
    expect(fact("Answers")).toBe("2xx 10.8/s, 5xx 1.20/s");

    // A workload is looked up by its name among the kinds that make pods.
    const gets: ObjectRef[] = [];
    wb.backend.on("resource_get", (args) => {
      const ref = args.ref as ObjectRef;
      gets.push(ref);
      if (ref.kind.kind === "StatefulSet") return { metadata: { name: ref.name } };
      throw { code: "notFound", message: "not found" };
    });
    fireEvent.click(within(call).getByRole("button", { name: "Open web" }));
    await waitFor(() => expect(useAppStore.getState().details).not.toBeNull());
    expect(useAppStore.getState().details).toEqual({
      kind: { group: "apps", version: "v1", kind: "StatefulSet" },
      namespace: "shop",
      name: "web",
    });
    expect(gets.map((r) => r.kind.kind)).toEqual(["Deployment", "StatefulSet"]);
    // Asked once: the answer is kept.
    fireEvent.click(within(call).getByRole("button", { name: "Requests of web" }));
    expect(gets).toHaveLength(2);
  });

  it("says when the object of an end is not there", async () => {
    await openTraffic();
    fireEvent.click(await nodeButton("frontend (shop)"));
    wb.backend.on("resource_get", () => {
      throw { code: "notFound", message: "not found" };
    });
    const panel = screen.getByRole("complementary", { name: "frontend (shop)" });
    fireEvent.click(within(panel).getByRole("button", { name: "Open frontend" }));
    expect(await within(panel).findByText("No Deployment, StatefulSet or DaemonSet named frontend in shop.")).toBeTruthy();
    expect(useAppStore.getState().details).toBeNull();
  });
});

describe("opening an end", () => {
  const gets = () => wb.backend.calls.filter((c) => c.cmd === "resource_get");

  it("a host named without a namespace says so instead of offering to open it", async () => {
    await openTraffic();
    fireEvent.click(await screen.findByRole("button", { name: "Service api.example.com: show its calls" }));
    const panel = screen.getByRole("complementary", { name: "api.example.com" });
    expect(
      within(panel).getByText("The source names api.example.com without a namespace, so there is nothing to open."),
    ).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: "Open api.example.com" })).toBeNull();
    expect(gets()).toHaveLength(0);
  });

  it("asks nothing for a name the kind cannot have", async () => {
    wb.backend.on("resource_get", () => ({ metadata: {} }));
    const peers = [
      { kind: "workload" as const, namespace: "shop", name: "Web_1" },
      { kind: "workload" as const, namespace: "Shop", name: "web" },
      { kind: "workload" as const, namespace: "shop", name: "x".repeat(254) },
      // A Service name is a DNS-1035 label: no dots, a letter first.
      { kind: "service" as const, namespace: "shop", name: "api.example.com" },
      { kind: "service" as const, namespace: "shop", name: "1api" },
    ];
    for (const peer of peers) expect(await resolvePeer("c1", peer)).toBeNull();
    expect(gets()).toHaveLength(0);
    // A dotted workload name is a valid DNS-1123 subdomain.
    expect(await resolvePeer("c1", { kind: "workload", namespace: "shop", name: "web.v2" })).not.toBeNull();
  });

  it("believes 'not found' for a minute only: the object may be created since", async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      let exists = false;
      wb.backend.on("resource_get", () => {
        if (exists) return { metadata: { name: "web" } };
        throw { code: "notFound", message: "not found" };
      });
      const peer = { kind: "service" as const, namespace: "shop", name: "web" };
      expect(await resolvePeer("c1", peer)).toBeNull();
      exists = true;
      now += NOT_FOUND_TTL_MS - 1;
      expect(await resolvePeer("c1", peer)).toBeNull();
      expect(gets()).toHaveLength(1);
      now += 2;
      expect(await resolvePeer("c1", peer)).toEqual({ kind: { group: "", version: "v1", kind: "Service" }, namespace: "shop", name: "web" });
      expect(gets()).toHaveLength(2);
      // What was found is kept.
      now += NOT_FOUND_TTL_MS * 10;
      await resolvePeer("c1", peer);
      expect(gets()).toHaveLength(2);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("the list of calls", () => {
  it("offers every call to the keyboard and screen readers", async () => {
    const { container } = await openTraffic();
    await nodeButton("frontend (shop)");
    fireEvent.click(screen.getByRole("tab", { name: "List" }));
    const table = screen.getByRole("table", { name: "5 calls between two ends, busiest first" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(6);
    expect(within(rows[1]!).getAllByRole("cell").map((c) => c.textContent)).toEqual([
      "frontend (shop)",
      "web (shop)",
      "HTTP",
      "12.0 req/s",
      "10.0%",
      "p50 10 ms · p95 50 ms",
      "Istio",
      "Details",
    ]);
    // TCP counts connections and has no error verdict.
    expect(within(table).getByText("0.25 conn/s")).toBeTruthy();
    expect(within(table).getByText("no verdict for TCP")).toBeTruthy();
    fireEvent.click(
      within(table).getByRole("button", {
        name: "Show the details of web (shop) to db (pay) over gRPC: 4.00 req/s, error rate 2.0%, from Istio",
      }),
    );
    expect(screen.getByRole("complementary", { name: "Calls from web (shop) to db (pay)" })).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("filters by protocol, status and namespace", async () => {
    const { container } = await openTraffic();
    await nodeButton("frontend (shop)");
    const lines = () => container.querySelectorAll(".traffic-link").length;
    fireEvent.change(screen.getByRole("combobox", { name: "Protocol" }), { target: { value: "tcp" } });
    expect(lines()).toBe(1);
    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), { target: { value: "5xx" } });
    expect(screen.getByText("No call matches these filters.")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Protocol" }), { target: { value: "all" } });
    expect(lines()).toBe(1);
    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), { target: { value: "all" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Namespace" }), { target: { value: "pay" } });
    expect(lines()).toBe(1);
    // Filters change the drawing only: nothing more is asked.
    expect(asked()).toHaveLength(1);
  });

  it("asks again over the last hour when the window changes", async () => {
    await openTraffic();
    await nodeButton("frontend (shop)");
    fireEvent.click(screen.getByRole("radio", { name: "Last hour" }));
    await waitFor(() => expect(asked()).toHaveLength(2));
    expect(asked()[1]!.args.window).toBe("hour1");
  });
});

describe("without a graph", () => {
  it("says Prometheus is missing, and what would provide the graph", async () => {
    await openTraffic(graph({ prometheus: false, sources: [], edges: [], totalEdges: 0 }));
    expect(await screen.findByText(/none is set up or found for this cluster/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cluster settings" })).toBeTruthy();
    expect(screen.getByText(/Any of these would provide the graph/)).toBeTruthy();
  });

  it("names the sources that report requests but no callers", async () => {
    await openTraffic(graph({ sources: [], requestOnly: ["ingressNginx", "beyla"], edges: [], totalEdges: 0 }));
    expect(await screen.findByText(/no metrics that name both ends of a call/)).toBeTruthy();
    expect(
      screen.getByText(
        "Requests per workload, without who sent them, come from ingress-nginx, Grafana Beyla: see the Requests section of each workload.",
      ),
    ).toBeTruthy();
  });

  it("says when the sources saw no calls here, and which failed", async () => {
    await openTraffic(
      graph({
        sources: [
          { kind: "istio", via: "cluster", latency: true },
          { kind: "hubble", via: "cluster", latency: true },
        ],
        failed: ["hubble"],
        edges: [],
        totalEdges: 0,
      }),
    );
    expect(await screen.findByText("Istio saw no calls with an end in these namespaces in the last 5 minutes.")).toBeTruthy();
    expect(screen.getByText("Could not read the traffic metrics of Cilium Hubble.")).toBeTruthy();
  });

  it("says when a proxy refused a source's query as too long, apart from other failures", async () => {
    await openTraffic(
      graph({
        sources: [
          { kind: "istio", via: "cluster", latency: true },
          { kind: "linkerd", via: "cluster", latency: true },
          { kind: "hubble", via: "cluster", latency: true },
        ],
        failed: ["linkerd", "hubble"],
        queryTooLong: ["hubble"],
      }),
    );
    expect(
      await screen.findByText(
        "The query for Cilium Hubble was too long for a proxy in front of Prometheus. Raise the proxy's URL limit, or set Prometheus by its URL in the cluster settings: long queries are then sent as a POST.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Could not read the traffic metrics of Linkerd.")).toBeTruthy();
  });

  it("keeps the calls whose details could not be read, and says which", async () => {
    const [first, ...rest] = SHOP_EDGES;
    const partial = edge(first!.from, first!.to, {
      rate: 12,
      errorRatio: null,
      p50Ms: null,
      p95Ms: null,
      missing: ["errors", "latency"],
    });
    await openTraffic(graph({ edges: [partial, ...rest] }));
    expect(
      await screen.findByText(
        "Some details of the calls from Istio could not be read (error rates, latency): Prometheus did not answer those queries.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "List" }));
    const table = screen.getByRole("table");
    const row = within(table).getAllByRole("row")[1]!;
    expect(within(row).getAllByRole("cell").map((c) => c.textContent).slice(4, 6)).toEqual([
      "could not be read",
      "could not be read",
    ]);
  });

  it("says when the busiest calls are all it shows", async () => {
    await openTraffic(graph({ totalEdges: 340 }));
    expect(await screen.findByText("Showing the 5 busiest of 340 calls between two ends.")).toBeTruthy();
  });
});

describe("polling", () => {
  it("reads while the mode is shown and the window visible, and stops otherwise", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let state: DocumentVisibilityState = "visible";
    const visibility = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
    try {
      await openTraffic();
      await nodeButton("frontend (shop)");
      expect(asked()).toHaveLength(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TRAFFIC_POLL_MS.minutes5);
      });
      expect(asked()).toHaveLength(2);
      state = "hidden";
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TRAFFIC_POLL_MS.minutes5 * 3);
      });
      expect(asked()).toHaveLength(2);
      state = "visible";
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await waitFor(() => expect(asked()).toHaveLength(3));
      // Back to the object map: the traffic graph is no longer read.
      fireEvent.click(screen.getByRole("tab", { name: "Objects" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TRAFFIC_POLL_MS.minutes5 * 3);
      });
      expect(asked()).toHaveLength(3);
    } finally {
      visibility.mockRestore();
    }
  });
});
