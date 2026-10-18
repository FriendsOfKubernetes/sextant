// The engine against the Kubernetes NetworkPolicy semantics (networking.k8s.io/v1), table by table.
import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import { cidrContains, inCidr, parseCidr, parseIp } from "./cidr";
import { dnsCheck, evaluate, evaluateService, type ConnectionResult, type Traffic, type World } from "./engine";
import { ignoredRules, kubernetesPolicy } from "./kubernetes";
import { describedPod, parseLabels, serviceInfo, type Endpoint, type Verdict } from "./model";
import { external, info, namespace, netpol, pod, podEp, service, world } from "./testData";

const TCP80: Traffic = { protocol: "TCP", port: 80 };

const NAMESPACES = [
  namespace("shop", { team: "shop" }),
  namespace("payments", { team: "payments", env: "prod" }),
  namespace("other", { team: "other" }),
  namespace("kube-system"),
];

const client = pod("shop", "client", { app: "client" }, { ip: "10.0.1.5" });
const web = pod("shop", "web", { app: "web" }, { ip: "10.0.1.6", ports: [{ name: "http", containerPort: 8080 }] });
const api = pod("payments", "api", { app: "api" }, { ip: "10.0.2.7", ports: [{ name: "http", containerPort: 9090 }] });
const stranger = pod("other", "stranger", { app: "client" }, { ip: "10.0.3.8" });

interface Case {
  name: string;
  policies: KubeObject[];
  from: Endpoint;
  to: Endpoint;
  traffic?: Traffic;
  egress: Verdict;
  ingress: Verdict;
  namespaces?: KubeObject[] | null;
}

function run(c: Pick<Case, "policies" | "from" | "to" | "traffic" | "namespaces">): ConnectionResult {
  return evaluate(c.from, c.to, c.traffic ?? TCP80, world(c.policies, c.namespaces === undefined ? NAMESPACES : c.namespaces));
}

function table(cases: Case[]): void {
  for (const c of cases) {
    it(c.name, () => {
      const r = run(c);
      expect({ egress: r.egress.verdict, ingress: r.ingress.verdict }).toEqual({ egress: c.egress, ingress: c.ingress });
      const overall = r.egress.verdict === "denied" || r.ingress.verdict === "denied" ? "denied" : r.egress.verdict === "unknown" || r.ingress.verdict === "unknown" ? "unknown" : "allowed";
      expect(r.verdict).toBe(overall);
    });
  }
}

