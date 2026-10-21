// The coverage views against a mock backend: the Connectivity page's Coverage tab, the namespace table's columns and
// the pod details line; watches bounded to the namespaces of the filter; axe on the tab.
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings, type KindRef, type KubeObject, type ResourceKind, type WatchSpec } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore, useAppStore } from "../../app/store";
import { getResourceDef, resetClusterKinds } from "../../resources";
import { axeViolations } from "../../test/axe";
import { emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore } from "../namespaces";
import { resetSharedWatches, setWatchLinger } from "../resource-map/watches";
import { ConnectivityPage } from "./ConnectivityPage";
import { NamespaceCoverageCell } from "./coverageColumns";
import { MAX_COVERAGE_NAMESPACES } from "./CoverageView";
import { PodIsolationSection } from "./details";
import { NAMESPACE, NETWORK_POLICY, POD, SERVICE } from "./hooks";
import "./index";
import { resetConnectivity, useConnectivityStore } from "./state";
import { namespace, netpol, pod } from "./testData";

const served = (kind: KindRef, namespaced = true): ResourceKind => ({
  kindRef: kind,
  plural: `${kind.kind.toLowerCase()}s`,
  namespaced,
  verbs: ["list", "watch"],
  printerColumns: [],
});

let wb: WatchBackend;

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetSharedWatches();
  resetConnectivity();
  resetSettingsCache();
  resetNamespaceRestore();
  setWatchLinger(0);
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => [served(POD), served(SERVICE), served(NAMESPACE, false), served(NETWORK_POLICY)]);
  wb.backend.on("settings_get", () => defaultAppSettings());
});

afterEach(() => {
  resetSharedWatches();
  setWatchLinger(null);
  wb.backend.restore();
  resetClusterKinds();
  resetSettingsCache();
});

const inNs = (ns: string) => (spec: WatchSpec) => JSON.stringify(spec.namespaces) === JSON.stringify([ns]) && spec.labelSelector === null;
const NAMESPACES = [namespace("shop"), namespace("payments"), namespace("tools")];
const web = pod("shop", "web", { app: "web" }, { ip: "10.0.1.6" });
const db = pod("shop", "db", { app: "db" }, { ip: "10.0.1.7" });
const api = pod("payments", "api", { app: "api" }, { ip: "10.0.2.7" });

async function feed(ns: string, pods: KubeObject[], policies: KubeObject[]) {
  emitSnapshot(wb, await watchOf(wb, "Pod", inNs(ns)), pods);
  emitSnapshot(wb, await watchOf(wb, "NetworkPolicy", inNs(ns)), policies);
}

const feedNamespaces = async () => emitSnapshot(wb, await watchOf(wb, "Namespace", (s) => s.namespaces === null), NAMESPACES);

