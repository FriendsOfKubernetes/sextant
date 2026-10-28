import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultAppSettings, loadSettings, type AppSettings, type KindRef, type KubeObject, type ObjectRef, type ResourceKind } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetClusterKinds } from "../../resources";
import { watchBackend, type WatchBackend } from "../../features/details/testing";
import { resetSharedWatches, setWatchLinger } from "../../features/resource-map/watches";
import { DraPodSection, DraNodeSection } from "./nodePod";
import { useNamespaceClaims } from "./hooks";
import fixtures from "./fixtures/objects.json";
import { RESOURCE_CLAIM, RESOURCE_SLICE } from "./model";
import { emitSnapshot, watchOf } from "../details/testing";
import { NAMESPACE, NETWORK_POLICY, POD, SERVICE } from "../../features/netpol/hooks";


import { resetMetricsCache } from "../../features/metrics/hooks";
import { DetailsDisclosureProvider, DetailsSectionScope } from "../../layout/details/disclosure";
import { resetDetailsDisclosureState } from "../../layout/details/disclosureState";

const ref: ObjectRef = { kind: POD, namespace: "demo", name: "demo-api" };
let wb: WatchBackend;
beforeEach(async () => {
  resetSettingsCache(); resetDetailsDisclosureState(); resetClusterKinds(); resetSharedWatches(); resetMetricsCache(); setWatchLinger(0);
  wb = watchBackend();
  let settings = defaultAppSettings();
  wb.backend.on("settings_get", () => settings);
  wb.backend.on("settings_update", (args) => settings = args.settings as AppSettings);
  const served = (kind: KindRef): ResourceKind => ({ kindRef: kind, plural: kind.kind.toLowerCase(), namespaced: kind.kind !== "Namespace", verbs: ["list", "watch"], printerColumns: [] });
  wb.backend.on("cluster_kinds", () => [POD, NAMESPACE, SERVICE, NETWORK_POLICY, RESOURCE_CLAIM, RESOURCE_SLICE].map(served));
  await loadSettings();
});
afterEach(() => {
  cleanup(); vi.useRealTimers(); resetMetricsCache(); resetSharedWatches(); resetClusterKinds(); setWatchLinger(null);
  wb.backend.restore(); resetSettingsCache(); resetDetailsDisclosureState();
});



const objects = fixtures as unknown as Record<string, KubeObject>;
function panel(section: React.ReactNode) { return <DetailsDisclosureProvider clusterId="c1" objectRef={ref}><DetailsSectionScope id="dra">{section}</DetailsSectionScope></DetailsDisclosureProvider>; }
it("releases and reacquires pod claims while preserving another consumer", async () => {
  function Other() { useNamespaceClaims("c1", "gpu-test1", true); return null; }
  const other = render(<Other />);
  render(panel(<DraPodSection clusterId="c1" objectRef={ref} obj={objects.podRunning!} />));
  const id = await watchOf(wb, "ResourceClaim");
  fireEvent.click(screen.getByRole("button", { expanded: true }));
  expect(wb.backend.listenerCount(`watch:${id}`)).toBeGreaterThan(0);
  other.unmount();
  await waitFor(() => expect(wb.backend.listenerCount(`watch:${id}`)).toBe(0));
  fireEvent.click(screen.getByRole("button", { expanded: false }));
  await waitFor(() => expect([...wb.specs.keys()].some((next) => next !== id)).toBe(true));
});
it("releases node slices after collapse and reacquires on expansion", async () => {
  render(panel(<DraNodeSection clusterId="c1" objectRef={ref} obj={{ metadata: { name: "kind-worker" } }} />));
  const id = await watchOf(wb, "ResourceSlice");
  emitSnapshot(wb, id, [objects.sliceV1!]);
  const button = await screen.findByRole("button", { expanded: true });
  fireEvent.click(button);
  await waitFor(() => expect(wb.backend.listenerCount(`watch:${id}`)).toBe(0));
  fireEvent.click(screen.getByRole("button", { expanded: false }));
  await waitFor(() => expect([...wb.specs].some(([next, spec]) => next !== id && spec.kind.kind === "ResourceSlice")).toBe(true));
});
