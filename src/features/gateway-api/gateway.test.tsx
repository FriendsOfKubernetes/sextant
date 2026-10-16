import { fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KindRef, KubeObject, ObjectRef, ResourceKind } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { Sidebar } from "../../layout/sidebar/Sidebar";
import { getResourceDef, kindFromApiVersion, resetClusterKinds, type ColumnDef } from "../../resources";
import "../details";
import { emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import backendTlsPolicyJson from "./fixtures/backendtlspolicy.json";
import endpointSlicesJson from "./fixtures/endpointslices.json";
import gatewayClassJson from "./fixtures/gatewayclass.json";
import gatewayClassPendingJson from "./fixtures/gatewayclass-pending.json";
import gatewayInternalJson from "./fixtures/gateway-internal.json";
import gatewayJson from "./fixtures/gateway.json";
import grpcRouteJson from "./fixtures/grpcroute.json";
import httpRouteCrossNsJson from "./fixtures/httproute-crossns.json";
import httpRouteJson from "./fixtures/httproute.json";
import referenceGrantJson from "./fixtures/referencegrant.json";
import servicesJson from "./fixtures/services.json";
import tcpRouteJson from "./fixtures/tcproute.json";
import "./index";
import { i18n } from "../../i18n";
import {
  backendIssue,
  backendRefs,
  explainReason,
  filterPhrases,
  grpcMatchPhrases,
  healthOf,
  httpMatchPhrases,
  sharesOf,
  type Phrase,
  GATEWAY_KINDS,
  isProblem,
  listenerStatuses,
  parentStatuses,
  problemCount,
  referenceGrantFor,
  referencePermitted,
  routeAttachedTo,
  routeRules,
} from "./model";
import { PoliciesPage } from "./policies";
import { useGatewayProblems } from "./problems";

// Gateway API v1 objects with the status Envoy Gateway writes: a Gateway with a listener whose certificate is in
// another namespace without a ReferenceGrant, an HTTPRoute accepted by one Gateway and rejected by the other for its
// hostnames, an HTTPRoute whose backend is in another namespace, a TCPRoute no listener allows.
const gatewayClass = gatewayClassJson as KubeObject;
const gatewayClassPending = gatewayClassPendingJson as KubeObject;
const gateway = gatewayJson as KubeObject;
const gatewayInternal = gatewayInternalJson as KubeObject;
const httpRoute = httpRouteJson as KubeObject;
const httpRouteCrossNs = httpRouteCrossNsJson as KubeObject;
const grpcRoute = grpcRouteJson as KubeObject;
const tcpRoute = tcpRouteJson as KubeObject;
const referenceGrant = referenceGrantJson as KubeObject;
const backendTlsPolicy = backendTlsPolicyJson as KubeObject;
const services = servicesJson as KubeObject[];
const endpointSlices = endpointSlicesJson as KubeObject[];

const kindOf = (obj: KubeObject): KindRef => kindFromApiVersion(obj.apiVersion ?? "", obj.kind ?? "");

function columnOf(obj: KubeObject, id: string): ColumnDef {
  const col = getResourceDef(kindOf(obj)).columns.find((c) => c.id === id);
  if (!col) throw new Error(`${obj.kind} has no column ${id}`);
  return col;
}

const ids = (obj: KubeObject) => getResourceDef(kindOf(obj)).columns.map((c) => c.id);

function cell(obj: KubeObject, id: string): HTMLElement {
  const col = columnOf(obj, id);
  const content = col.render
    ? col.render(obj, { clusterId: "c1", kind: kindOf(obj), now: Date.parse("2026-10-16T12:00:00Z") })
    : String(col.value(obj) ?? "");
  const { container } = render(<div data-testid="cell">{content as ReactElement}</div>);
  return within(container).getByTestId("cell");
}

describe("Gateway API tables", () => {
  it("Gateway: class, addresses, listeners programmed, attached routes, status", () => {
    expect(ids(gateway)).toEqual(["name", "namespace", "class", "addresses", "listeners", "attachedRoutes", "status", "age"]);
    expect(columnOf(gateway, "class").value(gateway)).toBe("eg");
    expect(columnOf(gateway, "addresses").value(gateway)).toBe("172.18.0.200");
    // https-shop is not programmed: its certificate is not permitted.
    expect(cell(gateway, "listeners")).toHaveTextContent("2/3");
    expect(cell(gateway, "listeners").querySelector(".rt-status--danger")).not.toBeNull();
    expect(columnOf(gateway, "attachedRoutes").value(gateway)).toBe(3);
    expect(cell(gatewayInternal, "listeners").querySelector(".rt-status--success")).not.toBeNull();
    // Status: Programmed, or the problem — the broken listener and its reason, explained in the tooltip.
    expect(columnOf(gatewayInternal, "status").value(gatewayInternal)).toBe("Programmed");
    expect(cell(gatewayInternal, "status").querySelector(".rt-status--success")).toHaveTextContent("Programmed");
    expect(columnOf(gateway, "status").value(gateway)).toBe("Listener https-shop: RefNotPermitted");
    const status = cell(gateway, "status");
    expect(status.querySelector(".rt-status--danger")).toHaveTextContent("Listener https-shop: RefNotPermitted");
    expect(status.querySelector("[title]")).toHaveAttribute("title", expect.stringContaining("no ReferenceGrant in that namespace"));
  });

  it("HTTPRoute: hostnames, parents with status, rules", () => {
    expect(ids(httpRoute)).toEqual(["name", "namespace", "hostnames", "parents", "rules", "age"]);
    expect(columnOf(httpRoute, "hostnames").value(httpRoute)).toBe("api.example.com +1");
    expect(columnOf(httpRoute, "parents").value(httpRoute)).toBe(
      "public-gw ✓, internal ✗ NoMatchingListenerHostname",
    );
    const parents = cell(httpRoute, "parents");
    expect(within(parents).getByText("public-gw ✓")).toHaveClass("rt-status--success");
    expect(within(parents).getByText("internal ✗ NoMatchingListenerHostname")).toHaveClass("rt-status--danger");
    expect(columnOf(httpRoute, "rules").value(httpRoute)).toBe(3);
  });

  it("GRPC, TCP routes; TCP has no hostnames", () => {
    expect(columnOf(grpcRoute, "parents").value(grpcRoute)).toBe("public-gw ✓");
    expect(ids(tcpRoute)).toEqual(["name", "namespace", "parents", "rules", "age"]);
    expect(columnOf(tcpRoute, "parents").value(tcpRoute)).toBe("internal ✗ NotAllowedByListeners");
  });

  it("GatewayClass, ReferenceGrant and BackendTLSPolicy", () => {
    expect(ids(gatewayClass)).toEqual(["name", "controller", "accepted", "description", "age"]);
    expect(getResourceDef(kindOf(gatewayClass)).namespaced).toBe(false);
    expect(columnOf(gatewayClass, "controller").value(gatewayClass)).toBe("gateway.envoyproxy.io/gatewayclass-controller");
    expect(columnOf(gatewayClass, "accepted").value(gatewayClass)).toBe("✓");
    expect(columnOf(gatewayClassPending, "accepted").value(gatewayClassPending)).toBe("? Pending");
    expect(columnOf(referenceGrant, "from").value(referenceGrant)).toBe("HTTPRoute (web), GRPCRoute (web)");
    expect(columnOf(referenceGrant, "to").value(referenceGrant)).toBe("Service, Secret shared-ca");
    expect(columnOf(backendTlsPolicy, "targets").value(backendTlsPolicy)).toBe("Service api-v2");
    expect(columnOf(backendTlsPolicy, "status").value(backendTlsPolicy)).toBe("public-gw ✓");
  });

  it("every kind sits in the Gateway API section with its own label", () => {
    const labels = GATEWAY_KINDS.map(({ kind }) => {
      const def = getResourceDef(kind);
      expect(def.sidebar?.section).toBe("gatewayApi");
      return def.sidebar?.labelKey;
    });
    expect(new Set(labels).size).toBe(GATEWAY_KINDS.length);
  });

  it("kinds with a status offer the Only problems filter, with isProblem; ReferenceGrants do not", () => {
    expect(getResourceDef(kindOf(httpRoute)).problem?.(httpRoute)).toBe(true);
    expect(getResourceDef(kindOf(grpcRoute)).problem?.(grpcRoute)).toBe(false);
    expect(getResourceDef(kindOf(gateway)).problem?.(gateway)).toBe(true);
    expect(getResourceDef(kindOf(referenceGrant)).problem).toBeUndefined();
  });
});

describe("problems", () => {
  it("are what a controller rejected: a broken listener, a rejected parent; not an unprocessed class", () => {
    expect(isProblem(gateway, kindOf(gateway))).toBe(true);
    expect(isProblem(gatewayInternal, kindOf(gatewayInternal))).toBe(false);
    expect(isProblem(httpRoute, kindOf(httpRoute))).toBe(true);
    expect(isProblem(httpRouteCrossNs, kindOf(httpRouteCrossNs))).toBe(true);
    expect(isProblem(grpcRoute, kindOf(grpcRoute))).toBe(false);
    expect(isProblem(tcpRoute, kindOf(tcpRoute))).toBe(true);
    expect(isProblem(gatewayClass, kindOf(gatewayClass))).toBe(false);
    // Pending (no controller took it yet) is shown as pending, but is not a problem.
    expect(healthOf(gatewayClassPending, kindOf(gatewayClassPending))).toBe("pending");
    expect(isProblem(gatewayClassPending, kindOf(gatewayClassPending))).toBe(false);
    expect(isProblem(referenceGrant, kindOf(referenceGrant))).toBe(false);
    expect(isProblem(backendTlsPolicy, kindOf(backendTlsPolicy))).toBe(false);
    // The "Only problems" filter of the HTTPRoutes table keeps both routes, of the GRPCRoutes none.
    expect([httpRoute, httpRouteCrossNs].filter((r) => isProblem(r, kindOf(r)))).toHaveLength(2);
    expect(problemCount([gateway, gatewayInternal], kindOf(gateway))).toBe(1);
  });

  it("a route without status from any controller is pending, which does not count", () => {
    const fresh = structuredClone(grpcRoute);
    delete fresh.status;
    expect(parentStatuses(fresh)[0]?.health).toBe("pending");
    expect(columnOf(fresh, "parents").value(fresh)).toBe("public-gw ? Pending");
    expect(isProblem(fresh, kindOf(fresh))).toBe(false);
  });

  it("a listener not programmed for reason Pending is pending, not a problem", () => {
    const gw = structuredClone(gatewayInternal);
    const status = gw.status as { listeners: { conditions: { type: string; status: string; reason: string }[] }[] };
    const programmed = status.listeners[0]!.conditions.find((c) => c.type === "Programmed")!;
    programmed.status = "False";
    programmed.reason = "Pending";
    expect(listenerStatuses(gw)[0]?.health).toBe("pending");
    expect(healthOf(gw, kindOf(gw))).toBe("pending");
    expect(isProblem(gw, kindOf(gw))).toBe(false);
  });
});

// ---------- Model ----------

describe("the model", () => {
  it("routeAttachedTo: the parent entry for a Gateway and, with a listener, only if it can attach there", () => {
    const [http, https] = listenerStatuses(gateway);
    expect(routeAttachedTo(httpRoute, gateway)?.accepted?.status).toBe("True");
    expect(routeAttachedTo(httpRoute, gateway, http)?.ref.sectionName).toBe("http");
    expect(routeAttachedTo(httpRoute, gateway, https)).toBeUndefined();
    expect(routeAttachedTo(httpRoute, gatewayInternal)?.accepted?.reason).toBe("NoMatchingListenerHostname");
    expect(routeAttachedTo(grpcRoute, gatewayInternal)).toBeUndefined();
  });

  it("backendRefs: defaults filled, duplicates removed, shares of traffic per rule", () => {
    expect(backendRefs(httpRoute).map((b) => `${b.namespace}/${b.name}:${b.port}`)).toEqual([
      "web/api-v2:8080",
      "web/api-v1:8080",
    ]);
    expect(routeRules(httpRoute, kindOf(httpRoute))[0]?.backends.map((b) => b.percent)).toEqual([90, 10]);
  });

  it("shares of traffic add up to 100", () => {
    expect(sharesOf([1, 1, 1])).toEqual([34, 33, 33]);
    expect(sharesOf([2, 1])).toEqual([67, 33]);
    expect(sharesOf([1, 1, 1, 1, 1, 1, 1])).toEqual([15, 15, 14, 14, 14, 14, 14]);
    expect(sharesOf([0, 0])).toEqual([0, 0]);
    expect(sharesOf([90, 10])).toEqual([90, 10]);
  });

  const text = (phrases: Phrase[]) => phrases.map((p) => i18n.t(p.key, p.params)).join(" · ");

  it("matches as text: query parameters, regular expressions, no path, any gRPC method", () => {
    expect(
      text(
        httpMatchPhrases({
          headers: [{ type: "RegularExpression", name: "x-user", value: "^a.*" }],
          queryParams: [{ name: "v", value: "2" }],
          method: "POST",
        }),
      ),
    ).toBe("PathPrefix / · header x-user~^a.* · query v=2 · POST");
    expect(text(httpMatchPhrases({ path: { type: "RegularExpression", value: "/v[0-9]+" } }))).toBe(
      "RegularExpression /v[0-9]+",
    );
    expect(text(grpcMatchPhrases({}))).toBe("any method");
    expect(text(grpcMatchPhrases({ method: { type: "RegularExpression", service: "echo\\..*" } }))).toBe(
      "method ~ echo\\..*/*",
    );
    expect(text(filterPhrases({ type: "ResponseHeaderModifier", responseHeaderModifier: { add: [{ name: "a", value: "1" }] } }))).toBe(
      "response: add header a=1",
    );
    expect(text(filterPhrases({ type: "RequestMirror", requestMirror: { backendRef: { name: "shadow", namespace: "qa", port: 80 } } }, "web"))).toBe(
      "mirror → qa/shadow:80",
    );
  });

  it("backendIssue: a backend in another namespace is not permitted only if no ReferenceGrant there permits it", () => {
    const parents = parentStatuses(httpRouteCrossNs);
    const backend = (namespace: string) => ({
      group: "",
      kind: "Service",
      name: "api",
      namespace,
      port: 80,
      weight: 1,
      percent: 100,
    });
    const context = { routeNamespace: "web", routeKind: "HTTPRoute", parents };
    // Grants unknown: suspected.
    expect(backendIssue(backend("shared"), context)).toBe("RefNotPermitted");
    const grantsIn = (ns: string) => (ns === "shared" ? [referenceGrant] : []);
    expect(backendIssue(backend("shared"), { ...context, grantsIn })).toBeUndefined();
    expect(backendIssue(backend("legacy"), { ...context, grantsIn })).toBe("RefNotPermitted");
    // A mirror in another namespace (from routeRules) is checked the same way.
    const route = structuredClone(httpRouteCrossNs);
    (route.spec as { rules: { filters: unknown[] }[] }).rules[1]!.filters = [
      { type: "RequestMirror", requestMirror: { backendRef: { name: "shadow", namespace: "qa", port: 80 } } },
    ];
    const [mirror] = routeRules(route, kindOf(route))[1]!.mirrors;
    expect(mirror).toMatchObject({ kind: "Service", name: "shadow", namespace: "qa" });
    expect(backendIssue(mirror!, { ...context, grantsIn })).toBe("RefNotPermitted");
  });

  it("explainReason: the common reasons have an explanation", () => {
    for (const reason of [
      "NotAllowedByListeners",
      "NoMatchingListenerHostname",
      "NoMatchingParent",
      "RefNotPermitted",
      "BackendNotFound",
      "InvalidKind",
      "InvalidCertificateRef",
      "UnsupportedProtocol",
      "InvalidListeners",
    ]) {
      expect(explainReason(reason), reason).toBe(`gateway:reasons.${reason}`);
    }
    expect(explainReason("Accepted")).toBeUndefined();
  });

  it("referencePermitted: a grant in the target namespace for the kind (and name)", () => {
    const from = { group: "gateway.networking.k8s.io", kind: "HTTPRoute", namespace: "web" };
    const svc = { group: "", kind: "Service", name: "anything", namespace: "shared" };
    expect(referencePermitted([referenceGrant], from, svc)).toBe(true);
    expect(referencePermitted([referenceGrant], from, { ...svc, namespace: "legacy" })).toBe(false);
    expect(referencePermitted([referenceGrant], from, { ...svc, kind: "Secret", name: "other" })).toBe(false);
    expect(referencePermitted([referenceGrant], from, { ...svc, kind: "Secret", name: "shared-ca" })).toBe(true);
    const grant = referenceGrantFor(from, { group: "", kind: "Service", namespace: "legacy", name: "legacy" });
    expect(referencePermitted([grant], from, { ...svc, namespace: "legacy", name: "legacy" })).toBe(true);
  });
});

// ---------- Discovery ----------

const served = (kind: KindRef, namespaced = true): ResourceKind => ({
  kindRef: kind,
  plural: `${kind.kind.toLowerCase()}s`,
  namespaced,
  verbs: ["list", "watch"],
  printerColumns: [],
});

const STANDARD: KindRef[] = [gatewayClass, gateway, httpRoute, grpcRoute, referenceGrant].map(kindOf);
const BUILT_IN: KindRef[] = [
  { group: "", version: "v1", kind: "Pod" },
  { group: "", version: "v1", kind: "Service" },
  { group: "discovery.k8s.io", version: "v1", kind: "EndpointSlice" },
];

let wb: WatchBackend;
let discovery: KindRef[];

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  discovery = [...BUILT_IN, ...STANDARD, kindOf(tcpRoute)];
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => discovery.map((k) => served(k, k.kind !== "GatewayClass")));
});