describe("isolation and policyTypes", () => {
  table([
    { name: "no policies: both sides allowed", policies: [], from: podEp(client), to: podEp(web), egress: "allowed", ingress: "allowed" },
    {
      name: "policyTypes [Ingress] with no rules denies all ingress",
      policies: [netpol("shop", "deny", { podSelector: {}, policyTypes: ["Ingress"] })],
      from: podEp(client),
      to: podEp(web),
      egress: "allowed",
      ingress: "denied",
    },
    {
      name: "policyTypes left out: Ingress always (no ingress section = deny all)",
      policies: [netpol("shop", "deny", { podSelector: {} })],
      from: podEp(client),
      to: podEp(web),
      egress: "allowed",
      ingress: "denied",
    },
    {
      name: "`ingress: [{}]` allows everything",
      policies: [netpol("shop", "all", { podSelector: {}, ingress: [{}] })],
      from: podEp(stranger),
      to: podEp(web),
      egress: "allowed",
      ingress: "allowed",
    },
    {
      name: "`ingress: []` allows nothing",
      policies: [netpol("shop", "none", { podSelector: {}, ingress: [] })],
      from: podEp(client),
      to: podEp(web),
      egress: "allowed",
      ingress: "denied",
    },
    {
      name: "policyTypes left out with egress rules: Egress too",
      policies: [netpol("shop", "out", { podSelector: { matchLabels: { app: "client" } }, egress: [{ to: [{ podSelector: { matchLabels: { app: "db" } } }] }] })],
      from: podEp(client),
      to: podEp(web),
      egress: "denied",
      ingress: "allowed",
    },
    {
      name: "policyTypes [Ingress] ignores egress rules",
      policies: [netpol("shop", "in", { podSelector: { matchLabels: { app: "client" } }, policyTypes: ["Ingress"], egress: [{ to: [{ podSelector: { matchLabels: { app: "db" } } }] }] })],
      from: podEp(client),
      to: podEp(web),
      egress: "allowed",
      ingress: "allowed",
    },
    {
      name: "policyTypes [Egress] only: ingress not isolated",
      policies: [netpol("shop", "out", { podSelector: {}, policyTypes: ["Egress"] })],
      from: podEp(client),
      to: podEp(web),
      egress: "denied",
      ingress: "allowed",
    },
    {
      name: "a policy of another namespace does not select",
      policies: [netpol("payments", "deny", { podSelector: {}, policyTypes: ["Ingress", "Egress"] })],
      from: podEp(client),
      to: podEp(web),
      egress: "allowed",
      ingress: "allowed",
    },
    {
      name: "a podSelector that does not select the pod",
      policies: [netpol("shop", "deny-db", { podSelector: { matchLabels: { app: "db" } }, policyTypes: ["Ingress"] })],
      from: podEp(client),
      to: podEp(web),
      egress: "allowed",
      ingress: "allowed",
    },
    {
      name: "policies add up: a deny-all and an allow from client",
      policies: [
        netpol("shop", "deny", { podSelector: {}, policyTypes: ["Ingress"] }),
        netpol("shop", "allow-client", { podSelector: { matchLabels: { app: "web" } }, ingress: [{ from: [{ podSelector: { matchLabels: { app: "client" } } }] }] }),
      ],
      from: podEp(client),
      to: podEp(web),
      egress: "allowed",
      ingress: "allowed",
    },
  ]);

  it("defaults policyTypes the way the API server does", () => {
    expect(kubernetesPolicy(netpol("a", "p", { podSelector: {} })).isolates).toEqual({ ingress: true, egress: false });
    expect(kubernetesPolicy(netpol("a", "p", { podSelector: {}, egress: [{}] })).isolates).toEqual({ ingress: true, egress: true });
    expect(kubernetesPolicy(netpol("a", "p", { podSelector: {}, egress: [] })).isolates).toEqual({ ingress: true, egress: false });
    expect(kubernetesPolicy(netpol("a", "p", { podSelector: {}, policyTypes: [] })).defaultedTypes).toBe(true);
    expect(kubernetesPolicy(netpol("a", "p", { podSelector: {}, policyTypes: ["Egress"] })).isolates).toEqual({ ingress: false, egress: true });
    expect(ignoredRules(netpol("a", "p", { podSelector: {}, policyTypes: ["Ingress"], egress: [{}] }))).toEqual(["egress"]);
  });
});

