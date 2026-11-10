// The details section, driven through the SDK's stand-in for Sextant's window, as the built-in view's tests drove it.
import type { KubeObject, WatchUpdate } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestWatch } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import fixtures from "../fixtures/monitoring.json";
import { MAX_DETAIL_NAMESPACES, MAX_LISTED_TARGETS, startDetails } from "./details";
import { setLanguage } from "./i18n";

const obj = (value: unknown) => structuredClone(value) as KubeObject;
const monitor = () => obj(fixtures.serviceMonitor);
const orphan = () => obj(fixtures.orphanMonitor);
const podMonitor = () => obj(fixtures.podMonitor);
const prometheus = () => obj(fixtures.prometheus);
const rule = () => obj(fixtures.rule);
const services = () => fixtures.services.map(obj);

const refOf = (o: KubeObject) => {
  const api = o.apiVersion ?? "";
  const [group, version] = api.includes("/") ? api.split("/") : ["", api];
  return { kind: { group: group!, version: version!, kind: o.kind ?? "" }, namespace: o.metadata.namespace ?? null, name: o.metadata.name };
};

const served = (kind: string, version = "v1") => ({ kindRef: { group: "monitoring.coreos.com", version, kind }, plural: `${kind.toLowerCase()}s`, namespaced: true, verbs: ["list", "watch"], printerColumns: [] });
const BOTH = [served("Prometheus"), served("PrometheusAgent", "v1alpha1")];

let host: TestHost;
let root: HTMLElement;
let stop: () => void = () => undefined;
let remembered: Record<string, boolean> = {};

async function open(o: KubeObject, options: { blocks?: Record<string, boolean>; kinds?: unknown[]; language?: string } = {}): Promise<void> {
  const { blocks = {}, kinds = BOTH, language = "en" } = options;
  remembered = { ...blocks };
  host = await startTestHost({
    context: { view: "details", contribution: "prometheus-operator", selection: [refOf(o)], resourceVersion: "1", language, blocks: remembered },
    handlers: {
      "resources.get": () => structuredClone(o),
      kinds: () => kinds,
      "ui.setBlockOpen": ({ id, open: isOpen }: { id: string; open: boolean }) => {
        remembered = { ...remembered, [id]: isOpen };
        host.setContext({ blocks: remembered });
      },
    },
  });
  setLanguage(language);
  root = document.createElement("main");
  document.body.append(root);
  stop = startDetails(host.sextant, root, "prometheus-operator");
  await expect.poll(() => root.querySelector(".sx-loading") === null).toBe(true);
}

afterEach(() => {
  setLanguage("en");
  stop();
  root?.remove();
  host?.close();
});

type Params = { kind: { group: string; kind: string; version?: string }; namespaces?: string[]; labelSelector?: string; metadataOnly?: boolean };
/** A watch's parameters, without the cluster the SDK names. */
const params = (w: TestWatch): Params => {
  const rest = { ...(w.params as Params & { clusterId?: string }) };
  delete rest.clusterId;
  return rest;
};
const watchOf = (kind: string) => host.watches.find((w) => params(w).kind.kind === kind && !w.stopped);
const snapshot = (items: KubeObject[]): WatchUpdate => ({ type: "snapshot", items: items as never });
const text = () => root.textContent ?? "";
const rows = () => [...root.querySelectorAll("tr")].map((r) => [...r.querySelectorAll("td, th")].map((c) => c.textContent));
const links = () => [...root.querySelectorAll("button")].filter((b) => !b.classList.contains("sx-block__toggle")).map((b) => b.textContent);
const toggle = (id: string) => root.querySelector<HTMLButtonElement>(`[data-block="${id}"] .sx-block__toggle`);
const notes = (tone: string) => [...root.querySelectorAll(`.promop-note--${tone}`)].map((n) => n.textContent);

