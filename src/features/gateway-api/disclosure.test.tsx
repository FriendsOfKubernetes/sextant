import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultAppSettings, loadSettings, updateSettings, type AppSettings, type KindRef, type KubeObject, type ObjectRef, type ResourceKind } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetClusterKinds } from "../../resources";
import { watchBackend, type WatchBackend } from "../../features/details/testing";
import { resetSharedWatches, setWatchLinger } from "../../features/resource-map/watches";
import { ExposedBySection } from "./reverse";
import { emitSnapshot, watchOf } from "../details/testing";
import { useWatch } from "../../api";
import { NAMESPACE, NETWORK_POLICY, POD, SERVICE } from "../../features/netpol/hooks";


import { resetMetricsCache } from "../../features/metrics/hooks";
import { DetailsDisclosureProvider, DetailsSectionScope } from "../../layout/details/disclosure";
import { resetDetailsDisclosureState } from "../../layout/details/disclosureState";

const ref: ObjectRef = { kind: POD, namespace: "demo", name: "demo-api" };
const INGRESS: KindRef = { group: "networking.k8s.io", version: "v1", kind: "Ingress" };
let wb: WatchBackend;
beforeEach(async () => {
  resetSettingsCache(); resetDetailsDisclosureState(); resetClusterKinds(); resetSharedWatches(); resetMetricsCache(); setWatchLinger(0);
  wb = watchBackend();
  let settings = defaultAppSettings();
  wb.backend.on("settings_get", () => settings);
  wb.backend.on("settings_update", (args) => settings = args.settings as AppSettings);
  const served = (kind: KindRef): ResourceKind => ({ kindRef: kind, plural: kind.kind.toLowerCase(), namespaced: kind.kind !== "Namespace", verbs: ["list", "watch"], printerColumns: [] });
  wb.backend.on("cluster_kinds", () => [POD, NAMESPACE, SERVICE, NETWORK_POLICY, INGRESS].map(served));
  await loadSettings();
});
afterEach(() => {
  cleanup(); vi.useRealTimers(); resetMetricsCache(); resetSharedWatches(); resetClusterKinds(); setWatchLinger(null);
  wb.backend.restore(); resetSettingsCache(); resetDetailsDisclosureState();
});




it("probes remembered collapse then releases exposure watches, preserving a shared ingress consumer", async () => {
  const service: KubeObject = { apiVersion: "v1", kind: "Service", metadata: { name: "api", namespace: "demo" } };
  const ingress: KubeObject = { apiVersion: "networking.k8s.io/v1", kind: "Ingress", metadata: { name: "edge", namespace: "demo", uid: "edge" }, spec: { rules: [{ http: { paths: [{ path: "/", backend: { service: { name: "api", port: { number: 80 } } } }] } }] } };
  function Other() { useWatch("c1", { kind: INGRESS, namespaces: ["demo"], labelSelector: null, fieldSelector: null }); return null; }
  const other = render(<Other />);
  const panel = () => <DetailsDisclosureProvider clusterId="c1" objectRef={ref}><DetailsSectionScope id="gateway"><ExposedBySection clusterId="c1" objectRef={ref} obj={service} /></DetailsSectionScope></DetailsDisclosureProvider>;
  const view = render(panel());
  const id = await watchOf(wb, "Ingress");
  emitSnapshot(wb, id, [ingress]);
  fireEvent.click(await screen.findByRole("button", { expanded: true }));
  expect(wb.backend.listenerCount(`watch:${id}`)).toBeGreaterThan(0);
  other.unmount();
  await waitFor(() => expect(wb.backend.listenerCount(`watch:${id}`)).toBe(0));
  view.unmount();
  render(panel());
  const next = await watchOf(wb, "Ingress");
  expect(next).not.toBe(id);
  emitSnapshot(wb, next, [ingress]);
  await screen.findByRole("button", { expanded: false });
  await waitFor(() => expect(wb.backend.listenerCount(`watch:${next}`)).toBe(0));
  fireEvent.click(screen.getByRole("button", { expanded: false }));
  await waitFor(() => expect([...wb.specs].some(([key, spec]) => key !== next && key !== id && spec.kind.kind === "Ingress")).toBe(true));
});

it.each(["empty", "forbidden"] as const)("settles a closed exposure probe after an %s response without restarting the watch", async response => {
  const service: KubeObject = { apiVersion: "v1", kind: "Service", metadata: { name: "api", namespace: "demo" } };
  const serviceRef: ObjectRef = { kind: SERVICE, name: "api", namespace: "demo" };
  await updateSettings(settings => ({ ...settings, appearance: { ...settings.appearance, detailsSections: { "/Service": { "gateway/gateway:exposedBy.title": false } } } }));
  render(<DetailsDisclosureProvider clusterId="c1" objectRef={serviceRef}><DetailsSectionScope id="gateway"><ExposedBySection clusterId="c1" objectRef={serviceRef} obj={service} /></DetailsSectionScope></DetailsDisclosureProvider>);
  const id = await watchOf(wb, "Ingress");
  if (response === "empty") emitSnapshot(wb, id, []);
  else act(() => wb.backend.emit(`watch:${id}`, { type: "error", error: { code: "forbidden", message: "no ingress access" } }));
  await waitFor(() => expect(wb.backend.listenerCount(`watch:${id}`)).toBe(0));
  expect(wb.specs.size).toBe(1);
  if (response === "empty") expect(screen.queryByRole("button", { expanded: false })).not.toBeInTheDocument();
  else {
    const button = screen.getByRole("button", { expanded: false }); fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const next = await watchOf(wb, "Ingress"); expect(next).not.toBe(id);
    emitSnapshot(wb, next, [{ apiVersion: "networking.k8s.io/v1", kind: "Ingress", metadata: { name: "fresh-edge", namespace: "demo" }, spec: { rules: [{ http: { paths: [{ path: "/", backend: { service: { name: "api", port: { number: 80 } } } }] } }] } }]);
    expect(await screen.findByText("fresh-edge")).toBeInTheDocument();
  }
});

it("treats failed discovery as unknown, releases its fallback probe, and keeps its header", async () => {
  resetClusterKinds();
  wb.backend.on("cluster_kinds", () => { throw { code: "forbidden", message: "no discovery access" }; });
  const serviceRef: ObjectRef = { kind: SERVICE, name: "api", namespace: "demo" };
  await updateSettings(settings => ({ ...settings, appearance: { ...settings.appearance, detailsSections: { "/Service": { "gateway/gateway:exposedBy.title": false } } } }));
  render(<DetailsDisclosureProvider clusterId="c1" objectRef={serviceRef}><DetailsSectionScope id="gateway"><ExposedBySection clusterId="c1" objectRef={serviceRef} obj={{ apiVersion: "v1", kind: "Service", metadata: { name: "api", namespace: "demo" } }} /></DetailsSectionScope></DetailsDisclosureProvider>);
  await waitFor(() => expect(wb.specs.size).toBe(6));
  const ids = [...wb.specs.keys()];
  act(() => { for (const id of ids) wb.backend.emit(`watch:${id}`, { type: "error", error: { code: "forbidden", message: "no list access" } }); });
  await waitFor(() => { for (const id of ids) expect(wb.backend.listenerCount(`watch:${id}`)).toBe(0); });
  expect(wb.specs.size).toBe(6);
  expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument();
});
