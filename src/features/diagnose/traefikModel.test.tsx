import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings, type AppSettings, type KindRef, type KubeObject, type ObjectRef, type ResourceKind, type WatchSpec } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { getDetailsSections } from "../../layout/details/registry";
import { getResourceDef, resetClusterKinds } from "../../resources";
import { axeViolations } from "../../test/axe";
import "../details";
import { watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore } from "../namespaces";
import { resetProblemSources } from "../problems/store";
import { resetSharedWatches } from "../resource-map/watches";
import "./index";
import fixtures from "./fixtures/traefik-objects.json";
import {
  checkRef,
  hostsOf,
  INGRESS_ROUTE,
  INGRESS_ROUTE_TCP,
  INGRESS_ROUTE_UDP,
  LEGACY_GROUP,
  refOf,
  routeSpec,
  traefikServiceRefs,
  type Lookup,
  type RefKind,
} from "./traefikModel";

const fx = fixtures as unknown as Record<string, KubeObject> & { services: KubeObject[]; secrets: KubeObject[] };
const all = [fx.ingressRoute!, fx.wrr!, fx.mirror!, fx.chain!, fx.httpsOnly!, fx.knownIps!, fx.authUsers!, fx.tlsOption!, fx.tlsStore!, fx.transport!];
const names = (list: { kind: string; name: string }[]) => list.map((r) => `${r.kind} ${r.name}`);

/** A lookup over the fixtures (`gone`: objects to treat as missing; `unread`: kinds whose lists are unknown). */
function lookup(gone: string[] = [], unread: string[] = []): Lookup {
  const objects = [...all, ...fx.services, ...fx.secrets].filter((o) => !gone.includes(o.metadata?.name ?? ""));
  return {
    exists: (kind, ns, name) =>
      unread.includes(kind) ? undefined : objects.some((o) => o.kind === kind && o.metadata?.namespace === ns && o.metadata?.name === name),
  };
}

describe("what the diagnosis reads of Traefik's objects, in the shapes of Traefik's types", () => {
  it("reads routes, their match rules, middlewares, services and TLS", () => {
    const spec = routeSpec(INGRESS_ROUTE, fx.ingressRoute!);
    expect(spec.entryPoints).toEqual(["websecure"]);
    expect(spec.routes.map((r) => [r.match, r.priority, names(r.middlewares), names(r.services)])).toEqual([
      ["Host(`foo.example.net`) && PathPrefix(`/bar`)", 10, ["Middleware secured"], ["Service foo"]],
      ["Host(`foo.example.net`) && PathPrefix(`/wrr`)", undefined, [], ["TraefikService wrr1"]],
      ["PathPrefix(`/dashboard`)", undefined, [], ["TraefikService api"]],
    ]);
    expect(spec.routes[2]!.services[0]!.provider).toBe("internal");
    expect(spec.tls).toMatchObject({ secretName: "supersecret", options: { kind: "TLSOption", name: "opt" }, domains: ["foo.example.net"], passthrough: false });
    expect(routeSpec(INGRESS_ROUTE_TCP, fx.tcpRoute!).tls?.passthrough).toBe(true);
    expect(routeSpec(INGRESS_ROUTE_UDP, fx.udpRoute!).routes[0]!.services.map((s) => [s.name, s.port])).toEqual([["foo", 8080]]);
  });

  it("finds exact hosts in Host and HostSNI rules (not regular expressions or *)", () => {
    expect(hostsOf("Host(`a.example.com`) || Host(`B.example.com`) && PathPrefix(`/x`)")).toEqual(["a.example.com", "b.example.com"]);
    expect(hostsOf('Host("a.example.com", "c.example.com")')).toEqual(["a.example.com", "c.example.com"]);
    expect(hostsOf("HostSNI(`*`)")).toEqual([]);
    expect(hostsOf("HostRegexp(`^.+\\.example\\.com$`)")).toEqual([]);
  });

  it("resolves a reference's namespace and provider as Traefik does", () => {
    expect(refOf("Middleware", "auth", undefined, "shop", "route")).toMatchObject({ namespace: "shop", crossNamespace: false });
    expect(refOf("Middleware", "auth", "infra", "shop", "route")).toMatchObject({ namespace: "infra", crossNamespace: true });
    expect(refOf("Middleware", "auth@file", "infra", "shop", "route")).toMatchObject({ name: "auth", provider: "file", namespace: "shop", crossNamespace: false });
  });

  it("lists a TraefikService's children, a mirror with its percent", () => {
    expect(names(traefikServiceRefs(fx.wrr!))).toEqual(["Service svc1", "TraefikService mirror1"]);
    expect(traefikServiceRefs(fx.mirror!).map((r) => [r.name, r.place, r.weight])).toEqual([
      ["svc1", "service", undefined],
      ["svc2", "mirror", 20],
    ]);
  });
});

