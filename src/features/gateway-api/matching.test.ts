import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import endpointSlicesJson from "./fixtures/matching/endpointslices.json";
import gatewaysJson from "./fixtures/matching/gateways.json";
import grpcRoutesJson from "./fixtures/matching/grpcroutes.json";
import httpRoutesJson from "./fixtures/matching/httproutes.json";
import namespacesJson from "./fixtures/matching/namespaces.json";
import referenceGrantsJson from "./fixtures/matching/referencegrants.json";
import servicesJson from "./fixtures/matching/services.json";
import {
  explainRequest,
  hostnameMap,
  hostnameMatches,
  intersectHostnames,
  parseRequest,
  replacePathPrefix,
  type Candidate,
  type ClusterSnapshot,
  type RequestInput,
  type RouteId,
  type RouteKindName,
} from "./matching";

// The Gateway API fixtures of the kind test cluster (scripts/fixtures/gateway-api/*.yaml, with the status
// status.yaml writes): public-gw (http :80, https :443 shop.example.com for labelled namespaces) and internal-gw
// (http :8080 internal.shop.example.com, grpc :9090, https :8443 with a missing certificate, TLS passthrough); routes
// shop (weighted, header match), http-redirect, checkout (/checkout granted, /refunds RefNotPermitted),
// legacy-admin (BackendNotFound), payments-status (NotAllowedByListeners) and the GRPCRoute inventory.
const fixtures: ClusterSnapshot = {
  gateways: gatewaysJson as KubeObject[],
  httpRoutes: httpRoutesJson as KubeObject[],
  grpcRoutes: grpcRoutesJson as KubeObject[],
  services: servicesJson as KubeObject[],
  endpointSlices: endpointSlicesJson as KubeObject[],
  referenceGrants: referenceGrantsJson as KubeObject[],
  namespaces: namespacesJson as KubeObject[],
};

const route = (name: string, namespace = "gw-shop", kind: RouteKindName = "HTTPRoute"): RouteId => ({ kind, namespace, name });
const has = (candidates: Candidate[], expected: Partial<Candidate>) =>
  expect(candidates).toContainEqual(expect.objectContaining(expected));

