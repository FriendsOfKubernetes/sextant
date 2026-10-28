import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultAppSettings, loadSettings, type AppSettings, type KindRef, type KubeObject, type ObjectRef, type ResourceKind } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetClusterKinds } from "../../resources";
import { watchBackend, type WatchBackend } from "../../features/details/testing";
import { resetSharedWatches, setWatchLinger } from "../../features/resource-map/watches";
import { ResourceTreeSection } from "./ResourceTree";
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
  wb.backend.on("cluster_kinds", () => [POD, NAMESPACE, SERVICE, NETWORK_POLICY].map(served));
  await loadSettings();
});
afterEach(() => {
  cleanup(); vi.useRealTimers(); resetMetricsCache(); resetSharedWatches(); resetClusterKinds(); setWatchLinger(null);
  wb.backend.restore(); resetSettingsCache(); resetDetailsDisclosureState();
});


it("releases and reacquires the real resource-tree watch when collapsed", async () => {
  const app: KubeObject = { apiVersion: "argoproj.io/v1alpha1", kind: "Application", metadata: { name: "app" }, spec: { destination: { server: "https://kubernetes.default.svc", namespace: "demo" } }, status: { resources: [{ group: "apps", version: "v1", kind: "Deployment", namespace: "demo", name: "workload" }] } };
  render(<DetailsDisclosureProvider clusterId="c1" objectRef={ref}><DetailsSectionScope id="argocd">
    <ResourceTreeSection clusterId="c1" objectRef={ref} obj={app} />
  </DetailsSectionScope></DetailsDisclosureProvider>);
  await waitFor(() => expect(wb.specs.size).toBeGreaterThan(0));
  const ids = [...wb.specs.keys()];
  const button = screen.getByRole("button", { expanded: true });
  fireEvent.click(button);
  await waitFor(() => { for (const id of ids) expect(wb.backend.listenerCount(`watch:${id}`)).toBe(0); });
  fireEvent.click(screen.getByRole("button", { expanded: false }));
  await waitFor(() => expect([...wb.specs.keys()].some((id) => !ids.includes(id))).toBe(true));
});