afterEach(() => {
  wb.backend.restore();
  resetClusterKinds();
});

const sections = () =>
  screen
    .getAllByRole("button")
    .filter((b) => b.hasAttribute("aria-expanded"))
    .map((b) => b.textContent);

describe("the Gateway API section", () => {
  it("lists the kinds the cluster serves, and only those", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Gateway API"));
    fireEvent.click(screen.getByRole("button", { name: /Gateway API/ }));
    const section = within(screen.getByRole("button", { name: /Gateway API/ }).closest("li")!);
    for (const label of ["Gateway Classes", "Gateways", "HTTP Routes", "GRPC Routes", "TCP Routes", "Reference Grants"]) {
      expect(section.getByRole("button", { name: label })).toBeInTheDocument();
    }
    // Experimental kinds the cluster does not serve are not listed.
    expect(section.queryByRole("button", { name: "TLS Routes" })).toBeNull();
    expect(section.queryByRole("button", { name: "Backend TLS Policies" })).toBeNull();
    // Nor again under Custom Resources.
    expect(screen.queryByRole("button", { name: "gateway.networking.k8s.io" })).toBeNull();
  });

  it("is not there when the cluster serves no Gateway API kinds", async () => {
    discovery = [...BUILT_IN];
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Network"));
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(true));
    expect(sections()).not.toContain("Gateway API");
  });
});

