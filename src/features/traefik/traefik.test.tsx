import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings, type AppSettings, type KindRef, type KubeObject, type ObjectRef, type ResourceKind, type WatchSpec, type WatchState } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { Sidebar } from "../../layout/sidebar/Sidebar";
import { getResourceDef, resetClusterKinds } from "../../resources";
import { axeViolations } from "../../test/axe";
import "../details";
import "../diagnose";
import { copy, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore } from "../namespaces";
import { OPT_IN_CATEGORIES, PROBLEM_CATEGORIES } from "../problems/model";
import { resetProblemSources } from "../problems/store";
import { acquireWatch, resetSharedWatches } from "../resource-map/watches";
import fixtures from "./fixtures/objects.json";
import "./index";
import {
  hostsOf,
  INGRESS_ROUTE,
  INGRESS_ROUTE_TCP,
  INGRESS_ROUTE_UDP,
  MIDDLEWARE,
  middlewareRefs,
  referencesOf,
  refOf,
  routeSpec,
  secretsOf,
  SERVERS_TRANSPORT,
  TLS_OPTION,
  TLS_STORE,
  TRAEFIK_KINDS,
  TRAEFIK_SERVICE,
  traefikServiceRefs,
} from "./model";
import { toProblems, TRAEFIK_GRACE_MS } from "./provider";
import { checkRef, judge, type Lookup } from "./resolve";
import { acquireTraefik, buildFindings, getTraefik, lookupOf, REBUILD_DELAY_MS, resetTraefikStore, type TraefikList } from "./store";

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

describe("the model, in the shapes of Traefik's types", () => {
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

  it("lists every reference of the other kinds", () => {
    expect(names(traefikServiceRefs(fx.wrr!))).toEqual(["Service svc1", "TraefikService mirror1"]);
    expect(traefikServiceRefs(fx.mirror!).map((r) => [r.name, r.place, r.weight])).toEqual([
      ["svc1", "service", undefined],
      ["svc2", "mirror", 20],
    ]);
    expect(names(middlewareRefs(fx.chain!))).toEqual(["Middleware https-only", "Middleware known-ips", "Middleware auth-users"]);
    expect(names(middlewareRefs(fx.authUsers!))).toEqual(["Secret authsecret"]);
    expect(names(secretsOf(TLS_OPTION, fx.tlsOption!))).toEqual(["Secret client-ca"]);
    expect(names(secretsOf(TLS_STORE, fx.tlsStore!))).toEqual(["Secret default-certificate"]);
    expect(names(secretsOf(SERVERS_TRANSPORT, fx.transport!))).toEqual(["Secret foobar"]);
  });
});

describe("what the references find", () => {
  it("everything there: ok; api@internal always exists", () => {
    expect(judge(INGRESS_ROUTE, fx.ingressRoute!, lookup()).health).toBe("ok");
    expect(judge(TRAEFIK_SERVICE, fx.wrr!, lookup()).health).toBe("ok");
  });

  it("a missing Middleware, Service, TLSOption or Secret breaks the object; a missing TLSStore or route TLS Secret does not", () => {
    for (const gone of ["secured", "foo", "opt"]) expect(judge(INGRESS_ROUTE, fx.ingressRoute!, lookup([gone])).health).toBe("failed");
    expect(judge(MIDDLEWARE, fx.authUsers!, lookup(["authsecret"])).health).toBe("failed");
    // Traefik builds the router without its TLS Secret (and serves another certificate): shown, never breaking.
    const noTls = judge(INGRESS_ROUTE, fx.ingressRoute!, lookup(["supersecret"]));
    expect(noTls.health).toBe("partial");
    expect(noTls.checks.find((c) => c.ref.kind === "Secret")?.state).toBe("missing");
    const withStore = copy(fx.ingressRoute!);
    (withStore.spec as { tls: Record<string, unknown> }).tls.store = { name: "nostore" };
    const j = judge(INGRESS_ROUTE, withStore, lookup());
    expect(j.health).toBe("partial");
    expect(j.checks.find((c) => c.ref.kind === "TLSStore")?.state).toBe("missing");
  });

  it("another namespace, another provider or an unread list is partial, never failed", () => {
    const cross = refOf("Middleware", "secured", "default", "elsewhere", "route");
    expect(checkRef(cross, lookup())).toBe("crossNamespace");
    expect(checkRef(refOf("Middleware", "x@file", undefined, "default", "route"), lookup())).toBe("otherProvider");
    expect(judge(INGRESS_ROUTE, fx.ingressRoute!, lookup([], ["Middleware"])).health).toBe("partial");
  });

  it("a route Traefik skips by its shape, and a service kind it does not know", () => {
    const bad = copy(fx.ingressRoute!);
    const routes = (bad.spec as { routes: Record<string, unknown>[] }).routes;
    routes[0]!.match = "";
    routes[1]!.kind = "Regex";
    expect(judge(INGRESS_ROUTE, bad, lookup()).issues).toEqual([
      { type: "emptyMatch", route: 0 },
      { type: "unsupportedKind", route: 1, value: "Regex" },
    ]);
    const badKind = copy(fx.ingressRoute!);
    ((badKind.spec as { routes: { services: Record<string, unknown>[] }[] }).routes[0]!.services[0]!).kind = "ExternalName";
    expect(judge(INGRESS_ROUTE, badKind, lookup()).checks.find((c) => c.ref.name === "foo")?.state).toBe("badKind");
  });

  it("every reference of a route is listed once, in order", () => {
    expect(names(referencesOf(INGRESS_ROUTE, fx.ingressRoute!))).toEqual([
      "Service foo",
      "Middleware secured",
      "TraefikService wrr1",
      "TraefikService api",
      "Secret supersecret",
      "TLSOption opt",
    ]);
  });
});

