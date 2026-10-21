import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import { copy } from "../details/testing";
import { INGRESS_ROUTE } from "../traefik/model";
import { chainStatus, firstBroken, type Chain, type ClusterView } from "./model";
import { diagnose, diagnosedKind } from "./engine";
import { NS, certificate, pod, service, slice, view, type ViewInput } from "./testData";
import { diagnoseIngressRoute } from "./traefik";

const WEB = { app: "web" };
const steps = (chain: Chain) => [...chain.findings.map((f) => `${f.id}:${f.status}`), ...(chain.stopped ? ["…"] : [])];

function route(spec: Record<string, unknown>): KubeObject {
  return { apiVersion: "traefik.io/v1alpha1", kind: "IngressRoute", metadata: { name: "shop", namespace: NS, uid: "ir-shop" }, spec };
}

const traefik = (kind: string, name: string, spec: Record<string, unknown>, namespace = NS): KubeObject => ({
  apiVersion: "traefik.io/v1alpha1",
  kind,
  metadata: { name, namespace, uid: `${kind}-${name}` },
  spec,
});

/** The test view plus the Traefik lists (`traefik.containo.us` not served). */
function withTraefik(input: ViewInput, objects: KubeObject[], unreadable: string[] = []): ClusterView {
  const base = view(input);
  return {
    ...base,
    objects: (kind, ns) => {
      if (kind.group !== "traefik.io") return null;
      if (unreadable.includes(ns)) return undefined;
      return objects.filter((o) => o.kind === kind.kind && o.metadata?.namespace === ns);
    },
  };
}

const healthy: ViewInput = {
  services: [service("web", { selector: WEB })],
  pods: [pod("web-1", WEB)],
  slices: [slice("web", [{ pod: "web-1" }])],
};

const simple = route({
  entryPoints: ["websecure"],
  routes: [{ match: "Host(`shop.example.com`)", kind: "Rule", middlewares: [{ name: "auth" }], services: [{ name: "web", port: 80 }] }],
});