describe("the problem counter", () => {
  it("shows on the section header in the sidebar", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Gateway API"));
    emitSnapshot(wb, await watchOf(wb, "HTTPRoute"), [httpRoute, httpRouteCrossNs, grpcRoute]);
    emitSnapshot(wb, await watchOf(wb, "Gateway"), [gateway]);
    await waitFor(() => expect(screen.getByTitle("3 problems")).toHaveTextContent("3"));
    expect(screen.getByRole("button", { name: /Gateway API/ })).toContainElement(screen.getByTitle("3 problems"));
  });

  it("counts the objects that are not OK over every served kind", async () => {
    const { result } = renderHook(() => useGatewayProblems("c1"));
    expect(result.current.loading).toBe(true);
    emitSnapshot(wb, await watchOf(wb, "GatewayClass"), [gatewayClass, gatewayClassPending]);
    emitSnapshot(wb, await watchOf(wb, "Gateway"), [gateway, gatewayInternal]);
    emitSnapshot(wb, await watchOf(wb, "HTTPRoute"), [httpRoute, httpRouteCrossNs]);
    emitSnapshot(wb, await watchOf(wb, "GRPCRoute"), [grpcRoute]);
    emitSnapshot(wb, await watchOf(wb, "TCPRoute"), [tcpRoute]);
    await waitFor(() => expect(result.current.loading).toBe(false));
    // The Gateway with a broken listener, both HTTPRoutes and the TCPRoute; not the pending class.
    expect(result.current.count).toBe(4);
    // TLSRoute, UDPRoute and BackendTLSPolicy are not served: never watched.
    expect([...wb.specs.values()].some((s) => s.kind.kind === "TLSRoute")).toBe(false);
  });
});

