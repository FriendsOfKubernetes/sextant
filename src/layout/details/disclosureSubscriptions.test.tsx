import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultAppSettings, loadSettings, type AppSettings, type KindRef, type KubeObject, type ObjectRef, type ResourceKind } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetClusterKinds } from "../../resources";
import { watchBackend, type WatchBackend } from "../../features/details/testing";
import { resetSharedWatches, setWatchLinger } from "../../features/resource-map/watches";
import { PodIsolationSection } from "../../features/netpol/details";
import { NAMESPACE, NETWORK_POLICY, POD, SERVICE } from "../../features/netpol/hooks";
import { useNetpolData } from "../../features/netpol/hooks";
import { MetricsDetailsSection } from "../../features/metrics/DetailsSection";
import { IDLE_TTL_MS, metricsCacheStats, POLL_INTERVAL_MS, resetMetricsCache, useMetricsStatus } from "../../features/metrics/hooks";
import { DetailsDisclosureProvider, DetailsSectionControls, DetailsSectionScope } from "./disclosure";
import { resetDetailsDisclosureState } from "./disclosureState";

const ref: ObjectRef = { kind: POD, namespace: "demo", name: "demo-api" };
const obj: KubeObject = { apiVersion: "v1", kind: "Pod", metadata: { name: ref.name, namespace: "demo" }, spec: { containers: [] } };
let wb: WatchBackend;
beforeEach(async () => {
  resetSettingsCache(); resetDetailsDisclosureState(); resetClusterKinds(); resetSharedWatches(); resetMetricsCache(); setWatchLinger(0);
  wb = watchBackend();
  let settings = defaultAppSettings();
  wb.backend.on("settings_get", () => settings);
  wb.backend.on("settings_update", (args) => settings = args.settings as AppSettings);
  const served = (kind: KindRef): ResourceKind => ({ kindRef: kind, plural: kind.kind.toLowerCase(), namespaced: kind.kind !== "Namespace", verbs: ["list", "watch"], printerColumns: [] });
  wb.backend.on("cluster_kinds", () => [POD, NAMESPACE, SERVICE, NETWORK_POLICY].map(served));
  await loadSettings();
});
afterEach(() => {
  cleanup(); vi.useRealTimers(); resetMetricsCache(); resetSharedWatches(); resetClusterKinds(); setWatchLinger(null);
  wb.backend.restore(); resetSettingsCache(); resetDetailsDisclosureState();
});

it("releases the network-policy watches on collapse, including namespace and DNS watches", async () => {
  render(<DetailsDisclosureProvider clusterId="c1" objectRef={ref}><DetailsSectionScope id="netpol">
    <PodIsolationSection clusterId="c1" objectRef={ref} obj={obj} />
  </DetailsSectionScope></DetailsDisclosureProvider>);
  await waitFor(() => expect([...wb.specs.values()].some((s) => s.kind.kind === "NetworkPolicy")).toBe(true));
  const ids = [...wb.specs.keys()];
  fireEvent.click(screen.getByRole("button", { name: "Network policies" }));
  await waitFor(() => { for (const id of ids) expect(wb.backend.listenerCount(`watch:${id}`)).toBe(0); });
  expect(wb.backend.calls.filter((c) => c.cmd === "watch_stop")).toHaveLength(ids.length);
  fireEvent.click(screen.getByRole("button", { name: "Network policies" }));
  await waitFor(() => expect([...wb.specs.keys()].some((id) => !ids.includes(id))).toBe(true));
});

it("keeps the real metrics poll for another consumer, stops after the last release and restarts only on reopen", async () => {
  vi.useFakeTimers();
  wb.backend.on("metrics_status", () => ({ metricsServer: false, prometheus: null, mode: { mode: "auto" }, usageSource: "auto", effectiveUsageSource: null }));
  render(<DetailsDisclosureProvider clusterId="c1" objectRef={ref}><DetailsSectionScope id="metrics">
    <MetricsDetailsSection clusterId="c1" objectRef={ref} obj={obj} />
  </DetailsSectionScope></DetailsDisclosureProvider>);
  await act(async () => {});
  expect(screen.getByText("Metrics are unavailable")).toBeInTheDocument();
  const count = () => wb.backend.calls.filter((c) => c.cmd === "metrics_status").length;
  expect(count()).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });
  expect(count()).toBe(2);
  function OtherConsumer() {
    const status = useMetricsStatus("c1");
    return <span>{status.data ? "Shared metrics ready" : "Loading shared metrics"}</span>;
  }
  const other = render(<OtherConsumer />);
  expect(screen.getByText("Shared metrics ready")).toBeInTheDocument();
  expect(count()).toBe(2);
  fireEvent.click(screen.getByRole("button", { name: "Metrics" }));
  expect(screen.queryByText("Metrics are unavailable")).not.toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2); });
  expect(count()).toBe(4);
  other.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(IDLE_TTL_MS); });
  expect(metricsCacheStats().entries).toBe(0);
  expect(count()).toBe(4);
  await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3); });
  expect(count()).toBe(4);
  fireEvent.click(screen.getByRole("button", { name: "Metrics" }));
  await act(async () => {});
  expect(screen.getByText("Metrics are unavailable")).toBeInTheDocument();
  expect(count()).toBe(5);
  await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });
  expect(count()).toBe(6);
  fireEvent.click(screen.getByRole("button", { name: "Metrics" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(IDLE_TTL_MS + POLL_INTERVAL_MS * 3); });
  expect(metricsCacheStats().entries).toBe(0);
  expect(count()).toBe(6);
});

it("preserves a shared network-policy consumer when the card collapses", async () => {
  function OtherConsumer() { useNetpolData("c1", ["demo"], { dns: true, pods: false }); return null; }
  const held = render(<OtherConsumer />);
  render(<DetailsDisclosureProvider clusterId="c1" objectRef={ref}><DetailsSectionScope id="netpol">
    <PodIsolationSection clusterId="c1" objectRef={ref} obj={obj} />
  </DetailsSectionScope></DetailsDisclosureProvider>);
  await waitFor(() => expect([...wb.specs.values()].some((s) => s.kind.kind === "NetworkPolicy")).toBe(true));
  const ids = [...wb.specs.keys()];
  fireEvent.click(screen.getByRole("button", { name: "Network policies" }));
  expect(wb.backend.calls.filter((c) => c.cmd === "watch_stop")).toHaveLength(0);
  for (const id of ids) expect(wb.backend.listenerCount(`watch:${id}`)).toBeGreaterThan(0);
  held.unmount();
  await waitFor(() => { for (const id of ids) expect(wb.backend.listenerCount(`watch:${id}`)).toBe(0); });
});

it("releases and reacquires real sources through the bulk controls", async () => {
  render(<DetailsDisclosureProvider clusterId="c1" objectRef={ref}>
    <DetailsSectionControls />
    <DetailsSectionScope id="netpol"><PodIsolationSection clusterId="c1" objectRef={ref} obj={obj} /></DetailsSectionScope>
  </DetailsDisclosureProvider>);
  await waitFor(() => expect([...wb.specs.values()].some((s) => s.kind.kind === "NetworkPolicy")).toBe(true));
  const ids = [...wb.specs.keys()];
  fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
  await waitFor(() => { for (const id of ids) expect(wb.backend.listenerCount(`watch:${id}`)).toBe(0); });
  fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
  await waitFor(() => expect([...wb.specs.keys()].some((id) => !ids.includes(id))).toBe(true));
  expect(screen.getByRole("button", { name: "Network policies" })).toHaveAttribute("aria-expanded", "true");
});