describe("explainRequest on the test-cluster fixtures", () => {
  it("sends /api with x-env=prod through public-gw/https to the weighted shop rule", () => {
    const r = explainRequest(
      { url: "https://shop.example.com/api/items?page=2", headers: { "X-Env": "prod" } },
      fixtures,
    );
    expect(r.outcome).toBe("forwarded");
    expect(r.gateway).toEqual({ namespace: "gw-infra", name: "public-gw" });
    expect(r.listener?.name).toBe("https");
    expect(r.route).toEqual({ ...route("shop"), hostname: "shop.example.com" });
    expect(r.rule).toMatchObject({ index: 0, match: 0 });
    expect(r.rule?.phrases).toContainEqual({
      key: "gateway:text.header",
      params: { name: "x-env", op: "=", value: "prod" },
    });
    expect(r.filters).toEqual([
      {
        type: "RequestHeaderModifier",
        phrases: [{ key: "gateway:text.addHeader", params: { name: "x-gateway", value: "public" } }],
      },
    ]);
    expect(r.backends.map((b) => [b.name, b.percent, b.ready, b.total, b.issue])).toEqual([
      ["api-v2", 90, 2, 3, undefined],
      ["api-v1", 10, 1, 1, undefined],
    ]);
    // The catch-all rule of the same route matches too, but a longer prefix wins.
    has(r.candidates, { route: route("shop"), rule: 1, reason: "lowerPrecedence", lostOn: "path" });
    // checkout matches neither of its paths.
    has(r.candidates, { route: route("checkout"), rule: 0, reason: "pathMismatch" });
    // payments-status names the listener, but the controller refused it there.
    has(r.candidates, {
      level: "route",
      route: route("payments-status", "gw-payments"),
      reason: "notAccepted",
      condition: "NotAllowedByListeners",
    });
    // public-gw/http is on port 80; internal-gw has no listener on 443.
    has(r.candidates, { level: "listener", listener: "http", reason: "otherPort" });
    has(r.candidates, { level: "gateway", gateway: { namespace: "gw-infra", name: "internal-gw" }, reason: "noListenerMatched" });
    expect(r.notes).toEqual([]);
  });

  it.each<[string, RequestInput, Record<string, unknown>]>([
    [
      "/api without the header falls to the catch-all rule",
      { url: "https://shop.example.com/api/items" },
      { outcome: "forwarded", route: { ...route("shop"), hostname: "shop.example.com" }, rule: { index: 1, match: 0 } },
    ],
    [
      "/checkout goes to checkout through the ReferenceGrant",
      { url: "https://shop.example.com/checkout/cart" },
      { outcome: "forwarded", route: { ...route("checkout"), hostname: "shop.example.com" }, rule: { index: 0 } },
    ],
    [
      "POST /refunds reaches a backend no ReferenceGrant permits",
      { method: "post", url: "https://shop.example.com/refunds" },
      { outcome: "noBackend", status: 500, rule: { index: 1 } },
    ],
    [
      "plain HTTP is redirected to HTTPS by http-redirect",
      { url: "http://shop.example.com/cart?id=7" },
      {
        outcome: "redirected",
        status: 301,
        route: { ...route("http-redirect"), hostname: "shop.example.com" },
        redirect: { location: "https://shop.example.com/cart?id=7", statusCode: 301 },
      },
    ],
    [
      "legacy-admin is accepted, but its Service does not exist",
      { url: "http://internal.shop.example.com:8080/admin/users" },
      { outcome: "noBackend", status: 500, route: { ...route("legacy-admin"), hostname: "internal.shop.example.com" } },
    ],
    [
      "gRPC GetStock goes to the inventory GRPCRoute",
      { url: "http://grpc.internal.example.com:9090/inventory.v1.Inventory/GetStock", headers: { "content-type": "application/grpc" } },
      {
        outcome: "forwarded",
        listener: expect.objectContaining({ name: "grpc" }),
        route: { ...route("inventory", "gw-shop", "GRPCRoute"), hostname: "grpc.internal.example.com" },
        rule: { index: 0, match: 0, phrases: [{ key: "gateway:text.grpcMethod", params: { service: "inventory.v1.Inventory", method: "GetStock" } }] },
      },
    ],
    [
      "an unknown host on public-gw/https's port finds no listener",
      { url: "https://other.example.net/" },
      { outcome: "noListener" },
    ],
    ["a URL that cannot be read", { url: "http://" }, { outcome: "invalidUrl" }],
    ["an ftp URL", { url: "ftp://shop.example.com/" }, { outcome: "invalidUrl" }],
  ])("%s", (_, input, expected) => {
    expect(explainRequest(input, fixtures)).toMatchObject(expected);
  });

  it("marks the backend that no ReferenceGrant permits and the one that is missing", () => {
    const refunds = explainRequest({ method: "POST", url: "https://shop.example.com/refunds" }, fixtures);
    expect(refunds.backends).toEqual([expect.objectContaining({ name: "refunds-api", namespace: "gw-payments", issue: "RefNotPermitted" })]);
    const admin = explainRequest({ url: "http://internal.shop.example.com:8080/admin" }, fixtures);
    expect(admin.backends).toEqual([expect.objectContaining({ name: "legacy-ui", issue: "BackendNotFound", ready: 0, total: 0 })]);
    // GET /refunds does not match the POST rule.
    const get = explainRequest({ url: "https://shop.example.com/refunds" }, fixtures);
    has(get.candidates, { route: route("checkout"), rule: 1, reason: "methodMismatch" });
    expect(get.route?.name).toBe("shop");
  });

  it("a gRPC call to another method finds no rule: UNIMPLEMENTED, not a 404", () => {
    const r = explainRequest(
      { url: "http://grpc.internal.example.com:9090/inventory.v1.Inventory/Reserve", protocol: "grpc" },
      fixtures,
    );
    expect(r).toMatchObject({ outcome: "noRoute", grpcStatus: "UNIMPLEMENTED" });
    expect(r.status).toBeUndefined();
    has(r.candidates, { route: route("inventory", "gw-shop", "GRPCRoute"), reason: "grpcMethodMismatch" });
  });

  it("a route the listener refused is skipped with the controller's reason", () => {
    const r = explainRequest({ url: "http://internal.shop.example.com:8080/" }, fixtures);
    expect(r).toMatchObject({ outcome: "noRoute", status: 404, listener: expect.objectContaining({ name: "http" }) });
    has(r.candidates, { route: route("shop"), reason: "notAccepted", condition: "NoMatchingListenerHostname" });
    has(r.candidates, { route: route("legacy-admin"), reason: "pathMismatch" });
  });

  it("a listener whose certificate does not resolve takes nothing", () => {
    const r = explainRequest({ url: "https://admin.internal.example.com:8443/" }, fixtures);
    expect(r.outcome).toBe("noListener");
    has(r.candidates, { level: "listener", listener: "https", reason: "listenerNotReady", condition: "InvalidCertificateRef" });
  });

  it("a Gateway address in the URL with a Host header picks that Gateway", () => {
    const r = explainRequest(
      { url: "http://172.18.255.201:8080/admin", headers: { Host: "internal.shop.example.com:8080" } },
      fixtures,
    );
    expect(r.gateway?.name).toBe("internal-gw");
    expect(r.route?.name).toBe("legacy-admin");
    has(r.candidates, { level: "gateway", gateway: { namespace: "gw-infra", name: "public-gw" }, reason: "otherAddress" });
  });
});

// ---------- Synthetic objects for the spec's precedence rules ----------

const TS = "2026-10-14T09:00:00Z";
const ok = (type: string) => ({ type, status: "True", reason: type, lastTransitionTime: TS });

interface ListenerSpec {
  name: string;
  port?: number;
  protocol?: string;
  hostname?: string;
  allowedRoutes?: object;
}

