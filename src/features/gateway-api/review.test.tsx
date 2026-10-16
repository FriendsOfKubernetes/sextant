// Findings of the live check on the kind test cluster (the matching fixtures are that cluster's objects): what the
// Gateway's views list as attached, the Gateway's health in its topology, where refused routes go, the request check's
// wording for a refused route and its prefill, the redirect text, the conditions and share in "Exposed by", the
// Gateway status column, the parents tooltip, the short parent banner of a backend problem, and the namespace labels
// the request check watches.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KindRef, KubeObject, ObjectRef, ResourceKind } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { i18n } from "../../i18n";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { getResourceDef, kindFromApiVersion, resetClusterKinds } from "../../resources";
import "../details";
import { emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import endpointSlicesJson from "./fixtures/matching/endpointslices.json";
import gatewaysJson from "./fixtures/matching/gateways.json";
import grpcRoutesJson from "./fixtures/matching/grpcroutes.json";
import httpRoutesJson from "./fixtures/matching/httproutes.json";
import namespacesJson from "./fixtures/matching/namespaces.json";
import referenceGrantsJson from "./fixtures/matching/referencegrants.json";
import servicesJson from "./fixtures/matching/services.json";
import "./index";
import { gatewayPrefill, resetRequestChecks, useRequestCheckStore } from "./checkState";
import { phrasesText } from "./details";
import { gatewayRoutes, serviceExposures } from "./exposure";
import { explainRequest, type ClusterSnapshot } from "./matching";
import { filterPhrases, GRPC_ROUTE, HTTP_ROUTE } from "./model";
import { RequestCheckPage } from "./RequestCheck";
import { flattenTopology, gatewayTopology, type TopologyNode } from "./topology";

const gateways = gatewaysJson as KubeObject[];
const httpRoutes = httpRoutesJson as KubeObject[];
const grpcRoutes = grpcRoutesJson as KubeObject[];
const services = servicesJson as KubeObject[];
const endpointSlices = endpointSlicesJson as KubeObject[];
const referenceGrants = referenceGrantsJson as KubeObject[];
const namespaces = namespacesJson as KubeObject[];

const byName = (list: KubeObject[], name: string) => list.find((o) => o.metadata?.name === name)!;
const publicGw = byName(gateways, "public-gw");
const internalGw = byName(gateways, "internal-gw");
const ROUTES = [
  { kind: HTTP_ROUTE, items: httpRoutes },
  { kind: GRPC_ROUTE, items: grpcRoutes },
];
const CLUSTER: ClusterSnapshot = {
  gateways,
  httpRoutes,
  grpcRoutes,
  services,
  endpointSlices,
  referenceGrants,
  namespaces,
};

const t = (key: string, params?: Record<string, unknown>) => i18n.t(key, params);
const kindOf = (obj: KubeObject): KindRef => kindFromApiVersion(obj.apiVersion ?? "", obj.kind ?? "");

// ---------- Pure ----------

describe("the routes of a Gateway (attached vs not attached)", () => {
  it("public-gw: three attached on their listeners, payments-status refused with its reason", () => {
    const { attached, notAttached } = gatewayRoutes(publicGw, ROUTES);
    expect(attached.map((a) => `${a.route.metadata?.name}@${a.listener.name}`)).toEqual([
      "checkout@https",
      "http-redirect@http",
      "shop@https",
    ]);
    // As many as the controller counts on its listeners (the "Attached routes" card).
    const counted = (publicGw.status as { listeners: { attachedRoutes: number }[] }).listeners.reduce(
      (sum, l) => sum + l.attachedRoutes,
      0,
    );
    expect(attached).toHaveLength(counted);
    expect(notAttached.map((n) => [n.route.metadata?.name, n.parent.accepted?.reason])).toEqual([
      ["payments-status", "NotAllowedByListeners"],
    ]);
  });

  it("internal-gw: shop is not attached (NoMatchingListenerHostname)", () => {
    const { attached, notAttached } = gatewayRoutes(internalGw, ROUTES);
    expect(attached.map((a) => a.route.metadata?.name)).not.toContain("shop");
    expect(notAttached.map((n) => [n.route.metadata?.name, n.parent.accepted?.reason])).toEqual([
      ["shop", "NoMatchingListenerHostname"],
    ]);
  });
});

describe("the topology of a Gateway", () => {
  const lines = (node: TopologyNode) =>
    flattenTopology(node).map(({ node: n, level }) => {
      const name =
        n.type === "route" ? n.ref.name : n.type === "listener" ? n.listener.name : n.type === "gateway" ? n.ref.name : "";
      return `${level} ${n.type} ${name} ${n.health}${n.reason ? ` ${n.reason}` : ""}`.replace(/ +/g, " ");
    });

  it("a broken listener makes the Gateway node a problem, as the table's red count says", () => {
    const tree = gatewayTopology(internalGw, { routes: ROUTES });
    expect(tree.health).toBe("problem");
    expect(tree.reason).toBe("ListenersBroken");
    expect(tree.params).toEqual({ count: 1, total: 4 });
    expect(tree.message).toContain("https: InvalidCertificateRef");
    expect(i18n.t("gateway:topology.reasons.ListenersBroken", tree.params)).toBe("1 of 4 listeners broken");
  });

  it("every refused route sits in one Not attached group under the Gateway; attached ones under their listener", () => {
    const pub = lines(gatewayTopology(publicGw, { routes: ROUTES })).filter((l) => /^\d (gateway|listener|route|notAttached)/.test(l));
    expect(pub).toEqual([
      "1 gateway public-gw ok",
      "2 listener http ok",
      "3 route http-redirect ok",
      "2 listener https ok",
      "3 route checkout problem RefNotPermitted",
      "3 route shop ok",
      "2 notAttached problem",
      "3 route payments-status problem NotAllowedByListeners",
    ]);
    const internal = lines(gatewayTopology(internalGw, { routes: ROUTES })).filter((l) =>
      /^\d (notAttached|route)/.test(l),
    );
    expect(internal).toContain("2 notAttached problem");
    expect(internal).toContain("3 route shop problem NoMatchingListenerHostname");
  });
});

describe("the request check", () => {
  it("a route the Gateway refused says so on every listener, not 'attached to another listener'", () => {
    const result = explainRequest({ url: "http://shop.example.com/" }, CLUSTER);
    const refused = result.candidates.filter((c) => c.route?.name === "payments-status");
    expect(refused.length).toBeGreaterThan(0);
    for (const c of refused) expect([c.reason, c.condition]).toEqual(["notAccepted", "NotAllowedByListeners"]);
    expect(i18n.t("gateway:check.loss.notAccepted")).toBe("Not accepted by the Gateway");
    // A route the Gateway accepted on another listener still is just there.
    const shop = result.candidates.find((c) => c.route?.name === "shop" && c.listener === "http");
    expect(shop?.reason).toBe("notAttached");
  });

  it("a Gateway's prefill is a request an attached route serves, not a 404", () => {
    const pub = gatewayPrefill(publicGw, ROUTES);
    expect(pub).toEqual({ method: "GET", grpc: false, url: "https://shop.example.com/" });
    const internal = gatewayPrefill(internalGw, ROUTES);
    expect(internal).toMatchObject({ grpc: true, method: "POST" });
    expect(internal.url).toBe("http://grpc.internal.example.com:9090/inventory.v1.Inventory/GetStock");
    for (const form of [pub, internal]) {
      const r = explainRequest({ url: form.url!, method: form.method, protocol: form.grpc ? "grpc" : "http" }, CLUSTER);
      expect(r.outcome).toBe("forwarded");
    }
    // Without routes known yet: the best listener, as before.
    expect(gatewayPrefill(publicGw).url).toBe("https://shop.example.com/");
  });
});

describe("texts", () => {
  const redirect = (requestRedirect: object) =>
    phrasesText(filterPhrases({ type: "RequestRedirect", requestRedirect }), t, ", ");

  it("a redirect spells out its whole target", () => {
    expect(redirect({ scheme: "https", statusCode: 301 })).toBe("Redirect to https://<same host><same path> (301)");
    expect(redirect({ hostname: "new.example.com", port: 8443, path: { type: "ReplaceFullPath", replaceFullPath: "/x" } })).toBe(
      "Redirect to <same scheme>://new.example.com:8443/x (302)",
    );
    expect(redirect({ path: { type: "ReplacePrefixMatch", replacePrefixMatch: "/v2" }, statusCode: 308 })).toBe(
      "Redirect to <same scheme>://<same host>/v2<rest of the path> (308)",
    );
  });

  it("Exposed by: each way in with its conditions and the Service's share", () => {
    const apiV2 = byName(services, "api-v2");
    const exposures = serviceExposures(apiV2, {
      routes: ROUTES,
      gatewayOf: (ref) => gateways.find((g) => g.metadata?.name === ref.name),
    });
    const serving = exposures.find((e) => e.state === "serving")!;
    expect(
      serving.targets.map((x) => [x.url, ...x.conditions.map((c) => phrasesText([c], t, "")), `${x.percent}%`].join(" · ")),
    ).toEqual(["https://shop.example.com/api · header x-env=prod · 90%"]);
  });
});

describe("the tables' columns", () => {
  const cell = (obj: KubeObject, id: string) => {
    const col = getResourceDef(kindOf(obj)).columns.find((c) => c.id === id)!;
    const content = col.render!(obj, { clusterId: "c1", kind: kindOf(obj), now: Date.parse("2026-10-16T12:00:00Z") });
    const { container } = render(<div>{content as ReactElement}</div>);
    return container;
  };

  it("Gateways: a Status column with the problem's reason", () => {
    const col = getResourceDef(kindOf(internalGw)).columns.find((c) => c.id === "status")!;
    expect(col.value(internalGw)).toBe("Listener https: InvalidCertificateRef");
    expect(col.value(publicGw)).toBe("Programmed");
  });

  it("HTTPRoutes: the parents cell's tooltip has every parent in full, explained", () => {
    const shop = byName(httpRoutes, "shop");
    const title = cell(shop, "parents").querySelector(".rt-status-list")!.getAttribute("title")!;
    expect(title).toContain("public-gw ✓");
    expect(title).toContain("internal-gw ✗ NoMatchingListenerHostname");
    expect(title).toContain("None of the route's hostnames matches");
  });
});

// ---------- Rendered ----------

const served = (kind: KindRef, namespaced = true): ResourceKind => ({
  kindRef: kind,
  plural: `${kind.kind.toLowerCase()}s`,
  namespaced,
  verbs: ["list", "watch"],
  printerColumns: [],
});

const DISCOVERY: KindRef[] = [
  { group: "", version: "v1", kind: "Service" },
  { group: "discovery.k8s.io", version: "v1", kind: "EndpointSlice" },
  kindOf(gateways[0]!),
  kindOf(httpRoutes[0]!),
  kindOf(grpcRoutes[0]!),
  kindOf(referenceGrants[0]!),
];

let wb: WatchBackend;

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetRequestChecks();
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => DISCOVERY.map((k) => served(k)));
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(() => Promise.resolve()) } });
});

