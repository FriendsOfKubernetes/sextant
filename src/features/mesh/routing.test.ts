import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import {
  exportedTo,
  findDestinationRule,
  hostMatches,
  hostSpecificity,
  parseDestinationRule,
  parseIstioGateway,
  parseServiceEntry,
  parseVirtualService,
  requestHostAliases,
  resolveHost,
} from "./istio";
import { destinationSelector, explainMeshRequest, parseMeshUrl, podsWithLabels, type MeshRequestInput, type RoutingSnapshot } from "./routing";

let seq = 0;
function obj(kind: string, namespace: string, name: string, spec: unknown, created = "2026-01-01T00:00:00Z"): KubeObject {
  seq++;
  return {
    apiVersion: "networking.istio.io/v1",
    kind,
    metadata: { namespace, name, uid: `${kind}-${namespace}-${name}-${seq}`, creationTimestamp: created },
    spec,
  } as KubeObject;
}

const vs = (ns: string, name: string, spec: unknown, created?: string) => parseVirtualService(obj("VirtualService", ns, name, spec, created));
const dr = (ns: string, name: string, spec: unknown) => parseDestinationRule(obj("DestinationRule", ns, name, spec));

const SERVICES = new Set(["shop/reviews", "shop/ratings", "shop/web", "pay/billing"]);

function snapshot(partial: Partial<RoutingSnapshot>): RoutingSnapshot {
  return {
    virtualServices: [],
    destinationRules: [],
    gateways: [],
    serviceEntries: [],
    serviceExists: (ns, name) => (ns === "shop" || ns === "pay" ? SERVICES.has(`${ns}/${name}`) : undefined),
    sidecarNamespaces: new Set(),
    ...partial,
  };
}

const fromShop = (url: string, extra: Partial<MeshRequestInput> = {}): MeshRequestInput => ({
  url,
  method: "GET",
  headers: {},
  from: { type: "mesh", namespace: "shop", labels: { app: "web" } },
  ...extra,
});

describe("Istio hosts", () => {
  it.each([
    ["reviews", "shop", "reviews.shop.svc.cluster.local"],
    ["reviews.shop.svc.cluster.local", "x", "reviews.shop.svc.cluster.local"],
    ["reviews.shop", "x", "reviews.shop"],
    ["*", "x", "*"],
    ["*.example.com", "x", "*.example.com"],
    ["Reviews", "shop", "reviews.shop.svc.cluster.local"],
  ])("resolves %s in %s as %s", (host, ns, want) => expect(resolveHost(host, ns)).toBe(want));

  it.each([
    ["*", "a.b", true],
    ["*.example.com", "a.example.com", true],
    ["*.example.com", "a.b.example.com", true],
    ["*.example.com", "example.com", false],
    ["api.example.com", "api.example.com", true],
    ["api.example.com", "www.example.com", false],
  ])("%s covers %s: %s", (pattern, host, want) => expect(hostMatches(pattern, host)).toBe(want));

  it("ranks exact hosts above wildcards and longer wildcards above shorter", () => {
    expect(hostSpecificity("a.example.com")).toBeGreaterThan(hostSpecificity("*.example.com"));
    expect(hostSpecificity("*.example.com")).toBeGreaterThan(hostSpecificity("*.com"));
    expect(hostSpecificity("*.com")).toBeGreaterThan(hostSpecificity("*"));
  });

  it("lists the names a request host can stand for", () => {
    expect(requestHostAliases("reviews", "shop")).toContain("reviews.shop.svc.cluster.local");
    expect(requestHostAliases("reviews.shop", "x")).toContain("reviews.shop.svc.cluster.local");
    expect(requestHostAliases("reviews.shop.svc", "x")).toContain("reviews.shop.svc.cluster.local");
  });

  it.each([
    [[], "a", "b", true],
    [["."], "a", "a", true],
    [["."], "a", "b", false],
    [["~"], "a", "a", false],
    [["*"], "a", "b", true],
    [["b", "c"], "a", "c", true],
  ])("exportTo %j from %s visible in %s: %s", (exportTo, own, ns, want) => expect(exportedTo(exportTo, own, ns)).toBe(want));
});

describe("URLs", () => {
  it("reads host, port, path and query; a URL without a scheme is http", () => {
    const r = parseMeshUrl("reviews.shop:9080/api/v1?user=a");
    expect(r).toMatchObject({ scheme: "http", host: "reviews.shop", port: 9080, path: "/api/v1" });
    expect(r?.query.get("user")).toBe("a");
    expect(parseMeshUrl("https://x.example.com")?.port).toBe(443);
    expect(parseMeshUrl("")).toBeUndefined();
    expect(parseMeshUrl("ftp://x")).toBeUndefined();
  });
});