describe("peers", () => {
  const fromPeers = (from: unknown[]) => [
    netpol("shop", "web", { podSelector: { matchLabels: { app: "web" } }, policyTypes: ["Ingress"], ingress: [{ from }] }),
  ];
  const fromPayments = pod("payments", "client", { app: "client" }, { ip: "10.0.2.9" });
  const otherInPayments = pod("payments", "batch", { app: "batch" }, { ip: "10.0.2.10" });
  table([
    { name: "podSelector alone: same namespace", policies: fromPeers([{ podSelector: { matchLabels: { app: "client" } } }]), from: podEp(client), to: podEp(web), egress: "allowed", ingress: "allowed" },
    { name: "podSelector alone: never another namespace", policies: fromPeers([{ podSelector: { matchLabels: { app: "client" } } }]), from: podEp(stranger), to: podEp(web), egress: "allowed", ingress: "denied" },
    { name: "namespaceSelector alone: every pod of matching namespaces", policies: fromPeers([{ namespaceSelector: { matchLabels: { team: "payments" } } }]), from: podEp(otherInPayments), to: podEp(web), egress: "allowed", ingress: "allowed" },
    { name: "namespaceSelector mismatch", policies: fromPeers([{ namespaceSelector: { matchLabels: { team: "payments" } } }]), from: podEp(stranger), to: podEp(web), egress: "allowed", ingress: "denied" },
    { name: "namespaceSelector {}: every namespace", policies: fromPeers([{ namespaceSelector: {} }]), from: podEp(stranger), to: podEp(web), egress: "allowed", ingress: "allowed" },
    { name: "namespaceSelector {} + podSelector: those pods anywhere", policies: fromPeers([{ namespaceSelector: {}, podSelector: { matchLabels: { app: "client" } } }]), from: podEp(stranger), to: podEp(web), egress: "allowed", ingress: "allowed" },
    {
      name: "podSelector + namespaceSelector in one peer = AND (namespace matches, pod does not)",
      policies: fromPeers([{ namespaceSelector: { matchLabels: { team: "payments" } }, podSelector: { matchLabels: { app: "client" } } }]),
      from: podEp(otherInPayments),
      to: podEp(web),
      egress: "allowed",
      ingress: "denied",
    },
    {
      name: "podSelector + namespaceSelector in one peer = AND (both match)",
      policies: fromPeers([{ namespaceSelector: { matchLabels: { team: "payments" } }, podSelector: { matchLabels: { app: "client" } } }]),
      from: podEp(fromPayments),
      to: podEp(web),
      egress: "allowed",
      ingress: "allowed",
    },
    {
      name: "the same selectors as two peers = OR",
      policies: fromPeers([{ namespaceSelector: { matchLabels: { team: "payments" } } }, { podSelector: { matchLabels: { app: "client" } } }]),
      from: podEp(otherInPayments),
      to: podEp(web),
      egress: "allowed",
      ingress: "allowed",
    },
    {
      name: "matchExpressions: NotIn and DoesNotExist",
      policies: fromPeers([{ podSelector: { matchExpressions: [{ key: "app", operator: "NotIn", values: ["web"] }, { key: "legacy", operator: "DoesNotExist" }] } }]),
      from: podEp(client),
      to: podEp(web),
      egress: "allowed",
      ingress: "allowed",
    },
    {
      name: "matchExpressions: an unknown operator never matches",
      policies: fromPeers([{ podSelector: { matchExpressions: [{ key: "app", operator: "Like", values: ["client"] }] } }]),
      from: podEp(client),
      to: podEp(web),
      egress: "allowed",
      ingress: "denied",
    },
    {
      name: "a namespace selected by kubernetes.io/metadata.name",
      policies: fromPeers([{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "other" } } }]),
      from: podEp(stranger),
      to: podEp(web),
      egress: "allowed",
      ingress: "allowed",
    },
    {
      name: "an empty `from` allows every source",
      policies: [netpol("shop", "web", { podSelector: {}, ingress: [{ from: [], ports: [{ port: 80 }] }] })],
      from: external("198.51.100.7"),
      to: podEp(web),
      egress: "allowed",
      ingress: "allowed",
    },
    {
      name: "a selector peer never matches an outside address",
      policies: fromPeers([{ namespaceSelector: {} }]),
      from: external("198.51.100.7"),
      to: podEp(web),
      egress: "allowed",
      ingress: "denied",
    },
  ]);

  it("says which namespace labels did not match", () => {
    const r = run({ policies: fromPeers([{ namespaceSelector: { matchLabels: { team: "payments" } } }]), from: podEp(stranger), to: podEp(web) });
    const reason = r.ingress.policies[0]!.rules[0]!.peers![0]!.check.reason;
    expect(reason).toEqual({ type: "namespaceSelector", namespace: "other", selector: "team=payments", labels: { team: "other", "kubernetes.io/metadata.name": "other" } });
    expect(r.ingress.why).toBe("noRuleMatches");
  });

  it("says the namespace when a podSelector-only peer meets another namespace", () => {
    const r = run({ policies: fromPeers([{ podSelector: { matchLabels: { app: "client" } } }]), from: podEp(stranger), to: podEp(web) });
    expect(r.ingress.policies[0]!.rules[0]!.peers![0]!.check.reason).toEqual({ type: "namespace", expected: "shop", actual: "other" });
  });

  it("namespace labels that cannot be read make a namespaceSelector unknown", () => {
    const policies = fromPeers([{ namespaceSelector: { matchLabels: { team: "payments" } } }]);
    expect(run({ policies, from: podEp(stranger), to: podEp(web), namespaces: null }).ingress.verdict).toBe("unknown");
    // …except one on the name label the API server sets, and the empty one.
    const byName = fromPeers([{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "payments" } } }]);
    expect(run({ policies: byName, from: podEp(stranger), to: podEp(web), namespaces: null }).ingress.verdict).toBe("denied");
    expect(run({ policies: fromPeers([{ namespaceSelector: {} }]), from: podEp(stranger), to: podEp(web), namespaces: null }).ingress.verdict).toBe("allowed");
  });
});

