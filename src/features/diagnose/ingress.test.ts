import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import { controllerSelector } from "./controllers";
import { diagnoseIngress } from "./ingress";
import { chainStatus, type Chain, type Status } from "./model";
import { certificate, ingress, ingressClass, networkPolicy, pod, service, slice, view, type ViewInput } from "./testData";
import { nameCovers } from "./tls";

const WEB = { app: "web" };
const NGINX = "k8s.io/ingress-nginx";
const steps = (chain: Chain) => [...chain.findings.map((f) => `${f.id}:${f.status}`), ...(chain.stopped ? ["…"] : [])];
const branchSteps = (chain: Chain) => chain.chains.map((c) => steps(c));

const backend = (name = "web", port: Record<string, unknown> = { number: 80 }) => ({ service: { name, port } });
const rule = (host: string, path = "/", b = backend(), pathType = "Prefix") => ({ host, http: { paths: [{ path, pathType, backend: b }] } });
const controllerPod = pod("ingress-nginx-controller-1", { "app.kubernetes.io/name": "ingress-nginx" }, { namespace: "ingress-nginx" });

/** A healthy cluster around an Ingress of class nginx in front of Service web. */
const healthy: ViewInput = {
  services: [service("web", { selector: WEB })],
  pods: [pod("web-1", WEB)],
  slices: [slice("web", [{ pod: "web-1" }])],
  classes: [ingressClass("nginx", NGINX)],
  controllerPods: { [NGINX]: [controllerPod] },
};

interface Case {
  name: string;
  obj: KubeObject;
  input?: Partial<ViewInput>;
  steps: string[];
  branches?: string[][];
  status: Status;
}

const cases: Case[] = [
  {
    name: "a healthy Ingress",
    obj: ingress("shop", { ingressClassName: "nginx", rules: [rule("shop.example.com")] }),
    steps: ["ingress.class:ok", "ingress.controller:ok", "ingress.address:ok"],
    branches: [["ingress.path.0:ok", "ingress.backend:ok", "service.selector:ok", "service.ready:ok", "service.targetPort.0:ok", "service.slices:ok", "policies:ok"]],
    status: "ok",
  },
  {
    name: "a class that does not exist stops everything",
    obj: ingress("shop", { ingressClassName: "traefik", rules: [rule("shop.example.com")] }),
    steps: ["ingress.class:broken", "…"],
    branches: [],
    status: "broken",
  },
  {
    name: "no class and no default class",
    obj: ingress("shop", { rules: [rule("shop.example.com")] }),
    steps: ["ingress.class:broken", "…"],
    status: "broken",
  },
  {
    name: "no class: the default class applies",
    obj: ingress("shop", { rules: [rule("shop.example.com")] }),
    input: { classes: [ingressClass("nginx", NGINX, true)] },
    steps: ["ingress.class:ok", "ingress.controller:ok", "ingress.address:ok"],
    status: "ok",
  },
  {
    name: "no controller pod and no address",
    obj: ingress("shop", { ingressClassName: "nginx", rules: [rule("shop.example.com")] }, []),
    input: { controllerPods: {} },
    steps: ["ingress.class:ok", "ingress.controller:broken", "…"],
    status: "broken",
  },
  {
    name: "a controller Sextant does not know, with an address",
    obj: ingress("shop", { ingressClassName: "other", rules: [rule("shop.example.com")] }),
    input: { classes: [ingressClass("other", "example.com/other")] },
    steps: ["ingress.class:ok", "ingress.controller:ok", "ingress.address:ok"],
    status: "ok",
  },
  {
    name: "a missing Service breaks only its own path",
    obj: ingress("shop", { ingressClassName: "nginx", rules: [rule("shop.example.com", "/api", backend("api")), rule("shop.example.com")] }),
    steps: ["ingress.class:ok", "ingress.controller:ok", "ingress.address:ok"],
    branches: [
      ["ingress.path.0:ok", "ingress.backend:broken", "…"],
      ["ingress.path.1:ok", "ingress.backend:ok", "service.selector:ok", "service.ready:ok", "service.targetPort.0:ok", "service.slices:ok", "policies:ok"],
    ],
    status: "broken",
  },
  {
    name: "a Service port by a name it does not have",
    obj: ingress("shop", { ingressClassName: "nginx", rules: [rule("shop.example.com", "/", backend("web", { name: "https" }))] }),
    steps: ["ingress.class:ok", "ingress.controller:ok", "ingress.address:ok"],
    branches: [["ingress.path.0:ok", "ingress.backend:ok", "service.port:broken", "…"]],
    status: "broken",
  },
  {
    name: "a path that does not start with a slash",
    obj: ingress("shop", { ingressClassName: "nginx", rules: [rule("shop.example.com", "api", backend(), "Exact")] }),
    steps: ["ingress.class:ok", "ingress.controller:ok", "ingress.address:ok"],
    branches: [["ingress.path.0:broken", "…"]],
    status: "broken",
  },
  {
    name: "neither rules nor a default backend",
    obj: ingress("shop", { ingressClassName: "nginx" }),
    steps: ["ingress.class:ok", "ingress.controller:ok", "ingress.address:ok", "ingress.rules:broken", "…"],
    status: "broken",
  },
  {
    name: "a TLS Secret that does not exist",
    obj: ingress("shop", { ingressClassName: "nginx", tls: [{ hosts: ["shop.example.com"], secretName: "shop-tls" }], rules: [rule("shop.example.com")] }),
    input: { certificates: { "shop/shop-tls": { state: "notFound" } } },
    steps: ["ingress.class:ok", "ingress.controller:ok", "ingress.address:ok", "ingress.tls.0:broken", "…"],
    status: "broken",
  },
  {
    name: "a certificate that does not cover the host",
    obj: ingress("shop", { ingressClassName: "nginx", tls: [{ hosts: ["shop.example.com"], secretName: "shop-tls" }], rules: [rule("shop.example.com")] }),
    input: { certificates: { "shop/shop-tls": { state: "ready", info: { chain: [certificate(["*.other.com"])], chainTruncated: false, ca: [], caInvalid: false } } } },
    steps: ["ingress.class:ok", "ingress.controller:ok", "ingress.address:ok", "ingress.tls.0:broken", "…"],
    status: "broken",
  },
  {
    name: "an expired certificate",
    obj: ingress("shop", { ingressClassName: "nginx", tls: [{ hosts: ["shop.example.com"], secretName: "shop-tls" }], rules: [rule("shop.example.com")] }),
    input: { certificates: { "shop/shop-tls": { state: "ready", info: { chain: [certificate(["*.example.com"], { notAfter: "2026-01-01T00:00:00Z" })], chainTruncated: false, ca: [], caInvalid: false } } } },
    steps: ["ingress.class:ok", "ingress.controller:ok", "ingress.address:ok", "ingress.tls.0:broken", "…"],
    status: "broken",
  },
  {
    name: "a wildcard certificate that covers the host, and a default backend",
    obj: ingress("shop", { ingressClassName: "nginx", tls: [{ hosts: ["shop.example.com"], secretName: "shop-tls" }], defaultBackend: backend() }),
    input: { certificates: { "shop/shop-tls": { state: "ready", info: { chain: [certificate(["*.example.com"])], chainTruncated: false, ca: [], caInvalid: false } } } },
    steps: ["ingress.class:ok", "ingress.controller:ok", "ingress.address:ok", "ingress.tls.0:ok"],
    branches: [["ingress.backend:ok", "service.selector:ok", "service.ready:ok", "service.targetPort.0:ok", "service.slices:ok", "policies:ok"]],
    status: "ok",
  },
  {
    name: "a policy that lets in only the controller's namespace",
    obj: ingress("shop", { ingressClassName: "nginx", rules: [rule("shop.example.com")] }),
    input: {
      policies: [
        networkPolicy("from-nginx", {
          podSelector: {},
          ingress: [{ from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "ingress-nginx" } } }] }],
        }),
      ],
    },
    steps: ["ingress.class:ok", "ingress.controller:ok", "ingress.address:ok"],
    branches: [["ingress.path.0:ok", "ingress.backend:ok", "service.selector:ok", "service.ready:ok", "service.targetPort.0:ok", "service.slices:ok", "policies:ok"]],
    status: "ok",
  },
  {
    name: "a policy that keeps the controller out",
    obj: ingress("shop", { ingressClassName: "nginx", rules: [rule("shop.example.com")] }),
    input: { policies: [networkPolicy("same-ns", { podSelector: {}, ingress: [{ from: [{ podSelector: {} }] }] })] },
    steps: ["ingress.class:ok", "ingress.controller:ok", "ingress.address:ok"],
    branches: [["ingress.path.0:ok", "ingress.backend:ok", "service.selector:ok", "service.ready:ok", "service.targetPort.0:ok", "service.slices:ok", "policies:broken", "…"]],
    status: "broken",
  },
];

