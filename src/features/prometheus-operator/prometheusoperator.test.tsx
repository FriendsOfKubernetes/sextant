import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings, type AppSettings, type KindRef, type KubeObject, type ObjectRef, type ResourceKind, type WatchSpec } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { Sidebar } from "../../layout/sidebar/Sidebar";
import { resetClusterKinds } from "../../resources";
import { axeViolations } from "../../test/axe";
import "../details";
import { copy, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore } from "../namespaces";
import { detect } from "../problems/model";
import { resetProblemSources } from "../problems/store";
import { sourcesFor } from "../problems/sources";
import { labelSelector } from "../resource-map/selectors";
import { resetSharedWatches } from "../resource-map/watches";
import fixtures from "./fixtures/monitoring.json";
import "./index";
import {
  ALERTMANAGER,
  picksUp,
  POD_MONITOR,
  PROBE,
  PROMETHEUS,
  PROMETHEUS_RULE,
  ruleGroupsOf,
  selectorText,
  SERVER_GRACE_MS,
  serverReadiness,
  SERVICE_MONITOR,
  targetNamespaces,
} from "./model";
import { toProblems } from "./provider";
import { acquireMonitoring, getMonitoring, REBUILD_DELAY_MS, resetMonitoringStore } from "./store";
import { acquireWatch as acquireSharedWatch } from "../resource-map/watches";
import { OPT_IN_CATEGORIES } from "../problems/model";

const fx = fixtures as unknown as Record<string, KubeObject> & { services: KubeObject[] };
const monitor = fx.serviceMonitor!;
const orphan = fx.orphanMonitor!;
const prometheus = fx.prometheus!;
const rule = fx.rule!;
const noLabels = () => undefined;

describe("the model", () => {
  it("where a monitor looks and its selector as the API server's text", () => {
    expect(targetNamespaces(monitor)).toEqual({ type: "list", names: ["default"] });
    const anywhere = copy(monitor);
    (anywhere.spec as Record<string, unknown>).namespaceSelector = { any: true };
    expect(targetNamespaces(anywhere)).toEqual({ type: "any" });
    (anywhere.spec as Record<string, unknown>).namespaceSelector = { matchNames: ["b", "a", "b"] };
    expect(targetNamespaces(anywhere)).toEqual({ type: "list", names: ["a", "b"] });
    const selector = labelSelector({
      matchLabels: { app: "web" },
      matchExpressions: [
        { key: "tier", operator: "In", values: ["a", "b"] },
        { key: "canary", operator: "DoesNotExist" },
      ],
    });
    expect(selectorText(selector)).toBe("app=web,tier in (a,b),!canary");
    expect(selectorText(labelSelector({}))).toBe("");
    expect(selectorText(labelSelector({ matchExpressions: [{ key: "x", operator: "Bogus" }] }))).toBeNull();
  });

  it("a Prometheus with ignoreNamespaceSelectors makes its monitors look in their own namespace only", () => {
    const wide = copy(monitor);
    (wide.spec as Record<string, unknown>).namespaceSelector = { matchNames: ["a", "b"] };
    const ignoring = copy(prometheus);
    (ignoring.spec as Record<string, unknown>).ignoreNamespaceSelectors = true;
    expect(targetNamespaces(wide)).toEqual({ type: "list", names: ["a", "b"] });
    expect(targetNamespaces(wide, [prometheus])).toEqual({ type: "list", names: ["a", "b"] });
    expect(targetNamespaces(wide, [ignoring])).toEqual({ type: "list", names: ["default"] });
    // One ignores, one does not: both sets of namespaces are scraped.
    expect(targetNamespaces(wide, [ignoring, prometheus])).toEqual({ type: "list", names: ["a", "b", "default"] });
    const anywhere = copy(monitor);
    (anywhere.spec as Record<string, unknown>).namespaceSelector = { any: true };
    expect(targetNamespaces(anywhere, [ignoring])).toEqual({ type: "list", names: ["default"] });
  });

  it("a Prometheus picks a monitor up by its selector and namespace selector", () => {
    expect(picksUp(prometheus, SERVICE_MONITOR, monitor, noLabels)).toBe(true);
    expect(picksUp(prometheus, SERVICE_MONITOR, orphan, noLabels)).toBe(false);
    // A null namespace selector: only the Prometheus's own namespace.
    const elsewhere = copy(monitor);
    elsewhere.metadata!.namespace = "other";
    expect(picksUp(prometheus, SERVICE_MONITOR, elsewhere, noLabels)).toBe(false);
    // A null selector selects nothing (Probes here); an empty one everything (rules).
    expect(picksUp(prometheus, PROBE, { ...monitor, kind: "Probe" }, noLabels)).toBe(false);
    expect(picksUp(prometheus, PROMETHEUS_RULE, rule, noLabels)).toBe(true);
    // A namespace selector by labels needs the namespace's labels.
    const byLabels = copy(prometheus);
    (byLabels.spec as Record<string, unknown>).serviceMonitorNamespaceSelector = { matchLabels: { monitoring: "on" } };
    expect(picksUp(byLabels, SERVICE_MONITOR, elsewhere, noLabels)).toBeUndefined();
    expect(picksUp(byLabels, SERVICE_MONITOR, elsewhere, () => ({ monitoring: "on" }))).toBe(true);
  });

  it("reads rule groups and the readiness of Prometheus", () => {
    expect(ruleGroupsOf(rule)).toEqual([{ name: "./example.rules", interval: undefined, alerts: 1, records: 1 }]);
    expect(serverReadiness(prometheus)).toMatchObject({ state: "degraded", available: 1, desired: 2, reason: "SomePodsNotReady" });
    expect(detect(PROMETHEUS, prometheus)).toEqual([expect.objectContaining({ reason: "SomePodsNotReady", graceMs: SERVER_GRACE_MS })]);
    expect(detect(SERVICE_MONITOR, monitor)).toEqual([]);
  });

  it("the problems source: Prometheus and Alertmanager watched, the monitors through the provider, only where served", () => {
    const kinds = [SERVICE_MONITOR, PROMETHEUS, ALERTMANAGER].map(served);
    expect(sourcesFor(["prometheusOperator"], kinds).map((s) => `${s.kind.kind}${s.external ? " (provider)" : ""}`)).toEqual([
      "Prometheus",
      "Alertmanager",
      "ServiceMonitor (provider)",
    ]);
    expect(sourcesFor(["prometheusOperator"], [served(POD)])).toEqual([]);
  });
});

