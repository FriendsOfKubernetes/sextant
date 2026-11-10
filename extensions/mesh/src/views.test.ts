// The details sections and the "Request routing" page, driven through the SDK's stand-in for Sextant's window, as the
// built-in view's tests (`mesh.test.tsx`) drove the built-in ones on the same fixtures.
import type { KubeObject, WatchUpdate } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestWatch } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import bookinfo from "../fixtures/bookinfo.json";
import { startDetails } from "./details";
import { setLanguage } from "./i18n";
import { startMembership } from "./membership";
import { startRequestCheck } from "./requestCheck";

const copy = <T>(value: T): T => structuredClone(value);
const fx = bookinfo as unknown as Record<string, KubeObject[]>;

const kind = (group: string, version: string, k: string) => ({ kindRef: { group, version, kind: k }, plural: `${k.toLowerCase()}s`, namespaced: true, verbs: ["list", "watch"], printerColumns: [] });
const ISTIO = [
  kind("networking.istio.io", "v1", "VirtualService"),
  kind("networking.istio.io", "v1", "DestinationRule"),
  kind("networking.istio.io", "v1", "Gateway"),
  kind("networking.istio.io", "v1", "ServiceEntry"),
  kind("security.istio.io", "v1", "PeerAuthentication"),
  kind("security.istio.io", "v1", "AuthorizationPolicy"),
];
const LINKERD = [kind("policy.linkerd.io", "v1beta3", "Server"), kind("policy.linkerd.io", "v1beta1", "ServerAuthorization"), kind("policy.linkerd.io", "v1alpha1", "AuthorizationPolicy")];
const CORE = [kind("", "v1", "Service"), kind("", "v1", "Pod")];

let host: TestHost;
let root: HTMLElement;
let stop: () => void = () => undefined;
let hidden: boolean[] = [];
/** The extension's session storage (`storage` with `session: true`): this run only, apart from the stored data. */
let session = new Map<string, unknown>();
let kindsAnswer: unknown[] = [];

type Start = "details" | "membership" | "page";
async function open(what: Start, options: { obj?: KubeObject; group?: string; version?: string; kinds?: unknown[]; blocks?: Record<string, boolean>; language?: string } = {}): Promise<void> {
  const language = options.language ?? "en";
  let blocks = options.blocks ?? {};
  const obj = options.obj;
  hidden = [];
  session = new Map();
  kindsAnswer = options.kinds ?? [...CORE, ...ISTIO];
  host = await startTestHost({
    context: {
      view: what === "page" ? "page" : "details",
      contribution: what === "page" ? "request-check" : what === "membership" ? "membership" : "mesh",
      selection: obj ? [{ kind: { group: options.group ?? "", version: options.version ?? "v1", kind: obj.kind! }, namespace: obj.metadata.namespace ?? null, name: obj.metadata.name }] : [],
      resourceVersion: obj ? "1" : null,
      language,
      blocks,
    },
    handlers: {
      "resources.get": () => copy(obj),
      kinds: () => kindsAnswer,
      "storage.get": ({ key, session: s }: { key: string; session?: boolean }) => ((s ? session : host.storage).has(key) ? (s ? session : host.storage).get(key) : null),
      "storage.set": ({ key, value, session: s }: { key: string; value: unknown; session?: boolean }) => void (s ? session : host.storage).set(key, value),
      "ui.revealSection": () => null,
      "ui.setHidden": ({ hidden: h }: { hidden: boolean }) => void hidden.push(h),
      "ui.setBlockOpen": (params: { id: string; open: boolean }) => {
        blocks = { ...blocks, [params.id]: params.open };
        setTimeout(() => host.setContext({ blocks }));
        return null;
      },
    },
  });
  setLanguage(language);
  root = document.createElement("main");
  document.body.append(root);
  stop = what === "page" ? startRequestCheck(host.sextant, root) : what === "membership" ? startMembership(host.sextant, root) : startDetails(host.sextant, root);
}