describe("an IngressRoute's path", () => {
  it("is a registered route kind of the diagnosis", () => {
    expect(diagnosedKind(INGRESS_ROUTE)).toBe("registered");
    expect(diagnosedKind({ group: "traefik.containo.us", kind: "IngressRoute" })).toBe("registered");
    expect(diagnosedKind({ group: "traefik.io", kind: "IngressRouteTCP" })).toBeUndefined();
  });

  it("follows the route, its middleware and Service down to the pods", () => {
    const chain = diagnose(INGRESS_ROUTE, simple, withTraefik(healthy, [traefik("Middleware", "auth", { basicAuth: { secret: "s" } })]));
    expect(steps(chain)).toEqual(["traefik.entryPoints:ok"]);
    const [r] = chain.chains;
    expect(steps(r!)).toEqual(["traefik.rule:ok", "traefik.middleware.0:ok"]);
    const backend = r!.chains[0]!;
    expect(steps(backend).slice(0, 2)).toEqual(["traefik.service:ok", "service.selector:ok"]);
    expect(chainStatus(chain)).toBe("ok");
    // No status to read: said once, as a note of the first link.
    expect(chain.findings[0]!.notes?.[0]?.key).toBe("traefik:diagnose.noStatus");
  });

  it("breaks on a middleware or Service that does not exist", () => {
    const noMiddleware = diagnoseIngressRoute(simple, INGRESS_ROUTE, withTraefik(healthy, []));
    expect(steps(noMiddleware.chains[0]!)).toEqual(["traefik.rule:ok", "traefik.middleware.0:broken", "…"]);
    expect(firstBroken(noMiddleware)?.text).toEqual({ key: "traefik:diagnose.refMissing", params: { kind: "Middleware", name: "auth", namespace: NS } });
    const noService = diagnoseIngressRoute(simple, INGRESS_ROUTE, withTraefik({ ...healthy, services: [] }, [traefik("Middleware", "auth", {})]));
    expect(steps(noService.chains[0]!.chains[0]!)).toEqual(["traefik.service:broken", "…"]);
  });

  it("leaves a reference into another namespace, another provider's object or an unread list unknown", () => {
    const cross = route({ routes: [{ match: "Host(`a`)", middlewares: [{ name: "auth", namespace: "infra" }, { name: "x@file" }], services: [{ name: "web", port: 80 }] }] });
    const v = withTraefik(healthy, [traefik("Middleware", "auth", {}, "infra")]);
    expect(steps(diagnoseIngressRoute(cross, INGRESS_ROUTE, v).chains[0]!)).toEqual([
      "traefik.rule:ok",
      "traefik.middleware.0:unknown",
      "traefik.middleware.1:unknown",
    ]);
    // A missing object in another namespace is broken whatever the provider allows.
    expect(steps(diagnoseIngressRoute(cross, INGRESS_ROUTE, withTraefik(healthy, [])).chains[0]!)).toContain("traefik.middleware.0:broken");
    // The lists could not be read: unknown, not broken.
    expect(steps(diagnoseIngressRoute(simple, INGRESS_ROUTE, withTraefik(healthy, [], [NS])).chains[0]!)).toContain("traefik.middleware.0:unknown");
  });

  it("follows weighted and mirrored TraefikServices down to Services; api@internal always exists", () => {
    const ir = route({
      routes: [
        { match: "PathPrefix(`/`)", services: [{ kind: "TraefikService", name: "wrr" }] },
        { match: "PathPrefix(`/dashboard`)", services: [{ kind: "TraefikService", name: "api@internal" }] },
      ],
    });
    const objects = [
      traefik("TraefikService", "wrr", { weighted: { services: [{ name: "web", port: 80, weight: 3 }, { name: "mirror", kind: "TraefikService", weight: 0 }] } }),
      traefik("TraefikService", "mirror", { mirroring: { name: "web", port: 80, mirrors: [{ name: "gone", port: 80, percent: 10 }] } }),
    ];
    const chain = diagnoseIngressRoute(ir, INGRESS_ROUTE, withTraefik(healthy, objects));
    const wrr = chain.chains[0]!.chains[0]!;
    expect(steps(wrr)).toEqual(["traefik.service:ok"]);
    expect(steps(wrr.chains[0]!).slice(0, 2)).toEqual(["traefik.service:ok", "service.selector:ok"]);
    const mirror = wrr.chains[1]!;
    expect(steps(mirror)).toEqual(["traefik.weight:warn", "traefik.service:ok"]);
    expect(steps(mirror.chains[1]!)).toEqual(["traefik.service:broken", "…"]);
    expect(mirror.chains[1]!.title?.key).toBe("traefik:diagnose.mirrorTitle");
    expect(steps(chain.chains[1]!.chains[0]!)).toEqual(["traefik.service:ok"]);
  });

  it("checks the TLS Secret's certificate against the route's hosts and the TLSOption it names", () => {
    const tls = route({
      routes: [{ match: "Host(`shop.example.com`)", services: [{ name: "web", port: 80 }] }],
      tls: { secretName: "shop-tls", options: { name: "strict" } },
    });
    const good = withTraefik({ ...healthy, certificates: { [`${NS}/shop-tls`]: { state: "ready", info: { chain: [certificate(["shop.example.com"])], ca: [], caInvalid: false, chainTruncated: false } } } }, [
      traefik("TLSOption", "strict", {}),
    ]);
    expect(steps(diagnoseIngressRoute(tls, INGRESS_ROUTE, good))).toEqual(["traefik.entryPoints:ok", "traefik.tls:ok", "traefik.tls.options:ok"]);
    const wrongHost = copy(tls);
    (wrongHost.spec as { routes: { match: string }[] }).routes[0]!.match = "Host(`other.example.com`)";
    expect(steps(diagnoseIngressRoute(wrongHost, INGRESS_ROUTE, good))).toEqual(["traefik.entryPoints:ok", "traefik.tls:broken", "…"]);
    const missing = withTraefik({ ...healthy, certificates: { [`${NS}/shop-tls`]: { state: "notFound" } } }, []);
    expect(steps(diagnoseIngressRoute(tls, INGRESS_ROUTE, missing))).toEqual(["traefik.entryPoints:ok", "traefik.tls:broken", "…"]);
  });

  it("an empty match rule or another kind than Rule breaks only its route", () => {
    const ir = route({ routes: [{ match: "", services: [{ name: "web", port: 80 }] }, { match: "Host(`a`)", kind: "Regex", services: [] }] });
    const chain = diagnoseIngressRoute(ir, INGRESS_ROUTE, withTraefik(healthy, []));
    expect(chain.chains.map(steps)).toEqual([["traefik.rule:broken", "…"], ["traefik.rule:broken", "…"]]);
  });

  it("knows nothing of Traefik lists in an agent's view (no `objects`): unknown, never broken", () => {
    const chain = diagnoseIngressRoute(simple, INGRESS_ROUTE, view(healthy));
    expect(steps(chain.chains[0]!)).toEqual(["traefik.rule:ok", "traefik.middleware.0:unknown"]);
  });
});