// ---------- In the app ----------

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const SERVICE: KindRef = { group: "", version: "v1", kind: "Service" };
const MONITORING = [SERVICE_MONITOR, POD_MONITOR, PROBE, PROMETHEUS_RULE, PROMETHEUS, ALERTMANAGER];
function served(kind: KindRef): ResourceKind {
  return { kindRef: kind, plural: `${kind.kind.toLowerCase()}s`, namespaced: true, verbs: ["list", "watch"], printerColumns: [] };
}

let wb: WatchBackend;
let stored: AppSettings;

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetProblemSources();
  resetMonitoringStore();
  resetSharedWatches();
  resetSettingsCache();
  resetNamespaceRestore();
  stored = defaultAppSettings();
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => [POD, SERVICE, ...MONITORING].map(served));
  wb.backend.on("settings_get", () => structuredClone(stored));
});

afterEach(() => {
  wb.backend.restore();
  resetClusterKinds();
  resetProblemSources();
  resetMonitoringStore();
  resetSharedWatches();
  resetSettingsCache();
});

/** Sends a snapshot to every listening watch of `kind` (matching `match`). */
function emitAll(kind: string, items: KubeObject[], match: (s: WatchSpec) => boolean = () => true): void {
  for (const [id, spec] of wb.specs) {
    if (spec.kind.kind !== kind || !match(spec) || wb.backend.listenerCount(`watch:${id}`) === 0) continue;
    act(() => wb.backend.emit(`watch:${id}`, { type: "snapshot", items }));
  }
}

const settle = () => act(() => new Promise<void>((r) => setTimeout(r, REBUILD_DELAY_MS + 150)));

describe("what the monitors select, for the problems screen", () => {
  it("finds a monitor that selects nothing and one no Prometheus picks up", async () => {
    stored.notifications.enabledCategories = ["prometheusOperator"];
    render(<Sidebar clusterId="c1" />);
    const release = acquireMonitoring("c1");
    await watchOf(wb, "ServiceMonitor");
    emitAll("ServiceMonitor", [monitor, orphan]);
    emitAll("PodMonitor", []);
    emitAll("Prometheus", [prometheus]);
    emitAll("PrometheusAgent", []);
    emitAll("Alertmanager", []);
    await settle();
    // Services of the monitors' namespace, metadata only.
    const services = await watchOf(wb, "Service", (s) => s.metadataOnly === true);
    expect(wb.specs.get(services)?.namespaces).toEqual(["default"]);
    emitAll("Service", fx.services, (s) => s.metadataOnly === true);
    await waitFor(() => expect(getMonitoring("c1").loading).toBe(false));
    const findings = getMonitoring("c1").findings;
    expect(findings.map((f) => [f.ref.name, f.selected, f.pickedBy])).toEqual([
      ["example-app", 2, ["default/prometheus"]],
      ["orphan", 0, []],
    ]);
    const problems = toProblems(findings, new Map(), 1000);
    expect(problems.map((p) => [p.object.name, p.reason, p.notify, p.messageKey])).toEqual([
      ["orphan", "SelectsNothing", true, "messages.serviceMonitorSelectsNothing"],
      ["orphan", "NotPickedUp", false, "messages.monitorNotPickedUp"],
    ]);
    expect(problems[0]?.messageLists).toEqual({ namespaces: ["default"] });
    // The section counts the monitor that selects nothing and the degraded Prometheus, not the warning.
    await waitFor(() => expect(screen.getByTitle("2 objects need attention")).toHaveTextContent("2"));
    release();
  });

  it("is an opt-in category: nothing is listed or counted until it is turned on", async () => {
    expect(OPT_IN_CATEGORIES).toContain("prometheusOperator");
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(true));
    await settle();
    expect([...wb.specs.values()].some((s) => s.kind.kind === "ServiceMonitor" || s.kind.kind === "Prometheus")).toBe(false);
  });

  it("is rebuilt only when its own watches change, not on every change of another shared watch", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(true));
    await settle();
    const release = acquireMonitoring("c1");
    await watchOf(wb, "ServiceMonitor");
    emitAll("ServiceMonitor", [monitor]);
    emitAll("PodMonitor", []);
    emitAll("Prometheus", [prometheus]);
    emitAll("PrometheusAgent", []);
    await settle();
    emitAll("Service", fx.services, (s) => s.metadataOnly === true);
    await waitFor(() => expect(getMonitoring("c1").loading).toBe(false), { timeout: 3000 });
    const built = getMonitoring("c1");
    // A busy unrelated list (the resource map's ConfigMaps) changes twice.
    const other = acquireSharedWatch("c1", { kind: { group: "", version: "v1", kind: "ConfigMap" }, namespaces: ["x"], labelSelector: null, fieldSelector: null });
    const cm = await watchOf(wb, "ConfigMap");
    act(() => wb.backend.emit(`watch:${cm}`, { type: "snapshot", items: [] }));
    act(() => wb.backend.emit(`watch:${cm}`, { type: "snapshot", items: [{ metadata: { name: "a", namespace: "x", uid: "a" } }] }));
    await settle();
    expect(getMonitoring("c1")).toBe(built);
    // Its own list changes: rebuilt once the delay has passed.
    emitAll("ServiceMonitor", [monitor, orphan]);
    await settle();
    expect(getMonitoring("c1")).not.toBe(built);
    other();
    release();
  });
});