function gateway(listeners: ListenerSpec[], name = "gw", addresses: string[] = []): KubeObject {
  return {
    apiVersion: "gateway.networking.k8s.io/v1",
    kind: "Gateway",
    metadata: { name, namespace: "infra", creationTimestamp: TS },
    spec: {
      gatewayClassName: "eg",
      listeners: listeners.map((l) => ({ port: 80, protocol: "HTTP", allowedRoutes: { namespaces: { from: "All" } }, ...l })),
    },
    status: {
      addresses: addresses.map((value) => ({ type: "IPAddress", value })),
      conditions: [ok("Accepted"), ok("Programmed")],
      listeners: listeners.map((l) => ({
        name: l.name,
        attachedRoutes: 1,
        supportedKinds: [
          { group: "gateway.networking.k8s.io", kind: "HTTPRoute" },
          { group: "gateway.networking.k8s.io", kind: "GRPCRoute" },
        ],
        conditions: [ok("Accepted"), ok("Programmed"), ok("ResolvedRefs")],
      })),
    },
  };
}

interface RouteOptions {
  hostnames?: string[];
  created?: string;
  namespace?: string;
  sectionName?: string;
  gateway?: string;
  /** A refusal reason; accepted when absent. */
  refused?: string;
  kind?: "HTTPRoute" | "GRPCRoute";
}

function httpRoute(name: string, rules: unknown[], o: RouteOptions = {}): KubeObject {
  const parentRef = {
    group: "gateway.networking.k8s.io",
    kind: "Gateway",
    name: o.gateway ?? "gw",
    namespace: "infra",
    ...(o.sectionName ? { sectionName: o.sectionName } : {}),
  };
  return {
    apiVersion: "gateway.networking.k8s.io/v1",
    kind: o.kind ?? "HTTPRoute",
    metadata: { name, namespace: o.namespace ?? "web", creationTimestamp: o.created ?? TS },
    spec: { parentRefs: [parentRef], ...(o.hostnames ? { hostnames: o.hostnames } : {}), rules },
    status: {
      parents: [
        {
          parentRef,
          controllerName: "gateway.envoyproxy.io/gatewayclass-controller",
          conditions: [
            o.refused
              ? { type: "Accepted", status: "False", reason: o.refused, lastTransitionTime: TS }
              : ok("Accepted"),
            ok("ResolvedRefs"),
          ],
        },
      ],
    },
  };
}

const backend = (name: string) => ({ backendRefs: [{ name, port: 8080 }] });
const prefix = (value: string, extra: object = {}) => ({ path: { type: "PathPrefix", value }, ...extra });
const exact = (value: string, extra: object = {}) => ({ path: { type: "Exact", value }, ...extra });
const rule = (matches: unknown[], to: string) => ({ matches, ...backend(to) });

const oneGateway = [gateway([{ name: "http" }])];

/** The backend the request reaches and the criterion the other matching candidate lost on. */
function winner(routes: KubeObject[], input: RequestInput, gateways = oneGateway) {
  const r = explainRequest(input, { gateways, httpRoutes: routes.filter((x) => x.kind === "HTTPRoute"), grpcRoutes: routes.filter((x) => x.kind === "GRPCRoute") });
  return {
    to: r.backends.map((b) => b.name).join(","),
    lostOn: r.candidates.filter((c) => c.reason === "lowerPrecedence").map((c) => c.lostOn),
    r,
  };
}