// ---------- Details ----------

function refTo(obj: KubeObject): ObjectRef {
  return { kind: kindOf(obj), namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
}

async function openDetails(obj: KubeObject): Promise<void> {
  const ref = refTo(obj);
  useAppStore.getState().openDetails(ref);
  render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  const id = await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`);
  emitSnapshot(wb, id, [obj]);
}

function section(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-section='${id}']`);
  if (!el) throw new Error(`no section ${id}`);
  return el;
}

const listWatch = (kind: string) => watchOf(wb, kind, (s) => s.fieldSelector === null && s.labelSelector === null);

let clipboard: string[];

beforeEach(() => {
  clipboard = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn((text: string) => Promise.resolve(void clipboard.push(text))) },
  });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

/** The body rows of the table under the block titled `title`, as cell texts. */
function tableRows(title: string): string[][] {
  const block = within(section("gatewayApi")).getByRole("heading", { name: title }).closest(".dt-block")!;
  return [...block.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent ?? ""));
}

describe("details of a Gateway", () => {
  it("summary cards, the listeners table with the broken listener and a plain-language banner", async () => {
    await openDetails(gateway);
    const gw = within(section("gatewayApi"));
    expect(gw.getByRole("button", { name: "Open GatewayClass eg" })).toBeInTheDocument();
    expect(gw.getByText("172.18.0.200")).toBeInTheDocument();
    expect(gw.getByText("2 of 3 programmed")).toHaveClass("rt-status--danger");

    expect(tableRows("Listeners")).toEqual([
      ["http", "80/HTTP", "any", "", "All namespaces", "2", "OK"],
      ["https", "443/HTTPS", "*.example.com", "example-com-tls", "Namespaces with gateway-access=public", "1", "OK"],
      ["https-shop", "443/HTTPS", "shop.example.org", "shop/shop-tls", "Same namespace", "0", "ResolvedRefs: RefNotPermitted"],
    ]);
    // Certificates open the Secret.
    fireEvent.click(gw.getByRole("button", { name: "Open Secret shop-tls" }));
    expect(useAppStore.getState().details).toEqual({ kind: { group: "", version: "v1", kind: "Secret" }, namespace: "shop", name: "shop-tls" });

    const banner = gw.getByText("Listener https-shop: ResolvedRefs is False (RefNotPermitted)").closest(".gw-problem")!;
    expect(banner).toHaveTextContent("no ReferenceGrant in that namespace permits it");
    expect(banner).toHaveTextContent("Certificate ref to secret shop/shop-tls not permitted by any ReferenceGrant.");
    fireEvent.click(within(banner as HTMLElement).getByRole("button", { name: "Copy ReferenceGrant YAML" }));
    await waitFor(() => expect(clipboard).toHaveLength(1));
    expect(clipboard[0]).toBe(
      [
        "apiVersion: gateway.networking.k8s.io/v1beta1",
        "kind: ReferenceGrant",
        "metadata:",
        "  name: allow-gateway-from-infra-to-secret-shop-tls",
        "  namespace: shop",
        "spec:",
        "  from:",
        "  - group: gateway.networking.k8s.io",
        "    kind: Gateway",
        "    namespace: infra",
        "  to:",
        '  - group: ""',
        "    kind: Secret",
        "    name: shop-tls",
        "",
      ].join("\n"),
    );
  });

  it("lists the routes attached to it, with their status there", async () => {
    await openDetails(gateway);
    emitSnapshot(wb, await listWatch("HTTPRoute"), [httpRoute, httpRouteCrossNs]);
    emitSnapshot(wb, await listWatch("GRPCRoute"), [grpcRoute]);
    emitSnapshot(wb, await listWatch("TCPRoute"), [tcpRoute]);
    await waitFor(() => expect(within(section("gatewayApi")).queryByText("Looking for routes…")).toBeNull());
    expect(tableRows("Attached routes (3)")).toEqual([
      ["HTTPRoute", "api", "web", "http", "public-gw ✓"],
      ["HTTPRoute", "legacy-bridge", "web", "http", "public-gw ✗ RefNotPermitted"],
      ["GRPCRoute", "echo", "web", "https", "public-gw ✓"],
    ]);
  });
});