describe("ipBlock", () => {
  const block = (cidr: string, except?: string[]) => [
    netpol("shop", "ext", { podSelector: {}, policyTypes: ["Ingress"], ingress: [{ from: [{ ipBlock: { cidr, ...(except ? { except } : {}) } }] }] }),
  ];
  table([
    { name: "an outside address inside the block", policies: block("203.0.113.0/24", ["203.0.113.128/25"]), from: external("203.0.113.5"), to: podEp(web), egress: "allowed", ingress: "allowed" },
    { name: "an outside address in `except`", policies: block("203.0.113.0/24", ["203.0.113.128/25"]), from: external("203.0.113.200"), to: podEp(web), egress: "allowed", ingress: "denied" },
    { name: "an outside address outside the block", policies: block("203.0.113.0/24"), from: external("198.51.100.1"), to: podEp(web), egress: "allowed", ingress: "denied" },
    { name: "IPv6 inside", policies: block("2001:db8::/32", ["2001:db8:1::/48"]), from: external("2001:db8:2::1"), to: podEp(web), egress: "allowed", ingress: "allowed" },
    { name: "IPv6 in except", policies: block("2001:db8::/32", ["2001:db8:1::/48"]), from: external("2001:db8:1::1"), to: podEp(web), egress: "allowed", ingress: "denied" },
    { name: "an IPv4 address never matches an IPv6 block", policies: block("::/0"), from: external("203.0.113.5"), to: podEp(web), egress: "allowed", ingress: "denied" },
    { name: "a pod IP inside the block: implementation-defined", policies: block("10.0.0.0/8"), from: podEp(client), to: podEp(web), egress: "allowed", ingress: "unknown" },
    { name: "a pod IP outside the block", policies: block("192.168.0.0/16"), from: podEp(client), to: podEp(web), egress: "allowed", ingress: "denied" },
    { name: "a pod without an IP", policies: block("10.0.0.0/8"), from: { type: "pod", pod: describedPod("shop", { app: "client" }) }, to: podEp(web), egress: "allowed", ingress: "unknown" },
  ]);

  it("notes that ipBlock and pod IPs are implementation-defined", () => {
    expect(run({ policies: block("10.0.0.0/8"), from: podEp(client), to: podEp(web) }).notes).toContain("ipBlockPods");
  });

  it("CIDR math", () => {
    expect(inCidr("10.0.0.0/8", "10.255.255.255")).toBe(true);
    expect(inCidr("10.0.0.0/8", "11.0.0.0")).toBe(false);
    expect(inCidr("0.0.0.0/0", "8.8.8.8")).toBe(true);
    expect(inCidr("10.1.2.3/32", "10.1.2.3")).toBe(true);
    expect(inCidr("10.1.2.0/23", "10.1.3.255")).toBe(true);
    expect(inCidr("10.1.2.0/23", "10.1.4.0")).toBe(false);
    expect(inCidr("fd00::/8", "fd12:3456::1")).toBe(true);
    expect(inCidr("fd00::/8", "fe80::1")).toBe(false);
    expect(inCidr("::ffff:0:0/96", "::ffff:10.0.0.1")).toBe(true);
    expect(inCidr("2001:db8::/129", "2001:db8::1")).toBeNull();
    expect(inCidr("10.0.0.0/8", "10.0.0")).toBeNull();
    expect(parseIp("1:2:3:4:5:6:7:8")?.family).toBe(6);
    expect(parseIp("1::2::3")).toBeNull();
    expect(parseIp("256.1.1.1")).toBeNull();
    expect(cidrContains(parseCidr("10.1.2.3/8")!, parseIp("10.200.0.1")!)).toBe(true);
  });
});