describe("HTTPRoute matching precedence", () => {
  it.each<[string, KubeObject[], RequestInput, string, string[]]>([
    [
      "Exact path beats a PathPrefix of the same path",
      [httpRoute("a", [rule([prefix("/foo")], "prefix")]), httpRoute("b", [rule([exact("/foo")], "exact")])],
      { url: "http://x.test/foo" },
      "exact",
      ["path"],
    ],
    [
      "the longest PathPrefix wins",
      [httpRoute("a", [rule([prefix("/foo")], "short"), rule([prefix("/foo/bar")], "long")])],
      { url: "http://x.test/foo/bar/baz" },
      "long",
      ["path"],
    ],
    [
      "PathPrefix matches whole elements: /foo does not take /foobar",
      [httpRoute("a", [rule([prefix("/foo")], "foo"), rule([prefix("/")], "root")])],
      { url: "http://x.test/foobar" },
      "root",
      [],
    ],
    [
      "a trailing slash of the prefix is ignored",
      [httpRoute("a", [rule([prefix("/foo/")], "foo")])],
      { url: "http://x.test/foo" },
      "foo",
      [],
    ],
    [
      "a method match beats none",
      [httpRoute("a", [rule([prefix("/api")], "any"), rule([prefix("/api", { method: "GET" })], "get")])],
      { url: "http://x.test/api" },
      "get",
      ["method"],
    ],
    [
      "more header matches win",
      [
        httpRoute("a", [
          rule([prefix("/", { headers: [{ name: "x-a", value: "1" }] })], "one"),
          rule([prefix("/", { headers: [{ name: "x-a", value: "1" }, { name: "X-B", value: "2" }] })], "two"),
        ]),
      ],
      { url: "http://x.test/", headers: { "x-a": "1", "x-b": "2" } },
      "two",
      ["headers"],
    ],
    [
      "more query params win",
      [httpRoute("a", [rule([prefix("/")], "none"), rule([prefix("/", { queryParams: [{ name: "v", value: "2" }] })], "query")])],
      { url: "http://x.test/?v=2" },
      "query",
      ["queryParams"],
    ],
    [
      "on a tie the oldest route wins",
      [
        httpRoute("a", [rule([prefix("/")], "newer")], { created: "2026-10-14T10:00:00Z" }),
        httpRoute("b", [rule([prefix("/")], "older")], { created: "2026-10-14T09:00:00Z" }),
      ],
      { url: "http://x.test/" },
      "older",
      ["age"],
    ],
    [
      "then the first by {namespace}/{name}",
      [httpRoute("b", [rule([prefix("/")], "web-b")]), httpRoute("z", [rule([prefix("/")], "apps-z")], { namespace: "apps" })],
      { url: "http://x.test/" },
      "apps-z",
      ["name"],
    ],
    [
      "then the first rule of the route",
      [httpRoute("a", [rule([prefix("/")], "first"), rule([prefix("/")], "second")])],
      { url: "http://x.test/" },
      "first",
      ["ruleOrder"],
    ],
    [
      "precedence holds across rules of different routes: a younger route's longer prefix wins",
      [
        httpRoute("old", [rule([prefix("/")], "old")], { created: "2026-10-01T00:00:00Z" }),
        httpRoute("new", [rule([prefix("/api")], "new")], { created: "2026-10-14T00:00:00Z" }),
      ],
      { url: "http://x.test/api/v1" },
      "new",
      ["path"],
    ],
    [
      "a RegularExpression path ranks above any PathPrefix (Envoy Gateway's order)",
      [httpRoute("a", [rule([prefix("/api/v1")], "prefix"), rule([{ path: { type: "RegularExpression", value: "/api/.*" } }], "regex")])],
      { url: "http://x.test/api/v1" },
      "regex",
      ["path"],
    ],
    [
      "… and below an Exact path",
      [httpRoute("a", [rule([{ path: { type: "RegularExpression", value: "/api/.*" } }], "regex"), rule([exact("/api/v1")], "exact")])],
      { url: "http://x.test/api/v1" },
      "exact",
      ["path"],
    ],
    [
      "PathPrefix /foo/ and /foo are the same prefix: the older route wins",
      [
        httpRoute("slash", [rule([prefix("/foo/")], "slash")], { created: "2026-10-14T10:00:00Z" }),
        httpRoute("bare", [rule([prefix("/foo")], "bare")], { created: "2026-10-14T09:00:00Z" }),
      ],
      { url: "http://x.test/foo/bar" },
      "bare",
      ["age"],
    ],
    [
      "the URL's host is the host header of a header match",
      [httpRoute("a", [rule([prefix("/")], "any"), rule([prefix("/", { headers: [{ name: "Host", value: "x.test" }] })], "host")])],
      { url: "http://x.test/" },
      "host",
      ["headers"],
    ],
    [
      "query parameters are compared raw: x+y is not \"x y\"",
      [
        httpRoute("a", [
          rule([prefix("/")], "none"),
          rule([prefix("/", { queryParams: [{ name: "q", value: "x y" }] })], "decoded"),
          rule([prefix("/", { queryParams: [{ name: "q", value: "x+y" }] })], "raw"),
        ]),
      ],
      { url: "http://x.test/?q=x+y" },
      "raw",
      ["queryParams"],
    ],
    [
      "an exact hostname beats a wildcard hostname, whatever the paths",
      [
        httpRoute("wild", [rule([exact("/x")], "wild")], { hostnames: ["*.example.com"] }),
        httpRoute("exact", [rule([prefix("/")], "exact")], { hostnames: ["foo.example.com"] }),
      ],
      { url: "http://foo.example.com/x" },
      "exact",
      ["hostname"],
    ],
    [
      "a longer wildcard hostname beats a shorter one",
      [
        httpRoute("short", [rule([exact("/x")], "short")], { hostnames: ["*.example.com"] }),
        httpRoute("long", [rule([prefix("/")], "long")], { hostnames: ["*.foo.example.com"] }),
      ],
      { url: "http://a.foo.example.com/x" },
      "long",
      ["hostnameLength"],
    ],
  ])("%s", (_, routes, input, to, lostOn) => {
    const w = winner(routes, input);
    expect(w.to).toBe(to);
    expect(w.lostOn).toEqual(lostOn);
  });

  it("notes that a RegularExpression path's precedence is implementation-specific", () => {
    const { r } = winner(
      [httpRoute("a", [rule([{ path: { type: "RegularExpression", value: "/api/v[0-9]+" } }], "regex")])],
      { url: "http://x.test/api/v2" },
    );
    expect(r.backends.map((b) => b.name)).toEqual(["regex"]);
    expect(r.notes).toEqual(expect.arrayContaining(["regexPathPrecedence", "regexDialect"]));
  });

  it("reports the header, query parameter and invalid pattern that did not match", () => {
    const { r } = winner(
      [
        httpRoute("a", [
          rule([prefix("/", { headers: [{ name: "X-Env", value: "prod" }] })], "h"),
          rule([prefix("/", { queryParams: [{ name: "debug", type: "RegularExpression", value: "1|true" }] })], "q"),
          rule([{ path: { type: "RegularExpression", value: "(" } }], "bad"),
        ]),
      ],
      { url: "http://x.test/?debug=yes", headers: { "x-env": "dev" } },
    );
    expect(r.outcome).toBe("noRoute");
    has(r.candidates, { rule: 0, match: 0, reason: "headerMismatch", field: "x-env" });
    has(r.candidates, { rule: 1, match: 0, reason: "queryMismatch", field: "debug" });
    has(r.candidates, { rule: 2, match: 0, reason: "invalidRegex", field: "(" });
  });

  it("a rule without matches takes every path; the default match is reported", () => {
    const { r } = winner([httpRoute("a", [backend("all")])], { url: "http://x.test/anything" });
    expect(r.rule).toEqual({ index: 0, phrases: [{ key: "gateway:text.path", params: { type: "PathPrefix", value: "/" } }] });
  });
});