afterEach(() => {
  setLanguage("en");
  stop();
  root?.remove();
  host?.close();
});

type Params = { kind: { group: string; kind: string }; namespaces?: string[]; fieldSelector?: string; metadataOnly?: boolean };
const params = (w: TestWatch) => w.params as Params;
const live = () => host.watches.filter((w) => !w.stopped);
const watchOf = (k: string, test: (p: Params) => boolean = () => true) => live().find((w) => params(w).kind.kind === k && test(params(w)));
const snapshot = (items: KubeObject[]): WatchUpdate => ({ type: "snapshot", items: items as never });
const text = () => root.textContent ?? "";
const everywhere = (p: Params) => p.namespaces === undefined && p.fieldSelector === undefined;

/** Answers the shared Istio configuration's lists as the built-in test fed them. */
async function feedIstio(): Promise<void> {
  await expect.poll(() => watchOf("VirtualService", everywhere) && watchOf("AuthorizationPolicy", everywhere)).toBeTruthy();
  watchOf("VirtualService", everywhere)!.emit(snapshot(fx.virtualServices!));
  watchOf("DestinationRule", everywhere)!.emit(snapshot(fx.destinationRules!));
  watchOf("Gateway", everywhere)!.emit(snapshot(fx.gateways!));
  watchOf("ServiceEntry", everywhere)!.emit(snapshot([]));
  watchOf("PeerAuthentication", everywhere)!.emit(snapshot(fx.peerAuthentications!));
  watchOf("AuthorizationPolicy", everywhere)!.emit(snapshot(fx.authorizationPolicies!));
  await expect.poll(() => watchOf("Service", (p) => p.metadataOnly === true)).toBeTruthy();
  watchOf("Service", (p) => p.metadataOnly === true)!.emit(snapshot(fx.services!.map((s) => ({ ...s, spec: undefined }) as KubeObject)));
}

const vsOf = (name: string) => fx.virtualServices!.find((v) => v.metadata.name === name)!;

describe("details of a VirtualService", () => {
  it("tells its mesh problems, its fields and its routes in plain words", async () => {
    await open("details", { obj: vsOf("reviews"), group: "networking.istio.io" });
    await feedIstio();
    await expect.poll(text).toContain("MissingSubset");
    expect(root.querySelector("[role=alert]")?.textContent).toContain("which destination rule reviews does not define");
    expect(text()).toContain("Route 2 (default)");
    expect(text()).toContain("Retry up to 3 times, 2s per try");
    expect(text()).toContain("Header x-user is alice");
    // The configuration is watched in every namespace, kinds the cluster does not serve never.
    expect(watchOf("Sidecar")).toBeUndefined();
  });

  it("“Check a request…” opens the request check prefilled", async () => {
    await open("details", { obj: vsOf("reviews"), group: "networking.istio.io" });
    await expect.poll(() => [...root.querySelectorAll("button")].find((b) => b.textContent === "Check a request…")).toBeTruthy();
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Check a request…")!.click();
    await expect.poll(() => host.calls.some((c) => c.method === "ui.navigate")).toBe(true);
    // In the session storage only, as the built-in kept the form in memory; and the details close, as the built-in's did.
    expect(host.storage.has("check:test-cluster")).toBe(false);
    const stored = session.get("check:test-cluster") as { form: { url: string; from: string; namespace: string }; checked: unknown };
    expect(stored.form).toMatchObject({ url: "http://reviews/", from: "mesh", namespace: "shop" });
    expect(stored.checked).toEqual(stored.form);
    expect(host.calls.find((c) => c.method === "ui.navigate")?.params).toEqual({ page: "request-check", closeDetails: true });
    // The built-in button's icon.
    expect(host.calls.some((c) => c.method === "ui.icon" && (c.params as { name: string }).name === "requestCheck")).toBe(true);
  });

  it("a closed block draws nothing, and is remembered in Sextant's memory", async () => {
    await open("details", { obj: vsOf("reviews"), group: "networking.istio.io", blocks: { httpRoutes: false } });
    await feedIstio();
    await expect.poll(text).toContain("MissingSubset");
    expect(text()).not.toContain("Route 2 (default)");
    root.querySelector<HTMLElement>('[data-block="httpRoutes"] .sx-block__toggle')!.click();
    await expect.poll(text).toContain("Route 2 (default)");
    expect(host.calls.find((c) => c.method === "ui.setBlockOpen")?.params).toEqual({ id: "httpRoutes", open: true });
  });
});

