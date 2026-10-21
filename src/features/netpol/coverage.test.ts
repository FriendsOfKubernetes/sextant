// Network policy coverage: which pods a policy isolates per direction, every flavour, default deny and "unknown".
import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import { calicoPolicy } from "./calico";
import { ciliumPolicies } from "./cilium";
import { defaultDenyOf, levelOf, namespaceCoverage, podCoverage, type CoverageState } from "./coverage";
import type { Direction, Policy, Tri } from "./model";
import { info, namespace, netpol, pod, world } from "./testData";

const NAMESPACES = [namespace("shop", { team: "shop" }), namespace("other", { team: "other" })];
const web = info(pod("shop", "web", { app: "web" }, { ip: "10.0.1.6" }));
const db = info(pod("shop", "db", { app: "db" }, { ip: "10.0.1.7" }));
const stranger = info(pod("other", "stranger", { app: "web" }, { ip: "10.0.3.8" }));
const host = info(pod("shop", "agent", { app: "web" }, { ip: "10.0.0.2", hostNetwork: true }));

function cnp(ns: string | null, name: string, spec: Record<string, unknown>): KubeObject {
  return {
    apiVersion: "cilium.io/v2",
    kind: ns === null ? "CiliumClusterwideNetworkPolicy" : "CiliumNetworkPolicy",
    metadata: { name, ...(ns === null ? {} : { namespace: ns }), uid: `cnp-${name}` },
    spec,
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
  pod?: typeof web;
  ingress: CoverageState;
  egress: CoverageState;
}

function table(cases: Case[]): void {
  for (const c of cases) {
    it(c.name, () => {
      const w = world(c.policies, NAMESPACES);
      const p = c.pod ?? web;
      expect([podCoverage(p, "ingress", w).state, podCoverage(p, "egress", w).state]).toEqual([c.ingress, c.egress]);
    });
  }
}

describe("Kubernetes NetworkPolicy", () => {
  table([
    { name: "no policy: not isolated", policies: [], ingress: "notIsolated", egress: "notIsolated" },
    { name: "policyTypes left out: Ingress only", policies: [netpol("shop", "p", { podSelector: {} })], ingress: "isolated", egress: "notIsolated" },
    {
      name: "policyTypes left out with egress rules: both",
      policies: [netpol("shop", "p", { podSelector: {}, egress: [{}] })],
      ingress: "isolated",
      egress: "isolated",
    },
    { name: "Egress only when listed", policies: [netpol("shop", "p", { podSelector: {}, policyTypes: ["Egress"] })], ingress: "notIsolated", egress: "isolated" },
    {
      name: "a podSelector that does not select the pod",
      policies: [netpol("shop", "p", { podSelector: { matchLabels: { app: "db" } }, policyTypes: ["Ingress", "Egress"] })],
      ingress: "notIsolated",
      egress: "notIsolated",
    },
    { name: "a policy of another namespace", policies: [netpol("shop", "p", { podSelector: {} })], pod: stranger, ingress: "notIsolated", egress: "notIsolated" },
    { name: "an allow-all policy still isolates", policies: [netpol("shop", "p", { podSelector: {}, ingress: [{}] })], ingress: "isolated", egress: "notIsolated" },
    { name: "hostNetwork pods are not subject", policies: [netpol("shop", "p", { podSelector: {}, policyTypes: ["Ingress", "Egress"] })], pod: host, ingress: "notIsolated", egress: "notIsolated" },
  ]);

  it("names the isolating policies and the hostNetwork reason", () => {
    const w = world([netpol("shop", "deny", { podSelector: {} })], NAMESPACES);
    expect(podCoverage(web, "ingress", w).by.map((r) => r.name)).toEqual(["deny"]);
    expect(podCoverage(host, "ingress", w).hostNetwork).toBe(true);
  });
});

describe("Cilium", () => {
  table([
    { name: "endpointSelector with ingress rules isolates ingress", policies: cilium(cnp("shop", "c", { endpointSelector: {}, ingress: [{ fromEndpoints: [{}] }] })), ingress: "isolated", egress: "notIsolated" },
    { name: "egress rules isolate egress", policies: cilium(cnp("shop", "c", { endpointSelector: { matchLabels: { app: "web" } }, egress: [{}] })), ingress: "notIsolated", egress: "isolated" },
    {
      name: "enableDefaultDeny off: selected, not isolated",
      policies: cilium(cnp("shop", "c", { endpointSelector: {}, ingress: [{ fromEndpoints: [{}] }], enableDefaultDeny: { ingress: false } })),
      ingress: "notIsolated",
      egress: "notIsolated",
    },
    { name: "a clusterwide policy selects every namespace", policies: cilium(cnp(null, "cc", { endpointSelector: {}, ingress: [{}] })), pod: stranger, ingress: "isolated", egress: "notIsolated" },
    { name: "a host policy selects no pod", policies: cilium(cnp(null, "h", { nodeSelector: {}, ingress: [{}] })), ingress: "notIsolated", egress: "notIsolated" },
    {
      name: "a cluster label in the selector: unknown",
      policies: cilium(cnp("shop", "c", { endpointSelector: { matchLabels: { "io.cilium.k8s.policy.cluster": "a" } }, ingress: [{}] })),
      ingress: "unknown",
      egress: "notIsolated",
    },
  ]);
});

describe("Calico", () => {
  table([
    { name: "types left out: Ingress", policies: [cal(calico("shop", "k", { selector: "all()" }))], ingress: "isolated", egress: "notIsolated" },
    { name: "types left out, egress rules only: Egress", policies: [cal(calico("shop", "k", { selector: "app == 'web'", egress: [{ action: "Allow" }] }))], ingress: "notIsolated", egress: "isolated" },
    { name: "types written", policies: [cal(calico("shop", "k", { selector: "all()", types: ["Ingress", "Egress"] }))], ingress: "isolated", egress: "isolated" },
    { name: "a GlobalNetworkPolicy narrowed by namespaceSelector", policies: [cal(calico(null, "g", { selector: "all()", namespaceSelector: "team == 'other'" }))], ingress: "notIsolated", egress: "notIsolated" },
    { name: "a GlobalNetworkPolicy selecting the namespace", policies: [cal(calico(null, "g", { selector: "all()", namespaceSelector: "team == 'shop'" }))], ingress: "isolated", egress: "notIsolated" },
    { name: "a tier other than default: unknown", policies: [cal(calico("shop", "k", { selector: "all()", tier: "security" }))], ingress: "unknown", egress: "notIsolated" },
    { name: "serviceAccountSelector: unknown", policies: [cal(calico("shop", "k", { selector: "all()", serviceAccountSelector: "name == 'x'" }))], ingress: "unknown", egress: "notIsolated" },
    { name: "a selector Sextant cannot parse: unknown", policies: [cal(calico("shop", "k", { selector: "app ==" }))], ingress: "unknown", egress: "notIsolated" },
  ]);
});

describe("unknown, never 'not isolated'", () => {
  it("an unreadable policy list of the pod's namespace", () => {
    const w = world([], NAMESPACES, { unreadable: [{ kind: "NetworkPolicy", namespace: "shop" }] });
    const c = podCoverage(web, "ingress", w);
    expect(c.state).toBe("unknown");
    expect(c.unknown).toEqual([{ type: "unreadable", kind: "NetworkPolicy", namespace: "shop" }]);
    expect(podCoverage(stranger, "ingress", w).state).toBe("notIsolated");
  });

  it("an unreadable cluster-wide list, and an unevaluated kind", () => {
    expect(podCoverage(web, "egress", world([], NAMESPACES, { unreadable: [{ kind: "CiliumClusterwideNetworkPolicy", namespace: null }] })).state).toBe("unknown");
    const w = world([], NAMESPACES, { unevaluated: [{ kind: "AdminNetworkPolicy", name: "a", namespace: null }] });
    expect(podCoverage(web, "ingress", w).state).toBe("unknown");
  });

  it("a certain policy wins over an unreadable list", () => {
    const w = world([netpol("shop", "p", { podSelector: {} })], NAMESPACES, { unreadable: [{ kind: "CiliumNetworkPolicy", namespace: "shop" }] });
    expect(podCoverage(web, "ingress", w).state).toBe("isolated");
  });

  it("namespace labels not known: a namespaceSelector policy may select", () => {
    const g = cal(calico(null, "g", { selector: "all()", namespaceSelector: "team == 'shop'" }));
    expect(podCoverage(web, "ingress", world([g], null)).state).toBe("unknown");
  });
});

describe("default deny", () => {
  const dd = (policies: (KubeObject | Policy)[], direction: Direction, ns = "shop", extra = {}): Tri =>
    defaultDenyOf(ns, direction, world(policies, NAMESPACES, extra)).state;

  it("Kubernetes: empty podSelector, no rules", () => {
    expect(dd([netpol("shop", "deny", { podSelector: {} })], "ingress")).toBe("yes");
    expect(dd([netpol("shop", "deny", { podSelector: {} })], "egress")).toBe("no");
    expect(dd([netpol("shop", "deny", { podSelector: {}, policyTypes: ["Ingress", "Egress"] })], "egress")).toBe("yes");
    expect(dd([netpol("shop", "deny", { podSelector: {} })], "ingress", "other")).toBe("no");
  });

  it("Kubernetes: a selector or an allowing rule is not a default deny", () => {
    expect(dd([netpol("shop", "p", { podSelector: { matchLabels: { app: "web" } } })], "ingress")).toBe("no");
    expect(dd([netpol("shop", "p", { podSelector: {}, ingress: [{}] })], "ingress")).toBe("no");
  });

  it("Cilium: the empty rule and a clusterwide namespace selector", () => {
    expect(dd(cilium(cnp("shop", "c", { endpointSelector: {}, ingress: [{}] })), "ingress")).toBe("yes");
    expect(dd(cilium(cnp("shop", "c", { endpointSelector: {}, ingress: [{ fromEndpoints: [{}] }] })), "ingress")).toBe("no");
    const byNs = cilium(cnp(null, "cc", { endpointSelector: { matchLabels: { "k8s:io.kubernetes.pod.namespace": "shop" } }, egress: [{}] }));
    expect(dd(byNs, "egress")).toBe("yes");
    expect(dd(byNs, "egress", "other")).toBe("no");
  });

  it("Calico: all() and a namespace-only global selector, Deny rules", () => {
    expect(dd([cal(calico("shop", "k", { selector: "all()", types: ["Ingress"] }))], "ingress")).toBe("yes");
    const g = cal(calico(null, "g", { selector: "projectcalico.org/namespace not in {'kube-system'}", types: ["Ingress", "Egress"], egress: [{ action: "Deny" }] }));
    expect(dd([g], "egress")).toBe("yes");
    expect(dd([g], "egress", "kube-system")).toBe("no");
    expect(dd([cal(calico("shop", "k", { selector: "all()", tier: "security" }))], "ingress")).toBe("maybe");
  });

  it("maybe when a list that could hold one is unreadable", () => {
    expect(dd([], "ingress", "shop", { unreadable: [{ kind: "NetworkPolicy", namespace: "shop" }] })).toBe("maybe");
  });
});

describe("a namespace", () => {
  it("counts pods per direction and lists the selecting policies", () => {
    const w = world([netpol("shop", "db-only", { podSelector: { matchLabels: { app: "db" } }, policyTypes: ["Ingress", "Egress"] })], NAMESPACES);
    const c = namespaceCoverage("shop", [web, db, host], w);
    expect(c.ingress).toMatchObject({ level: "some", isolated: 1, notIsolated: 2, unknown: 0, hostNetwork: 1 });
    expect(c.policies).toEqual([{ ref: expect.objectContaining({ name: "db-only" }), ingress: 1, egress: 1 }]);
    expect(namespaceCoverage("shop", undefined, w).ingress.level).toBe("unknown");
    expect(namespaceCoverage("shop", [], w).ingress.level).toBe("noPods");
  });

  it.each([
    [{ isolated: 3, notIsolated: 0, unknown: 0 }, "all"],
    [{ isolated: 0, notIsolated: 3, unknown: 0 }, "none"],
    [{ isolated: 1, notIsolated: 1, unknown: 1 }, "some"],
    [{ isolated: 2, notIsolated: 0, unknown: 1 }, "unknown"],
    [{ isolated: 0, notIsolated: 2, unknown: 1 }, "unknown"],
    [{ isolated: 0, notIsolated: 0, unknown: 0 }, "noPods"],
  ] as const)("level of %o is %s", (counts, level) => {
    expect(levelOf(counts)).toBe(level);
  });
});