describe("ports", () => {
  const onPorts = (ports: unknown[]) => [
    netpol("shop", "web", { podSelector: {}, policyTypes: ["Ingress"], ingress: [{ from: [{ podSelector: {} }], ports }] }),
  ];
  table([
    { name: "protocol defaults to TCP", policies: onPorts([{ port: 80 }]), from: podEp(client), to: podEp(web), egress: "allowed", ingress: "allowed" },
    { name: "TCP 80 does not allow UDP 80", policies: onPorts([{ port: 80 }]), from: podEp(client), to: podEp(web), traffic: { protocol: "UDP", port: 80 }, egress: "allowed", ingress: "denied" },
    { name: "SCTP", policies: onPorts([{ protocol: "SCTP", port: 9999 }]), from: podEp(client), to: podEp(web), traffic: { protocol: "SCTP", port: 9999 }, egress: "allowed", ingress: "allowed" },
    { name: "a port without a number: every port of the protocol", policies: onPorts([{ protocol: "UDP" }]), from: podEp(client), to: podEp(web), traffic: { protocol: "UDP", port: 5353 }, egress: "allowed", ingress: "allowed" },
    { name: "endPort: inside the range", policies: onPorts([{ port: 8000, endPort: 9000 }]), from: podEp(client), to: podEp(web), traffic: { protocol: "TCP", port: 8500 }, egress: "allowed", ingress: "allowed" },
    { name: "endPort: the last port counts", policies: onPorts([{ port: 8000, endPort: 9000 }]), from: podEp(client), to: podEp(web), traffic: { protocol: "TCP", port: 9000 }, egress: "allowed", ingress: "allowed" },
    { name: "endPort: outside the range", policies: onPorts([{ port: 8000, endPort: 9000 }]), from: podEp(client), to: podEp(web), traffic: { protocol: "TCP", port: 9001 }, egress: "allowed", ingress: "denied" },
    { name: "a named port resolved on the destination pod", policies: onPorts([{ port: "http" }]), from: podEp(client), to: podEp(web), traffic: { protocol: "TCP", port: 8080 }, egress: "allowed", ingress: "allowed" },
    { name: "a named port that names another number", policies: onPorts([{ port: "http" }]), from: podEp(client), to: podEp(web), egress: "allowed", ingress: "denied" },
    { name: "a named port the destination does not have", policies: onPorts([{ port: "grpc" }]), from: podEp(client), to: podEp(web), traffic: { protocol: "TCP", port: 8080 }, egress: "allowed", ingress: "denied" },
    { name: "ports ORed", policies: onPorts([{ port: 443 }, { port: 80 }]), from: podEp(client), to: podEp(web), egress: "allowed", ingress: "allowed" },
  ]);

  it("peers AND ports: a matching peer on another port is denied, with the port's reason", () => {
    const r = run({ policies: onPorts([{ port: 443 }]), from: podEp(client), to: podEp(web) });
    expect(r.ingress.verdict).toBe("denied");
    const rule = r.ingress.policies[0]!.rules[0]!;
    expect(rule.peerResult).toBe("yes");
    expect(rule.ports![0]!.check.reason).toEqual({ type: "port", expected: "443" });
  });

  it("a named egress port never matches an outside address", () => {
    const policies = [netpol("shop", "out", { podSelector: {}, policyTypes: ["Egress"], egress: [{ ports: [{ port: "https" }] }] })];
    const r = run({ policies, from: podEp(client), to: external("198.51.100.7"), traffic: { protocol: "TCP", port: 443 } });
    expect(r.egress.verdict).toBe("denied");
    expect(r.egress.policies[0]!.rules[0]!.ports![0]!.check.reason).toEqual({ type: "namedExternal", name: "https" });
    expect(r.ingress.why).toBe("external");
  });

  it("rules ORed: peer of one rule with the port of another is denied", () => {
    const policies = [
      netpol("shop", "web", {
        podSelector: {},
        policyTypes: ["Ingress"],
        ingress: [
          { from: [{ podSelector: { matchLabels: { app: "client" } } }], ports: [{ port: 443 }] },
          { from: [{ podSelector: { matchLabels: { app: "admin" } } }], ports: [{ port: 80 }] },
        ],
      }),
    ];
    expect(run({ policies, from: podEp(client), to: podEp(web) }).ingress.verdict).toBe("denied");
    expect(run({ policies, from: podEp(client), to: podEp(web), traffic: { protocol: "TCP", port: 443 } }).ingress.allowedBy).toMatchObject([
      { policy: { name: "web" }, rule: { index: 0 }, peer: 0, port: 0 },
    ]);
  });
});