describe("details of the other kinds", () => {
  it("a Gateway's bound VirtualServices, watched only while their block is open", async () => {
    await open("details", { obj: fx.gateways![0]!, group: "networking.istio.io", blocks: { boundVirtualServices: false } });
    await expect.poll(text).toContain("Servers");
    expect(watchOf("VirtualService")).toBeUndefined();
    root.querySelector<HTMLElement>('[data-block="boundVirtualServices"] .sx-block__toggle')!.click();
    await feedIstio();
    await expect.poll(() => [...root.querySelectorAll(".sx-link")].map((l) => l.textContent)).toContain("shop/storefront");
    root.querySelector<HTMLElement>('[data-block="boundVirtualServices"] .sx-block__toggle')!.click();
    await expect.poll(() => watchOf("VirtualService")).toBeUndefined();
  });

  it("a DestinationRule: its subsets and the TLS mode in words", async () => {
    await open("details", { obj: fx.destinationRules![0]!, group: "networking.istio.io" });
    await feedIstio();
    await expect.poll(text).toContain("TlsConflict");
    expect(text()).toContain("Subsets");
  });

  it("an AuthorizationPolicy: what it means and its rules", async () => {
    await open("details", { obj: fx.authorizationPolicies![0]!, group: "security.istio.io" });
    await expect.poll(text).toContain("Rule 1");
    expect(text()).toContain("Callers (principals)");
  });

  it("a Linkerd Server: the authorizations of its namespace that target it", async () => {
    const server = { apiVersion: "policy.linkerd.io/v1beta3", kind: "Server", metadata: { name: "web-http", namespace: "shop", labels: { app: "web" } }, spec: { port: 8080, podSelector: { matchLabels: { app: "web" } } } } as KubeObject;
    await open("details", { obj: server, group: "policy.linkerd.io", version: "v1beta3", kinds: [...CORE, ...LINKERD] });
    await expect.poll(() => watchOf("ServerAuthorization") && watchOf("AuthorizationPolicy")).toBeTruthy();
    expect(params(watchOf("ServerAuthorization")!).namespaces).toEqual(["shop"]);
    watchOf("ServerAuthorization")!.emit(snapshot([{ kind: "ServerAuthorization", metadata: { name: "allow-web", namespace: "shop" }, spec: { server: { name: "web-http" } } } as KubeObject]));
    watchOf("AuthorizationPolicy")!.emit(snapshot([{ kind: "AuthorizationPolicy", metadata: { name: "other", namespace: "shop" }, spec: { targetRef: { kind: "Server", name: "nope" } } } as KubeObject]));
    await expect.poll(() => [...root.querySelectorAll(".sx-link")].map((l) => l.textContent)).toEqual(["ServerAuthorization allow-web"]);
  });

  it("speaks the UI language", async () => {
    await open("details", { obj: fx.authorizationPolicies![0]!, group: "security.istio.io", language: "de" });
    await expect.poll(text).toContain("Regel 1");
  });
});

