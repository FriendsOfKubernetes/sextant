// The details section, driven through the SDK's stand-in for Sextant's window, as the built-in view's tests drove it.
import type { KubeObject, WatchUpdate } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestWatch } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import fixtures from "../fixtures/objects.json";
import { FIELDS_BLOCK, MAX_OBJECTS, startDetails } from "./details";
import { setLanguage } from "./i18n";
import { LEGACY_GROUP, TRAEFIK_GROUP } from "./model";

const copy = <T>(value: T): T => structuredClone(value);
const fx = fixtures as unknown as Record<string, KubeObject> & { services: KubeObject[]; secrets: KubeObject[] };
const KINDS = ["IngressRoute", "IngressRouteTCP", "IngressRouteUDP", "Middleware", "MiddlewareTCP", "TraefikService", "TLSOption", "TLSStore", "ServersTransport", "ServersTransportTCP"];
const kinds = (groups: string[]) =>
  groups.flatMap((group) =>
    KINDS.filter((k) => group === TRAEFIK_GROUP || k !== "ServersTransportTCP").map((kind) => ({
      kindRef: { group, version: "v1alpha1", kind },
      plural: `${kind.toLowerCase()}s`,
      namespaced: true,
      verbs: ["list", "watch"],
      printerColumns: [],
    })),
  );

let host: TestHost;
let root: HTMLElement;
let stop: () => void = () => undefined;

async function open(obj: KubeObject, options: { groups?: string[]; language?: string; blocks?: Record<string, boolean>; group?: string } = {}): Promise<void> {
  const language = options.language ?? "en";
  let blocks = options.blocks ?? {};
  const group = options.group ?? TRAEFIK_GROUP;
  host = await startTestHost({
    context: {
      view: "details",
      contribution: "traefik",
      selection: [{ kind: { group, version: "v1alpha1", kind: obj.kind! }, namespace: obj.metadata.namespace ?? null, name: obj.metadata.name }],
      resourceVersion: "1",
      language,
      blocks,
    },
    handlers: {
      "resources.get": () => copy(obj),
      kinds: () => kinds(options.groups ?? [TRAEFIK_GROUP]),
      "ui.setBlockOpen": (params) => {
        const { id, open: isOpen } = params as { id: string; open: boolean };
        blocks = { ...blocks, [id]: isOpen };
        setTimeout(() => host.setContext({ blocks }));
        return null;
      },
    },
  });
  setLanguage(language);
  root = document.createElement("main");
  document.body.append(root);
  stop = startDetails(host.sextant, root, "traefik");
}

afterEach(() => {
  setLanguage("en");
  stop();
  root?.remove();
  host?.close();
});

type Params = { kind: { group: string; kind: string }; namespaces?: string[]; fieldSelector?: string; metadataOnly?: boolean; maxObjects?: number };
const params = (w: TestWatch) => w.params as Params;
const live = () => host.watches.filter((w) => !w.stopped);
const watchOf = (group: string, kind: string, fieldSelector?: string) =>
  live().find((w) => params(w).kind.group === group && params(w).kind.kind === kind && params(w).fieldSelector === fieldSelector);
const snapshot = (items: KubeObject[]): WatchUpdate => ({ type: "snapshot", items: items as never });
const text = () => root.textContent ?? "";
const statusOf = (word: string) => [...root.querySelectorAll(".sx-status")].find((s) => s.textContent === word);
const byLabel = (label: string) => [...root.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label") === label);
const named = (kind: string, name: string, namespace = "default"): KubeObject => ({ apiVersion: "v1", kind, metadata: { name, namespace } }) as KubeObject;
const tables = () => [...root.querySelectorAll("table")].map((t) => [...t.querySelectorAll("tbody tr")].map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent)));