describe("DestinationRule lookup", () => {
  const rules = [dr("shop", "own", { host: "reviews" }), dr("istio-system", "root", { host: "*.svc.cluster.local" }), dr("other", "o", { host: "reviews.shop.svc.cluster.local" })];
  it("looks in the client's namespace, then the Service's, then the root namespace", () => {
    expect(findDestinationRule("reviews.shop.svc.cluster.local", "shop", rules)?.ref.name).toBe("own");
    expect(findDestinationRule("reviews.shop.svc.cluster.local", "other", rules)?.ref.name).toBe("o");
    expect(findDestinationRule("billing.pay.svc.cluster.local", "pay", rules)?.ref.name).toBe("root");
  });
  it("skips a rule not exported to the client", () => {
    const hidden = [dr("pay", "private", { host: "billing", exportTo: ["."] })];
    expect(findDestinationRule("billing.pay.svc.cluster.local", "shop", hidden)).toBeUndefined();
    expect(findDestinationRule("billing.pay.svc.cluster.local", "pay", hidden)?.ref.name).toBe("private");
  });
});

describe("explainMeshRequest", () => {
  const reviews = vs("shop", "reviews", {
    hosts: ["reviews"],
    http: [
      { name: "beta", match: [{ headers: { "x-user": { exact: "alice" } } }], route: [{ destination: { host: "reviews", subset: "v2" } }] },
      { name: "api", match: [{ uri: { prefix: "/api" }, method: { exact: "POST" } }], route: [{ destination: { host: "reviews", subset: "v1" } }], timeout: "3s", retries: { attempts: 2 } },
      {
        name: "split",
        route: [
          { destination: { host: "reviews", subset: "v1" }, weight: 90 },
          { destination: { host: "reviews", subset: "v3" }, weight: 10 },
        ],
      },
    ],
  });
  const rule = dr("shop", "reviews", { host: "reviews", subsets: [{ name: "v1", labels: { version: "v1" } }, { name: "v2", labels: { version: "v2" } }] });
  const snap = snapshot({ virtualServices: [reviews], destinationRules: [rule] });

  it.each([
    ["a header match", fromShop("http://reviews/", { headers: { "x-user": "alice" } }), "beta", ["v2"], 0],
    ["prefix and method", fromShop("http://reviews/api/items", { method: "POST" }), "api", ["v1"], 1],
    ["the catch-all", fromShop("http://reviews:9080/api/items"), "split", ["v1", "v3"], 2],
    ["the namespace-qualified name", fromShop("http://reviews.shop/"), "split", ["v1", "v3"], 2],
  ])("follows %s", (_label, input, routeName, subsets, skippedCount) => {
    const r = explainMeshRequest(input, snap)!;
    expect(r.outcome).toBe("routed");
    expect(r.route?.route.name).toBe(routeName);
    expect(r.destinations.map((d) => d.destination.subset)).toEqual(subsets);
    expect(r.skipped).toHaveLength(skippedCount);
  });

  it("reports weights and why earlier routes were skipped", () => {
    const r = explainMeshRequest(fromShop("http://reviews/other"), snap)!;
    expect(r.destinations.map((d) => d.weight)).toEqual([90, 10]);
    expect(r.skipped.map((s) => s.failedOn)).toEqual(["headers", "uri"]);
  });

  it("marks a subset the DestinationRule does not define", () => {
    const r = explainMeshRequest(fromShop("http://reviews/"), snap)!;
    expect(r.destinations[1]).toMatchObject({ problem: "missingSubset", rule: { name: "reviews" } });
    expect(r.destinations[0]?.subsetLabels).toEqual({ version: "v1" });
  });

  it("sends to the Service as is without a VirtualService", () => {
    const r = explainMeshRequest(fromShop("http://ratings:9080/"), snap)!;
    expect(r.outcome).toBe("defaultRoute");
    expect(r.destinations[0]).toMatchObject({ weight: 100, service: { namespace: "shop", name: "ratings" }, serviceFound: true });
  });

  it("answers 404 when no route matches", () => {
    const only = vs("shop", "web", { hosts: ["web"], http: [{ match: [{ uri: { exact: "/" } }], route: [{ destination: { host: "web" } }] }] });
    const r = explainMeshRequest(fromShop("http://web/x"), snapshot({ virtualServices: [only] }))!;
    expect(r).toMatchObject({ outcome: "noRoute", status: 404 });
  });

  it("an unknown host passes through", () => {
    expect(explainMeshRequest(fromShop("http://nowhere.example.com/"), snap)!.outcome).toBe("passthrough");
  });

  it("uses the oldest of two VirtualServices for one host on the sidecars", () => {
    const old = vs("shop", "old", { hosts: ["web"], http: [{ route: [{ destination: { host: "web" } }] }] }, "2026-01-01T00:00:00Z");
    const young = vs("shop", "young", { hosts: ["web"], http: [{ route: [{ destination: { host: "ratings" } }] }] }, "2026-02-01T00:00:00Z");
    const r = explainMeshRequest(fromShop("http://web/"), snapshot({ virtualServices: [young, old] }))!;
    expect(r.used.map((u) => u.name)).toEqual(["old"]);
    expect(r.candidates).toContainEqual({ ref: young.ref, reason: "duplicateIgnored" });
  });

  it("prefers the most specific host and ignores VirtualServices not exported or not bound", () => {
    const wild = vs("shop", "wild", { hosts: ["*.svc.cluster.local"], http: [{ route: [{ destination: { host: "ratings" } }] }] });
    const hidden = vs("pay", "hidden", { hosts: ["reviews.shop.svc.cluster.local"], exportTo: ["."], http: [{ route: [{ destination: { host: "ratings.shop.svc.cluster.local" } }] }] });
    const gw = vs("shop", "edge", { hosts: ["reviews"], gateways: ["edge"], http: [{ route: [{ destination: { host: "web" } }] }] });
    const r = explainMeshRequest(fromShop("http://reviews/"), snapshot({ virtualServices: [wild, hidden, gw, reviews], destinationRules: [rule] }))!;
    expect(r.used.map((u) => u.name)).toEqual(["reviews"]);
    const reasons = Object.fromEntries(r.candidates.map((c) => [c.ref.name, c.reason]));
    expect(reasons).toEqual({ wild: "lessSpecificHost", hidden: "notExported", edge: "notBound" });
  });

  it("matches query parameters, ports, source labels and source namespaces", () => {
    const v = vs("shop", "q", {
      hosts: ["web"],
      http: [
        { name: "q", match: [{ queryParams: { debug: { exact: "1" } } }], route: [{ destination: { host: "web" } }] },
        { name: "port", match: [{ port: 8080 }], route: [{ destination: { host: "web" } }] },
        { name: "labels", match: [{ sourceLabels: { app: "batch" } }], route: [{ destination: { host: "web" } }] },
        { name: "ns", match: [{ sourceNamespace: "shop" }], route: [{ destination: { host: "web" } }] },
      ],
    });
    const s = snapshot({ virtualServices: [v] });
    expect(explainMeshRequest(fromShop("http://web/?debug=1"), s)!.route?.route.name).toBe("q");
    expect(explainMeshRequest(fromShop("http://web:8080/"), s)!.route?.route.name).toBe("port");
    const batch: MeshRequestInput = { ...fromShop("http://web/"), from: { type: "mesh", namespace: "shop", labels: { app: "batch" } } };
    expect(explainMeshRequest(batch, s)!.route?.route.name).toBe("labels");
    expect(explainMeshRequest(fromShop("http://web/"), s)!.route?.route.name).toBe("ns");
  });

  it("stops at a regular expression JavaScript cannot read", () => {
    const v = vs("shop", "re", { hosts: ["web"], http: [{ match: [{ uri: { regex: "(?P<x>a)" } }], route: [{ destination: { host: "web" } }] }] });
    const r = explainMeshRequest(fromShop("http://web/a"), snapshot({ virtualServices: [v] }))!;
    expect(r.outcome).toBe("notEvaluated");
    expect(r.notes).toContain("regexDialect");
  });

  it("follows a delegate", () => {
    const root = vs("shop", "root", { hosts: ["web"], http: [{ match: [{ uri: { prefix: "/shop" } }], delegate: { name: "child", namespace: "pay" } }] });
    const child = vs("pay", "child", { http: [{ match: [{ uri: { prefix: "/shop/pay" } }], route: [{ destination: { host: "billing" } }] }] });
    const s = snapshot({ virtualServices: [root, child] });
    const r = explainMeshRequest(fromShop("http://web/shop/pay"), s)!;
    expect(r.outcome).toBe("routed");
    expect(r.route).toMatchObject({ vs: { name: "child" }, via: { name: "root" } });
    expect(r.destinations[0]?.service).toEqual({ namespace: "pay", name: "billing" });
    const missing = snapshot({ virtualServices: [root] });
    expect(explainMeshRequest(fromShop("http://web/shop"), missing)!.outcome).toBe("delegateMissing");
  });

  it("answers redirects and direct responses itself", () => {
    const v = vs("shop", "r", {
      hosts: ["web"],
      http: [
        { match: [{ uri: { exact: "/old" } }], redirect: { uri: "/new", redirectCode: 308 } },
        { directResponse: { status: 418 } },
      ],
    });
    const s = snapshot({ virtualServices: [v] });
    expect(explainMeshRequest(fromShop("http://web/old"), s)).toMatchObject({ outcome: "redirected", status: 308 });
    expect(explainMeshRequest(fromShop("http://web/x"), s)).toMatchObject({ outcome: "directResponse", status: 418 });
  });

  describe("through a Gateway", () => {
    const gateway = parseIstioGateway(
      obj("Gateway", "ingress", "edge", { selector: { istio: "ingressgateway" }, servers: [{ port: { number: 80, protocol: "HTTP" }, hosts: ["shop/*.example.com"] }] }),
    );
    const a = vs("shop", "a", { hosts: ["www.example.com"], gateways: ["ingress/edge"], http: [{ match: [{ uri: { prefix: "/a" } }], route: [{ destination: { host: "web" } }] }] }, "2026-01-01T00:00:00Z");
    const b = vs("shop", "b", { hosts: ["www.example.com"], gateways: ["ingress/edge"], http: [{ route: [{ destination: { host: "reviews" } }] }] }, "2026-02-01T00:00:00Z");
    const s = snapshot({ virtualServices: [a, b], gateways: [gateway] });
    const via = (url: string): MeshRequestInput => ({ url, method: "GET", headers: {}, from: { type: "gateway", gateway: "ingress/edge" } });

    it("merges the routes of the VirtualServices for the host, oldest first", () => {
      const r = explainMeshRequest(via("http://www.example.com/a"), s)!;
      expect(r.used.map((u) => u.name)).toEqual(["a", "b"]);
      expect(r.route?.vs.name).toBe("a");
      expect(explainMeshRequest(via("http://www.example.com/z"), s)!.route?.vs.name).toBe("b");
    });

    it("answers 404 for a host no server lists, and for an unknown gateway", () => {
      expect(explainMeshRequest(via("http://other.org/"), s)).toMatchObject({ outcome: "noGatewayServer", status: 404 });
      const unknown: MeshRequestInput = { ...via("http://www.example.com/"), from: { type: "gateway", gateway: "x/y" } };
      expect(explainMeshRequest(unknown, s)!.outcome).toBe("unknownGateway");
    });

    it("notes a server on another port", () => {
      expect(explainMeshRequest(via("http://www.example.com:8443/a"), s)!.notes).toContain("gatewayPort");
    });
  });

  it("covers a ServiceEntry host", () => {
    const entry = parseServiceEntry(obj("ServiceEntry", "shop", "ext", { hosts: ["api.partner.com"], location: "MESH_EXTERNAL" }));
    const r = explainMeshRequest(fromShop("https://api.partner.com/"), snapshot({ serviceEntries: [entry] }))!;
    expect(r.outcome).toBe("defaultRoute");
    expect(r.destinations[0]?.serviceEntry?.name).toBe("ext");
  });
});

