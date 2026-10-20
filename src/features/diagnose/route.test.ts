import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import { HTTP_ROUTE } from "../gateway-api/model";
import { chainStatus, type Chain, type Status } from "./model";
import { diagnoseRoute } from "./route";
import { NS, pod, service, slice, view, type ViewInput } from "./testData";

const WEB = { app: "web" };
const steps = (chain: Chain) => [...chain.findings.map((f) => `${f.id}:${f.status}`), ...(chain.stopped ? ["…"] : [])];
const branchSteps = (chain: Chain) => chain.chains.map((c) => steps(c));
const ok = (type: string) => ({ type, status: "True", reason: type });

function gateway(name: string, namespace = NS): KubeObject {
  return {
    apiVersion: "gateway.networking.k8s.io/v1",
    kind: "Gateway",
    metadata: { name, namespace, uid: `gw-${name}` },
    spec: { gatewayClassName: "eg", listeners: [{ name: "http", port: 80, protocol: "HTTP" }] },
    status: {
      addresses: [{ type: "IPAddress", value: "198.51.100.9" }],
      conditions: [ok("Accepted"), ok("Programmed")],
      listeners: [{ name: "http", attachedRoutes: 1, supportedKinds: [{ kind: "HTTPRoute" }], conditions: [ok("Accepted"), ok("Programmed"), ok("ResolvedRefs")] }],
    },
  };
}

interface RouteSpec {
  parents?: string[];
  /** Per parent: the Accepted condition's status and reason; missing: not reported. */
  accepted?: Record<string, [string, string]>;
  resolved?: [string, string];
  rules?: unknown[];
}

function route(spec: RouteSpec): KubeObject {
  const parents = spec.parents ?? ["gw"];
  return {
    apiVersion: "gateway.networking.k8s.io/v1",
    kind: "HTTPRoute",
    metadata: { name: "shop", namespace: NS, uid: "route-shop" },
    spec: {
      parentRefs: parents.map((name) => ({ name })),
      rules: spec.rules ?? [{ backendRefs: [{ name: "web", port: 80 }] }],
    },
    status: {
      parents: parents.flatMap((name) => {
        const accepted = spec.accepted ? spec.accepted[name] : ["True", "Accepted"];
        if (!accepted) return [];
        const conditions = [{ type: "Accepted", status: accepted[0], reason: accepted[1] }];
        if (spec.resolved) conditions.push({ type: "ResolvedRefs", status: spec.resolved[0], reason: spec.resolved[1] });
        return [{ parentRef: { name }, controllerName: "eg", conditions }];
      }),
    },
  };
}

const healthy: ViewInput = {
  services: [service("web", { selector: WEB })],
  pods: [pod("web-1", WEB)],
  slices: [slice("web", [{ pod: "web-1" }])],
  gateways: [gateway("gw"), gateway("other")],
};
const SERVICE_OK = ["route.backend:ok", "service.selector:ok", "service.ready:ok", "service.targetPort.0:ok", "service.slices:ok", "policies:ok"];

interface Case {
  name: string;
  obj: KubeObject;
  input?: Partial<ViewInput>;
  steps: string[];
  branches?: string[][];
  status: Status;
}

const cases: Case[] = [
  { name: "a healthy route", obj: route({}), steps: ["route.parent.0:ok"], branches: [SERVICE_OK], status: "ok" },
  { name: "no parents", obj: route({ parents: [] }), steps: ["route.parents:broken", "…"], status: "broken" },
  {
    name: "the Gateway did not accept it",
    obj: route({ accepted: { gw: ["False", "NotAllowedByListeners"] } }),
    steps: ["route.parent.0:broken", "…"],
    branches: [],
    status: "broken",
  },
  {
    name: "one of two Gateways accepted it",
    obj: route({ parents: ["gw", "other"], accepted: { gw: ["False", "NoMatchingListenerHostname"], other: ["True", "Accepted"] } }),
    steps: ["route.parent.0:warn", "route.parent.1:ok"],
    branches: [SERVICE_OK],
    status: "warn",
  },
  {
    name: "no controller reported yet",
    obj: route({ accepted: {} }),
    steps: ["route.parent.0:warn"],
    branches: [SERVICE_OK],
    status: "warn",
  },
  {
    name: "a Gateway that does not exist",
    obj: route({ parents: ["gone"] }),
    steps: ["route.parent.0:broken", "…"],
    status: "broken",
  },
  {
    name: "a backend Service that does not exist",
    obj: route({ rules: [{ backendRefs: [{ name: "api", port: 80 }] }, { backendRefs: [{ name: "web", port: 80 }] }] }),
    steps: ["route.parent.0:ok"],
    branches: [["route.backend:broken", "…"], SERVICE_OK],
    status: "broken",
  },
  {
    name: "a backend in another namespace without a ReferenceGrant",
    obj: route({ resolved: ["False", "RefNotPermitted"], rules: [{ backendRefs: [{ name: "web", namespace: "other", port: 80 }] }] }),
    steps: ["route.parent.0:ok"],
    branches: [["route.backend:broken", "…"]],
    status: "broken",
  },
  {
    name: "a backend with weight 0",
    obj: route({ rules: [{ backendRefs: [{ name: "web", port: 80, weight: 0 }] }] }),
    steps: ["route.parent.0:ok"],
    branches: [["route.weight:warn", ...SERVICE_OK]],
    status: "warn",
  },
  {
    name: "a rule without backends, and one that redirects",
    obj: route({ rules: [{ matches: [{ path: { value: "/a" } }] }, { filters: [{ type: "RequestRedirect", requestRedirect: { scheme: "https" } }] }] }),
    steps: ["route.parent.0:ok"],
    branches: [["route.rule:broken", "…"], ["route.rule:ok"]],
    status: "broken",
  },
  {
    name: "a backend port the Service does not have",
    obj: route({ rules: [{ backendRefs: [{ name: "web", port: 8443 }] }] }),
    steps: ["route.parent.0:ok"],
    branches: [["route.backend:ok", "service.port:broken", "…"]],
    status: "broken",
  },
];

describe("diagnoseRoute", () => {
  it.each(cases)("$name", (c) => {
    const chain = diagnoseRoute(c.obj, HTTP_ROUTE, view({ ...healthy, ...c.input }));
    expect(steps(chain)).toEqual(c.steps);
    if (c.branches) expect(branchSteps(chain)).toEqual(c.branches);
    expect(chainStatus(chain)).toBe(c.status);
  });

  it("explains a rejection with the Gateway API section's words", () => {
    const chain = diagnoseRoute(route({ accepted: { gw: ["False", "NotAllowedByListeners"] } }), HTTP_ROUTE, view(healthy));
    expect(chain.findings[0]?.notes?.[0]).toEqual({ key: "gateway:reasons.NotAllowedByListeners" });
  });

  it("names the listeners it is attached to", () => {
    const chain = diagnoseRoute(route({}), HTTP_ROUTE, view(healthy));
    expect(chain.findings[0]?.text).toEqual({ key: "diagnose:route.parentAccepted", params: { name: "gw", listeners: ["http"] } });
  });
});
