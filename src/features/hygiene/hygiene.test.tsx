import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings, type KindRef, type KubeObject, type ResourceKind, type WatchSpec } from "../../api";
import { resetAppStore } from "../../app/store";
import { getPages } from "../../layout/pages";
import { resetClusterKinds } from "../../resources";
import { emitDelta, watchBackend, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore, selectNamespaces } from "../namespaces";
import { CONFIG_MAP, NAMESPACE, NAMESPACE_KINDS, PV, SECRET, SERVICE_ACCOUNT } from "../resource-map/kinds";
import { openWatchCount, resetSharedWatches, setWatchLinger } from "../resource-map/watches";
import "./index";
import { CLEANUP_PAGE_ID, CleanupPage } from "./CleanupPage";
import { ENDPOINTS } from "./kinds";

const OLD = "2026-01-01T00:00:00Z";

const BUILT_IN: KindRef[] = [
  ...NAMESPACE_KINDS.filter((k) => k.group !== "gateway.networking.k8s.io"),
  CONFIG_MAP,
  SECRET,
  SERVICE_ACCOUNT,
  ENDPOINTS,
  PV,
  NAMESPACE,
];
const served = (kind: KindRef): ResourceKind => ({
  kindRef: kind,
  plural: `${kind.kind.toLowerCase()}s`,
  namespaced: kind !== PV && kind !== NAMESPACE,
  verbs: ["list", "watch", "delete"],
  printerColumns: [],
});

let wb: WatchBackend;
let deletes: Record<string, unknown>[];
let samples: Record<string, unknown>[];
let checks: Record<string, unknown>[];

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetNamespaceRestore();
  resetSharedWatches();
  setWatchLinger(0);
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => BUILT_IN.map(served));
  deletes = [];
  samples = [];
  // The ConfigMap and Secret rules are off by default; these tests turn them on.
  const settings = defaultAppSettings();
  settings.cleanup = { ...settings.cleanup, checkConfigMaps: true, checkSecrets: true };
  wb.backend.on("settings_get", () => settings);
  wb.backend.on("cleanup_sample", (args) => {
    samples.push(args);
    return (args.kinds as KindRef[]).map((kind) => ({ kind, objects: [], more: false, error: null }));
  });
  wb.backend.on("resource_delete", (args) => {
    deletes.push(args);
    return null;
  });
  checks = [];
  wb.backend.on("cleanup_cluster_check", (args) => {
    checks.push(args);
    return { unavailableGroups: [], referenced: [], unread: [] };
  });
});

afterEach(() => {
  resetSharedWatches();
  setWatchLinger(null);
  wb.backend.restore();
  resetClusterKinds();
});

let n = 0;
function cm(name: string, extra: Record<string, unknown> = {}): KubeObject {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name, namespace: "app", uid: `uid-${name}-${++n}`, resourceVersion: "5", creationTimestamp: OLD, ...extra },
  };
}

/** Waits for every watch of the page, then lists `objects` (by kind and namespace) in each. Returns the watch ids. */
async function list(objects: KubeObject[]): Promise<Map<string, WatchSpec>> {
  // The namespace filter watches Namespaces of its own; the page has one watch per served kind.
  await waitFor(() => expect(new Set([...wb.specs.values()].map((s) => s.kind.kind)).size).toBe(BUILT_IN.length));
  for (const [id] of wb.specs) await waitFor(() => expect(wb.backend.listenerCount(`watch:${id}`)).toBeGreaterThan(0));
  for (const [id, spec] of wb.specs) {
    const items = objects.filter(
      (o) => o.kind === spec.kind.kind && (spec.namespaces === null || spec.namespaces.includes(o.metadata?.namespace ?? "")),
    );
    act(() => wb.backend.emit(`watch:${id}`, { type: "snapshot", items }));
  }
  return wb.specs;
}

const watchIdOf = (kind: string) => [...wb.specs.entries()].find(([, s]) => s.kind.kind === kind && s.namespaces !== null)![0];