describe("diagnoseIngress", () => {
  it.each(cases)("$name", (c) => {
    const chain = diagnoseIngress(c.obj, view({ ...healthy, ...c.input }));
    expect(steps(chain)).toEqual(c.steps);
    if (c.branches) expect(branchSteps(chain)).toEqual(c.branches);
    expect(chainStatus(chain)).toBe(c.status);
  });

  it("says what a path type means", () => {
    const keys = (path: string, pathType: string) =>
      diagnoseIngress(ingress("shop", { ingressClassName: "nginx", rules: [rule("a.example.com", path, backend(), pathType)] }), view(healthy)).chains[0]
        ?.findings[0]?.text.key;
    expect(keys("/", "Prefix")).toBe("diagnose:ingress.pathEverything");
    expect(keys("/api", "Prefix")).toBe("diagnose:ingress.pathPrefix");
    expect(keys("/api/(.*)", "Prefix")).toBe("diagnose:ingress.prefixRegex");
    expect(keys("/api", "Exact")).toBe("diagnose:ingress.pathExact");
    expect(keys("/api/(.*)", "ImplementationSpecific")).toBe("diagnose:ingress.pathImplementationSpecific");
  });

  it("matches certificate names like TLS clients", () => {
    expect(nameCovers("*.example.com", "shop.example.com")).toBe(true);
    expect(nameCovers("*.example.com", "a.shop.example.com")).toBe(false);
    expect(nameCovers("*.example.com", "example.com")).toBe(false);
    expect(nameCovers("Shop.Example.com", "shop.example.com")).toBe(true);
    expect(nameCovers("*.example.com", "*.example.com")).toBe(true);
  });

  it("knows the pods of a few controllers only", () => {
    expect(controllerSelector(NGINX)).toBe("app.kubernetes.io/name=ingress-nginx");
    expect(controllerSelector("example.com/unknown")).toBeUndefined();
    expect(controllerSelector("toString")).toBeUndefined();
  });
});
