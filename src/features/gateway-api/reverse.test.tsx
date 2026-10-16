import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KindRef, KubeObject, ObjectRef, ResourceKind, WatchSpec } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { kindFromApiVersion, resetClusterKinds } from "../../resources";
import "../details";
import { emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import backendTlsPolicyJson from "./fixtures/backendtlspolicy.json";
import endpointSlicesJson from "./fixtures/endpointslices.json";
import gatewayInternalJson from "./fixtures/gateway-internal.json";
import gatewayJson from "./fixtures/gateway.json";
import grpcRouteJson from "./fixtures/grpcroute.json";
import httpRouteCrossNsJson from "./fixtures/httproute-crossns.json";
import httpRouteJson from "./fixtures/httproute.json";
import referenceGrantJson from "./fixtures/referencegrant.json";
import servicesJson from "./fixtures/services.json";
import tcpRouteJson from "./fixtures/tcproute.json";
import "./index";
import { hostnameIntersection, listenerAddresses } from "./exposure";
import { gatewayTopology, onlyProblems } from "./topology";

// Gateway API v1 objects with the status Envoy Gateway writes (the foundation's fixtures): public-gw (a listener whose
// certificate is in another namespace without a ReferenceGrant), internal, the HTTPRoute "api" accepted on public-gw
// and rejected by internal for its hostnames, "legacy-bridge" with a backend in another namespace, a GRPCRoute and a
// TCPRoute no listener of internal allows.
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
const apiV1 = services.find((s) => s.metadata?.name === "api-v1")!;
const apiV2 = services.find((s) => s.metadata?.name === "api-v2")!;

const legacyService: KubeObject = {
  apiVersion: "v1",
  kind: "Service",
  metadata: { name: "legacy", namespace: "legacy", uid: "svc-legacy" },
  spec: { type: "ClusterIP", ports: [{ port: 80 }], selector: { app: "legacy" } },
};

/** An Ingress (ingress-nginx) in web: shop.example.com/cart → api-v1 over TLS. */
const ingress: KubeObject = {
  apiVersion: "networking.k8s.io/v1",
  kind: "Ingress",
  metadata: { name: "shop", namespace: "web", uid: "ing-1" },
  spec: {
    ingressClassName: "nginx",
    tls: [{ hosts: ["shop.example.com"], secretName: "shop-example-tls" }],
    rules: [
      {
        host: "shop.example.com",
        http: {
          paths: [
            { path: "/cart", pathType: "Prefix", backend: { service: { name: "api-v1", port: { number: 8080 } } } },
            { path: "/", pathType: "Prefix", backend: { service: { name: "storefront", port: { number: 80 } } } },
          ],
        },
      },
    ],
  },
  status: { loadBalancer: { ingress: [{ ip: "172.18.0.210" }] } },
};

const tlsSecret = (name: string, namespace: string): KubeObject => ({
  apiVersion: "v1",
  kind: "Secret",
  type: "kubernetes.io/tls",
  metadata: { name, namespace, uid: `secret-${namespace}-${name}`, annotations: { "sextant.dev/values-hidden": "true" } },
  data: { "tls.crt": "", "tls.key": "" },
});

const kindOf = (obj: KubeObject): KindRef => kindFromApiVersion(obj.apiVersion ?? "", obj.kind ?? "");

const served = (kind: KindRef, namespaced = true): ResourceKind => ({
  kindRef: kind,
  plural: `${kind.kind.toLowerCase()}s`,
  namespaced,
  verbs: ["list", "watch"],
  printerColumns: [],
});

const INGRESS: KindRef = { group: "networking.k8s.io", version: "v1", kind: "Ingress" };
const BUILT_IN: KindRef[] = [
  { group: "", version: "v1", kind: "Pod" },
  { group: "", version: "v1", kind: "Service" },
  { group: "", version: "v1", kind: "Secret" },
  { group: "discovery.k8s.io", version: "v1", kind: "EndpointSlice" },
];
const GATEWAY_API: KindRef[] = [gateway, httpRoute, grpcRoute, tcpRoute, referenceGrant, backendTlsPolicy].map(kindOf);
const GATEWAY_CLASS: KindRef = { group: "gateway.networking.k8s.io", version: "v1", kind: "GatewayClass" };

let wb: WatchBackend;
let discovery: KindRef[];

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  discovery = [...BUILT_IN, INGRESS, GATEWAY_CLASS, ...GATEWAY_API];
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => discovery.map((k) => served(k, k.kind !== "GatewayClass")));
});