describe("the Cleanup page", () => {
  it("is a page of the Cluster section after the security posture", () => {
    const page = getPages("cluster").find((p) => p.id === CLEANUP_PAGE_ID);
    expect(page).toMatchObject({ section: "cluster", order: 45, labelKey: "hygiene:sidebar", icon: "cleanup" });
  });

  it("asks for a namespace while the filter says all namespaces, and watches nothing", async () => {
    render(<CleanupPage clusterId="c1" />);
    expect(await screen.findByText("Choose namespaces")).toBeInTheDocument();
    // Only the namespace filter's own list of namespaces.
    expect([...wb.specs.values()].filter((s) => s.kind.kind !== "Namespace")).toEqual([]);
  });

  it("lists candidates with their reason, keeps managed objects apart, and watches only the namespace in view", async () => {
    await act(() => selectNamespaces("c1", ["app"]));
    const { unmount } = render(<CleanupPage clusterId="c1" />);
    await list([
      cm("orphan"),
      cm("kube-root-ca.crt"),
      cm("helm-values", { labels: { "app.kubernetes.io/managed-by": "Helm" }, annotations: { "meta.helm.sh/release-name": "web" } }),
      { apiVersion: "v1", kind: "Namespace", metadata: { name: "app", uid: "ns-app", creationTimestamp: OLD }, status: { phase: "Active" } },
    ]);
    const group = await screen.findByRole("region", { name: "ConfigMaps nothing uses" });
    expect(within(group).getByRole("checkbox", { name: "Select ConfigMap app/orphan" })).toBeInTheDocument();
    expect(within(group).getAllByText("No Pod, pod template or other watched object refers to it.")).toHaveLength(2);
    expect(within(group).getByText("Managed by a tool, not offered for deletion")).toBeInTheDocument();
    expect(within(group).getByText("Helm release web")).toBeInTheDocument();
    expect(within(group).queryByRole("checkbox", { name: /helm-values/ })).toBeNull();
    expect(screen.queryByText(/kube-root-ca/)).toBeNull();

    const namespaces = new Set([...wb.specs.values()].map((s) => JSON.stringify(s.namespaces)));
    expect(namespaces).toEqual(new Set([JSON.stringify(["app"]), "null"]));
    expect(new Set([...wb.specs.values()].filter((s) => s.namespaces === null).map((s) => s.kind.kind))).toEqual(new Set(["Namespace", "PersistentVolume"]));
    expect([...wb.specs.values()].find((s) => s.kind.kind === "Endpoints")?.metadataOnly).toBe(true);
    unmount();
    await waitFor(() => expect(openWatchCount()).toBe(0));
  });

  it("deletes the selected objects one by one with uid and resourceVersion preconditions", async () => {
    await act(() => selectNamespaces("c1", ["app"]));
    render(<CleanupPage clusterId="c1" />);
    const orphan = cm("orphan");
    await list([orphan, cm("other")]);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select ConfigMap app/orphan" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected (1)…" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete 1 object" });
    expect(within(dialog).getByText("app/orphan")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    const result = await screen.findByRole("dialog", { name: "Cleanup result" }, { timeout: 5000 });
    expect(within(result).getByText("Deleted")).toBeInTheDocument();
    expect(deletes).toEqual([
      {
        clusterId: "c1",
        ref: { kind: CONFIG_MAP, namespace: "app", name: "orphan" },
        preconditions: { uid: orphan.metadata!.uid, resourceVersion: "5" },
      },
    ]);
  });

  it("keeps an object that changed or became used after it was confirmed, and goes on with the rest", async () => {
    await act(() => selectNamespaces("c1", ["app"]));
    render(<CleanupPage clusterId="c1" />);
    const changed = cm("changed");
    const used = cm("used");
    await list([changed, used, cm("plain")]);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select all: ConfigMaps nothing uses" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected (3)…" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete 3 objects" });
    // While the dialog is open: one ConfigMap is edited, another starts being mounted by a pod.
    emitDelta(wb, watchIdOf("ConfigMap"), [{ ...changed, metadata: { ...changed.metadata, resourceVersion: "6" } }]);
    emitDelta(wb, watchIdOf("Pod"), [
      {
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name: "p", namespace: "app", uid: "pod-p", creationTimestamp: OLD },
        spec: { containers: [{ name: "c", image: "x" }], volumes: [{ name: "v", configMap: { name: "used" } }] },
        status: { phase: "Running" },
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    const result = await screen.findByRole("dialog", { name: "Cleanup result" }, { timeout: 5000 });
    expect(within(result).getByText("Deleted: 1. Kept: 2. Failed: 0.")).toBeInTheDocument();
    expect(result.querySelector('[data-outcome="changed"]')?.textContent).toContain("app/changed");
    expect(result.querySelector('[data-outcome="notCandidate"]')?.textContent).toContain("app/used");
    expect(deletes.map((d) => (d.ref as { name: string }).name)).toEqual(["plain"]);
  });

  it("reports a refused deletion per object and does not stop", async () => {
    await act(() => selectNamespaces("c1", ["app"]));
    wb.backend.on("resource_delete", (args) => {
      deletes.push(args);
      if ((args.ref as { name: string }).name === "a") throw { code: "forbidden", message: "configmaps \"a\" is forbidden" };
      if ((args.ref as { name: string }).name === "b") throw { code: "conflict", message: "Precondition failed" };
      return null;
    });
    render(<CleanupPage clusterId="c1" />);
    await list([cm("a"), cm("b"), cm("c")]);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select all: ConfigMaps nothing uses" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected (3)…" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    const result = await screen.findByRole("dialog", { name: "Cleanup result" }, { timeout: 5000 });
    expect(within(result).getByText("Deleted: 1. Kept: 1. Failed: 1.")).toBeInTheDocument();
    expect(deletes).toHaveLength(3);
  });

  it("asks to type the number of objects above 20", async () => {
    await act(() => selectNamespaces("c1", ["app"]));
    render(<CleanupPage clusterId="c1" />);
    await list(Array.from({ length: 21 }, (_, i) => cm(`cm-${i}`)));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select all: ConfigMaps nothing uses" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected (21)…" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete 21 objects" });
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(21);
    const confirm = within(dialog).getByRole("button", { name: "Delete" });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Type 21 to confirm" }), { target: { value: "20" } });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Type 21 to confirm" }), { target: { value: "21" } });
    expect(confirm).toBeEnabled();
  });

  it("samples the namespace in view once (metadata, a few names, no Events) and shows a Retain volume as kept", async () => {
    await act(() => selectNamespaces("c1", ["app"]));
    render(<CleanupPage clusterId="c1" />);
    await list([
      {
        apiVersion: "v1",
        kind: "PersistentVolume",
        metadata: { name: "pv-kept", uid: "pv-kept", creationTimestamp: OLD },
        spec: { persistentVolumeReclaimPolicy: "Retain", claimRef: { namespace: "app", name: "gone" } },
        status: { phase: "Released", lastPhaseTransitionTime: OLD },
      },
    ]);
    const group = await screen.findByRole("region", { name: "Released or unclaimed PersistentVolumes" });
    expect(within(group).getByText("Kept on purpose, not offered for deletion")).toBeInTheDocument();
    expect(within(group).getByText("Reclaim policy Retain: the data is kept on purpose.")).toBeInTheDocument();
    expect(within(group).queryByRole("checkbox")).toBeNull();
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ clusterId: "c1", namespace: "app", limit: 5 });
    expect((samples[0]!.kinds as KindRef[]).some((k) => k.kind === "Event")).toBe(false);
  });

  it("offers no ConfigMap or Secret while their rules are off, and says so", async () => {
    wb.backend.on("settings_get", () => defaultAppSettings());
    await act(() => selectNamespaces("c1", ["app"]));
    render(<CleanupPage clusterId="c1" />);
    expect(await screen.findByText("ConfigMaps and Secrets are not checked. They can be turned on in the settings.")).toBeInTheDocument();
    await waitFor(() => expect([...wb.specs.values()].some((s) => s.kind.kind === "Pod")).toBe(true));
    expect([...wb.specs.values()].some((s) => s.kind.kind === "ConfigMap" || s.kind.kind === "Secret")).toBe(false);
  });

  it("samples again after the confirmation: a custom resource created since the page opened keeps the ConfigMap", async () => {
    await act(() => selectNamespaces("c1", ["app"]));
    render(<CleanupPage clusterId="c1" />);
    await list([cm("orphan")]);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select ConfigMap app/orphan" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected (1)…" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete 1 object" });
    // An Argo CD Application appears in the namespace after the page sampled it.
    const application: KindRef = { group: "argoproj.io", version: "v1alpha1", kind: "Application" };
    wb.backend.on("cleanup_sample", (args) => {
      samples.push(args);
      return [{ kind: application, objects: [{ name: "shop", serviceAccount: null }], more: false, error: null }];
    });
    const before = samples.length;
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    const result = await screen.findByRole("dialog", { name: "Cleanup result" }, { timeout: 5000 });
    expect(result.querySelector('[data-outcome="notCandidate"]')?.textContent).toContain("app/orphan");
    expect(deletes).toEqual([]);
    expect(samples.length).toBeGreaterThan(before);
    // The cluster check looked for the page's ConfigMaps and nothing else.
    expect(checks.at(-1)?.targets).toEqual([{ kind: "ConfigMap", namespace: "app", name: "orphan" }]);
  });
});