describe("details of a ServiceMonitor", () => {
  it("lists the Services its selector selects in its namespace, the endpoints' ports on them, and the Prometheus that picks it up", async () => {
    await open(monitor());
    // No heading of its own; the fields first.
    expect(root.querySelector("h1, h2")).toBeNull();
    expect(text()).toContain("Namespaces");
    expect(text()).toContain("app=example-app");
    await expect.poll(() => watchOf("Prometheus")).toBeDefined();
    // Every namespace, at the version the cluster serves; PrometheusAgents too.
    expect(params(watchOf("Prometheus")!)).toEqual({ kind: { group: "monitoring.coreos.com", version: "v1", kind: "Prometheus" } });
    expect(params(watchOf("PrometheusAgent")!)).toEqual({ kind: { group: "monitoring.coreos.com", version: "v1alpha1", kind: "PrometheusAgent" } });
    // The selector goes to the API server, in the monitor's namespace.
    expect(params(watchOf("Service")!)).toEqual({ kind: { group: "", version: "v1", kind: "Service" }, namespaces: ["default"], labelSelector: "app=example-app" });
    expect(notes("muted")).toContain("Loading…");
    watchOf("Prometheus")!.emit(snapshot([prometheus()]));
    watchOf("PrometheusAgent")!.emit(snapshot([]));
    watchOf("Service")!.emit(snapshot(services().filter((s) => s.metadata.labels?.app === "example-app")));
    await expect.poll(() => links()).toEqual(["default/example-app", "default/example-app-2", "default/prometheus"]);
    expect(text()).toContain("2 Services");
    expect(rows()).toEqual([
      ["Port", "Path", "Interval", "Port name found"],
      ["web", "/metrics", "", "on 2 of 2"],
      ["metrics", "/stats", "30s", "on 1 of 2"],
    ]);
    expect(root.querySelector(".promop-warn")?.textContent).toBe("on 1 of 2");
    // A link opens the object's details in Sextant's panel.
    const button = [...root.querySelectorAll("button")].find((b) => b.textContent === "default/example-app-2")!;
    button.click();
    await expect.poll(() => host.calls.find((call) => call.method === "ui.openDetails")?.params).toMatchObject({ kind: { kind: "Service" }, namespace: "default", name: "example-app-2" });
  });

  it("says so when it selects nothing, and when no Prometheus picks it up", async () => {
    await open(orphan());
    await expect.poll(() => watchOf("Service")).toBeDefined();
    watchOf("Service")!.emit(snapshot([]));
    watchOf("Prometheus")!.emit(snapshot([prometheus()]));
    watchOf("PrometheusAgent")!.emit(snapshot([]));
    await expect.poll(() => notes("danger")).toEqual(["Selects no Service: Prometheus scrapes nothing for it."]);
    expect(notes("warning")).toEqual(["No Prometheus picks it up: no Prometheus selector matches its labels and namespace."]);
  });

  it("watches its targets only while Selects now is open, and remembers the block in Sextant", async () => {
    await open(monitor(), { blocks: { targets: false } });
    await expect.poll(() => watchOf("Prometheus")).toBeDefined();
    expect(watchOf("Service")).toBeUndefined();
    expect(toggle("targets")!.getAttribute("aria-expanded")).toBe("false");
    toggle("targets")!.click();
    await expect.poll(() => watchOf("Service")).toBeDefined();
    expect(remembered).toEqual({ targets: true });
    toggle("targets")!.click();
    await expect.poll(() => watchOf("Service")).toBeUndefined();
  });

  it("reads the Namespaces' labels (metadata only) only when a Prometheus selects namespaces by labels", async () => {
    await open(monitor());
    await expect.poll(() => watchOf("Prometheus")).toBeDefined();
    const p = prometheus();
    (p.spec as Record<string, unknown>).serviceMonitorNamespaceSelector = { matchLabels: { monitoring: "on" } };
    watchOf("Prometheus")!.emit(snapshot([p]));
    watchOf("PrometheusAgent")!.emit(snapshot([]));
    await expect.poll(() => watchOf("Namespace")).toBeDefined();
    expect(params(watchOf("Namespace")!)).toEqual({ kind: { group: "", version: "v1", kind: "Namespace" }, metadataOnly: true });
    watchOf("Namespace")!.emit({ type: "error", message: "boom" } as never);
    await expect.poll(() => notes("warning")).toContain("Not known: the labels of the namespaces could not be read.");
  });

  it("looks in its own namespace when every Prometheus that picks it up ignores namespace selectors", async () => {
    const m = monitor();
    (m.spec as Record<string, unknown>).namespaceSelector = { matchNames: ["apps", "web"] };
    await open(m);
    await expect.poll(() => watchOf("Service")).toBeDefined();
    expect(params(watchOf("Service")!).namespaces).toEqual(["apps", "web"]);
    const p = prometheus();
    (p.spec as Record<string, unknown>).ignoreNamespaceSelectors = true;
    watchOf("Prometheus")!.emit(snapshot([p]));
    watchOf("PrometheusAgent")!.emit(snapshot([]));
    await expect.poll(() => params(watchOf("Service")!).namespaces).toEqual(["default"]);
    expect(notes("muted")).toContain(
      "A Prometheus that picks it up ignores the namespace selectors of monitors (ignoreNamespaceSelectors): it finds targets in the monitor's own namespace.",
    );
  });

  it("lists nothing for an empty selector in every namespace, nor in too many namespaces, nor for an unknown operator", async () => {
    const every = monitor();
    Object.assign(every.spec as Record<string, unknown>, { namespaceSelector: { any: true }, selector: {} });
    await open(every);
    await expect.poll(() => notes("muted")).toContain("Every Service in every namespace: not listed.");
    expect(text()).toContain("Every namespace");
    expect(text()).toContain("Everything");
    expect(watchOf("Service")).toBeUndefined();
    stop();
    host.close();

    const many = monitor();
    (many.spec as Record<string, unknown>).namespaceSelector = { matchNames: Array.from({ length: MAX_DETAIL_NAMESPACES + 1 }, (_, i) => `ns-${i}`) };
    await open(many);
    await expect.poll(() => notes("muted")).toContain("It looks in 21 namespaces: too many to list here.");
    expect(watchOf("Service")).toBeUndefined();
    stop();
    host.close();

    const bad = monitor();
    (bad.spec as Record<string, unknown>).selector = { matchExpressions: [{ key: "k", operator: "Gt", values: ["1"] }] };
    await open(bad);
    await expect.poll(() => notes("danger")).toEqual(["The selector uses an operator Kubernetes does not know, so it selects nothing."]);
    expect(watchOf("Service")).toBeUndefined();
  });

  it("lists at most 30 targets by name, and says the list could not be read", async () => {
    await open(monitor());
    await expect.poll(() => watchOf("Service")).toBeDefined();
    const many = Array.from({ length: MAX_LISTED_TARGETS + 2 }, (_, i) => ({ ...services()[0]!, metadata: { ...services()[0]!.metadata, name: `svc-${String(i).padStart(2, "0")}`, uid: `u${i}` } }));
    watchOf("Service")!.emit(snapshot(many as KubeObject[]));
    await expect.poll(() => notes("muted")).toContain("and 2 more");
    expect(text()).toContain("32 Services");
    watchOf("Service")!.emit({ type: "error", message: "nope" } as never);
    await expect.poll(() => notes("warning")).toContain("The list could not be read.");
  });

  it("of a cluster without Prometheus kinds: says there is no Prometheus object", async () => {
    await open(monitor(), { kinds: [] });
    await expect.poll(() => notes("muted")).toContain("There is no Prometheus object in the cluster.");
    expect(watchOf("Prometheus")).toBeUndefined();
  });
});

