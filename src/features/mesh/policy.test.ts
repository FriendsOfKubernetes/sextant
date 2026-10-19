import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import { inBlock, parseAuthorizationPolicy, valueMatches, whoMayCall, type Caller } from "./authz";
import { parseDestinationRule, parseIstioGateway, parseServiceEntry, parseVirtualService } from "./istio";
import { istioMembership, linkerdMembership, podShape } from "./membership";
import { mtlsModeFor, parsePeerAuthentication } from "./mtls";
import { meshProblems, type AnalysisInput } from "./problems";
import { policyPhrases } from "./phrases";

let seq = 0;
function obj(kind: string, namespace: string, name: string, spec: unknown, created = "2026-01-01T00:00:00Z"): KubeObject {
  seq++;
  return { apiVersion: "x/v1", kind, metadata: { namespace, name, uid: `${name}-${seq}`, creationTimestamp: created }, spec } as KubeObject;
}

const pa = (ns: string, name: string, spec: unknown, created?: string) => parsePeerAuthentication(obj("PeerAuthentication", ns, name, spec, created));
const ap = (ns: string, name: string, spec: unknown) => parseAuthorizationPolicy(obj("AuthorizationPolicy", ns, name, spec));

describe("mTLS mode by PeerAuthentication precedence", () => {
  const mesh = pa("istio-system", "default", { mtls: { mode: "STRICT" } });
  const ns = pa("shop", "ns", { mtls: { mode: "PERMISSIVE" } });
  const unsetNs = pa("pay", "ns", { mtls: { mode: "UNSET" } });
  const wl = pa("shop", "web", { selector: { matchLabels: { app: "web" } }, mtls: { mode: "DISABLE" }, portLevelMtls: { "8080": { mode: "STRICT" }, "9090": {} } });
  const wlInherit = pa("shop", "api", { selector: { matchLabels: { app: "api" } }, portLevelMtls: { "8443": { mode: "DISABLE" } } });
  const all = [mesh, ns, unsetNs, wl, wlInherit];

  it.each([
    ["no policy at all", "shop", { app: "x" }, [], "PERMISSIVE", "default"],
    ["the mesh-wide policy", "other", { app: "x" }, all, "STRICT", "mesh"],
    ["the namespace policy over the mesh", "shop", { app: "x" }, all, "PERMISSIVE", "namespace"],
    ["UNSET inherits from the mesh", "pay", { app: "x" }, all, "STRICT", "mesh"],
    ["the workload policy over the namespace", "shop", { app: "web" }, all, "DISABLE", "workload"],
    ["a workload policy without a mode inherits", "shop", { app: "api" }, all, "PERMISSIVE", "namespace"],
  ] as const)("%s", (_label, namespace, labels, policies, mode, source) => {
    const r = mtlsModeFor(namespace, labels, policies);
    expect(r.mode).toBe(mode);
    expect(r.source).toBe(source);
  });

  it("applies port-level modes of the workload policy, inheriting where unset", () => {
    expect(mtlsModeFor("shop", { app: "web" }, all).ports).toEqual([
      { port: 8080, mode: "STRICT" },
      { port: 9090, mode: "DISABLE" },
    ]);
    expect(mtlsModeFor("shop", { app: "api" }, all).ports).toEqual([{ port: 8443, mode: "DISABLE" }]);
  });

  it("takes the oldest of two policies of one level", () => {
    const a = pa("x", "b", { mtls: { mode: "DISABLE" } }, "2026-03-01T00:00:00Z");
    const b = pa("x", "a", { mtls: { mode: "STRICT" } }, "2026-01-01T00:00:00Z");
    expect(mtlsModeFor("x", {}, [a, b]).policy?.name).toBe("a");
  });

  it("a selector policy of the root namespace applies there only", () => {
    const rootSel = pa("istio-system", "gw", { selector: { matchLabels: { app: "web" } }, mtls: { mode: "DISABLE" } });
    expect(mtlsModeFor("shop", { app: "web" }, [rootSel]).mode).toBe("PERMISSIVE");
  });
});