describe("details of an HTTPRoute", () => {
  it("parents: one accepted, one rejected for its hostnames, explained", async () => {
    await openDetails(httpRoute);
    const details = within(section("gatewayApi"));
    expect(details.getByText("api.example.com")).toBeInTheDocument();
    expect(details.getByText("api.example.org")).toBeInTheDocument();
    expect(tableRows("Parents")).toEqual([
      ["infra/public-gw", "http", "✓", "✓"],
      ["infra/internal", "all listeners", "✗ NoMatchingListenerHostname", "✓"],
    ]);
    const banner = details.getByText("internal ✗ NoMatchingListenerHostname").closest(".gw-problem")!;
    expect(banner).toHaveTextContent("None of the route's hostnames matches the hostname of a listener");
    fireEvent.click(details.getByRole("button", { name: "Open Gateway internal" }));
    expect(useAppStore.getState().details).toEqual(refTo(gatewayInternal));
  });

  it("rules: matches → weighted backends, filters, pod readiness of each backend", async () => {
    await openDetails(httpRoute);
    emitSnapshot(wb, await listWatch("Service"), services);
    emitSnapshot(wb, await listWatch("EndpointSlice"), endpointSlices);
    const rule = (n: number) => document.querySelector<HTMLElement>(`[data-rule='${n}']`)!;
    await waitFor(() => expect(rule(0)).toHaveTextContent("3/3 pods ready"));
    expect(rule(0)).toHaveTextContent("PathPrefix /api · header x-env=prod → api-v2:8080 90%, api-v1:8080 10%");
    expect(rule(0)).toHaveTextContent("Filters set header x-gateway=public, remove header x-debug");
    expect(within(rule(0)).getByText("3/3 pods ready")).toHaveClass("rt-status--success");
    expect(within(rule(0)).getByText("1/2 pods ready")).toHaveClass("rt-status--danger");
    expect(rule(1)).toHaveTextContent("Exact /healthz · GET → api-v1:8080");
    // A redirect answers by itself: no backends needed.
    expect(rule(2)).toHaveTextContent("PathPrefix /old");
    expect(rule(2)).toHaveTextContent("Redirect to https, same host and path (301)");
    expect(rule(2)).not.toHaveTextContent("<");
    expect(rule(2)).not.toHaveTextContent("No backends");
    for (const n of [0, 1, 2]) expect(rule(n)).not.toHaveClass("gw-rule--broken");
  });

  it("a backend that does not exist breaks its rule", async () => {
    const route = structuredClone(httpRoute);
    (route.spec as { rules: { backendRefs: { name: string }[] }[] }).rules[1]!.backendRefs[0]!.name = "api-v0";
    await openDetails(route);
    emitSnapshot(wb, await listWatch("Service"), services);
    emitSnapshot(wb, await listWatch("EndpointSlice"), endpointSlices);
    const rule = () => document.querySelector<HTMLElement>("[data-rule='1']")!;
    await waitFor(() => expect(rule()).toHaveClass("gw-rule--broken"));
    expect(rule()).toHaveTextContent("not found");
    expect(rule()).toHaveTextContent("A backend of the route does not exist");
  });

  it("RefNotPermitted: the rule with the backend in another namespace is broken and offers a ReferenceGrant", async () => {
    await openDetails(httpRouteCrossNs);
    const broken = document.querySelector<HTMLElement>("[data-rule='0']")!;
    expect(broken).toHaveClass("gw-rule--broken");
    expect(broken).toHaveTextContent("PathPrefix /legacy → legacy/legacy:80");
    expect(broken).toHaveTextContent("rewrite prefix /");
    expect(broken).toHaveTextContent("not permitted");
    expect(document.querySelector("[data-rule='1']")).not.toHaveClass("gw-rule--broken");
    expect(broken).toHaveTextContent("Needed in namespace legacy for Service legacy/legacy");
    fireEvent.click(within(broken).getByRole("button", { name: "Copy ReferenceGrant YAML" }));
    await waitFor(() => expect(within(broken).getByRole("status")).toHaveTextContent("Copied"));
    expect(clipboard).toEqual([
      [
        "apiVersion: gateway.networking.k8s.io/v1beta1",
        "kind: ReferenceGrant",
        "metadata:",
        "  name: allow-httproute-from-web-to-service-legacy",
        "  namespace: legacy",
        "spec:",
        "  from:",
        "  - group: gateway.networking.k8s.io",
        "    kind: HTTPRoute",
        "    namespace: web",
        "  to:",
        '  - group: ""',
        "    kind: Service",
        "    name: legacy",
        "",
      ].join("\n"),
    ]);
  });
});

