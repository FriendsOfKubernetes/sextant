import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KindRef, ResourceKind, WatchSpec } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { getPages } from "../../layout/pages";
import { resetClusterKinds } from "../../resources";
import { emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore, selectNamespaces } from "../namespaces";
import "./index";
import { NAMESPACE_KINDS, POD, REPLICA_SET } from "./kinds";
import { MAP_PAGE_ID, MapPage, resetMapFilters } from "./MapPage";
import * as data from "./testData";
import { openWatchCount, resetSharedWatches, setWatchLinger } from "./watches";

const served = (kind: KindRef): ResourceKind => ({
  kindRef: kind,
  plural: `${kind.kind.toLowerCase()}s`,
  namespaced: true,
  verbs: ["list", "watch"],
  printerColumns: [],
});
const BUILT_IN = NAMESPACE_KINDS.filter((k) => k.group !== "gateway.networking.k8s.io");

let wb: WatchBackend;

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetNamespaceRestore();
  resetSharedWatches();
  resetMapFilters();
  setWatchLinger(0);
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => BUILT_IN.map(served));
});

afterEach(() => {
  resetSharedWatches();
  setWatchLinger(null);
  wb.backend.restore();
  resetClusterKinds();
});

const inNs = (ns: string) => (spec: WatchSpec) =>
  JSON.stringify(spec.namespaces) === JSON.stringify([ns]) && spec.fieldSelector === null;

async function list(objects: { kind: KindRef; items: object[] }[], ns = "shop") {
  for (const kind of BUILT_IN) {
    const id = await watchOf(wb, kind.kind, inNs(ns));
    emitSnapshot(wb, id, (objects.find((o) => o.kind.kind === kind.kind)?.items ?? []) as never[]);
  }
}

describe("the Map page", () => {
  it("is a page of the Cluster section after the overview and the problems", () => {
    const page = getPages("cluster").find((p) => p.id === MAP_PAGE_ID);
    expect(page).toMatchObject({ section: "cluster", order: 20, labelKey: "resourcemap:sidebar", icon: "network" });
  });

  it("asks for a namespace while the filter says all namespaces, and watches nothing", async () => {
    render(<MapPage clusterId="c1" />);
    expect(await screen.findByText("Choose a namespace")).toBeInTheDocument();
    expect([...wb.specs.values()].some((s) => s.kind.kind === "Pod")).toBe(false);
  });

  it("draws the namespace with health colours; a click opens the details", async () => {
    await act(() => selectNamespaces("c1", ["shop"]));
    render(<MapPage clusterId="c1" />);
    await list(data.SHOP);
    const deployment = await screen.findByRole("button", { name: "Open Deployment web" });
    expect(deployment).toHaveClass("rmap-node--ok");
    // A kind the problems rules do not judge is drawn neutral.
    expect(screen.getByRole("button", { name: "Open Service web" })).toHaveClass("rmap-node--neutral");
    expect(document.querySelectorAll(".rmap-edge").length).toBeGreaterThan(5);
    fireEvent.click(deployment);
    expect(useAppStore.getState().details).toEqual({ kind: { group: "apps", version: "v1", kind: "Deployment" }, namespace: "shop", name: "web" });
  });

  it("filters by kind; cluster objects start hidden", async () => {
    await act(() => selectNamespaces("c1", ["shop"]));
    render(<MapPage clusterId="c1" />);
    await list(data.SHOP);
    await screen.findByRole("button", { name: "Open Deployment web" });
    expect(screen.queryByRole("button", { name: "Open Node node-1" })).toBeNull();
    // Node counts come from their own watch: wait for them rather than for the namespace's objects.
    fireEvent.click(await screen.findByRole("checkbox", { name: "Node (2)" }));
    expect(await screen.findByRole("button", { name: "Open Node node-1" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Pod (4)" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Open Pod / })).toBeNull());
  });

  it("2000 pods of one ReplicaSet collapse into one node and do not freeze the page", async () => {
    await act(() => selectNamespaces("c1", ["shop"]));
    render(<MapPage clusterId="c1" />);
    const rs = { apiVersion: "apps/v1", kind: "ReplicaSet", metadata: { name: "big-5c8d7f9b6", namespace: "shop", uid: "uid-rs-big" } };
    const started = performance.now();
    await list([
      { kind: REPLICA_SET, items: [rs] },
      { kind: POD, items: data.manyPods(2000) },
    ]);
    const group = await screen.findByRole("button", { name: "2000 pods (Pod)" }, { timeout: 3000 });
    // Listing, relating and drawing 2000 pods takes about 0.3 s here; a frozen page would take many seconds.
    expect(performance.now() - started).toBeLessThan(3000);
    expect(group).toHaveClass("rmap-node--problem");
    expect(within(group).getByText("200 with problems")).toBeInTheDocument();
    expect(document.querySelectorAll(".rmap-node").length).toBeLessThan(10);

    fireEvent.click(group);
    expect(await screen.findByRole("button", { name: "1900 more (Pod)" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Open Pod / })).toHaveLength(100);
    fireEvent.click(screen.getByRole("button", { name: "Collapse groups" }));
    expect(await screen.findByRole("button", { name: "2000 pods (Pod)" })).toBeInTheDocument();
  });

  it("watches only the namespace in view and lets go when the page is left", async () => {
    await act(() => selectNamespaces("c1", ["shop"]));
    const { unmount } = render(<MapPage clusterId="c1" />);
    await list(data.SHOP);
    const namespaces = new Set(
      [...wb.specs.values()].filter((s) => s.kind.kind !== "Namespace").map((s) => JSON.stringify(s.namespaces)),
    );
    expect(namespaces).toEqual(new Set([JSON.stringify(["shop"])]));
    expect(openWatchCount()).toBe(BUILT_IN.length);
    unmount();
    await waitFor(() => expect(openWatchCount()).toBe(0));
  });
});