describe("both sides", () => {
  const egressOnlyToDb = netpol("shop", "egress", {
    podSelector: { matchLabels: { app: "client" } },
    policyTypes: ["Egress"],
    egress: [{ to: [{ podSelector: { matchLabels: { app: "db" } } }] }],
  });
  const ingressFromClient = netpol("shop", "web", {
    podSelector: { matchLabels: { app: "web" } },
    ingress: [{ from: [{ podSelector: { matchLabels: { app: "client" } } }] }],
  });
  table([
    { name: "egress denied, ingress allowed: denied", policies: [egressOnlyToDb, ingressFromClient], from: podEp(client), to: podEp(web), egress: "denied", ingress: "allowed" },
    { name: "egress to an outside address: no ingress side", policies: [egressOnlyToDb], from: podEp(client), to: external("1.1.1.1"), egress: "denied", ingress: "allowed" },
    { name: "from outside: no egress side", policies: [ingressFromClient], from: external("1.1.1.1"), to: podEp(web), egress: "allowed", ingress: "denied" },
    {
      name: "a hostNetwork destination is not subject to policy",
      policies: [netpol("shop", "deny", { podSelector: {}, policyTypes: ["Ingress"] })],
      from: podEp(client),
      to: podEp(pod("shop", "agent", {}, { hostNetwork: true, ip: "192.168.1.10" })),
      egress: "allowed",
      ingress: "allowed",
    },
    {
      name: "a hostNetwork source is not subject to egress policy; from another node it is unknown",
      policies: [netpol("shop", "deny", { podSelector: {}, policyTypes: ["Ingress", "Egress"] })],
      from: podEp(pod("shop", "agent", { app: "client" }, { hostNetwork: true, node: "node-2" })),
      to: podEp(web),
      egress: "allowed",
      ingress: "unknown",
    },
    {
      name: "a hostNetwork source on the destination's node: node traffic is always allowed",
      policies: [netpol("shop", "deny", { podSelector: {}, policyTypes: ["Ingress"] })],
      from: podEp(pod("shop", "agent", {}, { hostNetwork: true, node: "node-1" })),
      to: podEp(web),
      egress: "allowed",
      ingress: "allowed",
    },
    {
      name: "a pod to itself: policy applies",
      policies: [netpol("shop", "deny", { podSelector: {}, policyTypes: ["Ingress"] })],
      from: podEp(web),
      to: podEp(web),
      egress: "allowed",
      ingress: "denied",
    },
    {
      name: "a source described by namespace and labels",
      policies: [ingressFromClient],
      from: { type: "pod", pod: describedPod("shop", { app: "client" }) },
      to: podEp(web),
      egress: "allowed",
      ingress: "allowed",
    },
  ]);

  it("notes self traffic and hostNetwork", () => {
    expect(run({ policies: [], from: podEp(web), to: podEp(web) }).notes).toContain("self");
    const agent = pod("shop", "agent", {}, { hostNetwork: true });
    expect(run({ policies: [], from: podEp(agent), to: podEp(web) }).notes).toContain("hostNetworkSource");
    expect(run({ policies: [], from: podEp(web), to: podEp(agent) }).notes).toContain("hostNetworkDestination");
  });

  it("a list it could not read makes its namespace's side unknown", () => {
    const w: World = { ...world([], NAMESPACES), unreadable: [{ kind: "NetworkPolicy", namespace: "shop" }] };
    const r = evaluate(podEp(api), podEp(web), TCP80, w);
    expect(r.egress.verdict).toBe("allowed");
    expect(r.ingress.verdict).toBe("unknown");
    expect(r.ingress.unknown).toEqual([{ type: "unreadable", kind: "NetworkPolicy", namespace: "shop" }]);
  });

  it("a policy kind Sextant does not evaluate makes both sides unknown", () => {
    const w = world([], NAMESPACES, { unevaluated: [{ kind: "AdminNetworkPolicy", name: "cluster-baseline" }] });
    expect(evaluate(podEp(client), podEp(web), TCP80, w).verdict).toBe("unknown");
  });

  it("a namespaced one only for pods of its namespace", () => {
    const w = world([], NAMESPACES, { unevaluated: [{ kind: "NetworkPolicy (crd.antrea.io)", name: "deny", namespace: "shop" }] });
    const r = evaluate(podEp(api), podEp(web), TCP80, w);
    expect([r.egress.verdict, r.ingress.verdict]).toEqual(["allowed", "unknown"]);
    expect(evaluate(podEp(api), podEp(api), TCP80, w).verdict).toBe("allowed");
  });
});