function refTo(obj: KubeObject): ObjectRef {
  return { kind: { group: "monitoring.coreos.com", version: "v1", kind: obj.kind ?? "" }, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
}

async function openDetails(obj: KubeObject): Promise<HTMLElement> {
  const ref = refTo(obj);
  useAppStore.getState().openDetails(ref);
  const { container } = render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`);
  emitAll(ref.kind.kind, [obj], (s) => s.fieldSelector === `metadata.name=${ref.name}`);
  await waitFor(() => expect(document.querySelector("[data-section='prometheusOperator']")).not.toBeNull());
  return container;
}

const view = () => within(document.querySelector<HTMLElement>("[data-section='prometheusOperator']")!);

describe("details of a ServiceMonitor", () => {
  it("lists the Services its selector picks now, checks the port names and names the Prometheus that picks it up", async () => {
    const container = await openDetails(monitor);
    // The selector goes to the API server; only the monitor's namespace is listed.
    const id = await watchOf(wb, "Service", (s) => s.labelSelector === "app=example-app");
    expect(wb.specs.get(id)?.namespaces).toEqual(["default"]);
    emitAll("Service", fx.services.slice(0, 2), (s) => s.labelSelector === "app=example-app");
    await watchOf(wb, "Prometheus");
    emitAll("Prometheus", [prometheus]);
    emitAll("PrometheusAgent", []);
    const v = view();
    await waitFor(() => expect(v.getByText("2 Services")).toBeInTheDocument());
    expect(v.getByRole("button", { name: "Open Service example-app-2" })).toBeInTheDocument();
    const rows = v.getAllByRole("row").map((r) => r.textContent);
    expect(rows).toContain("web/metricson 2 of 2");
    expect(rows).toContain("metrics/stats30son 1 of 2");
    await waitFor(() => expect(v.getByRole("button", { name: "Open Prometheus prometheus" })).toBeInTheDocument());
    expect(await axeViolations(container)).toEqual([]);
  });

  it("says when it selects nothing and no Prometheus picks it up", async () => {
    await openDetails(orphan);
    await watchOf(wb, "Service", (s) => s.labelSelector === "app=gone");
    emitAll("Service", [], (s) => s.labelSelector === "app=gone");
    await watchOf(wb, "Prometheus");
    emitAll("Prometheus", [prometheus]);
    emitAll("PrometheusAgent", []);
    const v = view();
    await waitFor(() => expect(v.getByText("Selects no Service: Prometheus scrapes nothing for it.")).toBeInTheDocument());
    await waitFor(() => expect(v.getByText(/No Prometheus picks it up/)).toBeInTheDocument());
  });
});

describe("details of Prometheus and a PrometheusRule", () => {
  it("a Prometheus: degraded, replicas and what it picks up", async () => {
    const container = await openDetails(prometheus);
    const v = view();
    expect(v.getByText("Degraded")).toHaveClass("rt-status--warning");
    expect(v.getByText("1 of 2 available")).toBeInTheDocument();
    const rows = v.getAllByRole("row").map((r) => r.textContent);
    expect(rows).toContain("ServiceMonitorsteam=frontendIts own namespace");
    expect(rows).toContain("ProbesNoneIts own namespace");
    expect(rows).toContain("PrometheusRulesAllIts own namespace");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("a PrometheusRule: its groups and rules", async () => {
    await openDetails(rule);
    const rows = view().getAllByRole("row").map((r) => r.textContent);
    expect(rows).toContain("./example.rules11");
  });
});
