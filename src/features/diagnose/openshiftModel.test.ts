import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import { getDetailsSections } from "../../layout/details/registry";
import { getResourceDef } from "../../resources";
import objectsJson from "./fixtures/openshift-objects.json";
import { ROUTE, routeBackends, routeState, routeTargetPort, routeTls, routeUrl } from "./openshiftModel";
import "./register";

const objects = objectsJson as KubeObject[];
const byName = (kind: string, name: string): KubeObject => structuredClone(objects.find((o) => o.kind === kind && o.metadata?.name === name)!);
const sp = (o: KubeObject) => o.spec as Record<string, unknown>;

describe("what the diagnosis reads of a Route", () => {
  it("reads a Route's backends with their shares, its target port, TLS flags and where it answers", () => {
    const route = byName("Route", "frontend");
    expect(routeBackends(route).map((b) => [b.name, b.weight, b.percent])).toEqual([
      ["frontend", 100, 80],
      ["frontend-canary", 25, 20],
    ]);
    expect(routeTargetPort(route)).toBe("8080-tcp");
    expect(routeTargetPort(byName("Route", "api"))).toBe(8443);
    expect(routeTargetPort(byName("Route", "internal"))).toBeUndefined();
    expect(routeTls(route)).toEqual({
      termination: "edge",
      insecure: "Redirect",
      certificate: true,
      key: true,
      caCertificate: true,
      destinationCACertificate: false,
      externalCertificate: undefined,
    });
    expect(JSON.stringify(routeTls(route))).not.toMatch(/BEGIN|FIXTURE/);
    expect(routeUrl(route)).toBe("https://frontend-shop.apps.ocp.example.com/");
    expect(routeUrl(byName("Route", "internal"))).toBe("http://internal.shard2.example.com");
    const unweighted = structuredClone(route);
    delete (sp(unweighted).to as Record<string, unknown>).weight;
    expect(routeBackends(unweighted)[0]!.weight).toBe(100);
    (sp(unweighted).to as Record<string, unknown>).weight = 0;
    (sp(unweighted).alternateBackends as Record<string, unknown>[])[0]!.weight = 0;
    expect(routeBackends(unweighted).map((b) => b.percent)).toEqual([0, 0]);
  });

  it.each([
    ["frontend", "admitted"],
    ["api", "rejected"],
    ["internal", "pending"],
  ])("Route %s is %s", (name, state) => {
    expect(routeState(byName("Route", name))).toBe(state);
  });

  it("offers the Diagnose action and the Diagnosis tab on Routes, whose views are an extension's", () => {
    expect(getResourceDef(ROUTE).actions).toContain("diagnose");
    expect(getDetailsSections(ROUTE).map((s) => s.id)).toContain("diagnosis");
  });
});
