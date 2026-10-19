// Automated accessibility checks (axe-core) over the main screens, rendered with every feature and the mock backend.
// What axe cannot judge in jsdom (contrast, layout) is covered by src/styles/contrast.test.ts.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBackend, type KubeObject, type MockBackend, type ResourceKind, type WatchSpec } from "../api";
import { App } from "../app/App";
import "../app/features";
import { resetAppStore, useAppStore } from "../app/store";
import { ConfirmDialog, Dialog } from "../components";
import { openSettings, SETTINGS_PAGE_ID, SETTINGS_TABS } from "../features/settings";
import { PROBLEMS_PAGE_ID } from "../features/problems/constants";
import { openLogsTab } from "../features/logs/openLogsTab";
import { openExecTab } from "../features/terminal/tabs";
import { getResourceDefs, resetClusterKinds } from "../resources";
import { axeViolations } from "./axe";

const served = (group: string, version: string, kind: string, namespaced = true): ResourceKind => ({
  kindRef: { group, version, kind },
  plural: `${kind.toLowerCase()}s`,
  namespaced,
  verbs: ["list", "watch", "get", "patch", "delete"],
  printerColumns: [],
});

const KINDS = getResourceDefs().map((d) => served(d.kind.group, d.kind.version, d.kind.kind, d.namespaced ?? true));

const pod = (name: string, phase = "Running"): KubeObject => ({
  apiVersion: "v1",
  kind: "Pod",
  metadata: { name, namespace: "default", uid: `uid-${name}`, creationTimestamp: "2026-10-01T00:00:00Z", labels: { app: "web" } },
  spec: { nodeName: "node-1", containers: [{ name: "app", image: "nginx:1.27" }] },
  status: {
    phase,
    containerStatuses: [{ name: "app", ready: phase === "Running", restartCount: 0, image: "nginx:1.27", state: { running: {} } }],
  },
});

const PODS = [pod("web-1"), pod("web-2"), pod("web-3", "Pending")];

// xterm.js asks for the device pixel ratio through matchMedia and measures glyphs on a canvas; jsdom has neither.
beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { value: () => null, configurable: true });
});

let backend: MockBackend;
let watches: { id: string; spec: WatchSpec }[];

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  watches = [];
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("rt__scroll") ? 660 : 0;
  });
  backend = mockBackend(
    {
      clusters_list: () => [
        { id: "c1", context: "kind-test", clusterName: "kind-test", server: "https://127.0.0.1:6443", user: "admin", namespace: null, sourceId: "default" },
      ],
      cluster_connect: () => ({ version: "v1.31.0" }),
      cluster_kinds: () => KINDS,
      resource_get: (args) => {
        const ref = args.ref as { name: string };
        const found = PODS.find((p) => p.metadata?.name === ref.name);
        if (found) return found;
        throw { code: "notFound", message: `${ref.name} not found` };
      },
      watch_start: (args) => {
        const spec = args.spec as WatchSpec;
        const id = `${spec.kind.kind}-${watches.length + 1}`;
        watches.push({ id, spec });
        return id;
      },
      watch_stop: () => undefined,
    },
    { settings: { theme: "light" } },
  );
});

afterEach(() => {
  backend.restore();
  resetClusterKinds();
});

/** Delivers the objects to every open watch of `kind`. */
function snapshot(kind: string, items: KubeObject[]) {
  for (const w of watches.filter((x) => x.spec.kind.kind === kind)) {
    act(() => backend.emit(`watch:${w.id}`, { type: "snapshot", items }));
  }
}

async function expectNoViolations() {
  // axe is async and walks the whole document; React must be idle meanwhile.
  const found = await axeViolations(document);
  expect(found).toEqual([]);
}

async function openPods() {
  render(<App />);
  act(() => useAppStore.getState().setActiveCluster("c1"));
  act(() => useAppStore.getState().setView("c1", "kind:/Pod"));
  await waitFor(() => expect(watches.some((w) => w.spec.kind.kind === "Pod")).toBe(true));
  snapshot("Pod", PODS);
  snapshot("Namespace", [{ metadata: { name: "default", uid: "ns-default" } }]);
  await screen.findByText("web-2");
}

// axe walks the whole rendered screen: under a full parallel run that takes longer than the default 5 s.
describe("accessibility (axe)", { timeout: 30_000 }, () => {
  it("cluster rail, sidebar and a resource table", async () => {
    await openPods();
    await expectNoViolations();
  });

  it("the details panel with its tabs", async () => {
    await openPods();
    fireEvent.click(screen.getByText("web-1"));
    const panel = await screen.findByRole("complementary", { name: "Details" });
    await within(panel).findByRole("heading", { name: "web-1" });
    await expectNoViolations();
  });

  it("finds what it is for: a button without a name, a field without a label", async () => {
    render(
      <main>
        <button />
        <input />
      </main>,
    );
    const found = await axeViolations(document);
    expect(found.some((v) => v.startsWith("button-name:"))).toBe(true);
    expect(found.some((v) => v.startsWith("label:"))).toBe(true);
  });

  it("a confirmation dialog", async () => {
    render(
      <ConfirmDialog open title="Delete Pod web-1?" danger onConfirm={() => undefined} onCancel={() => undefined}>
        <p>web-1</p>
      </ConfirmDialog>,
    );
    await expectNoViolations();
  });

  it("a form dialog", async () => {
    render(
      <Dialog open title="Scale" onClose={() => undefined}>
        <label>
          Replicas
          <input type="number" defaultValue={3} />
        </label>
      </Dialog>,
    );
    await expectNoViolations();
  });

  it.each(SETTINGS_TABS)("Settings, tab %s", async (tab) => {
    await openPods();
    act(() => useAppStore.getState().setView("c1", SETTINGS_PAGE_ID));
    act(() => openSettings({ tab }));
    await screen.findByRole("tablist", { name: /settings/i });
    await expectNoViolations();
  });

  it("the command palette", async () => {
    await openPods();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await screen.findByRole("dialog");
    await expectNoViolations();
  });

  it("the dock with a logs tab and a terminal tab", async () => {
    await openPods();
    act(() => void openLogsTab("c1", PODS[0]!));
    act(() => void openExecTab("c1", { kind: { group: "", version: "v1", kind: "Pod" }, namespace: "default", name: "web-1" }, "app"));
    await waitFor(() => expect(screen.getAllByRole("tab").length).toBeGreaterThan(1));
    await expectNoViolations();
  });

  it("the Problems page", async () => {
    await openPods();
    act(() => useAppStore.getState().setView("c1", PROBLEMS_PAGE_ID));
    await screen.findByRole("heading", { name: "Cluster problems" });
    await expectNoViolations();
  });
});