describe("details of other kinds", () => {
  it("a PodMonitor lists Pods and their container ports", async () => {
    await open(podMonitor());
    await expect.poll(() => watchOf("Pod")).toBeDefined();
    expect(params(watchOf("Pod")!)).toEqual({ kind: { group: "", version: "v1", kind: "Pod" }, namespaces: ["default"], labelSelector: "app=example-app" });
    const pod = obj({ apiVersion: "v1", kind: "Pod", metadata: { name: "example-app-1", namespace: "default", uid: "p1", labels: { app: "example-app" } }, spec: { containers: [{ name: "c", ports: [{ name: "web", containerPort: 8080 }] }] } });
    watchOf("Pod")!.emit(snapshot([pod]));
    await expect.poll(() => text()).toContain("1 Pod");
    expect(rows()[1]).toEqual(["web", "/metrics", "", "on 1 of 1"]);
  });

  it("a PrometheusRule: its groups, and who picks it up only while that block is open", async () => {
    await open(rule(), { blocks: { pickup: false } });
    expect(rows()).toEqual([
      ["Group", "Interval", "Alerts", "Recording rules"],
      ["./example.rules", "", "1", "1"],
    ]);
    await new Promise((r) => setTimeout(r, 20));
    expect(watchOf("Prometheus")).toBeUndefined();
    toggle("pickup")!.click();
    await expect.poll(() => watchOf("Prometheus")).toBeDefined();
    watchOf("Prometheus")!.emit(snapshot([prometheus()]));
    watchOf("PrometheusAgent")!.emit(snapshot([]));
    // The fixture's Prometheus picks every rule of its own namespace (`ruleSelector: {}`).
    await expect.poll(() => links()).toEqual(["default/prometheus"]);
  });

  it("a Prometheus: why it is not available, its readiness, replicas and selectors, watching nothing", async () => {
    await open(prometheus());
    expect(notes("danger")).toEqual(["shard 0: pod prometheus-prometheus-1: containers with incomplete status: [init-config-reloader]"]);
    const status = root.querySelector<HTMLElement>(".sx-status")!;
    expect([status.textContent, status.className, status.title]).toEqual([
      "Degraded",
      "sx-status sx-status--warning",
      "SomePodsNotReady: shard 0: pod prometheus-prometheus-1: containers with incomplete status: [init-config-reloader]",
    ]);
    expect(text()).toContain("1 of 2 available");
    expect(rows()).toEqual([
      ["Kind", "Selector", "Namespaces"],
      ["ServiceMonitors", "team=frontend", "Its own namespace"],
      ["PodMonitors", "team=frontend", "Its own namespace"],
      ["Probes", "None", "Its own namespace"],
      ["PrometheusRules", "All", "Its own namespace"],
    ]);
    expect(host.watches).toHaveLength(0);
  });

  it("an Alertmanager has no selectors block; a Probe its prober and targets", async () => {
    const am = prometheus();
    am.kind = "Alertmanager";
    await open(am);
    expect(root.querySelector('[data-block="selectors"]')).toBeNull();
    stop();
    host.close();
    const probe = obj({
      apiVersion: "monitoring.coreos.com/v1",
      kind: "Probe",
      metadata: { name: "blackbox", namespace: "default", uid: "probe-1" },
      spec: { prober: { url: "blackbox:9115" }, module: "http_2xx", targets: { staticConfig: { static: ["https://example.com"] } } },
    });
    await open(probe, { blocks: { pickup: false } });
    expect(text()).toContain("blackbox:9115");
    expect(text()).toContain("https://example.com");
  });

  it("speaks the UI language", async () => {
    await open(prometheus(), { language: "de" });
    expect(text()).toContain("1 von 2 verfügbar");
  });
});