/** Answers every list the IngressRoute fixture's references read, but the names in `gone`. */
async function answerRoute(gone: string[] = []): Promise<void> {
  const keep = (list: KubeObject[]) => list.filter((o) => !gone.includes(o.metadata.name));
  await expect.poll(() => watchOf("", "Service") && watchOf(TRAEFIK_GROUP, "Middleware") && watchOf(TRAEFIK_GROUP, "TraefikService") && watchOf(TRAEFIK_GROUP, "TLSOption") && watchOf("", "Secret")).toBeTruthy();
  watchOf("", "Service")!.emit(snapshot(keep(fx.services)));
  watchOf(TRAEFIK_GROUP, "Middleware")!.emit(snapshot(keep([named("Middleware", "secured")])));
  watchOf(TRAEFIK_GROUP, "TraefikService")!.emit(snapshot(keep([fx.wrr!])));
  watchOf(TRAEFIK_GROUP, "TLSOption")!.emit(snapshot(keep([named("TLSOption", "opt")])));
  watchOf("", "Secret")!.emit(snapshot(keep(fx.secrets)));
}

describe("details of an IngressRoute", () => {
  it("says Traefik writes no status, checks every reference and lists the routes with links", async () => {
    await open(fx.ingressRoute!);
    await expect.poll(() => statusOf("Checking…")).toBeDefined();
    await answerRoute();
    await expect.poll(() => statusOf("References found")?.classList.contains("sx-status--success")).toBe(true);
    expect(text()).toContain("Traefik writes no status on its objects.");
    // Each list once, in the namespaces the references name, names only; the Traefik kinds capped as the built-in.
    for (const [group, kind] of [
      [TRAEFIK_GROUP, "Middleware"],
      [TRAEFIK_GROUP, "TraefikService"],
      [TRAEFIK_GROUP, "TLSOption"],
    ]) {
      expect(params(watchOf(group!, kind!)!)).toMatchObject({ namespaces: ["default"], metadataOnly: true, maxObjects: MAX_OBJECTS });
    }
    expect(params(watchOf("", "Service")!)).toMatchObject({ namespaces: ["default"], metadataOnly: true });
    expect(params(watchOf("", "Secret")!)).toMatchObject({ namespaces: ["default"], metadataOnly: true });
    expect(params(watchOf("", "Secret")!).maxObjects).toBeUndefined();
    // No other group served: no twin looked for.
    expect(live().some((w) => params(w).kind.group === LEGACY_GROUP)).toBe(false);
    expect(byLabel("Open Service foo")).toHaveLength(2);
    expect(byLabel("Open Middleware secured")).toHaveLength(2);
    expect(byLabel("Open TraefikService wrr1")).toHaveLength(2);
    expect(byLabel("Open TLSOption opt")).toHaveLength(2);
    expect(byLabel("Open Secret supersecret")).toHaveLength(2);
    expect(text()).toContain("api@internal");
    const [routes, refs] = tables();
    expect(routes!.map((r) => [r[0], r[1], r[2]])).toEqual([
      ["1", "Host(`foo.example.net`) && PathPrefix(`/bar`)", "10"],
      ["2", "Host(`foo.example.net`) && PathPrefix(`/wrr`)", ""],
      ["3", "PathPrefix(`/dashboard`)", ""],
    ]);
    expect(routes![0]![4]).toBe("foo:80 weight 10");
    expect(refs!.map((r) => [r[0], r[1], r[2], r[3]])).toEqual([
      ["Service", "foo", "Route 1", "Found"],
      ["Middleware", "secured", "Route 1", "Found"],
      ["TraefikService", "wrr1", "Route 2", "Found"],
      ["TraefikService", "api@internal", "Route 3", "Found"],
      ["Secret", "supersecret", "TLS", "Found"],
      ["TLSOption", "opt", "TLS", "Found"],
    ]);
    // Nothing but the IngressRoute itself is read whole.
    expect(new Set(host.calls.filter((c) => c.method === "resources.get").map((c) => (c.params as { ref: { kind: { kind: string } } }).ref.kind.kind))).toEqual(new Set(["IngressRoute"]));
  });

  it("a missing Middleware breaks it; a missing TLS Secret does not (Traefik serves another certificate)", async () => {
    await open(fx.ingressRoute!);
    await answerRoute(["secured", "supersecret"]);
    await expect.poll(() => statusOf("Broken reference")?.classList.contains("sx-status--danger")).toBe(true);
    expect(text()).toContain("1 reference names an object that does not exist: Traefik skips what depends on it and logs an error.");
    expect(text()).toContain("The TLS Secret supersecret does not exist: Traefik still serves the routes");
    const refs = tables()[1]!;
    expect(refs.find((r) => r[1] === "secured")![3]).toBe("Does not exist");
    expect(refs.find((r) => r[1] === "supersecret")![3]).toBe("Does not exist");
  });

  it("a route Traefik skips, another provider's object and a reference into another namespace", async () => {
    const route = copy(fx.ingressRoute!);
    const routes = (route.spec as { routes: Record<string, unknown>[] }).routes;
    routes[0]!.match = "";
    (routes[0]!.middlewares as Record<string, unknown>[]).push({ name: "auth@file" }, { name: "secured", namespace: "infra" });
    await open(route);
    await answerRoute();
    watchOf(TRAEFIK_GROUP, "Middleware")!.emit(snapshot([named("Middleware", "secured"), named("Middleware", "secured", "infra")]));
    await expect.poll(() => statusOf("Broken reference")).toBeDefined();
    expect(text()).toContain("Route 1 has no match rule: Traefik skips it.");
    await expect.poll(() => text()).toContain("A reference points into another namespace");
    expect(text()).toContain("A reference names an object of another Traefik provider (name@provider): Sextant cannot see it.");
    // The Middleware list is asked for the other namespace too; until it answers, that reference cannot be told.
    expect(params(watchOf(TRAEFIK_GROUP, "Middleware")!).namespaces).toEqual(["default", "infra"]);
    const refs = tables()[1]!;
    expect(refs.find((r) => r[1] === "auth@file")![3]).toBe("Another provider's object: not checked");
    expect(refs.find((r) => r[1] === "infra/secured")![3]).toBe("In another namespace: depends on allowCrossNamespace");
  });

  it("where both groups are served, names the old group's twin and looks up both groups", async () => {
    await open(fx.ingressRoute!, { groups: [TRAEFIK_GROUP, LEGACY_GROUP] });
    await expect.poll(() => watchOf(LEGACY_GROUP, "IngressRoute", "metadata.name=myingressroute")).toBeDefined();
    expect(params(watchOf(LEGACY_GROUP, "IngressRoute", "metadata.name=myingressroute")!)).toMatchObject({ namespaces: ["default"], metadataOnly: true });
    await expect.poll(() => watchOf(LEGACY_GROUP, "Middleware") && watchOf(LEGACY_GROUP, "TraefikService") && watchOf(LEGACY_GROUP, "TLSOption")).toBeTruthy();
    await answerRoute();
    for (const kind of ["Middleware", "TraefikService", "TLSOption"]) watchOf(LEGACY_GROUP, kind)!.emit(snapshot([]));
    watchOf(LEGACY_GROUP, "IngressRoute", "metadata.name=myingressroute")!.emit(snapshot([named("IngressRoute", "myingressroute")]));
    await expect.poll(() => text()).toContain("A IngressRoute of the same name exists in traefik.containo.us too");
    expect(statusOf("References found")).toBeDefined();
  });

  it("an object of the old group where both are served: Traefik v3 ignores it", async () => {
    const old = { ...copy(fx.tcpRoute!), apiVersion: `${LEGACY_GROUP}/v1alpha1` };
    await open(old, { groups: [TRAEFIK_GROUP, LEGACY_GROUP], group: LEGACY_GROUP });
    await expect.poll(() => watchOf(TRAEFIK_GROUP, "IngressRouteTCP", "metadata.name=ingressroutetcpfoo")).toBeDefined();
    await expect.poll(() => watchOf("", "Service")).toBeDefined();
    watchOf("", "Service")!.emit(snapshot(fx.services));
    watchOf(TRAEFIK_GROUP, "IngressRouteTCP", "metadata.name=ingressroutetcpfoo")!.emit(snapshot([]));
    await expect.poll(() => text()).toContain("Traefik v3 reads only traefik.io and ignores this object");
    expect(text()).toContain("TLS passthroughYes");
  });

  it("closed, it draws and watches nothing, as the built-in block", async () => {
    await open(fx.ingressRoute!, { blocks: { [FIELDS_BLOCK]: false } });
    await expect.poll(() => root.querySelector(".sx-block__toggle")).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(live()).toEqual([]);
    expect(text()).not.toContain("Traefik writes no status");
  });

  it("speaks the UI language", async () => {
    await open(fx.ingressRoute!, { language: "ru" });
    await answerRoute();
    await expect.poll(() => text()).toContain("Traefik не пишет status в свои объекты");
  });
});