describe("the Service mesh section of a pod", () => {
  it("shows the membership, the mTLS mode and who may call", async () => {
    await open("membership", { obj: fx.pods![0]! });
    await expect.poll(text).toContain("In the Istio mesh with a sidecar proxy.");
    expect(hidden.at(-1)).toBe(false);
    await feedIstio();
    await expect.poll(() => watchOf("Namespace")).toBeTruthy();
    expect(params(watchOf("Namespace")!).fieldSelector).toBe("metadata.name=shop");
    watchOf("Namespace")!.emit(snapshot(fx.namespaces!));
    await expect.poll(text).toContain("Set by the namespace's PeerAuthentication default:");
    expect(text()).toContain("STRICT");
    expect(text()).toContain("Cannot tell");
    const typeInto = (label: string, value: string) => {
      const input = [...root.querySelectorAll("label")].find((l) => l.querySelector("span")?.textContent === label)!.querySelector("input")!;
      input.value = value;
      input.dispatchEvent(new Event("input"));
    };
    typeInto("Caller namespace", "shop");
    typeInto("Service account", "web");
    typeInto("Method", "GET");
    await expect.poll(text).toContain("Allowed");
    typeInto("Service account", "batch");
    await expect.poll(text).toContain("Denied");
  });

  it("follows discovery: shown once the cluster serves Istio, as the built-in followed it", async () => {
    const plain = { apiVersion: "v1", kind: "Pod", metadata: { name: "p", namespace: "shop" }, spec: { containers: [{ name: "app" }] } } as KubeObject;
    await open("membership", { obj: plain, kinds: CORE });
    await expect.poll(() => hidden.at(-1)).toBe(true);
    kindsAnswer = [...CORE, ...ISTIO];
    host.setContext({ kindsVersion: 2 });
    await expect.poll(text).toContain("Not in the Istio mesh");
    expect(hidden.at(-1)).toBe(false);
  });

  it("is hidden where no mesh is served and the pod has no proxy", async () => {
    const plain = { apiVersion: "v1", kind: "Pod", metadata: { name: "p", namespace: "shop" }, spec: { containers: [{ name: "app" }] } } as KubeObject;
    await open("membership", { obj: plain, kinds: CORE });
    await expect.poll(() => hidden.at(-1)).toBe(true);
    expect(text()).toBe("");
    expect(host.watches).toEqual([]);
  });

  it("a workload in Linkerd: what its pods get, and linkerd-viz told", async () => {
    const deployment = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "web", namespace: "shop" },
      spec: { template: { metadata: { annotations: { "linkerd.io/inject": "enabled" } }, spec: { containers: [{ name: "web" }] } } },
    } as KubeObject;
    await open("membership", { obj: deployment, group: "apps", kinds: [...CORE, ...LINKERD] });
    await expect.poll(text).toContain("Linkerd");
    await expect.poll(() => watchOf("Namespace", (p) => p.fieldSelector === "metadata.name=linkerd-viz")).toBeTruthy();
    watchOf("Namespace", (p) => p.fieldSelector === "metadata.name=linkerd-viz")!.emit(snapshot([{ kind: "Namespace", metadata: { name: "linkerd-viz" } } as KubeObject]));
    await expect.poll(text).toContain("linkerd-viz is installed");
    // "Show request metrics" opens Sextant's Requests section of the same panel, as the built-in button did.
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Show request metrics")!.click();
    await expect.poll(() => host.calls.find((c) => c.method === "ui.revealSection")?.params).toEqual({ id: "requestHealth" });
  });
});

