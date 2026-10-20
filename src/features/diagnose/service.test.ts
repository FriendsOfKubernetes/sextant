import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import { chainStatus, type Chain, type Status } from "./model";
import { isDnsName } from "./objects";
import { diagnoseService } from "./service";
import { NOW, networkPolicy, pod, service, slice, view, type ViewInput } from "./testData";

const WEB = { app: "web" };
const outside = { type: "outside" } as const;

/** `id:status` of each finding, in order; `…` when the chain stopped. */
function steps(chain: Chain): string[] {
  return [...chain.findings.map((f) => `${f.id}:${f.status}`), ...(chain.stopped ? ["…"] : [])];
}
const keyOf = (chain: Chain, id: string) => chain.findings.find((f) => f.id === id)?.text.key;

const readyPods = [pod("web-1", WEB), pod("web-2", WEB)];
const goodSlice = slice("web", [{ pod: "web-1" }, { pod: "web-2" }]);

interface Case {
  name: string;
  svc: KubeObject;
  input: ViewInput;
  focus?: number | string;
  steps: string[];
  /** The i18n key of one finding: [id, key]. */
  says?: [string, string];
  status: Status;
}

const cases: Case[] = [
  {
    name: "a healthy ClusterIP Service",
    svc: service("web", { selector: WEB }),
    input: { pods: readyPods, slices: [goodSlice] },
    steps: ["service.selector:ok", "service.ready:ok", "service.targetPort.0:ok", "service.slices:ok", "policies:ok", "service.clusterIp:ok"],
    says: ["policies", "diagnose:policies.notIsolated"],
    status: "ok",
  },
  {
    name: "a selector that matches no pod stops at once",
    svc: service("web", { selector: { app: "web", tier: "front" } }),
    input: { pods: [pod("web-1", { app: "web", tier: "frontend" })], slices: [] },
    steps: ["service.selector:broken", "…"],
    says: ["service.selector", "diagnose:service.noPods"],
    status: "broken",
  },
  {
    name: "no pod is Ready",
    svc: service("web", { selector: WEB }),
    input: { pods: [pod("web-1", WEB, { ready: false, waiting: "CrashLoopBackOff" })], slices: [] },
    steps: ["service.selector:ok", "service.ready:broken", "…"],
    says: ["service.ready", "diagnose:service.noneReady"],
    status: "broken",
  },
  {
    name: "publishNotReadyAddresses lets not-ready pods take traffic",
    svc: service("web", { selector: WEB, publishNotReadyAddresses: true }),
    input: { pods: [pod("web-1", WEB, { ready: false })], slices: [slice("web", [{ pod: "web-1" }])] },
    steps: ["service.selector:ok", "service.ready:warn", "service.targetPort.0:ok", "service.slices:ok", "service.clusterIp:ok"],
    status: "warn",
  },
  {
    name: "some pods are not Ready",
    svc: service("web", { selector: WEB }),
    input: { pods: [...readyPods, pod("web-3", WEB, { ready: false })], slices: [goodSlice] },
    steps: ["service.selector:ok", "service.ready:warn", "service.targetPort.0:ok", "service.slices:ok", "policies:ok", "service.clusterIp:ok"],
    status: "warn",
  },
  {
    name: "a named target port no container has",
    svc: service("web", { selector: WEB, ports: [{ name: "http", port: 80, targetPort: "web", protocol: "TCP" }] }),
    input: { pods: readyPods, slices: [goodSlice] },
    steps: ["service.selector:ok", "service.ready:ok", "service.targetPort.0:broken", "…"],
    says: ["service.targetPort.0", "diagnose:service.namedPortMissing"],
    status: "broken",
  },
  {
    name: "a named target port with the right protocol",
    svc: service("web", { selector: WEB, ports: [{ port: 80, targetPort: "http" }] }),
    input: { pods: readyPods, slices: [goodSlice] },
    steps: ["service.selector:ok", "service.ready:ok", "service.targetPort.0:ok", "service.slices:ok", "policies:ok", "service.clusterIp:ok"],
    says: ["service.targetPort.0", "diagnose:service.namedPort"],
    status: "ok",
  },
  {
    name: "a numeric target port no container declares",
    svc: service("web", { selector: WEB, ports: [{ port: 80, targetPort: 9000 }] }),
    input: { pods: readyPods, slices: [goodSlice] },
    steps: ["service.selector:ok", "service.ready:ok", "service.targetPort.0:warn", "service.slices:ok", "policies:ok", "service.clusterIp:ok"],
    says: ["service.targetPort.0", "diagnose:service.portNotDeclared"],
    status: "warn",
  },
  {
    name: "a target port declared for another protocol",
    svc: service("web", { selector: WEB, ports: [{ port: 53, targetPort: 8080, protocol: "UDP" }] }),
    input: { pods: readyPods, slices: [goodSlice] },
    steps: ["service.selector:ok", "service.ready:ok", "service.targetPort.0:warn", "service.slices:ok", "policies:ok", "service.clusterIp:ok"],
    says: ["service.targetPort.0", "diagnose:service.protocolMismatch"],
    status: "warn",
  },
  {
    name: "no EndpointSlice yet",
    svc: service("web", { selector: WEB }),
    input: { pods: readyPods, slices: [] },
    steps: ["service.selector:ok", "service.ready:ok", "service.targetPort.0:ok", "service.slices:broken", "…"],
    says: ["service.slices", "diagnose:service.noSlices"],
    status: "broken",
  },
  {
    name: "EndpointSlices behind the pods",
    svc: service("web", { selector: WEB }),
    input: { pods: readyPods, slices: [slice("web", [{ pod: "web-1" }, { pod: "web-2", ready: false }])] },
    steps: ["service.selector:ok", "service.ready:ok", "service.targetPort.0:ok", "service.slices:warn", "policies:ok", "service.clusterIp:ok"],
    says: ["service.slices", "diagnose:service.slicesDiffer"],
    status: "warn",
  },
  {
    name: "a Service without a selector and its hand-made endpoints",
    svc: service("db", { selector: undefined }),
    input: { slices: [slice("db", [{ pod: "x" }])] },
    steps: ["service.selector:ok", "service.slices:ok", "service.clusterIp:ok"],
    says: ["service.slices", "diagnose:service.manualEndpoints"],
    status: "ok",
  },
  {
    name: "a Service without a selector and no endpoints",
    svc: service("db", { selector: undefined }),
    input: {},
    steps: ["service.selector:ok", "service.slices:broken", "…"],
    says: ["service.slices", "diagnose:service.manualNoSlices"],
    status: "broken",
  },
  {
    name: "pods that cannot be read",
    svc: service("web", { selector: WEB }),
    input: { unreadable: ["shop"] },
    steps: ["service.selector:unknown", "service.clusterIp:ok"],
    status: "unknown",
  },
  {
    name: "a deny-all policy in front of the pods",
    svc: service("web", { selector: WEB }),
    input: { pods: readyPods, slices: [goodSlice], policies: [networkPolicy("deny", { podSelector: {}, policyTypes: ["Ingress"] })] },
    steps: ["service.selector:ok", "service.ready:ok", "service.targetPort.0:ok", "service.slices:ok", "policies:broken", "…"],
    says: ["policies", "diagnose:policies.denied"],
    status: "broken",
  },
  {
    name: "a policy that lets in only pods of the namespace",
    svc: service("web", { selector: WEB }),
    input: {
      pods: readyPods,
      slices: [goodSlice],
      policies: [networkPolicy("same-ns", { podSelector: {}, ingress: [{ from: [{ podSelector: {} }] }] })],
    },
    steps: ["service.selector:ok", "service.ready:ok", "service.targetPort.0:ok", "service.slices:ok", "policies:broken", "…"],
    status: "broken",
  },
  {
    name: "a policy that lets in some namespaces: depends on the client",
    svc: service("web", { selector: WEB }),
    input: {
      pods: readyPods,
      slices: [goodSlice],
      policies: [networkPolicy("from-gw", { podSelector: {}, ingress: [{ from: [{ namespaceSelector: { matchLabels: { gw: "yes" } } }] }] })],
    },
    steps: ["service.selector:ok", "service.ready:ok", "service.targetPort.0:ok", "service.slices:ok", "policies:unknown", "service.clusterIp:ok"],
    says: ["policies", "diagnose:policies.dependsOnSource"],
    status: "unknown",
  },
  {
    name: "a load balancer without an address for hours",
    svc: service("web", { selector: WEB, type: "LoadBalancer", ports: [{ port: 80, targetPort: 8080, nodePort: 30080 }] }),
    input: { pods: readyPods, slices: [goodSlice] },
    steps: ["service.selector:ok", "service.ready:ok", "service.targetPort.0:ok", "service.slices:ok", "policies:ok", "service.nodePorts:ok", "service.loadBalancer:broken", "…"],
    says: ["service.loadBalancer", "diagnose:service.lbPendingHours"],
    status: "broken",
  },
  {
    name: "a load balancer with an address",
    svc: service("web", { selector: WEB, type: "LoadBalancer" }, { status: { loadBalancer: { ingress: [{ ip: "198.51.100.7" }] } } }),
    input: { pods: readyPods, slices: [goodSlice] },
    steps: ["service.selector:ok", "service.ready:ok", "service.targetPort.0:ok", "service.slices:ok", "policies:ok", "service.loadBalancer:ok"],
    status: "ok",
  },
  {
    name: "the port an Ingress names does not exist",
    svc: service("web", { selector: WEB }),
    focus: 8443,
    input: { pods: readyPods, slices: [goodSlice] },
    steps: ["service.port:broken", "…"],
    says: ["service.port", "diagnose:service.portMissing"],
    status: "broken",
  },
  {
    name: "through an Ingress the Service's own exposure is left out",
    svc: service("web", { selector: WEB, sessionAffinity: "ClientIP" }),
    focus: "http",
    input: { pods: readyPods, slices: [goodSlice] },
    steps: ["service.selector:ok", "service.ready:ok", "service.targetPort.0:ok", "service.slices:ok", "policies:ok"],
    status: "ok",
  },
];