const ready = (items: KubeObject[]): WatchState => ({ status: "ready", items: new Map(items.map((o, i) => [o.metadata?.uid ?? String(i), o])) });
const LEGACY = "traefik.containo.us";
const old = (obj: KubeObject, uid = `old-${obj.metadata?.name}`): KubeObject => ({ ...obj, apiVersion: `${LEGACY}/v1alpha1`, metadata: { ...obj.metadata, uid } });

describe("both groups served (Traefik v3 reads only traefik.io)", () => {
  const lists = (own: KubeObject[], legacy: KubeObject[]): TraefikList[] => [
    { kind: { group: "traefik.io", kind: "Middleware" }, state: ready(own) },
    { kind: { group: LEGACY, kind: "Middleware" }, state: ready(legacy) },
  ];
  const secured = refOf("Middleware", "secured", undefined, "default", "route");

  it("a target only in the old group is 'legacy only' from a traefik.io object, found from an old-group one", () => {
    const lookup = lookupOf(lists([], [old(fx.chain!)]), []);
    expect(checkRef(secured, lookup)).toBe("legacyOnly");
    expect(checkRef(secured, lookup, true)).toBe("found");
    const route = judge(INGRESS_ROUTE, fx.ingressRoute!, lookup, (r) => r.kind !== "Middleware");
    expect(route).toMatchObject({ health: "partial", checks: [{ state: "legacyOnly" }] });
    expect(judge({ group: LEGACY, kind: "IngressRoute" }, fx.ingressRoute!, lookup, (r) => r.kind !== "Middleware").health).toBe("ok");
  });

  it("a target in both groups is found in traefik.io, and the twin is told", () => {
    const lookup = lookupOf(lists([fx.chain!], [old(fx.chain!)]), []);
    const [check] = judge(INGRESS_ROUTE, fx.ingressRoute!, lookup, (r) => r.kind !== "Middleware").checks;
    expect(check).toMatchObject({ state: "found", legacyToo: true });
    // Only one group serves the kind: no twin, the one list decides.
    const one = lookupOf([{ kind: { group: LEGACY, kind: "Middleware" }, state: ready([old(fx.chain!)]) }], []);
    expect(judge(INGRESS_ROUTE, fx.ingressRoute!, one, (r) => r.kind !== "Middleware").checks[0]).toEqual({ ref: expect.anything(), state: "found" });
  });
});