describe("ReferenceGrants already there", () => {
  it("of two backends in other namespaces under RefNotPermitted, only the one without a grant is broken", async () => {
    const route = structuredClone(httpRouteCrossNs);
    (route.spec as { rules: { backendRefs: unknown[] }[] }).rules[1]!.backendRefs = [
      { group: "", kind: "Service", name: "api", namespace: "shared", port: 8080, weight: 1 },
    ];
    await openDetails(route);
    emitSnapshot(wb, await listWatch("ReferenceGrant"), [referenceGrant]);
    const legacy = document.querySelector<HTMLElement>("[data-rule='0']")!;
    const shared = document.querySelector<HTMLElement>("[data-rule='1']")!;
    await waitFor(() => expect(shared).not.toHaveClass("gw-rule--broken"));
    expect(shared).not.toHaveTextContent("not permitted");
    expect(legacy).toHaveClass("gw-rule--broken");
    expect(screen.getAllByRole("button", { name: "Copy ReferenceGrant YAML" })).toHaveLength(1);
    expect(within(legacy).getByRole("button", { name: "Copy ReferenceGrant YAML" })).toBeInTheDocument();
    // The grants are watched only in the backends' other namespaces.
    const spec = [...wb.specs.values()].find((s) => s.kind.kind === "ReferenceGrant");
    expect(spec?.namespaces).toEqual(["legacy", "shared"]);
  });

  it("a listener's certificate a grant permits gets no copy button; one without a grant does", async () => {
    const gw = structuredClone(gateway);
    const listener = (gw.spec as { listeners: { name: string; tls: { certificateRefs: unknown[] } }[] }).listeners[2]!;
    listener.tls.certificateRefs.push({ group: "", kind: "Secret", name: "shared-cert", namespace: "shared" });
    const grant: KubeObject = {
      apiVersion: "gateway.networking.k8s.io/v1beta1",
      kind: "ReferenceGrant",
      metadata: { name: "gateways-to-certs", namespace: "shared", uid: "rg-2" },
      spec: {
        from: [{ group: "gateway.networking.k8s.io", kind: "Gateway", namespace: "infra" }],
        to: [{ group: "", kind: "Secret" }],
      },
    };
    await openDetails(gw);
    emitSnapshot(wb, await listWatch("ReferenceGrant"), [grant]);
    const banner = within(section("gatewayApi"))
      .getByText("Listener https-shop: ResolvedRefs is False (RefNotPermitted)")
      .closest<HTMLElement>(".gw-problem")!;
    await waitFor(() => expect(within(banner).getAllByRole("button", { name: "Copy ReferenceGrant YAML" })).toHaveLength(1));
    expect(banner).toHaveTextContent("Needed in namespace shop for Secret shop/shop-tls");
    expect(banner).not.toHaveTextContent("shared-cert");
  });
});