describe("who may call (AuthorizationPolicy)", () => {
  const caller: Caller = { namespace: "front", serviceAccount: "web", method: "GET", path: "/api/items", port: 8080 };
  const allowFront = ap("shop", "allow-front", {
    selector: { matchLabels: { app: "api" } },
    rules: [{ from: [{ source: { principals: ["cluster.local/ns/front/sa/web"] } }], to: [{ operation: { methods: ["GET"], paths: ["/api/*"] } }] }],
  });
  const denyAdmin = ap("shop", "deny-admin", { action: "DENY", rules: [{ to: [{ operation: { paths: ["/admin*"] } }] }] });
  const allowNothing = ap("shop", "allow-nothing", {});
  const allowAll = ap("shop", "allow-all", { rules: [{}] });
  const denyJwt = ap("shop", "deny-jwt", { action: "DENY", rules: [{ from: [{ source: { notRequestPrincipals: ["*"] } }] }] });
  const denyHeader = ap("shop", "deny-header", { action: "DENY", rules: [{ when: [{ key: "request.headers[x-debug]", values: ["1"] }] }] });
  const custom = ap("shop", "ext", { action: "CUSTOM", provider: { name: "opa" }, rules: [{ to: [{ operation: { paths: ["/api/*"] } }] }] });
  const audit = ap("shop", "audit", { action: "AUDIT", rules: [{}] });
  const waypointDeny = ap("shop", "wp", { action: "DENY", targetRefs: [{ kind: "Service", name: "api" }], rules: [{}] });
  const labels = { app: "api" };

  it.each([
    ["no policy", [], caller, "allowed", "noPolicies"],
    ["a matching ALLOW", [allowFront], caller, "allowed", "allowMatched"],
    ["an ALLOW for others", [allowFront], { ...caller, serviceAccount: "batch" }, "denied", "noAllowMatched"],
    ["a matching DENY beats ALLOW", [allowFront, denyAdmin], { ...caller, path: "/admin/x" }, "denied", "denyMatched"],
    ["ALLOW without rules allows nothing", [allowNothing], caller, "denied", "noAllowMatched"],
    ["an empty rule allows everything", [allowAll], caller, "allowed", "allowMatched"],
    ["a DENY on a JWT is not evaluated", [allowAll, denyJwt], caller, "unknown", "denyMayMatch"],
    ["a DENY on a header not given is not evaluated", [allowAll, denyHeader], caller, "unknown", "denyMayMatch"],
    ["a DENY on a header given", [allowAll, denyHeader], { ...caller, headers: { "x-debug": "0" } }, "allowed", "allowMatched"],
    ["a matching CUSTOM hands over", [custom], caller, "external", "customMatched"],
    ["a CUSTOM for other paths", [custom], { ...caller, path: "/x" }, "allowed", "noPolicies"],
    ["AUDIT changes nothing", [audit], caller, "allowed", "noPolicies"],
    ["a DENY attached by targetRef is not evaluated", [waypointDeny], caller, "unknown", "targetRefNotEvaluated"],
    ["the principal is unknown without a service account", [allowFront], { ...caller, serviceAccount: undefined }, "unknown", "allowMayMatch"],
    ["a principal of another namespace cannot match", [allowFront], { ...caller, namespace: "batch", serviceAccount: undefined }, "denied", "noAllowMatched"],
  ] as const)("%s", (_label, policies, who, decision, reason) => {
    const r = whoMayCall("shop", labels, policies, who);
    expect(r.decision).toBe(decision);
    expect(r.reason).toBe(reason);
  });

  it("applies policies of the root namespace and of the workload's namespace only", () => {
    const root = ap("istio-system", "deny-all", { action: "DENY", rules: [{}] });
    const elsewhere = ap("other", "deny-all", { action: "DENY", rules: [{}] });
    expect(whoMayCall("shop", labels, [root], caller).decision).toBe("denied");
    expect(whoMayCall("shop", labels, [elsewhere], caller).decision).toBe("allowed");
    const otherApp = ap("shop", "deny-web", { action: "DENY", selector: { matchLabels: { app: "web" } }, rules: [{}] });
    expect(whoMayCall("shop", labels, [otherApp], caller).decision).toBe("allowed");
  });

  it("matches namespaces, ports, notX lists and IP blocks", () => {
    const p = ap("shop", "p", {
      rules: [{ from: [{ source: { namespaces: ["front"], notIpBlocks: ["10.0.0.0/8"] } }], to: [{ operation: { ports: ["8080"], notMethods: ["DELETE"] } }] }],
    });
    expect(whoMayCall("shop", labels, [p], { ...caller, ip: "192.168.1.2" }).decision).toBe("allowed");
    expect(whoMayCall("shop", labels, [p], { ...caller, ip: "10.1.2.3" }).decision).toBe("denied");
    expect(whoMayCall("shop", labels, [p], { ...caller, ip: undefined }).decision).toBe("unknown");
    expect(whoMayCall("shop", labels, [p], { ...caller, ip: "1.1.1.1", method: "DELETE" }).decision).toBe("denied");
  });

  it.each([
    ["*", "x", true],
    ["*", "", false],
    ["/api/*", "/api/x", true],
    ["*.example.com", "a.example.com", true],
    ["GET", "POST", false],
  ])("value %s matches %s: %s", (p, v, want) => expect(valueMatches(p, v)).toBe(want));

  it.each([
    ["10.0.0.0/8", "10.2.3.4", true],
    ["10.0.0.0/8", "11.0.0.1", false],
    ["192.168.1.5", "192.168.1.5", true],
    ["0.0.0.0/0", "8.8.8.8", true],
    ["fd00::/8", "fd00::1", undefined],
  ])("block %s holds %s: %s", (b, ip, want) => expect(inBlock(b, ip)).toBe(want));

  it("explains empty rules in words", () => {
    expect(policyPhrases(allowNothing).map((p) => p.key)).toContain("mesh:authz.special.allowNothing");
    expect(policyPhrases(allowAll).map((p) => p.key)).toContain("mesh:authz.special.everything");
    expect(policyPhrases(ap("istio-system", "x", { action: "DENY" })).map((p) => p.key)).toEqual([
      "mesh:authz.scope.mesh",
      "mesh:authz.action.DENY",
      "mesh:authz.special.noRules",
    ]);
  });
});