describe("a rebuild of the findings", () => {
  /** `n` IngressRoutes, each naming its own Middleware and Service, in one namespace. */
  function lists(n: number): { lists: TraefikList[]; services: WatchState } {
    const routes: KubeObject[] = [];
    const middlewares: KubeObject[] = [];
    const services: KubeObject[] = [];
    for (let i = 0; i < n; i++) {
      routes.push({ apiVersion: "traefik.io/v1alpha1", kind: "IngressRoute", metadata: { name: `r${i}`, namespace: "ns", uid: `r${i}` }, spec: { routes: [{ match: `Host(\`h${i}\`)`, middlewares: [{ name: `m${i}` }], services: [{ name: `s${i}`, port: 80 }] }] } });
      middlewares.push({ apiVersion: "traefik.io/v1alpha1", kind: "Middleware", metadata: { name: `m${i}`, namespace: "ns", uid: `m${i}` }, spec: { headers: {} } });
      services.push({ apiVersion: "v1", kind: "Service", metadata: { name: `s${i}`, namespace: "ns", uid: `s${i}` } });
    }
    return {
      lists: [
        { kind: { group: "traefik.io", kind: "IngressRoute" }, state: ready(routes) },
        { kind: { group: "traefik.io", kind: "Middleware" }, state: ready(middlewares) },
      ],
      services: ready(services),
    };
  }

  /** The fastest of a few rebuilds, each over fresh list states (so each indexes its lists anew). */
  function fastest(n: number): number {
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 5; run++) {
      const input = lists(n);
      const started = performance.now();
      const spec: WatchSpec = { kind: SERVICE, namespaces: ["ns"], labelSelector: null, fieldSelector: null, metadataOnly: true };
      const findings = buildFindings(input.lists, lookupOf(input.lists, [{ kind: "Service", spec, state: input.services }]));
      best = Math.min(best, performance.now() - started);
      expect(findings.every((f) => f.judgement.health === "ok")).toBe(true);
    }
    return best;
  }

  it("stays linear: ten times the objects take about ten times as long, not a hundred", () => {
    fastest(200); // warm-up
    const one = fastest(1000);
    const ten = fastest(10_000);
    // Linear measures about 8 here; a lookup that scanned a list per reference about 50.
    expect(ten / Math.max(one, 0.5)).toBeLessThan(25);
  });
});

const SERVICE: KindRef = { group: "", version: "v1", kind: "Service" };
const SECRET: KindRef = { group: "", version: "v1", kind: "Secret" };
const OWN = TRAEFIK_KINDS.filter((d) => d.kind.group === "traefik.io").map((d) => d.kind);
function served(kind: KindRef): ResourceKind {
  return { kindRef: kind, plural: `${kind.kind.toLowerCase()}s`, namespaced: true, verbs: ["list", "watch"], printerColumns: [] };
}

let wb: WatchBackend;
let stored: AppSettings;

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetProblemSources();
  resetTraefikStore();
  resetSharedWatches();
  resetSettingsCache();
  resetNamespaceRestore();
  stored = defaultAppSettings();
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => [SERVICE, SECRET, ...OWN].map(served));
  wb.backend.on("settings_get", () => structuredClone(stored));
});

afterEach(() => {
  wb.backend.restore();
  resetClusterKinds();
  resetProblemSources();
  resetTraefikStore();
  resetSharedWatches();
  resetSettingsCache();
});

function emitAll(kind: string, items: KubeObject[], match: (s: WatchSpec) => boolean = () => true): void {
  for (const [id, spec] of wb.specs) {
    if (spec.kind.kind !== kind || !match(spec) || wb.backend.listenerCount(`watch:${id}`) === 0) continue;
    act(() => wb.backend.emit(`watch:${id}`, { type: "snapshot", items }));
  }
}

const settle = () => act(() => new Promise<void>((r) => setTimeout(r, REBUILD_DELAY_MS + 150)));

/**
 * Answers every Traefik list with the fixtures (less `without`), then the Services (metadata only); the Secrets
 * (metadata only) when `secrets` — only open details list them.
 */
async function feed(without: string[] = [], secrets = false): Promise<void> {
  await watchOf(wb, "IngressRoute");
  for (const kind of OWN) emitAll(kind.kind, all.filter((o) => o.kind === kind.kind && !without.includes(o.metadata?.name ?? "")));
  await settle();
  const svc = await watchOf(wb, "Service", (s) => s.metadataOnly === true);
  expect(wb.specs.get(svc)?.namespaces).toEqual(["default"]);
  emitAll("Service", fx.services, (s) => s.metadataOnly === true);
  if (secrets) {
    await watchOf(wb, "Secret", (s) => s.metadataOnly === true);
    emitAll("Secret", fx.secrets.filter((s) => !without.includes(s.metadata?.name ?? "")), (s) => s.metadataOnly === true);
  }
  await waitFor(() => expect(getTraefik("c1").loading).toBe(false));
}

