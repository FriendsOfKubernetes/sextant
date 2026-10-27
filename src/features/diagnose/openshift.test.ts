import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import objectsJson from "../openshift/fixtures/objects.json";
import { ROUTE } from "../openshift/model";
import "../openshift/register";
import { diagnosedKind } from "./engine";
import { chainStatus, firstBroken, type Chain } from "./model";
import { diagnoseOpenShiftRoute, openshiftDiagnoser, selectedPorts } from "./openshift";
import { NOW, view, type ViewInput } from "./testData";
import { serviceInfo } from "../netpol/model";

const objects = objectsJson as KubeObject[];
const byName = (kind: string, name: string): KubeObject => structuredClone(objects.find((o) => o.kind === kind && o.metadata?.name === name)!);
const steps = (chain: Chain) => [...chain.findings.map((f) => `${f.id}:${f.status}`), ...(chain.stopped ? ["…"] : [])];
const keys = (chain: Chain) => chain.findings.map((f) => f.text.key);
const spec = (o: KubeObject) => o.spec as Record<string, unknown>;

const healthy: ViewInput = {
  services: [byName("Service", "frontend"), byName("Service", "frontend-canary")],
  pods: [byName("Pod", "frontend-2-x7k2p")],
  slices: [byName("EndpointSlice", "frontend-abcde")],
};

describe("the OpenShift Route diagnosis", () => {
  it("is registered for Route, with no lists or Secrets of its own", () => {
    expect(diagnosedKind(ROUTE)).toBe("registered");
    const route = byName("Route", "frontend");
    expect(openshiftDiagnoser.lists(route, "shop")).toEqual([]);
    expect(openshiftDiagnoser.secrets(route, "shop")).toEqual([]);
    expect(openshiftDiagnoser.namespaces(route, "shop")).toEqual([]);
  });

  it("follows an admitted edge Route to each backend Service by the named target port", () => {
    const chain = diagnoseOpenShiftRoute(byName("Route", "frontend"), ROUTE, view(healthy));
    expect(steps(chain)).toEqual(["openshift.admitted:ok", "openshift.host:ok", "openshift.tls:ok"]);
    expect(chain.findings[1]!.text.params).toEqual({ url: "https://frontend-shop.apps.ocp.example.com/" });
    expect(keys(chain)[2]).toBe("openshift:diagnose.tlsEdge");
    expect(chain.findings[2]!.notes?.map((n) => n.key)).toEqual(["openshift:diagnose.insecureRedirect"]);
    const [primary, canary] = chain.chains as [Chain, Chain];
    expect(primary.title?.params).toEqual({ name: "frontend", weight: 100 });
    expect(primary.findings[0]).toMatchObject({ id: "openshift.service", status: "ok", text: { params: { name: "frontend", port: "8080-tcp 8080/TCP" } } });
    expect(chainStatus(primary)).not.toBe("broken");
    // The canary Service's port is named "web": the Route's "8080-tcp" selects none of its ports.
    expect(firstBroken(canary)?.text.key).toBe("openshift:diagnose.noNamedPort");
  });

  it("stops at a Route no router admitted, or none answered for after 2 minutes", () => {
    const rejected = diagnoseOpenShiftRoute(byName("Route", "api"), ROUTE, view(healthy));
    expect(steps(rejected)).toEqual(["openshift.admitted:broken", "…"]);
    expect(rejected.findings[0]!.text.params).toEqual({ reason: "HostAlreadyClaimed" });
    expect(rejected.findings[0]!.notes?.[0]?.params).toMatchObject({ router: "default", reason: "HostAlreadyClaimed" });
    const unanswered = byName("Route", "internal");
    expect(steps(diagnoseOpenShiftRoute(unanswered, ROUTE, view(healthy)))).toEqual(["openshift.admitted:broken", "…"]);
    unanswered.metadata!.creationTimestamp = new Date(NOW - 30_000).toISOString();
    const fresh = diagnoseOpenShiftRoute(unanswered, ROUTE, view(healthy));
    expect(fresh.findings[0]).toMatchObject({ status: "warn", text: { key: "openshift:diagnose.pending" } });
  });

  it("says a missing Service, a zero weight and a numbered target port no Service port leads to", () => {
    const route = byName("Route", "frontend");
    const chain = diagnoseOpenShiftRoute(route, ROUTE, view({ ...healthy, services: [byName("Service", "frontend")] }));
    expect(firstBroken(chain.chains[1]!)?.text).toEqual({ key: "openshift:diagnose.serviceMissing", params: { name: "frontend-canary", namespace: "shop" } });
    (spec(route).to as Record<string, unknown>).weight = 0;
    (spec(route).alternateBackends as Record<string, unknown>[])[0]!.weight = 0;
    expect(firstBroken(diagnoseOpenShiftRoute(route, ROUTE, view(healthy)))?.text.key).toBe("openshift:diagnose.allWeightsZero");
    (spec(route).to as Record<string, unknown>).weight = 1;
    const one = diagnoseOpenShiftRoute(route, ROUTE, view(healthy));
    expect(one.chains[1]!.findings[0]).toMatchObject({ id: "openshift.weight", status: "warn" });
    spec(route).port = { targetPort: 9090 };
    expect(firstBroken(diagnoseOpenShiftRoute(route, ROUTE, view(healthy)).chains[0]!)?.text.key).toBe("openshift:diagnose.noTargetPort");
  });

  it("reads the TLS beside the path: a certificate without a key is broken, the router's own certificate is not", () => {
    const route = byName("Route", "frontend");
    delete (spec(route).tls as Record<string, unknown>).key;
    const chain = diagnoseOpenShiftRoute(route, ROUTE, view(healthy));
    expect(chain.findings.find((f) => f.id === "openshift.tls")).toMatchObject({ status: "broken", text: { key: "openshift:diagnose.tlsNoKey" } });
    // Beside the path: the backends are still followed.
    expect(chain.chains).toHaveLength(2);
    spec(route).tls = { termination: "reencrypt" };
    const reencrypt = diagnoseOpenShiftRoute(route, ROUTE, view(healthy)).findings.find((f) => f.id === "openshift.tls")!;
    expect(reencrypt.status).toBe("ok");
    expect(reencrypt.notes?.map((n) => n.key)).toEqual(["openshift:diagnose.tlsRouterCertificate", "openshift:diagnose.tlsServiceCa"]);
    // No finding carries any of the certificate fields' values.
    expect(JSON.stringify(diagnoseOpenShiftRoute(byName("Route", "frontend"), ROUTE, view(healthy)))).not.toMatch(/BEGIN|FIXTURE/);
  });

  it.each([
    ["8080-tcp", ["8080-tcp"]],
    [8080, ["8080-tcp"]],
    [9090, []],
    [undefined, ["8080-tcp"]],
  ] as const)("selects the Service ports of target port %s", (target, names) => {
    const info = serviceInfo(byName("Service", "frontend"));
    expect(selectedPorts(info.ports, target)?.map((p) => p.name)).toEqual(names);
  });

  it("cannot tell a numbered target port a named Service target port may lead to", () => {
    const named = serviceInfo({ ...byName("Service", "frontend"), spec: { ports: [{ name: "http", port: 80, targetPort: "web" }] } });
    expect(selectedPorts(named.ports, 8080)).toBeUndefined();
  });
});
