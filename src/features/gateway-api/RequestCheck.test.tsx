import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KindRef, KubeObject, ObjectRef, ResourceKind } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { i18n } from "../../i18n";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { Sidebar } from "../../layout/sidebar/Sidebar";
import { kindFromApiVersion, resetClusterKinds } from "../../resources";
import "../details";
import { copy, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import endpointSlicesJson from "./fixtures/matching/endpointslices.json";
import gatewaysJson from "./fixtures/matching/gateways.json";
import grpcRoutesJson from "./fixtures/matching/grpcroutes.json";
import httpRoutesJson from "./fixtures/matching/httproutes.json";
import namespacesJson from "./fixtures/matching/namespaces.json";
import referenceGrantsJson from "./fixtures/matching/referencegrants.json";
import servicesJson from "./fixtures/matching/services.json";
import "./index";
import { RequestCheckPage } from "./RequestCheck";
import { GRPC_STATUSES } from "./matching";
import {
  gatewayPrefill,
  LOSS_REASONS,
  NOTES,
  OUTCOMES,
  parseHeaderLines,
  PRECEDENCE_CRITERIA,
  REQUEST_CHECK_PAGE,
  resetRequestChecks,
  useRequestCheckStore,
} from "./checkState";

// The Gateway API fixtures of the kind test cluster that the matching engine's tests use: public-gw (http :80 →
// redirect, https :443 shop.example.com) and internal-gw (http :8080, grpc :9090, …); routes shop (weighted, header
// match), http-redirect, checkout (/refunds RefNotPermitted), legacy-admin, payments-status (NotAllowedByListeners)
// and the GRPCRoute inventory, with their Services, EndpointSlices and the ReferenceGrant.
const gateways = gatewaysJson as KubeObject[];
const httpRoutes = httpRoutesJson as KubeObject[];
const grpcRoutes = grpcRoutesJson as KubeObject[];
const services = servicesJson as KubeObject[];
const endpointSlices = endpointSlicesJson as KubeObject[];
const referenceGrants = referenceGrantsJson as KubeObject[];
const namespaces = namespacesJson as KubeObject[];

const kindOf = (obj: KubeObject): KindRef => kindFromApiVersion(obj.apiVersion ?? "", obj.kind ?? "");

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

/** A watch of every namespace (not the details panel's watch of one object). */
const listWatch = (kind: string) => watchOf(wb, kind, (s) => s.namespaces === null && s.fieldSelector === null);

async function feed(routes: KubeObject[] = httpRoutes): Promise<void> {
  emitSnapshot(wb, await listWatch("Gateway"), gateways);
  emitSnapshot(wb, await listWatch("HTTPRoute"), routes);
  emitSnapshot(wb, await listWatch("GRPCRoute"), grpcRoutes);
  emitSnapshot(wb, await listWatch("ReferenceGrant"), referenceGrants);
  emitSnapshot(wb, await listWatch("Service"), services);
  emitSnapshot(wb, await listWatch("EndpointSlice"), endpointSlices);
  emitSnapshot(wb, await listWatch("Namespace"), namespaces);
  await waitFor(() => expect(screen.queryByText(/Reading Gateways/)).toBeNull());
}

async function openPage(routes?: KubeObject[]): Promise<void> {
  render(<RequestCheckPage clusterId="c1" />);
  await feed(routes);
}

const urlInput = () => screen.getByRole<HTMLInputElement>("textbox", { name: "URL" });

function check(url: string, options: { method?: string; headers?: string; grpc?: boolean } = {}): void {
  if (options.method) fireEvent.change(screen.getByRole("combobox", { name: "Method" }), { target: { value: options.method } });
  if (options.grpc) fireEvent.click(screen.getByRole("checkbox", { name: "gRPC" }));
  fireEvent.change(urlInput(), { target: { value: url } });
  if (options.headers !== undefined)
    fireEvent.change(screen.getByRole("textbox", { name: "Headers" }), { target: { value: options.headers } });
  fireEvent.click(screen.getByRole("button", { name: "Check" }));
}

const result = () => screen.getByRole("region", { name: "Result" });

function step(id: string): HTMLElement {
  const el = result().querySelector<HTMLElement>(`[data-step='${id}']`);
  if (!el) throw new Error(`no step ${id}`);
  return el;
}

const steps = () => [...result().querySelectorAll<HTMLElement>("[data-step]")].map((s) => s.dataset.step);

function openConsidered(): HTMLElement {
  fireEvent.click(within(result()).getByRole("button", { name: /Also considered/ }));
  return result().querySelector<HTMLElement>(".gw-considered__list")!;
}

describe("the request check page", () => {
  it("is in the Gateway API section of the sidebar", async () => {
    render(<Sidebar clusterId="c1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Gateway API/ }));
    fireEvent.click(screen.getByRole("button", { name: "Request check" }));
    expect(useAppStore.getState().clusterViews.c1?.view).toBe(REQUEST_CHECK_PAGE);
  });

  it("follows /api with x-env=prod through public-gw/https to the weighted shop rule", async () => {
    await openPage();
    expect(screen.getByRole("heading", { name: "Where does this request go?" })).toBeInTheDocument();
    check("https://shop.example.com/api/items?page=2", { headers: "X-Env: prod" });

    expect(within(result()).getByRole("status")).toHaveTextContent("Forwarded to the backends");
    expect(steps()).toEqual(["gateway", "route", "filters", "backends"]);
    const gateway = step("gateway");
    expect(within(gateway).getByRole("button", { name: "Open Gateway public-gw" })).toHaveTextContent("gw-infra/public-gw");
    expect(gateway).toHaveTextContent("listener https · 443/HTTPS · shop.example.com");
    expect(gateway).toHaveTextContent("Port 443 and protocol HTTPS fit, and its hostname shop.example.com matches shop.example.com.");

    const route = step("route");
    expect(within(route).getByRole("button", { name: "Open HTTPRoute shop" })).toHaveTextContent("gw-shop/shop");
    expect(route).toHaveTextContent("Rule 1");
    expect(route).toHaveTextContent("PathPrefix /api · header x-env=prod");
    expect(route).toHaveTextContent("Preferred over 1 other matching rule by: path (Exact, then RegularExpression, then the longest PathPrefix).");

    expect(step("filters")).toHaveTextContent("add header x-gateway=public");

    const backends = [...step("backends").querySelectorAll<HTMLElement>("[data-backend]")];
    expect(backends.map((b) => b.textContent)).toEqual([
      "api-v2:808090% of requests2/3 pods ready",
      "api-v1:808010% of requests1/1 pods ready",
    ]);
    expect(within(backends[0]!).getByText("2/3 pods ready")).toHaveClass("rt-status--danger");
    expect(within(backends[1]!).getByText("1/1 pods ready")).toHaveClass("rt-status--success");
    // Every named object opens its details.
    fireEvent.click(within(backends[0]!).getByRole("button", { name: "Open Service api-v2" }));
    expect(useAppStore.getState().details).toMatchObject({ kind: { kind: "Service" }, namespace: "gw-shop", name: "api-v2" });
  });

  it("lists the candidates that lost, with translated reasons, collapsed until asked", async () => {
    await openPage();
    check("https://shop.example.com/api/items", { headers: "x-env: prod" });
    const button = within(result()).getByRole("button", { name: /Also considered \(\d+\)/ });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(result().querySelector(".gw-considered__list")).toBeNull();
    const list = openConsidered();
    expect(button).toHaveAttribute("aria-expanded", "true");
    const items = [...list.querySelectorAll("li")].map((li) => li.textContent ?? "");
    expect(items).toContain(
      "HTTPRoute gw-shop/shop · rule 2 · match 1 on gw-infra/public-gw/httpsMatches, but loses on path (Exact, then RegularExpression, then the longest PathPrefix)",
    );
    expect(items).toContain(
      "HTTPRoute gw-payments/payments-status on gw-infra/public-gw/httpsNot accepted by the Gateway: NotAllowedByListeners",
    );
    expect(items).toContain("gw-infra/public-gw / Listener httpAnother port");
    expect(items).toContain("Gateway gw-infra/internal-gwNone of its listeners fits the port, protocol and hostname");
    expect(items.some((i) => i.includes("checkout") && i.endsWith("The path does not match"))).toBe(true);
    // The controller's reason is explained in a tooltip.
    const refused = [...list.querySelectorAll("li")].find((li) => li.textContent?.includes("payments-status"))!;
    expect(refused.querySelector(".gw-considered__reason")!.getAttribute("title")).toMatch(/No listener of this Gateway lets the route attach/);
  });

  it("plain HTTP is redirected: the code and the location", async () => {
    await openPage();
    check("http://shop.example.com/cart?id=7");
    expect(within(result()).getByRole("status")).toHaveTextContent("Redirected: 301");
    expect(steps()).toEqual(["gateway", "route", "filters", "answer"]);
    expect(step("route")).toHaveTextContent("gw-shop/http-redirect");
    expect(step("answer")).toHaveTextContent("https://shop.example.com/cart?id=7");
    expect(step("answer")).toHaveTextContent("The Gateway answers 301 with Location https://shop.example.com/cart?id=7");
  });

  it("no route: 404 on the listener that takes the request", async () => {
    await openPage();
    check("http://internal.shop.example.com:8080/");
    expect(within(result()).getByRole("status")).toHaveTextContent("404 Not Found");
    expect(steps()).toEqual(["gateway", "route"]);
    expect(step("gateway")).toHaveTextContent("gw-infra/internal-gw");
    expect(step("route")).toHaveTextContent("Listener http takes the request, but no rule of a route attached to it matches");
  });

  it("no listener: the connection is not served", async () => {
    await openPage();
    check("https://other.example.net/");
    expect(within(result()).getByRole("status")).toHaveTextContent("No Gateway listener takes this request");
    expect(steps()).toEqual(["gateway"]);
  });

  it("a backend no ReferenceGrant permits: 500 with the reason and the grant to copy", async () => {
    await openPage();
    check("https://shop.example.com/refunds", { method: "POST" });
    expect(within(result()).getByRole("status")).toHaveTextContent("500 Internal Server Error");
    expect(step("route")).toHaveTextContent("gw-shop/checkout");
    expect(step("route")).toHaveTextContent("Rule 2");
    const backend = step("backends").querySelector<HTMLElement>("[data-backend='refunds-api']")!;
    expect(backend).toHaveTextContent("gw-payments/refunds-api:8080");
    expect(within(backend).getByText("not permitted: no ReferenceGrant in gw-payments allows it (500)")).toHaveClass("rt-status--danger");
    expect(step("answer")).toHaveTextContent("The rule has no backend that can take the request: the Gateway answers 500.");
    fireEvent.click(within(step("backends")).getByRole("button", { name: "Copy ReferenceGrant YAML" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const yaml = vi.mocked(navigator.clipboard.writeText).mock.calls[0]![0];
    expect(yaml).toContain("namespace: gw-payments");
    expect(yaml).toContain("kind: HTTPRoute");
    expect(yaml).toContain("name: refunds-api");
  });

  it("an invalid URL gets an inline error and no result", async () => {
    await openPage();
    check("http://");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a URL with http:// or https:// and a host");
    expect(urlInput()).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByRole("region", { name: "Result" })).toBeNull();
    check("ftp://shop.example.com/");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    check("https://shop.example.com/");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(result()).toBeInTheDocument();
  });

  it("header lines that are not `name: value` are pointed out", async () => {
    await openPage();
    check("https://shop.example.com/api", { headers: "x-env: prod\nnonsense\n\nbad name: 1" });
    expect(screen.getByRole("alert")).toHaveTextContent('Lines 2, 4 are not "name: value"');
    expect(screen.queryByRole("region", { name: "Result" })).toBeNull();
    expect(parseHeaderLines("Host: a.example.com:8443\nx: ")).toEqual({ headers: { Host: "a.example.com:8443", x: "" }, badLines: [] });
  });

  it("a gRPC call goes to the GRPCRoute; the method is POST", async () => {
    await openPage();
    check("http://grpc.internal.example.com:9090/inventory.v1.Inventory/GetStock", { grpc: true });
    expect(screen.getByRole("combobox", { name: "Method" })).toBeDisabled();
    expect(step("route")).toHaveTextContent("GRPCRoute gw-shop/inventory");
    expect(step("route")).toHaveTextContent("method inventory.v1.Inventory/GetStock");
  });

  it("a gRPC call no rule takes gets UNIMPLEMENTED, not a 404", async () => {
    await openPage();
    check("http://grpc.internal.example.com:9090/inventory.v1.Inventory/Reserve", { grpc: true });
    expect(within(result()).getByRole("status")).toHaveTextContent("gRPC UNIMPLEMENTED");
    expect(step("route")).toHaveTextContent("Listener grpc takes the gRPC call, but no rule of a route attached to it matches: the Gateway answers UNIMPLEMENTED.");
    expect(result()).not.toHaveTextContent("404");
  });

  it("remembers the last request of the cluster while the app runs", async () => {
    const { unmount } = render(<RequestCheckPage clusterId="c1" />);
    await feed();
    check("http://shop.example.com/cart");
    unmount();
    render(<RequestCheckPage clusterId="c1" />);
    expect(urlInput()).toHaveValue("http://shop.example.com/cart");
    // No result from half the data: the lists come again first.
    expect(screen.getByRole("status")).toHaveTextContent("Reading Gateways, routes and backends…");
    expect(screen.queryByRole("region", { name: "Result" })).toBeNull();
    await feed();
    expect(result()).toHaveTextContent("Redirected: 301");
  });
});

describe("the hostname map", () => {
  // A copy of shop, created later, claims the same hostname with the same matches: shop (older) wins.
  const shopCopy = (() => {
    const route = copy(httpRoutes[0]!);
    route.metadata = { ...route.metadata, name: "shop-copy", uid: "shop-copy", creationTimestamp: "2026-10-15T00:00:00Z" };
    return route;
  })();

  async function openHostnames(routes = [...httpRoutes, shopCopy]): Promise<HTMLElement> {
    await openPage(routes);
    fireEvent.click(screen.getByRole("tab", { name: "Hostnames" }));
    return screen.getByRole("table", { name: "Hostname map" });
  }

  const rowOf = (table: HTMLElement, route: string, gateway = "public-gw") =>
    [...table.querySelectorAll<HTMLElement>("tbody tr")].find(
      (tr) =>
        within(tr).queryByRole("button", { name: `Open HTTPRoute ${route}` }) &&
        within(tr).queryByRole("button", { name: `Open Gateway ${gateway}` }),
    )!;

  it("maps hostnames to listeners, routes and backends and highlights conflicts with the winner", async () => {
    const table = await openHostnames();
    const shop = rowOf(table, "shop");
    expect(shop).toHaveTextContent("shop.example.com");
    expect(shop).toHaveTextContent("gw-infra/public-gw / https (443/HTTPS)");
    expect(shop).toHaveTextContent("Accepted");
    expect(shop).toHaveTextContent("api-v2:8080");
    expect(shop).toHaveAttribute("data-conflict", "true");
    expect(shop).toHaveTextContent("Same match as gw-shop/shop-copy (rule 1): this route gets the traffic");
    const copyRow = rowOf(table, "shop-copy");
    expect(copyRow).toHaveAttribute("data-conflict", "true");
    expect(copyRow).toHaveTextContent("Same match as gw-shop/shop (rule 1): gw-shop/shop gets the traffic");
    expect(rowOf(table, "checkout")).not.toHaveAttribute("data-conflict");
    expect(screen.getByText("2 rows with conflicting routes")).toBeInTheDocument();
    // A route the listener refused is listed with the controller's reason.
    expect(rowOf(table, "payments-status")).toHaveTextContent("Not accepted: NotAllowedByListeners");
  });

  it("filters by the routes' namespace", async () => {
    const table = await openHostnames(httpRoutes);
    expect(table.querySelectorAll("tbody tr").length).toBeGreaterThan(1);
    fireEvent.change(screen.getByRole("combobox", { name: "Route namespace" }), { target: { value: "gw-payments" } });
    const rows = [...screen.getByRole("table", { name: "Hostname map" }).querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("gw-payments/payments-status");
  });

  it("a row checks a request to its hostname on its listener", async () => {
    const table = await openHostnames(httpRoutes);
    fireEvent.click(within(rowOf(table, "legacy-admin", "internal-gw")).getByText("Accepted"));
    expect(screen.getByRole("tab", { name: "Request" })).toHaveAttribute("aria-selected", "true");
    // A path the route serves.
    expect(urlInput()).toHaveValue("http://internal.shop.example.com:8080/admin");
    expect(step("route")).toHaveTextContent("gw-shop/legacy-admin");
    // The hostname itself is a button too.
    fireEvent.click(screen.getByRole("tab", { name: "Hostnames" }));
    const table2 = screen.getByRole("table", { name: "Hostname map" });
    fireEvent.click(within(rowOf(table2, "checkout")).getByRole("button", { name: "shop.example.com" }));
    expect(urlInput()).toHaveValue("https://shop.example.com/checkout");
    expect(step("route")).toHaveTextContent("gw-shop/checkout");
  });
});

describe("entry points in the details", () => {
  function refTo(obj: KubeObject): ObjectRef {
    return { kind: kindOf(obj), namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
  }

  async function openDetails(obj: KubeObject): Promise<void> {
    const ref = refTo(obj);
    useAppStore.getState().openDetails(ref);
    render(<DetailsPanel clusterId="c1" objectRef={ref} />);
    emitSnapshot(wb, await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`), [obj]);
  }

  it("a Gateway's button opens the page with its host", async () => {
    const publicGw = gateways[0]!;
    expect(gatewayPrefill(publicGw)).toEqual({ method: "GET", grpc: false, url: "https://shop.example.com/" });
    await openDetails(publicGw);
    fireEvent.click(await screen.findByRole("button", { name: "Check a request…" }));
    expect(useAppStore.getState().clusterViews.c1?.view).toBe(REQUEST_CHECK_PAGE);
    expect(useAppStore.getState().details).toBeNull();
    expect(useRequestCheckStore.getState().clusters.c1?.form.url).toBe("https://shop.example.com/");
    await openPage();
    expect(urlInput()).toHaveValue("https://shop.example.com/");
    expect(within(result()).getByRole("status")).toHaveTextContent("Forwarded to the backends");
    expect(step("route")).toHaveTextContent("gw-shop/shop");
  });

  it("a route's button opens the page on a listener the route is accepted on", async () => {
    await openDetails(httpRoutes[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Check a request…" }));
    // Until the page has the Gateways: the route's first hostname.
    expect(useRequestCheckStore.getState().clusters.c1?.form.url).toBe("http://shop.example.com/");
    await openPage();
    await waitFor(() => expect(urlInput()).toHaveValue("https://shop.example.com/"));
    expect(step("route")).toHaveTextContent("gw-shop/shop");
  });
});

describe("translations", () => {
  it("every code of the engine's results has a string", () => {
    const missing = [
      ...LOSS_REASONS.map((c) => `gateway:check.loss.${c}`),
      ...PRECEDENCE_CRITERIA.map((c) => `gateway:check.criteria.${c}`),
      ...NOTES.map((c) => `gateway:check.notes.${c}`),
      ...OUTCOMES.map((c) => `gateway:check.outcome.${c}`),
      ...GRPC_STATUSES.map((c) => `gateway:check.grpcStatus.${c}`),
    ].filter((key) => !i18n.exists(key));
    expect(missing).toEqual([]);
    expect(LOSS_REASONS).toHaveLength(25);
    expect(PRECEDENCE_CRITERIA).toHaveLength(12);
    expect(NOTES).toHaveLength(7);
    expect(OUTCOMES).toHaveLength(6);
  });
});