afterEach(() => {
  wb.backend.restore();
  resetClusterKinds();
  Reflect.deleteProperty(navigator, "clipboard");
});

const listWatch = (kind: string) => watchOf(wb, kind, (s) => s.fieldSelector === null && s.labelSelector === null);

async function openDetails(obj: KubeObject): Promise<void> {
  const ref: ObjectRef = { kind: kindOf(obj), namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
  useAppStore.getState().openDetails(ref);
  render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  emitSnapshot(wb, await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`), [obj]);
}

function block(title: string): HTMLElement {
  return screen.getByRole("heading", { name: title }).closest(".dt-block")!;
}

const rowsOf = (el: HTMLElement) =>
  [...el.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent ?? ""));

describe("details of a Gateway", () => {
  it("attached routes match the card; refused ones are listed apart with the reason", async () => {
    await openDetails(publicGw);
    emitSnapshot(wb, await listWatch("HTTPRoute"), httpRoutes);
    emitSnapshot(wb, await listWatch("GRPCRoute"), grpcRoutes);
    await waitFor(() => expect(screen.queryByText("Looking for routes…")).toBeNull());
    expect(screen.getByText("Attached routes", { selector: ".gw-card__label" }).nextSibling).toHaveTextContent("3");
    expect(rowsOf(block("Attached routes (3)")).map((r) => [r[1], r[3]])).toEqual([
      ["checkout", "https"],
      ["http-redirect", "http"],
      ["shop", "https"],
    ]);
    expect(rowsOf(block("Not attached (1)"))).toEqual([
      ["HTTPRoute", "payments-status", "gw-payments", "https", "NotAllowedByListeners"],
    ]);
    const reason = within(block("Not attached (1)")).getByText("NotAllowedByListeners");
    expect(reason.closest("[title]")).toHaveAttribute("title", expect.stringContaining("No listener of this Gateway lets the route attach"));
    // The check button prefills a request an attached route serves.
    fireEvent.click(screen.getByRole("button", { name: "Check a request…" }));
    expect(useRequestCheckStore.getState().clusters.c1?.form.url).toBe("https://shop.example.com/");
  });

  it("the Topology tab has no second heading and keeps its own padding", async () => {
    await openDetails(internalGw);
    fireEvent.click(screen.getByRole("tab", { name: "Topology" }));
    const table = await screen.findByRole("table", { name: "Topology" });
    expect(table.closest(".gw-topology")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Topology" })).toBeNull();
    const root = table.querySelector("tbody tr[data-type='gateway']")!;
    expect(root).toHaveAttribute("data-health", "problem");
    expect(root).toHaveTextContent("1 of 4 listeners broken");
  });
});

describe("details of an HTTPRoute with a backend not permitted", () => {
  it("explains RefNotPermitted once, at the rule; the parent banner only points there", async () => {
    await openDetails(byName(httpRoutes, "checkout"));
    // The grant in gw-payments permits /checkout's backend, not /refunds'.
    emitSnapshot(wb, await listWatch("ReferenceGrant"), referenceGrants);
    const explanation = /no ReferenceGrant in that namespace permits it/;
    await waitFor(() => expect(screen.getAllByText(explanation)).toHaveLength(1));
    const parentBanner = screen.getByText("public-gw ✗ RefNotPermitted").closest(".gw-problem")!;
    expect(parentBanner).toHaveTextContent("ResolvedRefs: RefNotPermitted — see the rule below");
    expect(parentBanner).not.toHaveTextContent(explanation);
    const ruleBanner = screen.getByText(explanation).closest(".gw-problem")!;
    expect(within(ruleBanner as HTMLElement).getByRole("button", { name: "Copy ReferenceGrant YAML" })).toBeInTheDocument();
  });
});

describe("the request check page", () => {
  it("watches the Namespaces' labels (metadata only), so Selector listeners are evaluated", async () => {
    render(<RequestCheckPage clusterId="c1" />);
    const nsWatch = await listWatch("Namespace");
    expect(wb.specs.get(nsWatch)).toMatchObject({ namespaces: null, metadataOnly: true });
    emitSnapshot(wb, await listWatch("Gateway"), gateways);
    emitSnapshot(wb, await listWatch("HTTPRoute"), httpRoutes);
    emitSnapshot(wb, await listWatch("GRPCRoute"), grpcRoutes);
    emitSnapshot(wb, await listWatch("ReferenceGrant"), referenceGrants);
    emitSnapshot(wb, await listWatch("Service"), services);
    emitSnapshot(wb, await listWatch("EndpointSlice"), endpointSlices);
    emitSnapshot(wb, nsWatch, namespaces);
    await waitFor(() => expect(screen.queryByText(/Reading Gateways/)).toBeNull());
    fireEvent.change(screen.getByRole("textbox", { name: "URL" }), { target: { value: "https://shop.example.com/api/cart" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Headers" }), { target: { value: "x-env: prod" } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    const result = screen.getByRole("region", { name: "Result" });
    expect(result).toHaveTextContent("Forwarded to the backends");
    // https on public-gw admits routes by a namespace selector: with the labels known there is nothing to note.
    expect(result).not.toHaveTextContent(/namespace selector/);
  });
});