describe("details of other kinds", () => {
  it("GRPCRoute: method matches", async () => {
    await openDetails(grpcRoute);
    expect(document.querySelector("[data-rule='0']")).toHaveTextContent(
      "method echo.v1.EchoService/Echo · header x-tenant=acme → echo:9000",
    );
  });

  it("TCPRoute: backends only, the parent explains why it is not accepted", async () => {
    await openDetails(tcpRoute);
    const details = within(section("gatewayApi"));
    expect(document.querySelector("[data-rule='0']")).toHaveTextContent("postgres:5432");
    expect(details.queryByRole("heading", { name: "Hostnames" })).toBeNull();
    expect(details.getByText("internal ✗ NotAllowedByListeners").closest(".gw-problem")).toHaveTextContent(
      "No listener of this Gateway lets the route attach",
    );
  });

  it("GatewayClass: controller, Accepted and the Gateways of the class", async () => {
    await openDetails(gatewayClass);
    const details = within(section("gatewayApi"));
    expect(details.getByText("gateway.envoyproxy.io/gatewayclass-controller")).toBeInTheDocument();
    emitSnapshot(wb, await listWatch("Gateway"), [gateway, gatewayInternal]);
    await waitFor(() =>
      expect(tableRows("Gateways of this class")).toEqual([
        ["internal", "infra", "172.18.0.201", "OK"],
        ["public-gw", "infra", "172.18.0.200", "ResolvedRefs: RefNotPermitted"],
      ]),
    );
  });

  it("a GatewayClass no controller took explains why", async () => {
    await openDetails(gatewayClassPending);
    expect(within(section("gatewayApi")).getByText("Accepted is Unknown (Pending)").closest(".gw-problem")).toHaveTextContent(
      "No controller has processed this yet",
    );
  });

  it("ReferenceGrant: from → to, readable", async () => {
    await openDetails(referenceGrant);
    const details = within(section("gatewayApi"));
    expect(
      details.getByText("HTTPRoute in namespace web may refer to Service (any), Secret shared-ca in namespace shared."),
    ).toBeInTheDocument();
    expect(
      details.getByText("GRPCRoute in namespace web may refer to Service (any), Secret shared-ca in namespace shared."),
    ).toBeInTheDocument();
  });
});