describe("Services", () => {
  const web2 = pod("shop", "web-2", { app: "web" }, { ip: "10.0.1.7", ports: [{ name: "http", containerPort: 8081 }] });
  const svc = serviceInfo(service("shop", "web", { app: "web" }, [{ name: "http", port: 80, targetPort: "http" }]));
  const onlyPort8080 = netpol("shop", "web", {
    podSelector: { matchLabels: { app: "web" } },
    ingress: [{ ports: [{ port: 8080 }] }],
  });

  it("checks every selected pod at the target port it names", () => {
    const r = evaluateService(podEp(client), svc, 0, [info(web), info(web2), info(client)], world([onlyPort8080], NAMESPACES));
    expect(r.backends.map((b) => [b.pod.name, b.port, b.result?.verdict])).toEqual([
      ["web", 8080, "allowed"],
      ["web-2", 8081, "denied"],
    ]);
    expect(r.verdict).toBe("partial");
  });

  it("a numeric target port, and the Service port when there is none", () => {
    const numeric = serviceInfo(service("shop", "web", { app: "web" }, [{ port: 80, targetPort: 8080 }]));
    expect(evaluateService(podEp(client), numeric, 0, [info(web)], world([onlyPort8080], NAMESPACES)).verdict).toBe("allowed");
    const same = serviceInfo(service("shop", "web", { app: "web" }, [{ port: 8080 }]));
    expect(evaluateService(podEp(client), same, 0, [info(web)], world([onlyPort8080], NAMESPACES)).verdict).toBe("allowed");
  });

  it("a named target port a pod does not have leaves that pod out", () => {
    const grpc = serviceInfo(service("shop", "web", { app: "web" }, [{ port: 80, targetPort: "grpc" }]));
    const r = evaluateService(podEp(client), grpc, 0, [info(web)], world([], NAMESPACES));
    expect(r.backends[0]!.port).toBeNull();
    expect(r.empty).toBe("noPort");
  });

  it("Services without a selector and ExternalName ones have nothing to check", () => {
    expect(evaluateService(podEp(client), serviceInfo(service("shop", "manual", null, [{ port: 80 }])), 0, [], world([])).empty).toBe("noSelector");
    expect(evaluateService(podEp(client), serviceInfo(service("shop", "ext", { a: "b" }, [{ port: 80 }], "ExternalName")), 0, [], world([])).empty).toBe("externalName");
    expect(evaluateService(podEp(client), svc, 0, [], world([])).empty).toBe("noPods");
  });
});

describe("DNS", () => {
  const dns = pod("kube-system", "coredns-1", { "k8s-app": "kube-dns" }, { ip: "10.0.0.10", ports: [{ name: "dns", containerPort: 53, protocol: "UDP" }, { name: "dns-tcp", containerPort: 53, protocol: "TCP" }] });
  const egressTo = (to: unknown[]) =>
    netpol("shop", "egress", { podSelector: { matchLabels: { app: "client" } }, policyTypes: ["Egress"], egress: to });

  it("no check when the source is not isolated for egress", () => {
    expect(dnsCheck(info(client), [info(dns)], world([], NAMESPACES))).toBeNull();
  });

  it("warns when egress isolation leaves DNS out", () => {
    const w = world([egressTo([{ to: [{ podSelector: { matchLabels: { app: "web" } } }] }])], NAMESPACES);
    expect(dnsCheck(info(client), [info(dns)], w)).toMatchObject({ udp: "denied", tcp: "denied" });
    // The target itself is allowed all the same.
    expect(evaluate(podEp(client), podEp(web), TCP80, w).verdict).toBe("allowed");
  });

  it("UDP 53 to kube-dns allowed, TCP not", () => {
    const w = world(
      [
        egressTo([
          {
            to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } }, podSelector: { matchLabels: { "k8s-app": "kube-dns" } } }],
            ports: [{ protocol: "UDP", port: "dns" }],
          },
        ]),
      ],
      NAMESPACES,
    );
    expect(dnsCheck(info(client), [info(dns)], w)).toMatchObject({ udp: "allowed", tcp: "denied" });
    // Without the DNS pods at hand, a pod with kube-dns's labels and ports stands in.
    expect(dnsCheck(info(client), [], w)).toMatchObject({ udp: "allowed", tcp: "denied", pods: [] });
  });
});

describe("inputs", () => {
  it("parses labels typed by the user", () => {
    expect(parseLabels("app=web, tier=api")).toEqual({ app: "web", tier: "api" });
    expect(parseLabels("")).toEqual({});
    expect(parseLabels("app.kubernetes.io/name=web")).toEqual({ "app.kubernetes.io/name": "web" });
    expect(parseLabels("app")).toBeNull();
    expect(parseLabels("=web")).toBeNull();
  });
});