describe("mesh membership", () => {
  const pod = (spec: unknown, labels: Record<string, string> = {}, annotations: Record<string, string> = {}) =>
    podShape({ metadata: { name: "p", namespace: "shop", labels, annotations }, spec } as KubeObject, false);
  const ns = (labels: Record<string, string> = {}, annotations: Record<string, string> = {}) => ({ labels, annotations });

  it.each([
    ["a sidecar", pod({ containers: [{ name: "app" }, { name: "istio-proxy", image: "proxyv2:1.24" }] }), ns(), "sidecar"],
    ["a native sidecar", pod({ containers: [{ name: "app" }], initContainers: [{ name: "istio-proxy", restartPolicy: "Always" }] }), ns(), "nativeSidecar"],
    ["ambient by namespace", pod({ containers: [{ name: "app" }] }), ns({ "istio.io/dataplane-mode": "ambient" }), "ambient"],
    ["ambient opted out", pod({ containers: [{ name: "app" }] }, { "istio.io/dataplane-mode": "none" }), ns({ "istio.io/dataplane-mode": "ambient" }), "none"],
    ["not meshed", pod({ containers: [{ name: "app" }] }), ns(), "none"],
  ])("Istio: %s", (_label, shape, namespace, mode) => expect(istioMembership(shape, namespace).mode).toBe(mode));

  it("says a pod needs a restart when injection is on and it has no proxy", () => {
    const m = istioMembership(pod({ containers: [{ name: "app" }] }), ns({ "istio-injection": "enabled" }));
    expect(m).toMatchObject({ mode: "none", injection: true, via: "namespace", restartNeeded: true });
    const rev = istioMembership(pod({ containers: [{ name: "istio-proxy" }] }, { "istio.io/rev": "canary" }), ns());
    expect(rev).toMatchObject({ mode: "sidecar", revision: "canary" });
    const out = istioMembership(pod({ containers: [{ name: "app" }] }, { "sidecar.istio.io/inject": "false" }), ns({ "istio-injection": "enabled" }));
    expect(out).toMatchObject({ injection: false, optedOut: true, restartNeeded: false });
  });

  it("reads a workload's template as what its pods will get", () => {
    const deploy = { metadata: { name: "d", namespace: "shop" }, spec: { template: { metadata: { labels: { app: "x" } }, spec: { containers: [{ name: "app" }] } } } } as KubeObject;
    const m = istioMembership(podShape(deploy, true), ns({ "istio-injection": "enabled" }), true);
    expect(m).toMatchObject({ injection: true, restartNeeded: false });
  });

  it("Linkerd: proxy, injection and restarts", () => {
    expect(linkerdMembership(pod({ containers: [{ name: "linkerd-proxy" }] }, { "linkerd.io/control-plane-ns": "linkerd" }), ns()).mode).toBe("proxy");
    const pending = linkerdMembership(pod({ containers: [{ name: "app" }] }), ns({}, { "linkerd.io/inject": "enabled" }));
    expect(pending).toMatchObject({ mode: "none", inject: "enabled", via: "namespace", restartNeeded: true });
    expect(linkerdMembership(pod({ containers: [{ name: "app" }] }, {}, { "linkerd.io/inject": "disabled" }), ns({}, { "linkerd.io/inject": "enabled" })).restartNeeded).toBe(false);
  });
});