describe("listener selection", () => {
  const gateways = [
    gateway([
      { name: "any" },
      { name: "wild", hostname: "*.example.com" },
      { name: "wild-foo", hostname: "*.foo.example.com" },
      { name: "exact", hostname: "foo.example.com" },
      { name: "tls", port: 443, protocol: "HTTPS", hostname: "foo.example.com" },
    ]),
  ];
  const all = [httpRoute("r", [backend("svc")])];

  it.each([
    ["foo.example.com", "exact"],
    ["bar.example.com", "wild"],
    ["a.b.example.com", "wild"],
    ["a.foo.example.com", "wild-foo"],
    ["example.com", "any"],
    ["example.net", "any"],
  ])("%s → %s", (host, listener) => {
    const { r } = winner(all, { url: `http://${host}/` }, gateways);
    expect(r.listener?.name).toBe(listener);
  });

  it("the less specific listeners that also match lose, the others say why", () => {
    const { r } = winner(all, { url: "http://foo.example.com/" }, gateways);
    has(r.candidates, { level: "listener", listener: "wild", reason: "lessSpecificListener" });
    has(r.candidates, { level: "listener", listener: "any", reason: "lessSpecificListener" });
    has(r.candidates, { level: "listener", listener: "wild-foo", reason: "otherHostname" });
    has(r.candidates, { level: "listener", listener: "tls", reason: "otherPort" });
  });

  it("https on port 80 does not fit an HTTP listener", () => {
    const { r } = winner(all, { url: "https://foo.example.com:80/" }, gateways);
    expect(r.outcome).toBe("noListener");
    has(r.candidates, { level: "listener", listener: "exact", reason: "otherProtocol" });
  });

  it("route hostnames are cut to the listener's; outside hostnames do not count", () => {
    const wildOnly = [gateway([{ name: "wild", hostname: "*.example.com" }])];
    const routes = [httpRoute("r", [backend("svc")], { hostnames: ["test.example.com", "test.example.net"] })];
    expect(winner(routes, { url: "http://test.example.com/" }, wildOnly).to).toBe("svc");
    const other = winner(routes, { url: "http://test.example.net/" }, wildOnly).r;
    expect(other.outcome).toBe("noListener");
    const elsewhere = winner(routes, { url: "http://other.example.com/" }, wildOnly).r;
    expect(elsewhere.outcome).toBe("noRoute");
    has(elsewhere.candidates, { level: "route", route: route("r", "web"), reason: "otherHost" });
    const disjoint = winner([httpRoute("r", [backend("svc")], { hostnames: ["example.org"] })], { url: "http://a.example.com/" }, wildOnly).r;
    has(disjoint.candidates, { level: "route", reason: "noHostnameIntersection" });
  });

  it("a route attached to another listener of the Gateway is skipped", () => {
    const two = [gateway([{ name: "a", hostname: "a.test" }, { name: "b", hostname: "b.test" }])];
    const { r } = winner([httpRoute("r", [backend("svc")], { sectionName: "b" })], { url: "http://a.test/" }, two);
    expect(r.outcome).toBe("noRoute");
    has(r.candidates, { level: "route", listener: "a", reason: "notAttached" });
  });

  it("a GRPCRoute does not serve a plain HTTP request; a gRPC request prefers it to an HTTPRoute", () => {
    const routes = [
      httpRoute("web", [rule([prefix("/")], "http")]),
      httpRoute("rpc", [{ matches: [{ method: { service: "pkg.Svc" } }], ...backend("grpc") }], { kind: "GRPCRoute" }),
    ];
    const plain = winner(routes, { url: "http://x.test/pkg.Svc/Get" });
    expect(plain.to).toBe("http");
    has(plain.r.candidates, { route: route("rpc", "web", "GRPCRoute"), reason: "otherRouteKind" });
    const grpc = winner(routes, { url: "http://x.test/pkg.Svc/Get", headers: { "Content-Type": "application/grpc+proto" } });
    expect(grpc.to).toBe("grpc");
    expect(grpc.lostOn).toEqual(["routeKind"]);
    expect(grpc.r.notes).toContain("routeKindPrecedence");
    expect(plain.r.notes).not.toContain("routeKindPrecedence");
  });

  it("gRPC: the hostname decides before the route kind", () => {
    const routes = [
      httpRoute("web", [rule([prefix("/")], "http")], { hostnames: ["grpc.example.com"] }),
      httpRoute("rpc", [{ matches: [{ method: { service: "pkg.Svc" } }], ...backend("grpc") }], {
        kind: "GRPCRoute",
        hostnames: ["*.example.com"],
      }),
    ];
    const w = winner(routes, { url: "http://grpc.example.com/pkg.Svc/Get", protocol: "grpc" });
    expect(w.to).toBe("http");
    expect(w.lostOn).toEqual(["hostname"]);
    expect(w.r.notes).not.toContain("routeKindPrecedence");
  });

  it("gRPC: a GRPCRoute rule without usable backends answers UNAVAILABLE, not 500", () => {
    const routes = [httpRoute("rpc", [{ matches: [{ method: { service: "pkg.Svc" } }] }], { kind: "GRPCRoute" })];
    const { r } = winner(routes, { url: "http://x.test/pkg.Svc/Get", protocol: "grpc" });
    expect(r).toMatchObject({ outcome: "noBackend", grpcStatus: "UNAVAILABLE" });
    expect(r.status).toBeUndefined();
  });

  it("gRPC: a matching service and method beat a matching service only", () => {
    const routes = [
      httpRoute("svc", [{ matches: [{ method: { service: "pkg.Svc" } }], ...backend("service") }], { kind: "GRPCRoute" }),
      httpRoute("m", [{ matches: [{ method: { service: "pkg.Svc", method: "Get" } }], ...backend("method") }], { kind: "GRPCRoute" }),
    ];
    const w = winner(routes, { url: "http://x.test/pkg.Svc/Get", protocol: "grpc" });
    expect(w.to).toBe("method");
    expect(w.lostOn).toEqual(["grpcMethod"]);
  });

  it("several Gateways able to take the request: the one with a route wins, with a note", () => {
    const gws = [gateway([{ name: "http" }], "a-gw"), gateway([{ name: "http" }], "b-gw")];
    const { r } = winner([httpRoute("r", [backend("svc")], { gateway: "b-gw" })], { url: "http://x.test/" }, gws);
    expect(r.gateway?.name).toBe("b-gw");
    expect(r.notes).toContain("severalGateways");
    has(r.candidates, { level: "gateway", gateway: { namespace: "infra", name: "a-gw" }, reason: "noRouteMatched" });
  });
});