describe("what a reference finds", () => {
  it("found, missing, or an unknown service kind; api@internal always exists", () => {
    const [foo, secured] = routeSpec(INGRESS_ROUTE, fx.ingressRoute!).routes[0]!.refs;
    expect(checkRef(foo!, lookup())).toBe("found");
    expect(checkRef(secured!, lookup(["secured"]))).toBe("missing");
    expect(checkRef(refOf("TraefikService", "api@internal", undefined, "default", "route"), lookup())).toBe("found");
    expect(checkRef({ ...foo!, badKind: "ExternalName" }, lookup())).toBe("badKind");
  });

  it("another namespace, another provider or an unread list is open, never found nor missing", () => {
    expect(checkRef(refOf("Middleware", "secured", "default", "elsewhere", "route"), lookup())).toBe("crossNamespace");
    expect(checkRef(refOf("Middleware", "x@file", undefined, "default", "route"), lookup())).toBe("otherProvider");
    expect(checkRef(refOf("Middleware", "secured", undefined, "default", "route"), lookup([], ["Middleware"]))).toBe("unknown");
  });

  it("where both groups are served, a target only in the old group is 'legacy only' from traefik.io, found from the old group", () => {
    const legacyOnly = (names: string[]): Lookup => ({
      exists: () => false,
      legacy: (_kind: RefKind, _ns: string, name: string) => names.includes(name),
    });
    const secured = refOf("Middleware", "secured", undefined, "default", "route");
    expect(checkRef(secured, legacyOnly(["secured"]))).toBe("legacyOnly");
    expect(checkRef(secured, legacyOnly(["secured"]), true)).toBe("found");
    expect(checkRef(secured, legacyOnly([]))).toBe("missing");
    // The old group's list is not known: Traefik 2.10 might find the target there.
    expect(checkRef(secured, { exists: () => false, legacy: () => undefined })).toBe("unknown");
  });
});

const SERVICE: KindRef = { group: "", version: "v1", kind: "Service" };
const SECRET: KindRef = { group: "", version: "v1", kind: "Secret" };
const TRAEFIK_KINDS = ["IngressRoute", "Middleware", "TraefikService", "TLSOption", "TLSStore"].map((kind): KindRef => ({ group: "traefik.io", version: "v1alpha1", kind }));
function served(kind: KindRef): ResourceKind {
  return { kindRef: kind, plural: `${kind.kind.toLowerCase()}s`, namespaced: true, verbs: ["list", "watch"], printerColumns: [] };
}

let wb: WatchBackend;
let stored: AppSettings;

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetProblemSources();
  resetSharedWatches();
  resetSettingsCache();
  resetNamespaceRestore();
  stored = defaultAppSettings();
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => [SERVICE, SECRET, ...TRAEFIK_KINDS].map(served));
  wb.backend.on("settings_get", () => structuredClone(stored));
});

afterEach(() => {
  wb.backend.restore();
  resetClusterKinds();
  resetProblemSources();
  resetSharedWatches();
  resetSettingsCache();
});

function emitAll(kind: string, items: KubeObject[], match: (s: WatchSpec) => boolean = () => true): void {
  for (const [id, spec] of wb.specs) {
    if (spec.kind.kind !== kind || !match(spec) || wb.backend.listenerCount(`watch:${id}`) === 0) continue;
    act(() => wb.backend.emit(`watch:${id}`, { type: "snapshot", items }));
  }
}

describe("the Diagnose action and the Diagnosis tab, whose views are an extension's", () => {
  it("are offered on IngressRoutes of either group, not on the other Traefik kinds", () => {
    expect(getResourceDef(INGRESS_ROUTE).actions).toContain("diagnose");
    expect(getResourceDef({ ...INGRESS_ROUTE, group: LEGACY_GROUP }).actions).toContain("diagnose");
    expect(getResourceDef({ ...INGRESS_ROUTE, kind: "Middleware" }).actions).not.toContain("diagnose");
    expect(getDetailsSections(INGRESS_ROUTE).map((s) => s.id)).toContain("diagnosis");
    expect(getDetailsSections({ ...INGRESS_ROUTE, group: LEGACY_GROUP }).map((s) => s.id)).toContain("diagnosis");
  });

  it("the tab lists the route's Traefik objects in its namespace only, follows the routes and passes axe", async () => {
    wb.backend.on("tls_certificate_info", () => {
      throw { code: "notFound", message: "no tls.crt" };
    });
    const obj = fx.ingressRoute!;
    const ref: ObjectRef = { kind: INGRESS_ROUTE, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
    useAppStore.getState().openDetails(ref);
    const { container } = render(<DetailsPanel clusterId="c1" objectRef={ref} />);
    await watchOf(wb, "IngressRoute", (s) => s.fieldSelector === `metadata.name=${ref.name}`);
    emitAll("IngressRoute", [obj], (s) => s.fieldSelector === `metadata.name=${ref.name}`);
    fireEvent.click(await screen.findByRole("tab", { name: "Diagnosis" }));
    const inDefault = (s: WatchSpec) => JSON.stringify(s.namespaces) === JSON.stringify(["default"]) && s.fieldSelector === null && !s.metadataOnly;
    for (const kind of ["Middleware", "TraefikService", "TLSOption"]) {
      await watchOf(wb, kind, inDefault);
      emitAll(kind, all.filter((o) => o.kind === kind), inDefault);
    }
    emitAll("TLSStore", [], inDefault);
    emitAll("IngressRoute", [obj], inDefault);
    emitAll("Service", fx.services, inDefault);
    // A missing TLS Secret is a warning: Traefik builds the router anyway, so the routes are still followed.
    await screen.findByText("The TLS Secret supersecret does not exist in the namespace default.");
    expect(screen.queryByText(/^Traffic stops here:/)).toBeNull();
    expect(await screen.findByText("Matches Host(`foo.example.net`) && PathPrefix(`/bar`).")).toBeInTheDocument();
    // Nothing of the old group is listed where the cluster does not serve it.
    expect([...wb.specs.values()].some((s) => s.kind.group === "traefik.containo.us")).toBe(false);
    // The built-in Traefik details section is gone with the view.
    expect(container.querySelector("[data-section='traefik']")).toBeNull();
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