describe("mesh problems", () => {
  const vs = (ns: string, name: string, spec: unknown, created?: string) => parseVirtualService(obj("VirtualService", ns, name, spec, created));
  const dr = (ns: string, name: string, spec: unknown) => parseDestinationRule(obj("DestinationRule", ns, name, spec));
  const input = (partial: Partial<AnalysisInput>): AnalysisInput => ({
    virtualServices: [],
    destinationRules: [],
    gateways: [],
    serviceEntries: [],
    peerAuthentications: [],
    serviceExists: (ns, name) => (ns === "shop" ? ["reviews", "web"].includes(name) : undefined),
    ...partial,
  });

  it("finds missing hosts, DestinationRules, subsets and gateways", () => {
    const v = vs("shop", "v", {
      hosts: ["web"],
      gateways: ["mesh", "ingress/missing"],
      http: [
        { route: [{ destination: { host: "reviews", subset: "v9" } }] },
        { route: [{ destination: { host: "web", subset: "v1" } }] },
        { route: [{ destination: { host: "gone" } }] },
        { route: [{ destination: { host: "elsewhere.unknown-ns.svc.cluster.local" } }] },
        { route: [{ destination: { host: "api.partner.com" } }] },
      ],
    });
    const r = dr("shop", "reviews", { host: "reviews", subsets: [{ name: "v1", labels: { version: "v1" } }] });
    const found = meshProblems(input({ virtualServices: [v], destinationRules: [r] })).map((p) => [p.reason, p.params.host ?? p.params.gateway]);
    expect(found).toEqual([
      ["MissingSubset", "reviews"],
      ["MissingDestinationRule", "web"],
      ["UnknownHost", "gone"],
      ["UnknownHost", "api.partner.com"],
      ["MissingGateway", "ingress/missing"],
    ]);
  });

  it("a ServiceEntry covers an external host, and unknown namespaces are not judged", () => {
    const v = vs("shop", "v", { hosts: ["web"], http: [{ route: [{ destination: { host: "api.partner.com" } }] }] });
    const entry = parseServiceEntry(obj("ServiceEntry", "shop", "e", { hosts: ["*.partner.com"] }));
    expect(meshProblems(input({ virtualServices: [v], serviceEntries: [entry] }))).toEqual([]);
    expect(meshProblems(input({ virtualServices: [v], gateways: undefined, serviceEntries: [entry] }))).toEqual([]);
  });

  it("finds a TLS mode that STRICT workloads refuse", () => {
    const strict = parsePeerAuthentication(obj("PeerAuthentication", "shop", "ns", { mtls: { mode: "STRICT" } }));
    const simple = dr("shop", "simple", { host: "reviews", trafficPolicy: { tls: { mode: "SIMPLE" } } });
    const istio = dr("shop", "ok", { host: "web", trafficPolicy: { tls: { mode: "ISTIO_MUTUAL" } } });
    const found = meshProblems(input({ destinationRules: [simple, istio], peerAuthentications: [strict] }));
    expect(found.map((p) => [p.reason, p.ref.name, p.params.mode])).toEqual([["TlsConflict", "simple", "SIMPLE"]]);
    expect(meshProblems(input({ destinationRules: [simple] }))).toEqual([]);
  });

  it("finds VirtualServices that conflict on a host", () => {
    const old = vs("shop", "old", { hosts: ["web"], http: [{ route: [{ destination: { host: "web" } }] }] }, "2026-01-01T00:00:00Z");
    const young = vs("shop", "young", { hosts: ["web.shop.svc.cluster.local"], http: [{ route: [{ destination: { host: "web" } }] }] }, "2026-02-01T00:00:00Z");
    const private1 = vs("pay", "p1", { hosts: ["web.shop.svc.cluster.local"], exportTo: ["."], http: [{ route: [{ destination: { host: "web.shop.svc.cluster.local" } }] }] }, "2026-03-01T00:00:00Z");
    const found = meshProblems(input({ virtualServices: [young, old, private1] }));
    // p1 is visible in pay only, where old is visible too: a conflict for the callers of pay.
    expect(found.map((p) => [p.reason, p.ref.name, p.params.other])).toEqual([
      ["ConflictingVirtualService", "young", "shop/old"],
      ["ConflictingVirtualService", "p1", "shop/old"],
    ]);
    const onlyShop = vs("shop", "s", { hosts: ["other"], exportTo: ["."], http: [] }, "2026-01-01T00:00:00Z");
    const onlyPay = vs("pay", "q", { hosts: ["other.shop.svc.cluster.local"], exportTo: ["."], http: [] }, "2026-02-01T00:00:00Z");
    expect(meshProblems(input({ virtualServices: [onlyShop, onlyPay] }))).toEqual([]);
  });

  it("on a Gateway only an older catch-all shadows a newer VirtualService", () => {
    const gateway = parseIstioGateway(obj("Gateway", "ingress", "edge", { servers: [{ port: { number: 80 }, hosts: ["*"] }] }));
    const a = vs("shop", "a", { hosts: ["www.example.com"], gateways: ["ingress/edge"], http: [{ match: [{ uri: { prefix: "/a" } }], route: [{ destination: { host: "web" } }] }] }, "2026-01-01T00:00:00Z");
    const b = vs("shop", "b", { hosts: ["www.example.com"], gateways: ["ingress/edge"], http: [{ route: [{ destination: { host: "web" } }] }] }, "2026-02-01T00:00:00Z");
    expect(meshProblems(input({ virtualServices: [a, b], gateways: [gateway] }))).toEqual([]);
    const c = vs("shop", "c", { hosts: ["www.example.com"], gateways: ["ingress/edge"], http: [{ route: [{ destination: { host: "reviews" } }] }] }, "2026-03-01T00:00:00Z");
    const found = meshProblems(input({ virtualServices: [a, b, c], gateways: [gateway] }));
    expect(found.map((p) => [p.ref.name, p.params.other])).toEqual([["c", "shop/b"]]);
  });
});