describe("the Request routing page", () => {
  async function check(url: string, headers = ""): Promise<HTMLElement> {
    const set = (name: string, value: string) => {
      const field = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-field="${name}"]`)!;
      field.value = value;
      field.dispatchEvent(new Event("input"));
    };
    set("url", url);
    set("namespace", "shop");
    if (headers) set("headers", headers);
    root.querySelector<HTMLButtonElement>("button[type=submit]")!.click();
    await expect.poll(() => root.querySelector("section[aria-label='Where the request goes']")).toBeTruthy();
    return root.querySelector<HTMLElement>("section[aria-label='Where the request goes']")!;
  }

  it("follows a request to the route, the weighted subsets and their ready pods", async () => {
    await open("page");
    await feedIstio();
    await expect.poll(() => root.querySelector("[data-field=url]")).toBeTruthy();
    const result = await check("http://reviews:9080/x");
    expect(result.querySelector("[role=status]")?.textContent).toBe("Routed");
    const route = result.querySelector<HTMLElement>("[data-step='route']")!;
    expect(route.textContent).toContain("Route 2 (default)");
    expect(route.textContent).toContain("Route beta-users of reviews skipped: a header did not match.");
    expect(route.textContent).toContain("Retry up to 3 times, 2s per try");
    expect(result.querySelector("[data-step='destinations']")?.textContent).toContain("80%");
    expect(result.querySelector("[data-step='destinations']")?.textContent).toContain("The destination rule has no subset v3");
    // The Services and pods of the destination's namespace are watched now.
    await expect.poll(() => watchOf("Pod", (p) => p.namespaces?.includes("shop") === true)).toBeTruthy();
    watchOf("Service", (p) => p.namespaces?.includes("shop") === true && !p.metadataOnly)!.emit(snapshot(fx.services!));
    watchOf("Pod")!.emit(snapshot(fx.pods!));
    await expect.poll(() => root.querySelector("[data-step='destinations']")?.textContent).toContain("1 of 2 ready");
    // The form is kept for the cluster in this run's memory.
    expect((session.get("check:test-cluster") as { checked: { url: string } }).checked.url).toBe("http://reviews:9080/x");
    expect(host.storage.size).toBe(0);
  });

  it("takes the header route; the headers are kept for the run only, never on disk", async () => {
    await open("page");
    await feedIstio();
    await expect.poll(() => root.querySelector("[data-field=url]")).toBeTruthy();
    const result = await check("http://reviews.shop/", "x-user: alice");
    expect(result.querySelector("[data-step='route']")?.textContent).toContain("Header x-user is alice");
    expect(JSON.stringify(session.get("check:test-cluster"))).toContain("x-user: alice");
    expect(host.storage.size).toBe(0);
  });

  it("follows a request through an Istio gateway", async () => {
    await open("page");
    await feedIstio();
    await expect.poll(() => root.querySelector<HTMLOptionElement>("[data-field=from] option[value=gateway]")?.disabled).toBe(false);
    const from = root.querySelector<HTMLSelectElement>("[data-field=from]")!;
    from.value = "gateway";
    from.dispatchEvent(new Event("change"));
    await expect.poll(() => root.querySelector("[data-field=gateway]")).toBeTruthy();
    const gateway = root.querySelector<HTMLSelectElement>("[data-field=gateway]")!;
    gateway.value = "istio-ingress/public";
    gateway.dispatchEvent(new Event("change"));
    const url = root.querySelector<HTMLInputElement>("[data-field=url]")!;
    url.value = "http://shop.example.com/reviews/1";
    url.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>("button[type=submit]")!.click();
    await expect.poll(() => root.querySelector("section[aria-label='Where the request goes']")).toBeTruthy();
    const result = root.querySelector<HTMLElement>("section[aria-label='Where the request goes']")!;
    expect(result.querySelector("[data-step='gateway']")?.textContent).toContain("Server on port 80 (HTTP) for shop.example.com");
    expect(result.querySelector("[data-step='virtualService']")?.textContent).toContain("storefront");
    expect(result.querySelector("[data-step='destinations']")?.textContent).toContain("reviews.shop.svc.cluster.local:9080");
  });

  it("opens prefilled and checked, as a VirtualService's “Check a request…” left it", async () => {
    await open("page");
    session.set("check:test-cluster", { form: { url: "http://reviews/", method: "GET", from: "mesh", namespace: "shop", labels: "", gateway: "" }, checked: { url: "http://reviews/", method: "GET", from: "mesh", namespace: "shop", labels: "", gateway: "" } });
    stop();
    stop = startRequestCheck(host.sextant, root);
    await feedIstio();
    await expect.poll(() => root.querySelector("section[aria-label='Where the request goes'] [role=status]")?.textContent).toBe("Routed");
  });

  it("says so where the cluster serves no Istio traffic API", async () => {
    await open("page", { kinds: CORE });
    await expect.poll(text).toContain("This cluster serves no Istio VirtualServices or DestinationRules.");
  });
});