describe("diagnoseService", () => {
  it.each(cases)("$name", (c) => {
    const chain = diagnoseService(c.svc, view(c.input), { focus: c.focus, source: outside });
    expect(steps(chain)).toEqual(c.steps);
    expect(chainStatus(chain)).toBe(c.status);
    if (c.says) expect(keyOf(chain, c.says[0])).toBe(c.says[1]);
  });

  it("names why pods are not Ready and the label a near miss lacks", () => {
    const notReady = diagnoseService(service("web", { selector: WEB }), view({ pods: [pod("web-1", WEB, { ready: false, waiting: "CrashLoopBackOff" })] }), { source: outside });
    expect(notReady.findings[1]?.notes).toEqual([{ key: "diagnose:service.notReadyReason", params: { reason: "CrashLoopBackOff", count: 1 } }]);
    const miss = diagnoseService(service("web", { selector: { app: "web", tier: "front" } }), view({ pods: [pod("web-1", { app: "web", tier: "x" })] }), { source: outside });
    expect(miss.findings[0]?.notes).toEqual([{ key: "diagnose:service.nearMiss", params: { count: 1, label: "tier=front" } }]);
  });

  it.each([
    ["db.example.com", "ok"],
    ["10.0.0.5", "warn"],
    ["https://db.example.com/x", "broken"],
    ["", "broken"],
  ])("ExternalName %j", (name, status) => {
    const chain = diagnoseService(service("db", { type: "ExternalName", externalName: name || undefined, selector: WEB }), view({}), { source: outside });
    expect(steps(chain)[0]).toBe(`service.externalName:${status}`);
    expect(chain.findings).toHaveLength(1);
  });

  it("a load balancer created a moment ago is on its way", () => {
    const svc = service("web", { selector: WEB, type: "LoadBalancer" });
    svc.metadata!.creationTimestamp = new Date(NOW - 60_000).toISOString();
    const chain = diagnoseService(svc, view({ pods: readyPods, slices: [goodSlice] }), { source: outside });
    expect(steps(chain).at(-1)).toBe("service.loadBalancer:warn");
  });

  it("tells DNS names", () => {
    expect(["a.b-c.example", "svc", "x.y."].map(isDnsName)).toEqual([true, true, true]);
    expect(["UPPER.example", "-a.example", "a_b.example", "a".repeat(64)].map(isDnsName)).toEqual([false, false, false, false]);
  });
});