describe("allowedRoutes and parentRefs", () => {
  // infra/gw: admin.example.com admits routes of its own namespace only, public any.
  const gws = [
    gateway([
      { name: "admin", hostname: "admin.example.com", allowedRoutes: { namespaces: { from: "Same" } } },
      { name: "public", allowedRoutes: { namespaces: { from: "All" } } },
    ]),
  ];
  const r1 = httpRoute("r1", [backend("svc")], { namespace: "app" });

  it("Accepted on a parentRef without sectionName does not attach the route to a listener of another namespace", () => {
    const admin = winner([r1], { url: "http://admin.example.com/" }, gws).r;
    expect(admin).toMatchObject({ outcome: "noRoute", status: 404, listener: expect.objectContaining({ name: "admin" }) });
    has(admin.candidates, { level: "route", listener: "admin", route: route("r1", "app"), reason: "namespaceNotAllowed" });
    expect(winner([r1], { url: "http://www.example.com/" }, gws).to).toBe("svc");
    // The same route in the Gateway's namespace is admitted by `Same`.
    expect(winner([httpRoute("r1", [backend("svc")], { namespace: "infra" })], { url: "http://admin.example.com/" }, gws).to).toBe("svc");
    // The hostname map lists it on the public listener only.
    expect(hostnameMap(gws, { httpRoutes: [r1] }).map((row) => row.listener)).toEqual(["public"]);
  });

  it("Selector: decided by the namespaces' labels, or admitted with a note when they are unknown", () => {
    const selector = [
      gateway([{ name: "http", allowedRoutes: { namespaces: { from: "Selector", selector: { matchLabels: { shared: "true" } } } } }]),
    ];
    const ns = (name: string, labels: Record<string, string> = {}): KubeObject => ({ apiVersion: "v1", kind: "Namespace", metadata: { name, labels } });
    const input = { url: "http://x.test/" };
    const explain = (namespaces?: KubeObject[]) => explainRequest(input, { gateways: selector, httpRoutes: [r1], ...(namespaces ? { namespaces } : {}) });
    expect(explain([ns("app", { shared: "true" })])).toMatchObject({ outcome: "forwarded", notes: [] });
    const refused = explain([ns("app")]);
    expect(refused.outcome).toBe("noRoute");
    has(refused.candidates, { reason: "namespaceNotAllowed" });
    const unknown = explain();
    expect(unknown.outcome).toBe("forwarded");
    expect(unknown.notes).toContain("namespaceSelectorUnknown");
    expect(hostnameMap(selector, { httpRoutes: [r1], namespaces: [ns("app")] })).toEqual([]);
  });

  it("allowedRoutes.kinds compares the group too", () => {
    const foreign = [gateway([{ name: "http", allowedRoutes: { namespaces: { from: "All" }, kinds: [{ group: "example.com", kind: "HTTPRoute" }] } }])];
    const { r } = winner([r1], { url: "http://x.test/" }, foreign);
    expect(r.outcome).toBe("noRoute");
    has(r.candidates, { reason: "kindNotAllowed" });
  });

  it("parentRefs {gw, sectionName: a} and {gw}: the entry naming the listener speaks for it", () => {
    const two = [gateway([{ name: "a", hostname: "a.test" }, { name: "b", hostname: "b.test" }])];
    const ref = (sectionName?: string) => ({
      group: "gateway.networking.k8s.io",
      kind: "Gateway",
      name: "gw",
      namespace: "infra",
      ...(sectionName ? { sectionName } : {}),
    });
    const parent = (sectionName: string | undefined, accepted: boolean) => ({
      parentRef: ref(sectionName),
      controllerName: "gateway.envoyproxy.io/gatewayclass-controller",
      conditions: [accepted ? ok("Accepted") : { type: "Accepted", status: "False", reason: "NotAllowedByListeners", lastTransitionTime: TS }],
    });
    const withParents = (order: "specificFirst" | "broadFirst"): KubeObject => {
      const parents = [parent("a", false), parent(undefined, true)];
      const list = order === "specificFirst" ? parents : [...parents].reverse();
      return {
        apiVersion: "gateway.networking.k8s.io/v1",
        kind: "HTTPRoute",
        metadata: { name: "r", namespace: "web", creationTimestamp: TS },
        spec: { parentRefs: list.map((p) => p.parentRef), rules: [backend("svc")] },
        status: { parents: list },
      };
    };
    for (const order of ["specificFirst", "broadFirst"] as const) {
      const routes = [withParents(order)];
      const onA = winner(routes, { url: "http://a.test/" }, two).r;
      expect(onA.outcome).toBe("noRoute");
      has(onA.candidates, { listener: "a", reason: "notAccepted", condition: "NotAllowedByListeners" });
      expect(winner(routes, { url: "http://b.test/" }, two).to).toBe("svc");
    }
  });
});