describe("review fixes: dry run, invalid actions, remote IPs, missing headers, mesh wildcards", () => {
  const caller: Caller = { namespace: "front", serviceAccount: "web", method: "GET", path: "/x", port: 8080, ip: "10.0.0.5" };
  const labels = { app: "api" };
  const withAnnotations = (spec: unknown, annotations: Record<string, string>) => {
    const o = obj("AuthorizationPolicy", "shop", "p", spec);
    o.metadata = { ...o.metadata, annotations };
    return parseAuthorizationPolicy(o);
  };

  it("a dry-run policy is shown but not enforced", () => {
    const denyAll = withAnnotations({ action: "DENY", rules: [{}] }, { "istio.io/dry-run": "true" });
    expect(denyAll.dryRun).toBe(true);
    const r = whoMayCall("shop", labels, [denyAll], caller);
    expect(r).toMatchObject({ decision: "allowed", reason: "noPolicies" });
    expect(r.verdicts[0]).toMatchObject({ dryRun: true, match: "yes" });
    const allowNothing = withAnnotations({}, { "istio.io/dry-run": "true" });
    expect(whoMayCall("shop", labels, [allowNothing], caller).decision).toBe("allowed");
    expect(policyPhrases(denyAll).map((p) => p.key)).toContain("mesh:authz.dryRun");
  });

  it("an action Istio does not accept gives unknown, not ALLOW", () => {
    const odd = ap("shop", "odd", { action: "ALLOWED", rules: [{}] });
    expect(odd.action).toBe("INVALID");
    expect(whoMayCall("shop", labels, [odd], caller)).toMatchObject({ decision: "unknown", reason: "invalidPolicy" });
    // A DENY that certainly matches still decides.
    expect(whoMayCall("shop", labels, [odd, ap("shop", "d", { action: "DENY", rules: [{}] })], caller).decision).toBe("denied");
  });

  it("keeps the caller IP and the remote IP apart", () => {
    const remote = ap("shop", "r", { action: "DENY", rules: [{ from: [{ source: { remoteIpBlocks: ["1.2.3.0/24"] } }] }] });
    expect(whoMayCall("shop", labels, [remote], caller)).toMatchObject({ decision: "unknown", reason: "denyMayMatch" });
    expect(whoMayCall("shop", labels, [remote], { ...caller, remoteIp: "1.2.3.4" }).decision).toBe("denied");
    expect(whoMayCall("shop", labels, [remote], { ...caller, remoteIp: "9.9.9.9" }).decision).toBe("allowed");
    const own = ap("shop", "o", { action: "DENY", rules: [{ from: [{ source: { ipBlocks: ["10.0.0.0/8"] } }] }] });
    expect(whoMayCall("shop", labels, [own], caller).decision).toBe("denied");
    const cond = ap("shop", "c", { action: "DENY", rules: [{ when: [{ key: "remote.ip", values: ["10.0.0.0/8"] }] }] });
    expect(whoMayCall("shop", labels, [cond], caller).decision).toBe("unknown");
    const src = ap("shop", "s", { action: "DENY", rules: [{ when: [{ key: "source.ip", values: ["10.0.0.0/8"] }] }] });
    expect(whoMayCall("shop", labels, [src], caller).decision).toBe("denied");
  });

  it("a missing header matches no value, not even the empty one", () => {
    const empty = ap("shop", "e", { action: "DENY", rules: [{ when: [{ key: "request.headers[x-debug]", values: [""] }] }] });
    expect(whoMayCall("shop", labels, [empty], { ...caller, headers: {} }).decision).toBe("allowed");
    expect(whoMayCall("shop", labels, [empty], { ...caller, headers: { "x-debug": "" } }).decision).toBe("denied");
    const not = ap("shop", "n", { action: "DENY", rules: [{ when: [{ key: "request.headers[x-env]", notValues: ["prod"] }] }] });
    expect(whoMayCall("shop", labels, [not], { ...caller, headers: {} }).decision).toBe("denied");
  });

  it("a VirtualService with host * bound to the sidecars is invalid, not routed through", () => {
    const vs = parseVirtualService(obj("VirtualService", "shop", "all", { hosts: ["*"], http: [{ route: [{ destination: { host: "gone" } }] }] }));
    const found = meshProblems({
      virtualServices: [vs],
      destinationRules: [],
      gateways: [],
      serviceEntries: [],
      peerAuthentications: [],
      serviceExists: () => false,
    });
    expect(found.map((p) => [p.reason, p.params.host])).toEqual([["InvalidVirtualService", "*"]]);
    const onGateway = parseVirtualService(obj("VirtualService", "shop", "gw", { hosts: ["*"], gateways: ["ingress/edge"], http: [] }));
    expect(meshProblems({ virtualServices: [onGateway], destinationRules: [], gateways: undefined, serviceEntries: [], peerAuthentications: [], serviceExists: () => undefined })).toEqual([]);
  });
});
