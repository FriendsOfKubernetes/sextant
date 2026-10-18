// Cilium and Calico policies: the L3/L4 subset Sextant evaluates, and "unknown" for what it does not model.
import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import { calicoPolicy } from "./calico";
import { evalCalico, parseCalicoSelector } from "./calicoSelector";
import { ciliumPolicies } from "./cilium";
import { evaluate, type Traffic } from "./engine";
import type { Endpoint, Policy, Verdict } from "./model";
import { external, namespace, netpol, pod, podEp, world } from "./testData";

const TCP80: Traffic = { protocol: "TCP", port: 80 };
const NAMESPACES = [namespace("shop", { team: "shop" }), namespace("other", { team: "other" })];

const client = pod("shop", "client", { app: "client" }, { ip: "10.0.1.5" });
const web = pod("shop", "web", { app: "web" }, { ip: "10.0.1.6", ports: [{ name: "http", containerPort: 8080 }] });
const stranger = pod("other", "stranger", { app: "client" }, { ip: "10.0.3.8" });

function cnp(ns: string | null, name: string, spec: Record<string, unknown>, extra: Record<string, unknown> = {}): KubeObject {
  return {
    apiVersion: "cilium.io/v2",
    kind: ns === null ? "CiliumClusterwideNetworkPolicy" : "CiliumNetworkPolicy",
    metadata: { name, ...(ns === null ? {} : { namespace: ns }), uid: `cnp-${name}` },
    spec,
    ...extra,
  } as KubeObject;
}

function calico(ns: string | null, name: string, spec: Record<string, unknown>): KubeObject {
  return {
    apiVersion: "projectcalico.org/v3",
    kind: ns === null ? "GlobalNetworkPolicy" : "NetworkPolicy",
    metadata: { name, ...(ns === null ? {} : { namespace: ns }), uid: `cal-${name}` },
    spec,
  } as KubeObject;
}

const cilium = (o: KubeObject): Policy[] => ciliumPolicies(o, o.kind === "CiliumClusterwideNetworkPolicy");
const cal = (o: KubeObject): Policy => calicoPolicy(o, o.kind === "GlobalNetworkPolicy")!;

interface Case {
  name: string;
  policies: (KubeObject | Policy)[];
  from: Endpoint;
  to: Endpoint;
  traffic?: Traffic;
  egress: Verdict;
  ingress: Verdict;
}

function table(cases: Case[]): void {
  for (const c of cases) {
    it(c.name, () => {
      const r = evaluate(c.from, c.to, c.traffic ?? TCP80, world(c.policies, NAMESPACES));
      expect({ egress: r.egress.verdict, ingress: r.ingress.verdict }).toEqual({ egress: c.egress, ingress: c.ingress });
    });
  }
}

const webSelector = { endpointSelector: { matchLabels: { app: "web" } } };