describe("details of the other kinds", () => {
  it("a weighted TraefikService: its strategy and the services it sends to, with weights", async () => {
    await open(fx.wrr!);
    await expect.poll(() => watchOf("", "Service") && watchOf(TRAEFIK_GROUP, "TraefikService")).toBeTruthy();
    watchOf("", "Service")!.emit(snapshot(fx.services));
    watchOf(TRAEFIK_GROUP, "TraefikService")!.emit(snapshot([]));
    await expect.poll(() => statusOf("Broken reference")).toBeDefined();
    expect(text()).toContain("Weighted round robin");
    expect(text()).toContain("svc1:80 weight 1");
    expect(tables()[0]!.map((r) => [r[1], r[3]])).toEqual([
      ["svc1", "Found"],
      ["mirror1", "Does not exist"],
    ]);
  });

  it("a mirroring TraefikService: the main service and its mirrors with their percentages", async () => {
    await open(fx.mirror!);
    await expect.poll(() => watchOf("", "Service")).toBeDefined();
    watchOf("", "Service")!.emit(snapshot(fx.services));
    await expect.poll(() => statusOf("References found")).toBeDefined();
    expect(text()).toContain("Mirroring");
    expect(text()).toContain("svc2:80 20 %");
  });

  it("a chain Middleware: its middlewares in order", async () => {
    await open(fx.chain!);
    await expect.poll(() => watchOf(TRAEFIK_GROUP, "Middleware")).toBeDefined();
    watchOf(TRAEFIK_GROUP, "Middleware")!.emit(snapshot([fx.httpsOnly!, fx.knownIps!, fx.authUsers!]));
    await expect.poll(() => statusOf("References found")).toBeDefined();
    expect(text()).toContain("chain");
    expect(byLabel("Open Middleware https-only")).toHaveLength(2);
  });

  it("a TLSOption and a ServersTransport: their settings, and their Secrets checked while open", async () => {
    await open(fx.tlsOption!);
    await expect.poll(() => watchOf("", "Secret")).toBeDefined();
    expect(params(watchOf("", "Secret")!)).toMatchObject({ namespaces: ["default"], metadataOnly: true });
    // The Secrets are not waited for, as the built-in details did not wait for them.
    await expect.poll(() => text()).toContain("VersionTLS12");
    expect(text()).toContain("RequireAndVerifyClientCert");
    expect(text()).toContain("Strict SNI");
    watchOf("", "Secret")!.emit(snapshot([]));
    await expect.poll(() => statusOf("Broken reference")).toBeDefined();
    stop();
    root.remove();
    host.close();
    await open(fx.transport!);
    await expect.poll(() => statusOf("Not verified")?.classList.contains("sx-status--warning")).toBe(true);
    expect(text()).toContain("foobar");
  });
});