describe("the section and its problems", () => {
  it("is a problem category agents never get", () => {
    expect(PROBLEM_CATEGORIES).toContain("traefik");
  });

  it("judges every object without listing a Secret; a missing Middleware is a problem after the grace", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(true));
    await settle();
    const release = acquireTraefik("c1");
    await feed(["auth-users", "supersecret", "authsecret"]);
    // The background store never lists Secrets: their references are left to the details.
    expect([...wb.specs.values()].some((s) => s.kind.kind === "Secret")).toBe(false);
    const findings = getTraefik("c1").findings;
    const health = Object.fromEntries(findings.map((f) => [f.ref.name, f.judgement.health]));
    expect(health).toMatchObject({ myingressroute: "ok", secured: "failed", wrr1: "ok", mirror1: "ok", opt: "ok", mytransport: "ok" });
    const problems = toProblems(findings, new Map(), 1000);
    expect(problems.map((p) => [p.object.name, p.reason, p.messageKey, p.messageLists])).toEqual([
      ["secured", "MissingReference", "messages.traefikMissingReference", { refs: ["Middleware auth-users"] }],
    ]);
    expect(problems[0]!.activeAt).toBe(1000 + TRAEFIK_GRACE_MS);
    release();
  });

  it("is an opt-in category: off, the counter holds nothing; on, it holds the references", async () => {
    expect(OPT_IN_CATEGORIES).toContain("traefik");
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(screen.getByText("Traefik")).toBeInTheDocument());
    expect(screen.queryByText("IngressRoutes (traefik.containo.us)")).toBeNull();
    await settle();
    expect([...wb.specs.values()].some((s) => s.kind.group === "traefik.io")).toBe(false);
  });

  it("looks again only when its own watches change: another list's update keeps the same findings", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(true));
    const release = acquireTraefik("c1");
    await feed();
    const before = getTraefik("c1");
    // Every table row holds the store: one more holder neither re-reads nor rebuilds it.
    const again = acquireTraefik("c1");
    expect(getTraefik("c1")).toBe(before);
    const other = acquireWatch("c1", { kind: { group: "", version: "v1", kind: "ConfigMap" }, namespaces: ["x"], labelSelector: null, fieldSelector: null });
    await watchOf(wb, "ConfigMap");
    emitAll("ConfigMap", [{ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "a", namespace: "x", uid: "cm-a" } }]);
    await settle();
    expect(getTraefik("c1")).toBe(before);
    other();
    again();
    release();
  });

  it("turned on, its counter's problems source holds the store: the watches open without anything else holding them", async () => {
    stored = { ...stored, notifications: { ...stored.notifications, enabledCategories: ["traefik"] } };
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(screen.getByText("Traefik")).toBeInTheDocument());
    await feed(["https-only"]);
    expect(getTraefik("c1").findings.find((f) => f.ref.name === "secured")?.judgement.health).toBe("failed");
  });
});