describe("Cilium", () => {
  table([
    { name: "fromEndpoints, same namespace", policies: cilium(cnp("shop", "p", { ...webSelector, ingress: [{ fromEndpoints: [{ matchLabels: { app: "client" } }] }] })), from: podEp(client), to: podEp(web), egress: "allowed", ingress: "allowed" },
    { name: "fromEndpoints of a namespaced policy: never another namespace", policies: cilium(cnp("shop", "p", { ...webSelector, ingress: [{ fromEndpoints: [{ matchLabels: { app: "client" } }] }] })), from: podEp(stranger), to: podEp(web), egress: "allowed", ingress: "denied" },
    { name: "fromEndpoints naming the namespace", policies: cilium(cnp("shop", "p", { ...webSelector, ingress: [{ fromEndpoints: [{ matchLabels: { "k8s:io.kubernetes.pod.namespace": "other", app: "client" } }] }] })), from: podEp(stranger), to: podEp(web), egress: "allowed", ingress: "allowed" },
    { name: "fromEndpoints by namespace labels", policies: cilium(cnp("shop", "p", { ...webSelector, ingress: [{ fromEndpoints: [{ matchLabels: { "io.cilium.k8s.namespace.labels.team": "other" } }] }] })), from: podEp(stranger), to: podEp(web), egress: "allowed", ingress: "allowed" },
    { name: "`ingress: [{}]` denies everything (unlike Kubernetes)", policies: cilium(cnp("shop", "p", { ...webSelector, ingress: [{}] })), from: podEp(client), to: podEp(web), egress: "allowed", ingress: "denied" },
    {
      name: "a deny rule wins over a Kubernetes allow",
      policies: [netpol("shop", "all", { podSelector: {}, ingress: [{}] }), ...cilium(cnp("shop", "p", { ...webSelector, ingressDeny: [{ fromEndpoints: [{ matchLabels: { app: "client" } }] }] }))],
      from: podEp(client),
      to: podEp(web),
      egress: "allowed",
      ingress: "denied",
    },
    {
      name: "a Kubernetes deny-all and a Cilium allow add up",
      policies: [netpol("shop", "deny", { podSelector: {}, policyTypes: ["Ingress"] }), ...cilium(cnp("shop", "p", { ...webSelector, ingress: [{ fromEndpoints: [{ matchLabels: { app: "client" } }] }] }))],
      from: podEp(client),
      to: podEp(web),
      egress: "allowed",
      ingress: "allowed",
    },
    {
      name: "L7 rules on the port: unknown",
      policies: cilium(cnp("shop", "p", { ...webSelector, ingress: [{ fromEndpoints: [{}], toPorts: [{ ports: [{ port: "80", protocol: "TCP" }], rules: { http: [{ method: "GET" }] } }] }] })),
      from: podEp(client),
      to: podEp(web),
      egress: "allowed",
      ingress: "unknown",
    },
    {
      name: "L7 rules on another port do not matter",
      policies: cilium(cnp("shop", "p", { ...webSelector, ingress: [{ fromEndpoints: [{}], toPorts: [{ ports: [{ port: "443", protocol: "TCP" }], rules: { http: [{ method: "GET" }] } }] }] })),
      from: podEp(client),
      to: podEp(web),
      egress: "allowed",
      ingress: "denied",
    },
    {
      name: "even an allowing rule elsewhere does not beat an unmodelled one",
      policies: cilium(cnp("shop", "p", { ...webSelector, ingress: [{ fromEndpoints: [{}] }, { fromEndpoints: [{}], toPorts: [{ ports: [{ port: "80" }], rules: { http: [{}] } }] }] })),
      from: podEp(client),
      to: podEp(web),
      egress: "allowed",
      ingress: "unknown",
    },
    { name: "toFQDNs without ports: unknown", policies: cilium(cnp("shop", "p", { endpointSelector: { matchLabels: { app: "client" } }, egress: [{ toFQDNs: [{ matchName: "example.com" }] }] })), from: podEp(client), to: external("93.184.216.34"), egress: "unknown", ingress: "allowed" },
    { name: "toFQDNs on 443: port 80 is certainly denied", policies: cilium(cnp("shop", "p", { endpointSelector: { matchLabels: { app: "client" } }, egress: [{ toFQDNs: [{ matchName: "example.com" }], toPorts: [{ ports: [{ port: "443" }] }] }] })), from: podEp(client), to: external("93.184.216.34"), egress: "denied", ingress: "allowed" },
    { name: "fromEntities world: outside addresses", policies: cilium(cnp("shop", "p", { ...webSelector, ingress: [{ fromEntities: ["world"] }] })), from: external("198.51.100.1"), to: podEp(web), egress: "allowed", ingress: "allowed" },
    { name: "fromEntities world: not pods", policies: cilium(cnp("shop", "p", { ...webSelector, ingress: [{ fromEntities: ["world"] }] })), from: podEp(client), to: podEp(web), egress: "allowed", ingress: "denied" },
    { name: "fromEntities cluster: every pod", policies: cilium(cnp("shop", "p", { ...webSelector, ingress: [{ fromEntities: ["cluster"] }] })), from: podEp(stranger), to: podEp(web), egress: "allowed", ingress: "allowed" },
    { name: "fromCIDR does not select pods", policies: cilium(cnp("shop", "p", { ...webSelector, ingress: [{ fromCIDR: ["10.0.0.0/8"] }] })), from: podEp(client), to: podEp(web), egress: "allowed", ingress: "denied" },
    { name: "fromCIDRSet with except", policies: cilium(cnp("shop", "p", { ...webSelector, ingress: [{ fromCIDRSet: [{ cidr: "198.51.100.0/24", except: ["198.51.100.128/25"] }] }] })), from: external("198.51.100.200"), to: podEp(web), egress: "allowed", ingress: "denied" },
    { name: "enableDefaultDeny off: not isolated", policies: cilium(cnp("shop", "p", { ...webSelector, enableDefaultDeny: { ingress: false }, ingress: [{ fromEndpoints: [{ matchLabels: { app: "admin" } }] }] })), from: podEp(client), to: podEp(web), egress: "allowed", ingress: "allowed" },
    { name: "a clusterwide policy selects pods of every namespace", policies: cilium(cnp(null, "p", { endpointSelector: { matchLabels: { "k8s:app": "client" } }, egress: [{ toEndpoints: [{ matchLabels: { app: "db" } }] }] })), from: podEp(stranger), to: podEp(web), egress: "denied", ingress: "allowed" },
    { name: "a clusterwide policy's toEndpoints span namespaces", policies: cilium(cnp(null, "p", { endpointSelector: { matchLabels: { app: "client" } }, egress: [{ toEndpoints: [{ matchLabels: { app: "web" } }] }] })), from: podEp(stranger), to: podEp(web), egress: "allowed", ingress: "allowed" },
    { name: "a host policy selects no pod", policies: cilium(cnp(null, "host", { nodeSelector: {}, ingress: [{}] })), from: podEp(client), to: podEp(web), egress: "allowed", ingress: "allowed" },
    { name: "toPorts with a named port", policies: cilium(cnp("shop", "p", { ...webSelector, ingress: [{ toPorts: [{ ports: [{ port: "http" }] }] }] })), from: podEp(client), to: podEp(web), traffic: { protocol: "TCP", port: 8080 }, egress: "allowed", ingress: "allowed" },
    { name: "toPorts protocol ANY by default", policies: cilium(cnp("shop", "p", { ...webSelector, ingress: [{ toPorts: [{ ports: [{ port: "53" }] }] }] })), from: podEp(client), to: podEp(web), traffic: { protocol: "UDP", port: 53 }, egress: "allowed", ingress: "allowed" },
  ]);

  it("specs: one policy per spec", () => {
    const o = cnp("shop", "multi", {}, { specs: [{ ...webSelector, ingress: [{}] }, { endpointSelector: {}, egress: [{}] }] });
    Reflect.deleteProperty(o as Record<string, unknown>, "spec");
    expect(cilium(o).map((p) => p.ref.part)).toEqual([0, 1]);
  });

  it("names the unmodelled feature", () => {
    const r = evaluate(podEp(client), external("93.184.216.34"), TCP80, world(cilium(cnp("shop", "p", { endpointSelector: {}, egress: [{ toFQDNs: [{ matchName: "x" }] }] })), NAMESPACES));
    expect(r.egress.unknown).toMatchObject([{ type: "unmodelledRule", features: ["toFQDNs"] }]);
    expect(r.egress.policies[0]!.rules[0]!.peers![0]!.check.reason).toEqual({ type: "unmodelled", feature: "toFQDNs" });
  });
});