describe("the Coverage tab", () => {
  it("asks for namespaces while the filter shows all of them, and watches no pod", async () => {
    useConnectivityStore.getState().patch("c1", { tab: "coverage" });
    render(<ConnectivityPage clusterId="c1" />);
    expect(await screen.findByText("Choose namespaces")).toBeInTheDocument();
    expect([...wb.specs.values()].some((s) => s.kind.kind === "Pod")).toBe(false);
  });

  it("counts isolated pods per namespace, names the policies and lists the open pods", async () => {
    useAppStore.getState().setNamespaces("c1", ["shop", "payments"]);
    useConnectivityStore.getState().patch("c1", { tab: "coverage" });
    const { container } = render(<ConnectivityPage clusterId="c1" />);
    await feedNamespaces();
    await feed("shop", [web, db], [
      netpol("shop", "default-deny", { podSelector: {} }),
      netpol("shop", "db-out", { podSelector: { matchLabels: { app: "db" } }, policyTypes: ["Egress"] }),
    ]);
    await feed("payments", [api], []);
    const table = await screen.findByRole("table", { name: "Coverage of the namespaces" });
    const rows = within(table).getAllByRole("row").map((r) => r.textContent);
    expect(rows).toEqual([
      "NamespacePodsIngress isolatedEgress isolatedDefault deny",
      "shop2All (2 of 2)Some (1 of 2)Ingress: Yes · Egress: No",
      "payments1None (0 of 1)None (0 of 1)Ingress: No · Egress: No",
    ]);
    const shop = screen.getByRole("region", { name: "shop" });
    const policies = within(shop).getByRole("table", { name: "Policies that isolate pods in shop" });
    expect(within(policies).getAllByRole("row").map((r) => r.textContent)).toEqual([
      "PolicyKindPods isolated for ingressPods isolated for egress",
      "shop/db-outNetworkPolicy01",
      "shop/default-denyNetworkPolicy20",
    ]);
    const open = within(shop).getByRole("table", { name: "Pods of shop not isolated in some direction" });
    expect(within(open).getAllByRole("row").map((r) => r.textContent)).toEqual(["PodIngressEgress", "webIsolatedNot isolated"]);
    // Only the namespaces of the filter are watched.
    const podWatches = [...wb.specs.values()].filter((s) => s.kind.kind === "Pod").map((s) => JSON.stringify(s.namespaces));
    expect(podWatches.sort()).toEqual(['["payments"]', '["shop"]']);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("says 'Cannot tell' for a namespace whose policies cannot be read", async () => {
    useAppStore.getState().setNamespaces("c1", ["shop"]);
    useConnectivityStore.getState().patch("c1", { tab: "coverage" });
    render(<ConnectivityPage clusterId="c1" />);
    await feedNamespaces();
    emitSnapshot(wb, await watchOf(wb, "Pod", inNs("shop")), [web]);
    const id = await watchOf(wb, "NetworkPolicy", inNs("shop"));
    wb.backend.emit(`watch:${id}`, { type: "error", error: { kind: "forbidden", message: "no" } });
    const table = await screen.findByRole("table", { name: "Coverage of the namespaces" });
    await waitFor(() => expect(within(table).getAllByRole("row")[1]).toHaveTextContent("shop1Cannot tellCannot tellIngress: Cannot tell · Egress: Cannot tell"));
    expect(screen.getByRole("region", { name: "shop" })).toHaveTextContent("Could not read the NetworkPolicy objects of namespace shop.");
  });

  it("looks at the first namespaces of the filter only", async () => {
    const many = Array.from({ length: MAX_COVERAGE_NAMESPACES + 2 }, (_, i) => `ns-${i}`);
    useAppStore.getState().setNamespaces("c1", many);
    useConnectivityStore.getState().patch("c1", { tab: "coverage" });
    render(<ConnectivityPage clusterId="c1" />);
    expect(await screen.findByText(`Only the first ${MAX_COVERAGE_NAMESPACES} namespaces of the filter are shown.`)).toBeInTheDocument();
    await waitFor(() => expect([...wb.specs.values()].filter((s) => s.kind.kind === "Pod")).toHaveLength(MAX_COVERAGE_NAMESPACES));
  });
});

describe("the namespace columns", () => {
  it("are registered on the Namespace table after the status", () => {
    const ids = getResourceDef(NAMESPACE).columns.map((c) => c.id);
    expect(ids.slice(ids.indexOf("status"), ids.indexOf("status") + 3)).toEqual(["status", "netpolIngressCoverage", "netpolEgressCoverage"]);
  });

  it("compute a namespace of the filter and leave the others alone", async () => {
    useAppStore.getState().setNamespaces("c1", ["shop"]);
    render(
      <>
        <NamespaceCoverageCell clusterId="c1" namespace="shop" direction="ingress" />
        <NamespaceCoverageCell clusterId="c1" namespace="payments" direction="egress" />
      </>,
    );
    await feedNamespaces();
    await feed("shop", [web, db], [netpol("shop", "web-in", { podSelector: { matchLabels: { app: "web" } } })]);
    expect(await screen.findByText("Some (1 of 2)")).toBeInTheDocument();
    expect(screen.getByText("Not in filter")).toBeInTheDocument();
    expect([...wb.specs.values()].some((s) => JSON.stringify(s.namespaces) === '["payments"]')).toBe(false);
  });
});

describe("the pod details line", () => {
  it("shows the pod's coverage and the namespace's default deny", async () => {
    render(<PodIsolationSection clusterId="c1" objectRef={{ kind: POD, namespace: "shop", name: "web" }} obj={web} />);
    await feedNamespaces();
    emitSnapshot(wb, await watchOf(wb, "NetworkPolicy", inNs("shop")), [netpol("shop", "deny", { podSelector: {}, policyTypes: ["Ingress"] })]);
    emitSnapshot(wb, await watchOf(wb, "Pod", (s) => s.labelSelector === "k8s-app=kube-dns"), []);
    expect(await screen.findByText("Ingress: Isolated · Egress: Not isolated")).toBeInTheDocument();
    expect(screen.getByText("Ingress: Yes · Egress: No")).toBeInTheDocument();
    expect(screen.getByText("Namespace default deny")).toBeInTheDocument();
  });
});
