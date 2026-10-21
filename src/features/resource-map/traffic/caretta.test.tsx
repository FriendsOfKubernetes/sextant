// Caretta (#236) in the traffic graph: TCP links as bytes per second, without requests, errors or latency.
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TrafficEdge, TrafficGraph } from "../../../api";
import { resetAppStore, useAppStore } from "../../../app/store";
import { axeViolations } from "../../../test/axe";
import { useClustersStore } from "../../clusters/clustersStore";
import { watchBackend, type WatchBackend } from "../../details/testing";
import { resetMetricsCache } from "../../metrics/hooks";
import { resetNamespaceRestore, selectNamespaces } from "../../namespaces";
import { resetClusterKinds } from "../../../resources";
import { MapPage, resetMapFilters } from "../MapPage";
import { resetSharedWatches } from "../watches";
import { edge, graph, SHOP_EDGES, workload } from "./fixtures";
import { layoutTraffic, matchesFilters, NO_FILTERS } from "./model";
import { resetResolved } from "./resolve";

/** What the core makes of `metrics/traffic/testdata/caretta.json`: frontend → web both ways, 32 000 bytes/s. */
const bytes = (rate: number, patch: Partial<TrafficEdge> = {}): TrafficEdge =>
  edge(workload("shop", "frontend"), workload("shop", "web"), {
    source: "caretta",
    protocol: "tcpBytes",
    rate,
    errorRatio: null,
    p50Ms: null,
    p95Ms: null,
    statusClasses: [],
    ...patch,
  });

describe("Caretta's edges in the model", () => {
  it("are TCP for the filter, and their bytes another unit beside requests and connections", () => {
    const e = bytes(32000);
    expect(matchesFilters(e, { ...NO_FILTERS, protocol: "tcp" })).toBe(true);
    expect(matchesFilters(e, { ...NO_FILTERS, protocol: "http" })).toBe(false);
    const layout = layoutTraffic([...SHOP_EDGES, e]);
    const link = layout.links.find((l) => l.id === "workload|shop|frontend>workload|shop|web")!;
    expect(link).toMatchObject({ rate: 12, tcpRate: 0, bytesRate: 32000 });
    // The thickness stays the request rate's: bytes never make a line thicker.
    expect(layout.maxRate).toBe(12);
  });
});

let wb: WatchBackend;

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
  resetSharedWatches();
  wb.backend.restore();
  resetMetricsCache();
});

async function openTraffic(answer: TrafficGraph) {
  wb.backend.on("metrics_traffic_graph", () => answer);
  const view = render(<MapPage clusterId="c1" />);
  fireEvent.click(screen.getByRole("tab", { name: "Traffic" }));
  await act(() => selectNamespaces("c1", ["shop", "pay"]));
  return view;
}

describe("Caretta in the Traffic mode", () => {
  it("lists its links in bytes per second, says it sees TCP only, and passes axe", async () => {
    const { container } = await openTraffic(
      graph({
        sources: [{ kind: "caretta", via: "cluster", latency: false }],
        edges: [bytes(32000)],
        totalEdges: 1,
      }),
    );
    await screen.findByRole("button", {
      name: "Workload frontend (shop): show its calls",
    });
    expect(screen.getByText(/Caretta sees TCP connections only/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "List" }));
    const table = screen.getByRole("table", { name: /busiest first/ });
    const cells = within(within(table).getAllByRole("row")[1]!)
      .getAllByRole("cell")
      .map((c) => c.textContent);
    expect(cells.slice(0, 7)).toEqual([
      "frontend (shop)",
      "web (shop)",
      "TCP",
      "31.3KiB/s",
      "no verdict for TCP",
      "no latency histogram",
      "Caretta",
    ]);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("is named among what would provide the graph", async () => {
    await openTraffic(graph({ sources: [], edges: [], totalEdges: 0 }));
    expect(await screen.findByText(/Caretta would show the TCP connections between workloads/)).toBeTruthy();
  });
});