describe("the Policies page", () => {
  const trafficPolicy: KubeObject = {
    apiVersion: "gateway.envoyproxy.io/v1alpha1",
    kind: "BackendTrafficPolicy",
    metadata: { name: "api-retries", namespace: "web", uid: "btp-1" },
    spec: {
      targetRefs: [{ group: "gateway.networking.k8s.io", kind: "HTTPRoute", name: "api" }],
      retry: { numRetries: 3 },
    },
    status: {
      ancestors: [
        {
          ancestorRef: { group: "gateway.networking.k8s.io", kind: "Gateway", name: "public-gw", namespace: "infra" },
          controllerName: "gateway.envoyproxy.io/gatewayclass-controller",
          conditions: [{ type: "Accepted", status: "True", reason: "Accepted", message: "Policy has been accepted." }],
        },
        {
          ancestorRef: { group: "gateway.networking.k8s.io", kind: "Gateway", name: "internal", namespace: "infra" },
          controllerName: "gateway.envoyproxy.io/gatewayclass-controller",
          conditions: [{ type: "Accepted", status: "False", reason: "Conflicted", message: "Another policy targets it." }],
        },
      ],
    },
  };
  // A *Policy kind of another tool, without targetRefs: not an attached policy.
  const kyverno: KubeObject = {
    apiVersion: "kyverno.io/v1",
    kind: "ClusterPolicy",
    metadata: { name: "require-labels", uid: "kp-1" },
    spec: { rules: [] },
  };
  const TRAFFIC: KindRef = { group: "gateway.envoyproxy.io", version: "v1alpha1", kind: "BackendTrafficPolicy" };
  const KYVERNO: KindRef = { group: "kyverno.io", version: "v1", kind: "ClusterPolicy" };
  const TLS_POLICY = kindOf(backendTlsPolicy);

  it("is in the section's sidebar", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Gateway API"));
    fireEvent.click(screen.getByRole("button", { name: /Gateway API/ }));
    expect(screen.getByRole("button", { name: "Policies" })).toBeInTheDocument();
  });

  it("lists policies with targetRefs from every *Policy kind, targets as links", async () => {
    discovery = [...discovery, TLS_POLICY, TRAFFIC, KYVERNO];
    render(<PoliciesPage clusterId="c1" />);
    emitSnapshot(wb, await watchOf(wb, "BackendTLSPolicy"), [backendTlsPolicy]);
    emitSnapshot(wb, await watchOf(wb, "BackendTrafficPolicy"), [trafficPolicy]);
    emitSnapshot(wb, await watchOf(wb, "ClusterPolicy"), [kyverno]);
    const table = await screen.findByRole("table", { name: "Policies" });
    await waitFor(() => expect(screen.queryByText("Looking for policies…")).toBeNull());
    const rows = [...table.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
    expect(rows).toEqual([
      ["BackendTLSPolicy", "api-v2-tls", "web", "Service api-v2", "public-gw ✓"],
      ["BackendTrafficPolicy", "api-retries", "web", "HTTPRoute api", "public-gw ✓, internal ✗ Conflicted"],
    ]);
    fireEvent.click(within(table).getByRole("button", { name: "Open HTTPRoute api" }));
    expect(useAppStore.getState().details).toEqual(refTo(httpRoute));
    fireEvent.click(within(table).getByRole("button", { name: "Open BackendTrafficPolicy api-retries" }));
    expect(useAppStore.getState().details).toEqual({ kind: TRAFFIC, namespace: "web", name: "api-retries" });
  });

  it("says so when nothing attaches", async () => {
    render(<PoliciesPage clusterId="c1" />);
    expect(await screen.findByText("No policies attach to objects through targetRefs.")).toBeInTheDocument();
  });

  it("is not in the sidebar without the Gateway API", async () => {
    discovery = [...BUILT_IN, KYVERNO];
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Network"));
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(true));
    expect(sections()).not.toContain("Gateway API");
    expect(screen.queryByRole("button", { name: "Policies" })).toBeNull();
  });
});