describe("filters", () => {
  it("a redirect keeps the request's host and path and leaves out a well-known port", () => {
    const gws = [gateway([{ name: "http", port: 8080 }])];
    const redirect = (requestRedirect: object, match: object = prefix("/")) =>
      httpRoute("r", [{ matches: [match], filters: [{ type: "RequestRedirect", requestRedirect }] }]);
    const location = (rr: object, url: string, match?: object) =>
      winner([redirect(rr, match)], { url }, gws).r.redirect?.location;
    expect(location({ scheme: "https" }, "http://x.test:8080/a?b=1")).toBe("https://x.test/a?b=1");
    expect(location({ hostname: "y.test" }, "http://x.test:8080/a")).toBe("http://y.test:8080/a");
    expect(location({ port: 80 }, "http://x.test:8080/a")).toBe("http://x.test/a");
    expect(location({ path: { type: "ReplacePrefixMatch", replacePrefixMatch: "/new" } }, "http://x.test:8080/old/a", prefix("/old"))).toBe(
      "http://x.test:8080/new/a",
    );
    expect(location({ path: { type: "ReplaceFullPath", replaceFullPath: "/" } }, "http://x.test:8080/old/a")).toBe("http://x.test:8080/");
    expect(winner([redirect({})], { url: "http://x.test:8080/" }, gws).r.status).toBe(302);
  });

  it("a rewrite is reported with the path it produces", () => {
    const { r } = winner(
      [
        httpRoute("r", [
          {
            matches: [prefix("/shop")],
            filters: [{ type: "URLRewrite", urlRewrite: { hostname: "internal.test", path: { type: "ReplacePrefixMatch", replacePrefixMatch: "/" } } }],
            ...backend("svc"),
          },
        ]),
      ],
      { url: "http://x.test/shop/cart" },
    );
    expect(r.rewrite).toEqual({ hostname: "internal.test", path: "/cart" });
    expect(r.outcome).toBe("forwarded");
  });

  it("a rule without backends answers 500; backends with weight 0 too", () => {
    expect(winner([httpRoute("r", [{ matches: [prefix("/")] }])], { url: "http://x.test/" }).r).toMatchObject({ outcome: "noBackend", status: 500 });
    const zero = httpRoute("r", [{ matches: [prefix("/")], backendRefs: [{ name: "a", port: 80, weight: 0 }] }]);
    expect(winner([zero], { url: "http://x.test/" }).r.outcome).toBe("noBackend");
  });
});