describe("Calico", () => {
  table([
    {
      name: "a Deny at order 100 comes before a Kubernetes allow (order 1000)",
      policies: [netpol("shop", "allow", { podSelector: {}, ingress: [{}] }), cal(calico(null, "deny-client", { order: 100, selector: "app == 'web'", types: ["Ingress"], ingress: [{ action: "Deny", source: { selector: "app == 'client'" } }] }))],
      from: podEp(client),
      to: podEp(web),
      egress: "allowed",
      ingress: "denied",
    },
    {
      name: "a Kubernetes policy with no matching rule passes on to a later Allow",
      policies: [netpol("shop", "deny", { podSelector: {}, policyTypes: ["Ingress"] }), cal(calico("shop", "late", { order: 2000, selector: "all()", ingress: [{ action: "Allow" }] }))],
      from: podEp(client),
      to: podEp(web),
      egress: "allowed",
      ingress: "allowed",
    },
    {
      name: "selected and no rule decides: denied at the end of the tier",
      policies: [cal(calico("shop", "p", { selector: "app == 'web'", ingress: [{ action: "Allow", source: { selector: "app == 'admin'" } }] }))],
      from: podEp(client),
      to: podEp(web),
      egress: "allowed",
      ingress: "denied",
    },
    {
      name: "Log goes on to the next rule",
      policies: [cal(calico("shop", "p", { selector: "app == 'web'", ingress: [{ action: "Log" }, { action: "Allow", protocol: "TCP", destination: { ports: [80] } }] }))],
      from: podEp(client),
      to: podEp(web),
      egress: "allowed",
      ingress: "allowed",
    },
    {
      name: "Pass is not modelled",
      policies: [cal(calico("shop", "p", { selector: "app == 'web'", ingress: [{ action: "Pass" }] }))],
      from: podEp(client),
      to: podEp(web),
      egress: "allowed",
      ingress: "unknown",
    },
    {
      name: "a tier other than default is not modelled",
      policies: [cal(calico(null, "security.block", { tier: "security", selector: "all()", ingress: [{ action: "Allow" }] }))],
      from: podEp(client),
      to: podEp(web),
      egress: "allowed",
      ingress: "unknown",
    },
    {
      name: "a selector that does not parse: unknown",
      policies: [cal(calico("shop", "p", { selector: "app === web", ingress: [{ action: "Allow" }] }))],
      from: podEp(client),
      to: podEp(web),
      egress: "allowed",
      ingress: "unknown",
    },
    {
      name: "types left out with only egress rules: Egress only",
      policies: [cal(calico("shop", "p", { selector: "all()", egress: [{ action: "Allow", destination: { selector: "app == 'db'" } }] }))],
      from: podEp(client),
      to: podEp(web),
      egress: "denied",
      ingress: "allowed",
    },
    {
      name: "nets match pod IPs (Calico does)",
      policies: [cal(calico("shop", "p", { selector: "app == 'web'", ingress: [{ action: "Allow", source: { nets: ["10.0.1.0/24"] } }] }))],
      from: podEp(client),
      to: podEp(web),
      egress: "allowed",
      ingress: "allowed",
    },
    {
      name: "a source selector in another namespace needs a namespaceSelector",
      policies: [cal(calico("shop", "p", { selector: "app == 'web'", ingress: [{ action: "Allow", source: { selector: "app == 'client'" } }] }))],
      from: podEp(stranger),
      to: podEp(web),
      egress: "allowed",
      ingress: "denied",
    },
    {
      name: "namespaceSelector by projectcalico.org/name",
      policies: [cal(calico("shop", "p", { selector: "app == 'web'", ingress: [{ action: "Allow", source: { namespaceSelector: "projectcalico.org/name == 'other'", selector: "app == 'client'" } }] }))],
      from: podEp(stranger),
      to: podEp(web),
      egress: "allowed",
      ingress: "allowed",
    },
    {
      name: "a port range",
      policies: [cal(calico("shop", "p", { selector: "all()", ingress: [{ action: "Allow", protocol: "TCP", destination: { ports: ["8000:9000"] } }] }))],
      from: podEp(client),
      to: podEp(web),
      traffic: { protocol: "TCP", port: 8443 },
      egress: "allowed",
      ingress: "allowed",
    },
    {
      name: "an outside address and a selector: a network set may match, unknown",
      policies: [cal(calico("shop", "p", { selector: "all()", ingress: [{ action: "Allow", source: { selector: "role == 'partner'" } }] }))],
      from: external("198.51.100.1"),
      to: podEp(web),
      egress: "allowed",
      ingress: "unknown",
    },
    {
      name: "an outside address and nets: decided",
      policies: [cal(calico("shop", "p", { selector: "all()", ingress: [{ action: "Allow", source: { nets: ["198.51.100.0/24"] } }] }))],
      from: external("198.51.100.1"),
      to: podEp(web),
      egress: "allowed",
      ingress: "allowed",
    },
    {
      name: "a GlobalNetworkPolicy with a namespaceSelector",
      policies: [cal(calico(null, "p", { selector: "all()", namespaceSelector: "team == 'other'", types: ["Egress"], egress: [{ action: "Deny" }] }))],
      from: podEp(stranger),
      to: podEp(web),
      egress: "denied",
      ingress: "allowed",
    },
  ]);

  it("skips the Kubernetes policies the API server lists converted, and host-endpoint ones", () => {
    expect(calicoPolicy(calico("shop", "knp.default.web", { selector: "all()" }), false)).toBeNull();
    expect(calicoPolicy(calico(null, "host", { selector: "all()", preDNAT: true }), true)).toBeNull();
  });

  it("says the result came from Calico's order", () => {
    const w = world([cal(calico("shop", "p", { selector: "all()", ingress: [{ action: "Allow" }] }))], NAMESPACES);
    expect(evaluate(podEp(client), podEp(web), TCP80, w).notes).toContain("calicoOrder");
  });
});

describe("Calico selectors", () => {
  const labels = { app: "web", tier: "front", "team.example.com/owner": "shop" };
  it.each([
    ["", "yes"],
    ["all()", "yes"],
    ["global()", "no"],
    ["app == 'web'", "yes"],
    ['app == "api"', "no"],
    ["app != 'api'", "yes"],
    ["has(tier)", "yes"],
    ["!has(tier)", "no"],
    ["tier in {'front', 'back'}", "yes"],
    ["tier not in {'front'}", "no"],
    ["app contains 'e'", "yes"],
    ["app starts with 'w'", "yes"],
    ["app ends with 'x'", "no"],
    ["app == 'web' && (tier == 'back' || has(team.example.com/owner))", "yes"],
    ["missing != 'x'", "yes"],
  ])("%s → %s", (text, expected) => {
    const expr = parseCalicoSelector(text);
    expect(expr).not.toBeNull();
    expect(evalCalico(expr!, labels)).toBe(expected);
  });

  it.each(["app ==", "app = 'web'", "has(", "app in {'a'", "(app == 'a'", "app == 'a' extra"])("rejects %s", (text) => {
    expect(parseCalicoSelector(text)).toBeNull();
  });
});