afterEach(() => {
  wb.backend.restore();
  resetClusterKinds();
});

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

const live = (match: (spec: WatchSpec) => boolean) => (spec: WatchSpec) =>
  spec.fieldSelector === null && spec.labelSelector === null && match(spec);
const all = () => true;
const inNs = (...namespaces: string[]) => (s: WatchSpec) => JSON.stringify(s.namespaces) === JSON.stringify(namespaces);

/** Emits a list to the live watch of `kind` that matches. */
async function list(kind: string, items: KubeObject[], match: (spec: WatchSpec) => boolean = all) {
  emitSnapshot(wb, await watchOf(wb, kind, live(match)), items);
}

function section(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-section='${id}']`);
  if (!el) throw new Error(`no section ${id}`);
  return el;
}

function rowsOf(table: HTMLElement): string[][] {
  return [...table.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent ?? ""));
}

/** Lets pending effects and watch starts run. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe("the model", () => {
  it("hostnameIntersection: exact, wildcard either way, none", () => {
    expect(hostnameIntersection(undefined, [])).toEqual([]);
    expect(hostnameIntersection(undefined, ["a.example.com"])).toEqual(["a.example.com"]);
    expect(hostnameIntersection("*.example.com", [])).toEqual(["*.example.com"]);
    expect(hostnameIntersection("*.example.com", ["api.example.com", "api.example.org", "a.b.example.com"])).toEqual([
      "api.example.com",
      "a.b.example.com",
    ]);
    expect(hostnameIntersection("shop.example.com", ["*.example.com"])).toEqual(["shop.example.com"]);
    expect(hostnameIntersection("*.example.com", ["example.com"])).toBeNull();
    expect(hostnameIntersection("*.internal.example.com", ["api.example.com"])).toBeNull();
  });

  it("listenerAddresses: scheme from the protocol, default ports left out, paths only for HTTP", () => {
    expect(listenerAddresses({ protocol: "HTTPS", port: 443 }, ["api.example.com"], ["/api"], "1.2.3.4")).toEqual([
      "https://api.example.com/api",
    ]);
    expect(listenerAddresses({ protocol: "HTTP", port: 8080 }, [], [], "1.2.3.4")).toEqual(["http://1.2.3.4:8080/"]);
    expect(listenerAddresses({ protocol: "TCP", port: 5432 }, [], ["/x"], undefined)).toEqual(["tcp://*:5432"]);
  });
});

describe("Exposed by, on a Service", () => {
  it("lists the routes reaching it, attached or not, and the Ingresses", async () => {
    await openDetails(apiV1);
    await list("HTTPRoute", [httpRoute, httpRouteCrossNs]);
    await list("GRPCRoute", [grpcRoute]);
    await list("TCPRoute", [tcpRoute]);
    // Only the namespace of the Gateways the routes name, only the Service's namespace for Ingresses.
    await list("Gateway", [gateway, gatewayInternal], inNs("infra"));
    await list("Ingress", [ingress], inNs("web"));
    const block = await within(section("gatewayExposedBy")).findByRole("table");
    expect(rowsOf(block)).toEqual([
      [
        // Each way in with the rest of its match and the Service's share of a split rule.
        "http://api.example.com/api · header x-env=prod · 10%" +
          "http://api.example.org/api · header x-env=prod · 10%" +
          "http://api.example.com/healthz · GET" +
          "http://api.example.org/healthz · GET",
        "HTTPRoute api",
        "infra/public-gw / http",
        "Serving",
      ],
      ["none", "HTTPRoute api", "infra/internal", "Not attached: NoMatchingListenerHostname"],
      ["http://legacy.example.com/", "HTTPRoute legacy-bridge", "infra/public-gw / http", "Serving"],
      ["https://shop.example.com/cart", "Ingress shop", "nginx", "Serving"],
    ]);
    // The rejected parent is explained, and every hop opens its details.
    const rejected = within(block).getByText("Not attached: NoMatchingListenerHostname");
    expect(rejected).toHaveClass("rt-status--danger");
    expect(rejected.closest("[title]")).toHaveAttribute("title", expect.stringContaining("None of the route's hostnames"));
    fireEvent.click(within(block).getAllByRole("button", { name: "Open HTTPRoute api" })[0]!);
    expect(useAppStore.getState().details).toEqual(refTo(httpRoute));
    fireEvent.click(within(block).getAllByRole("button", { name: "Open Gateway public-gw" })[0]!);
    expect(useAppStore.getState().details).toEqual(refTo(gateway));
    fireEvent.click(within(block).getByRole("button", { name: "Open Ingress shop" }));
    expect(useAppStore.getState().details).toEqual(refTo(ingress));
    // ReferenceGrants are not listed: every route reaching it is in its own namespace.
    expect([...wb.specs.values()].some((s) => s.kind.kind === "ReferenceGrant")).toBe(false);
  });

  it("a route in another namespace reaches it only if a ReferenceGrant in its namespace permits it", async () => {
    await openDetails(legacyService);
    await list("HTTPRoute", [httpRoute, httpRouteCrossNs]);
    await list("Gateway", [gateway], inNs("infra"));
    await list("ReferenceGrant", [], inNs("legacy"));
    const block = await within(section("gatewayExposedBy")).findByRole("table");
    expect(rowsOf(block)).toEqual([
      ["http://legacy.example.com/legacy", "HTTPRoute web/legacy-bridge", "infra/public-gw / http", "Not permitted: RefNotPermitted"],
    ]);
    const permit: KubeObject = {
      apiVersion: "gateway.networking.k8s.io/v1beta1",
      kind: "ReferenceGrant",
      metadata: { name: "allow-web", namespace: "legacy", uid: "rg-legacy" },
      spec: {
        from: [{ group: "gateway.networking.k8s.io", kind: "HTTPRoute", namespace: "web" }],
        to: [{ group: "", kind: "Service", name: "legacy" }],
      },
    };
    await list("ReferenceGrant", [permit], inNs("legacy"));
    await waitFor(() => expect(rowsOf(block)[0]?.[3]).toBe("Serving"));
  });

  it("is not there when nothing reaches the Service", async () => {
    await openDetails(apiV2);
    await list("HTTPRoute", [httpRouteCrossNs]);
    await list("Ingress", [ingress], inNs("web"));
    await settle();
    expect(section("gatewayExposedBy")).toBeEmptyDOMElement();
  });
});

describe("Used by listeners, on a TLS Secret", () => {
  it("lists the listeners using it, with their status", async () => {
    await openDetails(tlsSecret("shop-tls", "shop"));
    await list("Gateway", [gateway, gatewayInternal]);
    await list("ReferenceGrant", [], inNs("shop"));
    const block = await within(section("gatewaySecretUse")).findByRole("table");
    expect(rowsOf(block)).toEqual([
      ["infra/public-gw", "https-shop (443/HTTPS shop.example.org)", "Not permitted: no ReferenceGrant lets the Gateway use it"],
    ]);
    fireEvent.click(within(block).getByRole("button", { name: "Open Gateway public-gw" }));
    expect(useAppStore.getState().details).toEqual(refTo(gateway));
  });

  it("a certificate in the Gateway's namespace is fine", async () => {
    await openDetails(tlsSecret("example-com-tls", "infra"));
    await list("Gateway", [gateway, gatewayInternal]);
    const block = await within(section("gatewaySecretUse")).findByRole("table");
    expect(rowsOf(block)).toEqual([["public-gw", "https (443/HTTPS *.example.com)", "OK"]]);
  });

  it("a Secret that is not a TLS one watches nothing", async () => {
    await openDetails({ ...tlsSecret("db", "web"), type: "Opaque" });
    await settle();
    expect([...wb.specs.values()].some((s) => s.kind.kind === "Gateway")).toBe(false);
  });
});

describe("Policies attached", () => {
  it("shows the policies whose targetRefs name the object", async () => {
    await openDetails(apiV2);
    // Policy kinds are listed in the object's namespace only.
    await list("BackendTLSPolicy", [backendTlsPolicy], inNs("web"));
    const block = await within(section("gatewayPolicies")).findByRole("table");
    expect(rowsOf(block)).toEqual([["BackendTLSPolicy", "api-v2-tls", "whole object", "public-gw ✓"]]);
    fireEvent.click(within(block).getByRole("button", { name: "Open BackendTLSPolicy api-v2-tls" }));
    expect(useAppStore.getState().details).toEqual(refTo(backendTlsPolicy));
  });

  it("nothing for an object no policy names", async () => {
    await openDetails(apiV1);
    await list("BackendTLSPolicy", [backendTlsPolicy], inNs("web"));
    await settle();
    expect(section("gatewayPolicies")).toBeEmptyDOMElement();
  });
});

describe("without the Gateway API", () => {
  it("a Service or a TLS Secret opens no Gateway API, Ingress or policy watch", async () => {
    discovery = [...BUILT_IN];
    await openDetails(apiV1);
    await settle();
    await openDetails(tlsSecret("shop-tls", "shop"));
    await settle();
    const watched = [...wb.specs.values()].map((s) => s.kind);
    expect(watched.length).toBeGreaterThan(0);
    expect(
      watched.filter((k) => k.group === "gateway.networking.k8s.io" || k.kind === "Ingress" || k.kind.endsWith("Policy")),
    ).toEqual([]);
  });
});

// ---------- Topology ----------

const ROUTES = (extra: KubeObject[] = []) => [
  { kind: kindOf(httpRoute), items: [httpRoute, httpRouteCrossNs, ...extra] },
  { kind: kindOf(grpcRoute), items: [grpcRoute] },
  { kind: kindOf(tcpRoute), items: [tcpRoute] },
];

/** The tree as indented lines: "  kind name health reason". */
function outline(node: ReturnType<typeof gatewayTopology> | null, level = 0): string[] {
  if (!node) return [];
  const name =
    node.type === "listener"
      ? node.listener.name
      : node.type === "rule"
        ? `rule${node.rule.index + 1}`
        : node.type === "backend"
          ? `${node.mirror ? "mirror " : ""}${node.backend.name}`
          : node.type === "notAttached"
            ? "Not attached"
            : node.ref.name;
  const label = node.type === "rule" ? name : `${node.type} ${name}`;
  const line = `${"  ".repeat(level)}${label} ${node.health}${node.reason ? ` ${node.reason}` : ""}`;
  return [line, ...node.children.flatMap((c) => outline(c, level + 1))];
}

describe("the topology model", () => {
  const servicesIn = (ns: string) => new Set(services.filter((s) => s.metadata?.namespace === ns).map((s) => s.metadata?.name ?? ""));
  const readiness = (b: { namespace: string | null; name: string }) => {
    const slices = endpointSlices.filter((s) => (s.metadata?.labels as Record<string, string> | undefined)?.["kubernetes.io/service-name"] === b.name);
    if (slices.length === 0) return { ready: 0, total: 0 };
    const eps = slices.flatMap((s) => (s.endpoints as { conditions: { ready: boolean } }[]) ?? []);
    return { ready: eps.filter((e) => e.conditions.ready).length, total: eps.length };
  };

  it("Gateway → listeners (each one) → routes on them → rules → backends, with health and reasons", () => {
    const tree = gatewayTopology(gateway, { routes: ROUTES(), servicesIn, grantsIn: () => [], readiness });
    expect(outline(tree)).toEqual([
      // The Gateway is as healthy as its listeners: https-shop is broken.
      "gateway public-gw problem ListenersBroken",
      "  listener http ok",
      "    route api ok",
      // api-v1 has 1 of 2 pods ready.
      "      rule1 pending",
      "        backend api-v2 ok",
      "        backend api-v1 pending",
      "      rule2 pending",
      "        backend api-v1 pending",
      // The redirect answers itself: no backends needed.
      "      rule3 ok",
      "    route legacy-bridge problem RefNotPermitted",
      "      rule1 problem RefNotPermitted",
      "        backend legacy problem RefNotPermitted",
      "      rule2 pending",
      "        backend api-v1 pending",
      "  listener https ok",
      "    route echo ok",
      "      rule1 problem BackendNotFound",
      "        backend echo problem BackendNotFound",
      // A listener with no routes still appears.
      "  listener https-shop problem RefNotPermitted",
    ]);
  });

  it("routes the Gateway did not accept are gathered under Not attached, with the reason and no rules", () => {
    const tree = gatewayTopology(gatewayInternal, { routes: ROUTES(), servicesIn, grantsIn: () => [], readiness });
    expect(outline(tree).filter((l) => !l.startsWith("      "))).toEqual([
      "gateway internal ok",
      "  listener http ok",
      "  notAttached Not attached problem",
      "    route api problem NoMatchingListenerHostname",
      "    route postgres problem NotAllowedByListeners",
    ]);
    const group = tree.children.find((c) => c.type === "notAttached")!;
    expect(group.children.every((r) => r.children.length === 0)).toBe(true);
  });

  it("Only problems keeps the paths to broken nodes", () => {
    const tree = gatewayTopology(gateway, { routes: ROUTES(), servicesIn, grantsIn: () => [], readiness });
    expect(outline(onlyProblems(tree))).toEqual([
      "gateway public-gw problem ListenersBroken",
      "  listener http ok",
      "    route legacy-bridge problem RefNotPermitted",
      "      rule1 problem RefNotPermitted",
      "        backend legacy problem RefNotPermitted",
      "  listener https ok",
      "    route echo ok",
      "      rule1 problem BackendNotFound",
      "        backend echo problem BackendNotFound",
      "  listener https-shop problem RefNotPermitted",
    ]);
    expect(onlyProblems(gatewayTopology(gatewayInternal, { routes: [] }))).toBeNull();
  });
});

describe("the Topology tab of a Gateway", () => {
  it("draws the tree with health dots; nodes open details; Only problems narrows it", async () => {
    await openDetails(gateway);
    fireEvent.click(screen.getByRole("tab", { name: "Topology" }));
    await list("HTTPRoute", [httpRoute, httpRouteCrossNs]);
    await list("GRPCRoute", [grpcRoute]);
    await list("TCPRoute", [tcpRoute]);
    await list("Service", services, inNs("legacy", "web"));
    await list("EndpointSlice", endpointSlices, inNs("legacy", "web"));
    await list("ReferenceGrant", [], inNs("legacy"));
    const table = await screen.findByRole("table", { name: "Topology" });
    await waitFor(() => expect(screen.queryByText("Looking for routes…")).toBeNull());
    const rows = () => [...table.querySelectorAll("tbody tr")];
    const levels = rows().map((tr) => `${tr.getAttribute("aria-level")} ${tr.getAttribute("data-type")}`);
    expect(levels.slice(0, 5)).toEqual(["1 gateway", "2 listener", "3 route", "4 rule", "5 backend"]);
    expect(rowsOf(table)[4]).toEqual(["Service api-v2:8080 90%", "3/3 pods ready"]);
    const broken = rows().find((tr) => tr.textContent?.includes("legacy/legacy:80"))!;
    expect(broken).toHaveAttribute("data-health", "problem");
    expect(within(broken as HTMLElement).getByRole("img", { name: "Problem" })).toHaveClass("gw-dot--problem");
    expect(broken).toHaveTextContent("not permitted (RefNotPermitted)");
    // A listener without routes is a row too.
    expect(rowsOf(table).some(([node]) => node?.startsWith("Listener https-shop"))).toBe(true);

    fireEvent.click(within(table).getByRole("button", { name: "Open HTTPRoute legacy-bridge" }));
    expect(useAppStore.getState().details).toEqual(refTo(httpRouteCrossNs));
    fireEvent.click(within(table).getByRole("button", { name: "Open Service api-v2" }));
    expect(useAppStore.getState().details).toEqual(refTo(apiV2));

    fireEvent.click(screen.getByRole("checkbox", { name: "Only problems" }));
    expect(rowsOf(table).map(([node]) => node)).toEqual([
      "Gateway public-gw",
      "Listener http 80/HTTP",
      "HTTPRoute web/legacy-bridge legacy.example.com",
      "Rule 1 PathPrefix /legacy · rewrite prefix /",
      "Service legacy/legacy:80",
      "Listener https 443/HTTPS *.example.com",
      "GRPCRoute web/echo grpc.example.com",
      "Rule 1 method echo.v1.EchoService/Echo · header x-tenant=acme",
      "Service echo:9000",
      "Listener https-shop 443/HTTPS shop.example.org",
    ]);
  });
});