describe("helpers", () => {
  // The spec's ReplacePrefixMatch table.
  it.each([
    ["/foo/bar", "/foo", "/xyz", "/xyz/bar"],
    ["/foo/bar", "/foo", "/xyz/", "/xyz/bar"],
    ["/foo/bar", "/foo/", "/xyz", "/xyz/bar"],
    ["/foo/bar", "/foo/", "/xyz/", "/xyz/bar"],
    ["/foo", "/foo", "/xyz", "/xyz"],
    ["/foo/", "/foo", "/xyz", "/xyz/"],
    ["/foo/bar", "/foo", "", "/bar"],
    ["/foo/", "/foo", "", "/"],
    ["/foo", "/foo", "", "/"],
    ["/foo/", "/foo", "/", "/"],
    ["/foo", "/foo", "/", "/"],
  ])("replacePathPrefix(%s, %s, %s) = %s", (path, p, r, out) => {
    expect(replacePathPrefix(path, p, r)).toBe(out);
  });

  it.each<[string | undefined, string, boolean]>([
    ["*.example.com", "test.example.com", true],
    ["*.example.com", "foo.test.example.com", true],
    ["*.example.com", "example.com", false],
    ["*.example.com", "test.example.net", false],
    ["foo.example.com", "foo.example.com", true],
    ["Foo.Example.com", "foo.example.com", true],
    [undefined, "anything.test", true],
  ])("hostnameMatches(%s, %s) = %s", (pattern, host, out) => {
    expect(hostnameMatches(pattern, host)).toBe(out);
  });

  it.each<[string, string | undefined, string | undefined]>([
    ["test.example.com", "test.example.com", "test.example.com"],
    ["*.example.com", "test.example.com", "test.example.com"],
    ["test.example.com", "*.example.com", "test.example.com"],
    ["foo.test.example.com", "*.example.com", "foo.test.example.com"],
    ["example.com", "*.example.com", undefined],
    ["test.example.net", "*.example.com", undefined],
    ["*.foo.example.com", "*.example.com", "*.foo.example.com"],
    ["*.example.com", "*.foo.example.com", "*.foo.example.com"],
    ["*.example.org", "*.example.com", undefined],
    ["a.test", undefined, "a.test"],
  ])("intersectHostnames(%s, %s) = %s", (r, l, out) => {
    expect(intersectHostnames(r, l)).toBe(out);
  });

  it("parses the request: Host header, default port, query, gRPC path", () => {
    expect(
      parseRequest({
        url: "shop.example.com/inventory.v1.Inventory/GetStock?x=1&x=2",
        headers: { Host: "Other.Example.com:8443", "Content-Type": "application/grpc" },
      }),
    ).toEqual({
      scheme: "http",
      protocol: "grpc",
      method: "POST",
      host: "other.example.com",
      urlHost: "shop.example.com",
      port: 80,
      path: "/inventory.v1.Inventory/GetStock",
      search: "?x=1&x=2",
      headers: [
        ["host", "Other.Example.com:8443"],
        ["content-type", "application/grpc"],
      ],
      query: [
        ["x", "1"],
        ["x", "2"],
      ],
      grpc: { service: "inventory.v1.Inventory", method: "GetStock" },
    });
  });
});

describe("hostnameMap", () => {
  it("maps the fixtures' hostnames to listeners, routes and backends", () => {
    const rows = hostnameMap(fixtures.gateways, fixtures);
    const summary = rows.map((r) => [r.hostname, `${r.gateway.name}/${r.listener}`, r.route.name, r.accepted, r.condition ?? ""]);
    expect(summary).toEqual([
      ["grpc.internal.example.com", "internal-gw/grpc", "inventory", true, ""],
      ["internal.shop.example.com", "internal-gw/http", "legacy-admin", true, ""],
      ["shop.example.com", "internal-gw/http", "shop", false, "NoMatchingListenerHostname"],
      ["shop.example.com", "public-gw/http", "http-redirect", true, ""],
      // Sorted by {namespace}/{name}: gw-payments before gw-shop.
      ["shop.example.com", "public-gw/https", "payments-status", false, "NotAllowedByListeners"],
      ["shop.example.com", "public-gw/https", "checkout", true, ""],
      ["shop.example.com", "public-gw/https", "shop", true, ""],
      ["www.shop.example.com", "internal-gw/http", "shop", false, "NoMatchingListenerHostname"],
    ]);
    const shop = rows.find((r) => r.route.name === "shop" && r.accepted);
    expect(shop?.backends.map((b) => `${b.name}:${b.port}`)).toEqual(["api-v2:8080", "api-v1:8080", "web:80"]);
    expect(rows.every((r) => r.conflicts.length === 0)).toBe(true);
  });

  it("marks two routes claiming the same host with an identical match; the older wins", () => {
    const gws = [gateway([{ name: "wild", hostname: "*.example.com" }])];
    const older = httpRoute("older", [rule([prefix("/api/", { headers: [{ name: "X-Env", value: "prod" }] })], "a")], {
      hostnames: ["shop.example.com"],
      created: "2026-10-01T00:00:00Z",
    });
    const newer = httpRoute(
      "newer",
      [rule([exact("/")], "b"), rule([prefix("/api", { headers: [{ name: "x-env", value: "prod" }] })], "c")],
      { hostnames: ["shop.example.com"], created: "2026-10-02T00:00:00Z" },
    );
    const other = httpRoute("other-host", [rule([prefix("/api")], "d")], { hostnames: ["blog.example.com"] });
    const rows = hostnameMap(gws, { httpRoutes: [older, newer, other] });
    const byName = (name: string) => rows.find((r) => r.route.name === name);
    expect(byName("older")?.conflicts).toEqual([
      { rule: 0, match: 0, with: route("newer", "web"), withRule: 1, withMatch: 0, wins: true },
    ]);
    expect(byName("newer")?.conflicts).toEqual([
      { rule: 1, match: 0, with: route("older", "web"), withRule: 0, withMatch: 0, wins: false },
    ]);
    expect(byName("other-host")?.conflicts).toEqual([]);
    // A route without hostnames on this listener serves the listener's wildcard.
    const catchAll = hostnameMap(gws, { httpRoutes: [httpRoute("all", [backend("x")])] });
    expect(catchAll.map((r) => r.hostname)).toEqual(["*.example.com"]);
  });
});