describe("destination pods", () => {
  it("are the Service's selector plus the subset's labels", () => {
    const svc = { metadata: { name: "reviews", namespace: "shop" }, spec: { selector: { app: "reviews" } } } as KubeObject;
    const sel = destinationSelector(svc, { destination: { host: "reviews", fqdn: "reviews.shop.svc.cluster.local", subset: "v1" }, weight: 100, subsetLabels: { version: "v1" } });
    expect(sel).toEqual({ app: "reviews", version: "v1" });
    const pods = [
      { metadata: { name: "a", namespace: "shop", labels: { app: "reviews", version: "v1" } } },
      { metadata: { name: "b", namespace: "shop", labels: { app: "reviews", version: "v2" } } },
      { metadata: { name: "c", namespace: "other", labels: { app: "reviews", version: "v1" } } },
    ] as KubeObject[];
    expect(podsWithLabels(pods, "shop", sel!).map((p) => p.metadata?.name)).toEqual(["a"]);
  });
});

describe("a mesh-bound VirtualService with host *", () => {
  it("is rejected by Istio, so the request does not go through it", () => {
    const all = vs("shop", "all", { hosts: ["*"], http: [{ route: [{ destination: { host: "nowhere.example.com" } }] }] });
    const r = explainMeshRequest(fromShop("http://ratings/"), snapshot({ virtualServices: [all] }))!;
    expect(r.outcome).toBe("defaultRoute");
    expect(r.candidates).toContainEqual({ ref: all.ref, reason: "invalidMeshWildcard" });
  });
});
