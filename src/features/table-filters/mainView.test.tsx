import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBackend, resetWatchRegistry, type KubeObject, type MockBackend, type ResourceKind, type WatchSpec } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import type { TableFilters } from "../../api/generated/TableFilters";
import { resetAppStore, useAppStore } from "../../app/store";
import { MainView } from "../../layout/main/MainView";
import { getResourceDefs, resetClusterKinds } from "../../resources";
import { defaultClusterSettings } from "../clusters/clusterSettings";
import { resetMetricsCache } from "../metrics/hooks";
import { resetNamespaceRestore } from "../namespaces";
import { resetTableFiltersState } from "./state";

const POD_VIEW = "kind:/Pod";
const CONFIG_VIEW = "kind:/ConfigMap";
const excludeJob: TableFilters = {
  columns: { controlledBy: { values: { mode: "exclude", values: ["Job"] }, condition: null } }, advanced: null,
};
const kinds: ResourceKind[] = getResourceDefs().map((def) => ({
  kindRef: def.kind, plural: `${def.kind.kind.toLowerCase()}s`, namespaced: def.namespaced ?? true,
  verbs: ["list", "watch"], printerColumns: [],
}));
const pod = (name: string, owner?: "Job" | "ReplicaSet"): KubeObject => ({
  apiVersion: "v1", kind: "Pod", metadata: {
    name, namespace: "shop", uid: `uid-${name}`, resourceVersion: "1",
    ...(owner ? { ownerReferences: [{ apiVersion: owner === "Job" ? "batch/v1" : "apps/v1", kind: owner, name: `${owner.toLowerCase()}-owner`, uid: `uid-${owner}`, controller: true }] } : {}),
  }, spec: { containers: [{ name: "app" }] }, status: { phase: "Running" },
});

let backend: MockBackend;
let watches: { id: string; spec: WatchSpec }[];
beforeEach(() => {
  resetAppStore(); resetClusterKinds(); resetNamespaceRestore(); resetTableFiltersState(); resetSettingsCache(); resetMetricsCache(); resetWatchRegistry();
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("rt__scroll") ? 660 : 0;
  });
  watches = [];
  backend = mockBackend({
    cluster_kinds: () => kinds,
    watch_start: ({ spec }) => {
      const watchSpec = spec as WatchSpec;
      const id = `${watchSpec.kind.kind}-${watches.length + 1}`;
      watches.push({ id, spec: watchSpec });
      return id;
    },
    watch_stop: () => undefined,
  }, { settings: { clusters: { c1: { ...defaultClusterSettings(), tableFilters: { [POD_VIEW]: excludeJob } } } } });
  useAppStore.getState().setActiveCluster("c1");
  useAppStore.getState().setView("c1", POD_VIEW);
});
afterEach(() => {
  cleanup(); resetWatchRegistry(); backend.restore(); resetTableFiltersState(); resetSettingsCache(); resetMetricsCache();
  resetAppStore(); resetClusterKinds(); resetNamespaceRestore(); vi.restoreAllMocks();
});

async function emitPods() {
  const activePodWatch = () => watches.filter((watch) => watch.spec.kind.kind === "Pod" && !watch.spec.metadataOnly
    && backend.listenerCount(`watch:${watch.id}`) === 1).at(-1);
  await waitFor(() => expect(activePodWatch()).toBeDefined());
  const watch = activePodWatch()!;
  act(() => backend.emit(`watch:${watch.id}`, { type: "snapshot", items: [pod("job-pod", "Job"), pod("deployment-pod", "ReplicaSet"), pod("standalone-pod")] }));
}

describe("persisted filters in primary resource lists", () => {
  it("restores controlledBy exclusion in MainView and retains it after visiting another kind", async () => {
    render(<MainView clusterId="c1" />);
    await emitPods();
    const table = await screen.findByRole("table");
    expect(within(table).queryByText("job-pod")).not.toBeInTheDocument();
    expect(within(table).getByText("deployment-pod")).toBeInTheDocument();
    expect(within(table).getByText("standalone-pod")).toBeInTheDocument();
    expect(screen.getByTestId("rt-count")).toHaveTextContent("2 of 3");
    expect(screen.getByRole("button", { name: /^Filters\s*1$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filter Controlled By" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Controlled By: except Job" })).toBeInTheDocument();

    act(() => useAppStore.getState().setView("c1", CONFIG_VIEW));
    expect(await screen.findByRole("heading", { name: "Config Maps" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
    act(() => useAppStore.getState().setView("c1", POD_VIEW));
    await emitPods();
    const reopened = await screen.findByRole("table");
    expect(within(reopened).queryByText("job-pod")).not.toBeInTheDocument();
    expect(within(reopened).getByText("deployment-pod")).toBeInTheDocument();
    expect(within(reopened).getByText("standalone-pod")).toBeInTheDocument();
    expect(screen.getByTestId("rt-count")).toHaveTextContent("2 of 3");
    expect(backend.settings.clusters.c1!.tableFilters).toEqual({ [POD_VIEW]: excludeJob });
    expect(backend.calls.filter((call) => call.cmd === "settings_update")).toHaveLength(0);
  });
});