function refTo(obj: KubeObject): ObjectRef {
  return { kind: { group: "traefik.io", version: "v1alpha1", kind: obj.kind ?? "" }, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
}

async function openDetails(obj: KubeObject): Promise<HTMLElement> {
  const ref = refTo(obj);
  useAppStore.getState().openDetails(ref);
  const { container } = render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`);
  emitAll(ref.kind.kind, [obj], (s) => s.fieldSelector === `metadata.name=${ref.name}`);
  await waitFor(() => expect(document.querySelector("[data-section='traefik']")).not.toBeNull());
  return container;
}

const view = () => within(document.querySelector<HTMLElement>("[data-section='traefik']")!);

describe("details", () => {
  it("an IngressRoute: no status, its routes with links, and the broken reference named", async () => {
    wb.backend.on("tls_certificate_info", () => {
      throw { code: "notFound", message: "no tls.crt" };
    });
    const container = await openDetails(fx.ingressRoute!);
    await feed(["secured"], true);
    const v = view();
    await waitFor(() => expect(v.getByText("Broken reference")).toBeInTheDocument());
    expect(v.getByText(/Traefik writes no status on its objects/)).toBeInTheDocument();
    expect(v.getAllByRole("button", { name: "Open Middleware secured" }).length).toBeGreaterThan(0);
    expect(v.getAllByRole("button", { name: "Open Service foo" }).length).toBeGreaterThan(0);
    const rows = v.getAllByRole("row").map((r) => r.textContent);
    expect(rows).toContain("MiddlewaresecuredRoute 1Does not exist");
    expect(rows).toContain("TraefikServiceapi@internalRoute 3Found");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("checks the Secrets an object names only while its details are open", async () => {
    const container = await openDetails(fx.authUsers!);
    await feed(["authsecret"], true);
    const secrets = [...wb.specs.values()].filter((s) => s.kind.kind === "Secret");
    expect(secrets.map((s) => [s.namespaces, s.metadataOnly])).toEqual([[["default"], true]]);
    const v = view();
    await waitFor(() => expect(v.getByText("Broken reference")).toBeInTheDocument());
    expect(v.getAllByRole("row").map((r) => r.textContent)).toContain("SecretauthsecretSecretDoes not exist");
    // The shared store (the column, the problems) never judged it.
    expect(getTraefik("c1").byUid.get("uid-auth-users")?.judgement.health).toBe("ok");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("a route whose TLS Secret is missing is not broken: Traefik serves another certificate", async () => {
    wb.backend.on("tls_certificate_info", () => {
      throw { code: "notFound", message: "no tls.crt" };
    });
    await openDetails(fx.ingressRoute!);
    await feed(["supersecret"], true);
    const v = view();
    await waitFor(() => expect(v.getByText(/The TLS Secret supersecret does not exist: Traefik still serves the routes/)).toBeInTheDocument());
    expect(v.getByText("Not all checked")).toBeInTheDocument();
    expect(v.queryByText("Broken reference")).toBeNull();
  });

  it("where both groups are served, names the old group's twin of an object", async () => {
    const legacyMiddleware: KindRef = { group: LEGACY, version: "v1alpha1", kind: "Middleware" };
    wb.backend.on("cluster_kinds", () => [SERVICE, SECRET, ...OWN, legacyMiddleware].map(served));
    await openDetails(fx.knownIps!);
    await feed();
    emitAll("Middleware", [old(fx.knownIps!)], (s) => s.kind.group === LEGACY && s.namespaces === null);
    const v = view();
    await waitFor(() => expect(v.getByText("A Middleware of the same name exists in traefik.containo.us too: Traefik v3 reads only this one, Traefik 2.10 reads both.")).toBeInTheDocument());
  });

  it("a weighted TraefikService and a TLSOption", async () => {
    const container = await openDetails(fx.wrr!);
    await feed();
    const v = view();
    await waitFor(() => expect(v.getByText("References found")).toBeInTheDocument());
    expect(v.getByText("Weighted round robin")).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("the Diagnose action and the Diagnosis tab", () => {
  it("is offered on IngressRoutes; the tab lists the route's Traefik objects in its namespace only and passes axe", async () => {
    expect(getResourceDef(INGRESS_ROUTE)?.actions).toContain("diagnose");
    expect(getResourceDef(MIDDLEWARE)?.actions).not.toContain("diagnose");
    wb.backend.on("tls_certificate_info", () => {
      throw { code: "notFound", message: "no tls.crt" };
    });
    await openDetails(fx.ingressRoute!);
    fireEvent.click(screen.getByRole("tab", { name: "Diagnosis" }));
    const inDefault = (s: WatchSpec) => JSON.stringify(s.namespaces) === JSON.stringify(["default"]) && s.fieldSelector === null && !s.metadataOnly;
    for (const kind of ["Middleware", "TraefikService", "TLSOption"]) {
      emitAll(kind, all.filter((o) => o.kind === kind), inDefault);
      await watchOf(wb, kind, inDefault);
      emitAll(kind, all.filter((o) => o.kind === kind), inDefault);
    }
    emitAll("TLSStore", [], inDefault);
    emitAll("IngressRoute", [fx.ingressRoute!], inDefault);
    emitAll("Service", fx.services, inDefault);
    // A missing TLS Secret is a warning: Traefik builds the router anyway, so the routes are still followed.
    await screen.findByText("The TLS Secret supersecret does not exist in the namespace default.");
    expect(screen.queryByText(/^Traffic stops here:/)).toBeNull();
    expect(await screen.findByText("Matches Host(`foo.example.net`) && PathPrefix(`/bar`).")).toBeInTheDocument();
    // Nothing of the old group is listed where the cluster does not serve it.
    expect([...wb.specs.values()].some((s) => s.kind.group === "traefik.containo.us")).toBe(false);
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
