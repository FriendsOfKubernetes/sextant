import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBackend, type ExtensionInfo, type ExtensionManifest, type KubeObject, type MockBackend } from "../api";
import { resetAppStore, useAppStore } from "../app/store";
import { getActionsFor, resetActions, runAction } from "../features/actions/registry";
import { useClusterMenuItems } from "../features/clusters/menuItems";
import { getClusterSettingsTabs } from "../features/clusters/settingsRegistry";
import { ActionBar } from "../features/details/ActionBar";
import { ActionDialogHost } from "../layout/main/ActionDialogHost";
import { AppShell } from "../layout/AppShell";
import { getDetailsSections } from "../layout/details/registry";
import { getDockActions } from "../layout/dock/registry";
import { getPage, registerPage, unregisterPage } from "../layout/pages";
import { getSectionBadge } from "../layout/sectionBadges";
import { i18n } from "../i18n";
import { getResourceDef } from "../resources/registry";
import { loadClusterKinds, resetClusterKinds } from "../resources/useKinds";
import { registerExtension, syncExtensions, unregisterExtension } from "./contributions";
import { ExtensionSettingsFrame } from "./ExtensionFrame";
import { resetExtensionsStore } from "./store";

const WIDGET = { group: "demo.sextant.dev", version: "v1", kind: "Widget" };
const widget: KubeObject = {
  apiVersion: "demo.sextant.dev/v1",
  kind: "Widget",
  metadata: { name: "w1", namespace: "team-a", uid: "u-w1", resourceVersion: "41" },
  spec: { size: "large" },
};
const widgetRef = { kind: WIDGET, namespace: "team-a", name: "w1" };
/** The id of the document in the frame (`doc`), as the SDK makes it up. */
const DOC = "0123456789abcdef0123456789abcdef";
// Titles are shown as written: nothing in them is interpolated or translated.
const ACTION_TITLE = "Scale: {{replicas}} $t(common:app.name)";

const manifest: ExtensionManifest = {
  id: "demo.widgets",
  name: "Widgets",
  version: "1.0.0",
  description: "Widgets of the test cluster",
  author: "Sextant",
  sextantApi: 1,
  entry: "index.html",
  permissions: { clusters: { type: "all" }, rules: [] },
  contributes: {
    pages: [{ id: "board", title: "Widget board", section: "widgets", sectionTitle: "Widget tools", icon: "nope" }],
    detailsSections: [
      // Kinds in manifests are compared ignoring case.
      { id: "info", title: "Widget info", kinds: [{ group: "demo.sextant.dev", kind: "widget" }], placement: "section" },
      { id: "graph", title: "Widget graph", kinds: [{ group: "demo.sextant.dev", kind: "Widget" }], placement: "tab" },
    ],
    actions: [
      {
        id: "scale",
        title: ACTION_TITLE,
        icon: "scale",
        kinds: [{ group: "demo.sextant.dev", kind: "Widget" }],
        danger: false,
        multiple: false,
        headless: false,
      },
    ],
    columns: [{ kind: { group: "demo.sextant.dev", kind: "Widget" }, id: "size", title: "Size", jsonPath: ".spec.size", after: "name" }],
    dockActions: [{ id: "console", title: "Widget console" }],
    problems: [],
    metricQueries: [],
    sectionBadges: [],
    problemCategories: [],
    commands: [],
    kinds: [],
    menuItems: [],
    services: [],
    agentTools: [],
    sections: [],
    settings: { title: "Widget settings" },
  },
};

const info = (over: Partial<ExtensionInfo> = {}): ExtensionInfo => ({
  id: "demo.widgets",
  name: "Widgets",
  version: "1.0.0",
  source: { type: "folder", path: "/src/widgets" },
  dev: true,
  enabled: true,
  state: "active",
  needsConsent: false,
  error: null,
  manifest,
  granted: manifest.permissions,
  installedAt: 0,
  baseUrl: "sextant-ext://demo.widgets/",
  entryUrl: "sextant-ext://demo.widgets/index.html",
  ...over,
});

let backend: MockBackend;
let list: ExtensionInfo[];

function setup() {
  list = [info()];
  backend = mockBackend({
    extensions_list: () => list,
    resource_get: () => widget,
    cluster_kinds: () => [],
  });
}

const frames = () => [...document.querySelectorAll("iframe")];
const frameOf = (container: HTMLElement) => container.querySelector("iframe")!;

/** Renders the window with cluster c1 open and waits for the extension's contributions. */
async function renderShell() {
  const view = render(<AppShell />);
  act(() => useAppStore.getState().setActiveCluster("c1"));
  await waitFor(() => expect(getPage("ext:demo.widgets:board")).toBeDefined());
  return view;
}

async function changeList(next: ExtensionInfo[]) {
  list = next;
  await waitFor(() => expect(backend.listenerCount("extensions-changed")).toBeGreaterThan(0));
  act(() => backend.emit("extensions-changed", null));
}

beforeEach(() => {
  resetAppStore();
  resetExtensionsStore();
  setup();
  registerPage({ id: "t-overview", section: "cluster", order: 0, label: "Overview page", Component: () => <p>cluster overview</p> });
});

afterEach(() => {
  syncExtensions([]);
  unregisterPage("t-overview");
  resetActions();
  backend.restore();
});

describe("extension frames", () => {
  it("are sandboxed without same-origin and open the entry with the view and the contribution id", async () => {
    await renderShell();
    const sidebar = screen.getByRole("navigation", { name: "Sections" });
    fireEvent.click(within(sidebar).getByRole("button", { name: "Widget tools" }));
    fireEvent.click(within(sidebar).getByRole("button", { name: "Widget board" }));
    const frame = frameOf(screen.getByRole("main"));
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-popups-to-escape-sandbox");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("src")).toBe("sextant-ext://demo.widgets/index.html?view=page&id=board");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame).toHaveAccessibleName("Widget board (Widgets)");
  });

  it("show «Extension failed» with Reload when the frame reports an error, and come back on Reload", async () => {
    await renderShell();
    act(() => useAppStore.getState().setView("c1", "ext:demo.widgets:board"));
    const main = screen.getByRole("main");
    const frame = frameOf(main);
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data: { sextant: 1, doc: DOC, type: "error", message: "boom" }, source: frame.contentWindow }),
      );
    });
    const alert = within(main).getByRole("alert");
    expect(alert).toHaveTextContent("Extension failed: boom");
    expect(within(main).queryByTitle(/Widget board/)).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "Reload" }));
    expect(within(main).queryByRole("alert")).toBeNull();
    expect(frameOf(main)).not.toBe(frame);
  });

  it("send the theme and language at start and again when the theme changes", async () => {
    document.documentElement.dataset.theme = "light";
    await renderShell();
    act(() => useAppStore.getState().setView("c1", "ext:demo.widgets:board"));
    const frame = frameOf(screen.getByRole("main"));
    const posted: unknown[] = [];
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((m: unknown) => void posted.push(m));
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: { sextant: 1, doc: DOC, type: "ready" }, source: frame.contentWindow }));
    });
    expect(posted.at(-1)).toMatchObject({
      sextant: 1,
      doc: DOC,
      type: "context",
      context: {
        extensionId: "demo.widgets",
        view: "page",
        contribution: "board",
        clusterId: "c1",
        theme: "light",
        language: "en",
        selection: [],
      },
    });
    act(() => {
      document.documentElement.dataset.theme = "dark";
    });
    await waitFor(() => expect(posted.at(-1)).toMatchObject({ type: "context", context: { theme: "dark" } }));
  });

  it("send the cluster view's selected namespaces, and again when they change", async () => {
    await renderShell();
    act(() => useAppStore.getState().setView("c1", "ext:demo.widgets:board"));
    const frame = frameOf(screen.getByRole("main"));
    const posted: unknown[] = [];
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((m: unknown) => void posted.push(m));
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: { sextant: 1, doc: DOC, type: "ready" }, source: frame.contentWindow }));
    });
    expect(posted.at(-1)).toMatchObject({ type: "context", context: { clusterId: "c1", namespaces: null } });
    act(() => useAppStore.getState().setNamespaces("c1", ["team-a", "team-b"]));
    expect(posted.at(-1)).toMatchObject({ doc: DOC, type: "context", context: { namespaces: ["team-a", "team-b"] } });
    // Another cluster's filter is not this frame's.
    const before = posted.length;
    act(() => useAppStore.getState().setNamespaces("c2", ["other"]));
    expect(posted).toHaveLength(before);
    act(() => useAppStore.getState().setNamespaces("c1", null));
    expect(posted.at(-1)).toMatchObject({ type: "context", context: { namespaces: null } });
  });

  it("show the namespace filter the page follows above its frame", async () => {
    await renderShell();
    act(() => useAppStore.getState().setNamespaces("c1", ["default"]));
    act(() => useAppStore.getState().setView("c1", "ext:demo.widgets:board"));
    const main = screen.getByRole("main");
    // A choice made in a table narrows the page too, and the page is where it can be changed.
    expect(within(main).getByRole("button", { name: "Namespaces: default" })).toBeInTheDocument();
    expect(frameOf(main)).toBeInTheDocument();
  });

  it("keep the live document's context and watches when the extension is renamed", async () => {
    backend.on("extension_call", () => null);
    backend.on("extension_watch_stop", () => undefined);
    await renderShell();
    const { container } = render(<ExtensionSettingsFrame extensionId="demo.widgets" />);
    const frame = frameOf(container);
    const posted: unknown[] = [];
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((m: unknown) => void posted.push(m));
    const fromFrame = (data: Record<string, unknown>) =>
      act(() => {
        window.dispatchEvent(new MessageEvent("message", { data: { sextant: 1, doc: DOC, ...data }, source: frame.contentWindow }));
      });
    fromFrame({ type: "ready" });
    fromFrame({ id: 1, method: "resources.watch", params: { clusterId: "c1", kind: { kind: "Pod" } } });
    await waitFor(() => expect(backend.calls.some((c) => c.cmd === "extension_call")).toBe(true));

    await changeList([info({ name: "Gadgets" })]);
    await waitFor(() => expect(frame).toHaveAccessibleName("Widget settings (Gadgets)"));
    expect(frameOf(container)).toBe(frame);
    act(() => useAppStore.getState().setNamespaces("c1", ["team-a"]));
    expect(posted.at(-1)).toMatchObject({ doc: DOC, type: "context", context: { namespaces: ["team-a"] } });
    await new Promise((r) => setTimeout(r, 20));
    expect(backend.calls.filter((c) => c.cmd === "extension_watch_stop")).toEqual([]);
    // Its notices carry the new name.
    fromFrame({ id: 2, method: "ui.notify", params: { text: "saved" } });
    expect(posted.at(-1)).toEqual({ sextant: 1, doc: DOC, id: 2, result: null });
    expect(screen.getByText("Gadgets: saved")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  });

  it("close the watches of the previous document when the frame loads a new one", async () => {
    backend.on("extension_call", () => null);
    backend.on("extension_watch_stop", () => undefined);
    await renderShell();
    act(() => useAppStore.getState().setView("c1", "ext:demo.widgets:board"));
    const frame = frameOf(screen.getByRole("main"));
    fireEvent.load(frame);
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { sextant: 1, doc: DOC, id: 1, method: "resources.watch", params: { clusterId: "c1", kind: { kind: "Pod" } } },
          source: frame.contentWindow,
        }),
      );
    });
    await waitFor(() => expect(backend.calls.some((c) => c.cmd === "extension_call")).toBe(true));
    const streamId = backend.calls.find((c) => c.cmd === "extension_call")!.args.streamId as string;
    // `location.reload()` in the frame.
    fireEvent.load(frame);
    await waitFor(() =>
      expect(backend.calls.filter((c) => c.cmd === "extension_watch_stop").map((c) => c.args.streamId)).toEqual([streamId]),
    );
  });

  it("reload when the extension's files change (development mode)", async () => {
    await renderShell();
    act(() => useAppStore.getState().setView("c1", "ext:demo.widgets:board"));
    const before = frameOf(screen.getByRole("main"));
    act(() => backend.emit("extension-files-changed", { id: "demo.widgets" }));
    await waitFor(() => expect(frameOf(screen.getByRole("main"))).not.toBe(before));
  });
});

describe("ui methods of a frame", () => {
  it("open details, navigate to the extension's page and show a notice", async () => {
    await renderShell();
    act(() => useAppStore.getState().setView("c1", "ext:demo.widgets:board"));
    const frame = frameOf(screen.getByRole("main"));
    const posted: unknown[] = [];
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((m: unknown) => void posted.push(m));
    const call = (id: number, method: string, params?: unknown) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", { data: { sextant: 1, doc: DOC, id, method, params }, source: frame.contentWindow }),
        );
      });

    call(1, "ui.navigate", { page: "missing" });
    expect(posted.at(-1)).toMatchObject({ id: 1, error: { code: "notFound" } });
    // A kind Sextant does not know needs its version.
    call(2, "ui.openDetails", { kind: { group: "x.io", kind: "Thing" }, namespace: "team-a", name: "t1" });
    expect(posted.at(-1)).toMatchObject({ id: 2, error: { code: "invalid" } });
    call(3, "ui.openDetails", { kind: { group: "", kind: "Pod" }, namespace: "team-a", name: "web-1" });
    expect(useAppStore.getState().details).toEqual({
      kind: { group: "", version: "v1", kind: "Pod" },
      namespace: "team-a",
      name: "web-1",
    });
    call(4, "ui.notify", { text: "Scaled w1 to 3" });
    expect(screen.getByText("Widgets: Scaled w1 to 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Widgets: Scaled w1 to 3")).toBeNull();
    expect(posted.slice(-2)).toEqual([
      { sextant: 1, doc: DOC, id: 3, result: null },
      { sextant: 1, doc: DOC, id: 4, result: null },
    ]);
    // Another extension's page is not the frame's to open.
    registerPage({ id: "ext:other.ext:board", section: "other", order: 0, label: "Other", Component: () => null });
    try {
      call(7, "ui.navigate", { page: "ext:other.ext:board" });
      expect(posted.at(-1)).toMatchObject({ id: 7, error: { code: "notFound" } });
      expect(useAppStore.getState().clusterViews.c1?.view).toBe("ext:demo.widgets:board");
    } finally {
      unregisterPage("ext:other.ext:board");
    }
    call(5, "ui.navigate", { page: "board" });
    expect(useAppStore.getState().clusterViews.c1?.view).toBe("ext:demo.widgets:board");
    call(6, "ui.navigate", { page: "t-overview" });
    expect(useAppStore.getState().clusterViews.c1?.view).toBe("t-overview");
  });
});

describe("contributions of an extension", () => {
  it("add a page in a section of its own and leave with the extension; the open page falls back to the overview", async () => {
    await renderShell();
    const sidebar = screen.getByRole("navigation", { name: "Sections" });
    expect(within(sidebar).getByRole("button", { name: "Widget tools" })).toBeInTheDocument();
    act(() => useAppStore.getState().setView("c1", "ext:demo.widgets:board"));
    expect(frames()).toHaveLength(1);

    await changeList([info({ enabled: false, state: "disabled" })]);
    await waitFor(() => expect(within(sidebar).queryByRole("button", { name: "Widget tools" })).toBeNull());
    expect(screen.getByRole("main")).toHaveTextContent("cluster overview");
    expect(useAppStore.getState().clusterViews.c1?.view).toBeNull();
    expect(frames()).toHaveLength(0);
  });

  it("show their texts in the UI language when the manifest translates them, English otherwise", async () => {
    const translations = {
      ru: { "pages.board.sectionTitle": "Инструменты виджетов", "detailsSections.info.title": "Сведения о виджете" },
    };
    list = [info({ manifest: { ...manifest, sextantApi: 2, translations } })];
    await renderShell();
    const sidebar = screen.getByRole("navigation", { name: "Sections" });
    expect(within(sidebar).getByRole("button", { name: "Widget tools" })).toBeInTheDocument();
    await act(() => i18n.changeLanguage("ru"));
    try {
      await waitFor(() => expect(within(sidebar).getByRole("button", { name: "Инструменты виджетов" })).toBeInTheDocument());
      const sections = getDetailsSections({ group: "demo.sextant.dev", version: "v1", kind: "Widget" }).map((s) => s.label);
      expect(sections).toContain("Сведения о виджете");
      // Not translated: shown in English.
      expect(sections).toContain("Widget graph");
    } finally {
      await act(() => i18n.changeLanguage("en"));
    }
    await waitFor(() => expect(within(sidebar).getByRole("button", { name: "Widget tools" })).toBeInTheDocument());
  });

  it("never take the place of Sextant's overview as the start page or the fallback", async () => {
    const first = { id: "first", title: "Ext first", section: "cluster", order: -5 };
    const withClusterPage = info({ manifest: { ...manifest, contributes: { ...manifest.contributes, pages: [first] } } });
    list = [withClusterPage];
    render(<AppShell />);
    act(() => useAppStore.getState().setActiveCluster("c1"));
    await waitFor(() => expect(getPage("ext:demo.widgets:first")).toBeDefined());
    expect(screen.getByRole("main")).toHaveTextContent("cluster overview");
    expect(frames()).toHaveLength(0);

    act(() => useAppStore.getState().setView("c1", "ext:demo.widgets:first"));
    expect(frames()).toHaveLength(1);
    await changeList([]);
    await waitFor(() => expect(frames()).toHaveLength(0));
    expect(screen.getByRole("main")).toHaveTextContent("cluster overview");
  });

  it("add a details section and a details tab next to Overview for their kinds", async () => {
    await renderShell();
    act(() => useAppStore.getState().openDetails(widgetRef));
    const panel = screen.getByRole("complementary", { name: "Details" });
    const tabs = within(panel).getByRole("tablist");
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Overview", "Widget graph"]);
    expect(within(panel).getByRole("heading", { name: "Widget info" })).toBeInTheDocument();
    expect(frameOf(panel).getAttribute("src")).toBe("sextant-ext://demo.widgets/index.html?view=details&id=info");

    fireEvent.click(within(tabs).getByRole("tab", { name: "Widget graph" }));
    expect(frames().map((f) => f.getAttribute("src"))).toEqual([
      "sextant-ext://demo.widgets/index.html?view=details&id=graph",
    ]);
    // Not for other kinds.
    expect(getDetailsSections({ group: "", version: "v1", kind: "Pod" }).map((s) => s.id)).not.toContain(
      "ext:demo.widgets:info",
    );
  });

  it("leave out a details section whose condition does not hold for the object (#408)", () => {
    const gated: ExtensionManifest = {
      ...manifest,
      sextantApi: 4,
      contributes: {
        ...manifest.contributes,
        detailsSections: [
          {
            id: "gpu",
            title: "GPU",
            kinds: [{ group: "", kind: "Node" }],
            placement: "section",
            when: { type: "equals", path: '.metadata.labels["nvidia.com/gpu.present"]', value: "true" },
          },
        ],
      },
    };
    registerExtension(info({ manifest: gated }));
    try {
      const section = getDetailsSections({ group: "", version: "v1", kind: "Node" }).find((s) => s.id === "ext:demo.widgets:gpu")!;
      expect(section.appliesToObject!({ metadata: { name: "gpu-1", labels: { "nvidia.com/gpu.present": "true" } } })).toBe(true);
      expect(section.appliesToObject!({ metadata: { name: "cpu-1" } })).toBe(false);
    } finally {
      unregisterExtension("demo.widgets");
    }
  });

  it("put a details section of every kind on every kind (#411)", () => {
    const every: ExtensionManifest = {
      ...manifest,
      sextantApi: 4,
      contributes: {
        ...manifest.contributes,
        detailsSections: [{ id: "results", title: "Policy results", kinds: [{ group: "*", kind: "*" }], placement: "section" }],
      },
    };
    registerExtension(info({ manifest: every }));
    try {
      for (const kind of [
        { group: "", version: "v1", kind: "Pod" },
        { group: "apps", version: "v1", kind: "Deployment" },
        { group: "example.dev", version: "v1", kind: "Widget" },
      ]) {
        expect(getDetailsSections(kind).map((s) => s.id), kind.kind).toContain("ext:demo.widgets:results");
      }
    } finally {
      unregisterExtension("demo.widgets");
    }
  });

  it("draw a details section without a heading, and one hidden until its frame shows it (#406)", () => {
    const quiet: ExtensionManifest = {
      ...manifest,
      sextantApi: 4,
      contributes: {
        ...manifest.contributes,
        detailsSections: [
          { id: "fields", title: "Widget fields", kinds: [{ group: "demo.sextant.dev", kind: "Widget" }], placement: "section", heading: false },
          { id: "late", title: "Widget late", kinds: [{ group: "demo.sextant.dev", kind: "Widget" }], placement: "section", startHidden: true },
        ],
      },
    };
    registerExtension(info({ manifest: quiet }));
    try {
      const sections = getDetailsSections({ group: "demo.sextant.dev", version: "v1", kind: "Widget" });
      const ref = { kind: { group: "demo.sextant.dev", version: "v1", kind: "Widget" }, namespace: "team-a", name: "w" };
      const Fields = sections.find((s) => s.id === "ext:demo.widgets:fields")!.Component;
      const Late = sections.find((s) => s.id === "ext:demo.widgets:late")!.Component;
      const { container } = render(
        <>
          <Fields clusterId="kind" objectRef={ref} obj={null} />
          <Late clusterId="kind" objectRef={ref} obj={null} />
        </>,
      );
      expect(screen.queryByRole("heading", { name: "Widget fields" })).toBeNull();
      expect(screen.getByRole("group", { name: "Widget fields" })).toBeInTheDocument();
      const [, late] = container.querySelectorAll(".ext-section");
      expect((late as HTMLElement).hidden).toBe(true);
    } finally {
      unregisterExtension("demo.widgets");
    }
  });

  it("offer an action only where the cluster serves the kinds it requires (#414)", async () => {
    resetClusterKinds();
    const NAMESPACE = { group: "", version: "v1", kind: "Namespace" };
    const gated: ExtensionManifest = {
      ...manifest,
      sextantApi: 4,
      contributes: {
        ...manifest.contributes,
        actions: [
          {
            id: "backup",
            title: "Back up namespace…",
            kinds: [{ group: "", kind: "Namespace" }],
            danger: false,
            multiple: false,
            headless: false,
            requiresKinds: [{ group: "velero.io", kind: "Backup" }],
          },
        ],
      },
    };
    registerExtension(info({ manifest: gated }));
    try {
      const ns = { metadata: { name: "shop" } };
      const offered = () => getActionsFor([ns], NAMESPACE, ["ext:demo.widgets:backup"]).map((a) => a.id);
      useAppStore.setState({ activeClusterId: "kind" });
      expect(offered()).toEqual([]);
      backend.on("cluster_kinds", () => [
        { kindRef: { group: "velero.io", version: "v1", kind: "Backup" }, plural: "backups", namespaced: true, verbs: ["list"], printerColumns: [], shortNames: [] },
      ]);
      loadClusterKinds("kind");
      await waitFor(() => expect(offered()).toEqual(["ext:demo.widgets:backup"]));
    } finally {
      unregisterExtension("demo.widgets");
    }
  });

  it("tell a details frame the shown object's uid (#415)", async () => {
    await renderShell();
    act(() => useAppStore.getState().openDetails(widgetRef));
    const panel = screen.getByRole("complementary", { name: "Details" });
    await waitFor(() => expect(frameOf(panel)).not.toBeNull());
    const frame = frameOf(panel);
    const posted: unknown[] = [];
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((m: unknown) => void posted.push(m));
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: { sextant: 1, doc: DOC, type: "ready" }, source: frame.contentWindow }));
    });
    await waitFor(() => expect(posted.at(-1)).toMatchObject({ type: "context", context: { view: "details", uid: "u-w1" } }));
  });

  it("keep a details frame's blocks in Sextant's memory, with Expand all and Collapse all (#416)", async () => {
    await renderShell();
    act(() => useAppStore.getState().openDetails(widgetRef));
    const panel = screen.getByRole("complementary", { name: "Details" });
    await waitFor(() => expect(frameOf(panel)).not.toBeNull());
    const frame = frameOf(panel);
    const posted: unknown[] = [];
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((m: unknown) => void posted.push(m));
    const send = (data: Record<string, unknown>) =>
      act(() => {
        window.dispatchEvent(new MessageEvent("message", { data: { sextant: 1, doc: DOC, ...data }, source: frame.contentWindow }));
      });
    send({ type: "ready" });
    await waitFor(() => expect(posted.at(-1)).toMatchObject({ type: "context", context: { blocks: {} } }));
    send({ type: "request", id: 7, method: "ui.setBlockOpen", params: { id: "pods", open: false } });
    await waitFor(() => expect(posted.at(-1)).toMatchObject({ type: "context", context: { blocks: { pods: false } } }));
    fireEvent.click(within(panel).getByRole("button", { name: "Expand all" }));
    await waitFor(() => expect(posted.at(-1)).toMatchObject({ type: "context", context: { blocks: { "*": true } } }));
  });

  it("give a details section the height the frame asks for", async () => {
    await renderShell();
    act(() => useAppStore.getState().openDetails(widgetRef));
    const frame = frameOf(screen.getByRole("complementary", { name: "Details" }));
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data: { sextant: 1, doc: DOC, type: "resize", height: 321 }, source: frame.contentWindow }),
      );
    });
    expect(frame).toHaveStyle({ height: "321px" });
  });

  it("add an action for its kinds that opens the extension in a window with the selected objects", async () => {
    await renderShell();
    const def = getResourceDef(WIDGET);
    expect(def.actions).toContain("ext:demo.widgets:scale");
    expect(getResourceDef({ group: "", version: "v1", kind: "Pod" }).actions).not.toContain("ext:demo.widgets:scale");
    const [action] = getActionsFor([widget], WIDGET, ["ext:demo.widgets:scale"]);
    expect(action).toMatchObject({ label: ACTION_TITLE, icon: "scale", placement: "more" });
    expect(action!.labelKey).toBeUndefined();
    // An extension's action is always in the details panel's "Actions" menu, never a main button (#275).
    const bar = render(<ActionBar clusterId="c1" kind={WIDGET} obj={widget} />);
    expect(within(bar.container).queryByRole("button", { name: ACTION_TITLE })).toBeNull();
    fireEvent.click(within(bar.container).getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menuitem", { name: ACTION_TITLE })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    bar.unmount();

    // The main view of the window draws the windows actions open.
    await act(() => runAction(action!, "c1", WIDGET, [widget]));
    const dialog = screen.getByRole("dialog", { name: ACTION_TITLE });
    const frame = frameOf(dialog);
    expect(frame.getAttribute("src")).toBe("sextant-ext://demo.widgets/index.html?view=action&id=scale");
    const posted: unknown[] = [];
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((m: unknown) => void posted.push(m));
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: { sextant: 1, doc: DOC, type: "ready" }, source: frame.contentWindow }));
    });
    expect(posted.at(-1)).toMatchObject({ context: { view: "action", selection: [widgetRef] } });

    // `ui.close` closes the window.
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data: { sextant: 1, doc: DOC, id: 1, method: "ui.close" }, source: frame.contentWindow }),
      );
    });
    expect(screen.queryByRole("dialog", { name: ACTION_TITLE })).toBeNull();
  });

  it("show a failed action's title as written in the failure dialog", async () => {
    const action = { label: ACTION_TITLE, icon: "scale" as const, appliesTo: () => true, run: () => Promise.reject(new Error("nope")) };
    render(<ActionDialogHost />);
    await act(() => runAction(action, "c1", WIDGET, [widget]));
    expect(screen.getByRole("dialog", { name: `${ACTION_TITLE} failed` })).toBeInTheDocument();
  });

  it("add a JSONPath column after the column it names", async () => {
    await renderShell();
    const columns = getResourceDef(WIDGET).columns;
    const at = columns.findIndex((c) => c.id === "ext:demo.widgets:size");
    expect(columns[at - 1]?.id).toBe("name");
    expect(columns[at]).toMatchObject({ title: "Size" });
    expect(columns[at]!.value(widget)).toBe("large");
  });

  it("add computed columns: the first path with a value, tones, cases, ages, durations and ratios (ADR-0153)", () => {
    const kind = { group: "demo.sextant.dev", kind: "Widget" };
    registerExtension(
      info({
        manifest: {
          ...manifest,
          sextantApi: 4,
          contributes: {
            ...manifest.contributes,
            columns: [
              { kind, id: "rev", title: "Revision", paths: [".status.lastApplied", ".status.artifact.revision"] },
              {
                kind,
                id: "ready",
                title: "Ready",
                paths: [".status.ready"],
                tones: { True: "ok", False: "error" },
                tooltipPaths: [".status.message"],
                cases: [
                  {
                    when: { type: "equals", path: ".spec.suspend", value: true },
                    text: "Suspended",
                    tooltip: "Suspended by {{.spec.suspendedBy}}",
                  },
                ],
              },
              { kind, id: "took", title: "Took", paths: [".status.startedAt"], format: "duration", endPaths: [".status.finishedAt"] },
              { kind, id: "step", title: "Step", paths: [".status.step"], format: "ratio", totalPaths: [".spec.steps"] },
              { kind, id: "zones", title: "Zones", paths: [".spec.zones"], format: "list" },
              {
                kind,
                id: "weight",
                title: "Weight",
                format: "number",
                valueText: "{{value}}%",
                lookup: { list: ".spec.plan", index: ".status.at", field: ".weight", nearestBefore: true, orElse: 0 },
                cases: [{ when: { type: "atLeast", path: ".status.at", otherPath: ".spec.plan" }, text: "100%", value: 100 }],
              },
              {
                kind,
                id: "source",
                title: "Source",
                paths: [".spec.sourceRef.name"],
                cases: [
                  { when: { type: "exists", path: ".spec.sourceRef.namespace" }, text: "{{.spec.sourceRef.kind}}/{{.spec.sourceRef.namespace}}/{{.spec.sourceRef.name}}" },
                  { when: { type: "exists", path: ".spec.sourceRef.name" }, text: "{{.spec.sourceRef.kind}}/{{.spec.sourceRef.name}}" },
                ],
              },
            ],
          },
        },
      }),
    );
    const columns = getResourceDef(WIDGET).columns;
    const col = (id: string) => columns.find((c) => c.id === `ext:demo.widgets:${id}`)!;
    const obj = (spec: object, status: object): KubeObject => ({ ...widget, spec, status });
    const ctx = { clusterId: "c1", kind: WIDGET, now: Date.parse("2026-11-06T12:00:00Z") };
    const one = obj({ steps: 4 }, { artifact: { revision: "main@sha1:abc" }, ready: "False", message: "fetch failed", step: 2 });
    expect(col("rev").value(one)).toBe("main@sha1:abc");
    expect(col("rev").value(obj({}, { lastApplied: "v2", artifact: { revision: "v1" } }))).toBe("v2");
    const cell = render(<>{col("ready").render!(one, ctx)}</>);
    expect(cell.container.querySelector(".rt-status--danger")?.textContent).toBe("False");
    expect(cell.container.querySelector("[title]")?.getAttribute("title")).toBe("fetch failed");
    cell.unmount();
    const suspended = render(<>{col("ready").render!(obj({ suspend: true }, { ready: "True" }), ctx)}</>);
    expect(suspended.container.textContent).toBe("Suspended");
    // Without the tooltip's value, the column's own tooltip (#380); with it, the case's.
    expect(suspended.container.querySelector("[title]")).toBeNull();
    suspended.unmount();
    const by = render(<>{col("ready").render!(obj({ suspend: true, suspendedBy: "ops" }, { ready: "True", message: "m" }), ctx)}</>);
    expect(by.container.querySelector("[title]")?.getAttribute("title")).toBe("Suspended by ops");
    by.unmount();
    expect(col("step").value(one)).toBe(0.5);
    expect(col("step").searchText!(one, { now: ctx.now, t: i18n.t })).toBe("2/4");
    const run = obj({}, { startedAt: "2026-11-06T11:00:00Z", finishedAt: "2026-11-06T11:30:00Z" });
    expect(col("took").value(run)).toBe(30 * 60_000);
    expect(col("took").filter?.type).toBe("number");
    // A case's text with field values (#368); one whose placeholder has none does not hold.
    // A value picked by an index field, the nearest earlier item's when it has none, written by `valueText` (#387).
    const plan = [{ weight: 10 }, { pause: {} }, { weight: 40 }, { pause: {} }];
    const weight = (status: object) => col("weight").searchText!(obj({ plan }, status), { now: ctx.now, t: i18n.t });
    expect(weight({})).toBe("10%");
    expect(weight({ at: 1 })).toBe("10%");
    expect(weight({ at: 3 })).toBe("40%");
    expect(col("weight").value(obj({ plan }, { at: 3 }))).toBe(40);
    expect(weight({ at: 4 })).toBe("100%");
    // A case's own number sorts and filters (#390).
    expect(col("weight").value(obj({ plan }, { at: 4 }))).toBe(100);
    expect(col("weight").searchText!(obj({ plan: [{ pause: {} }] }, { at: 0 }), { now: ctx.now, t: i18n.t })).toBe("0%");
    expect(col("weight").searchText!(obj({}, { at: 0 }), { now: ctx.now, t: i18n.t })).toBeUndefined();
    // A list of scalars joined in the UI language (#395).
    expect(col("zones").searchText!(obj({ zones: ["a", "b", { x: 1 }] }, {}), { now: ctx.now, t: i18n.t })).toBe("a, b");
    expect(col("zones").searchText!(obj({ zones: "a" }, {}), { now: ctx.now, t: i18n.t })).toBeUndefined();
    // A count Kubernetes leaves out is 0 when the whole is there.
    expect(col("step").searchText!(obj({ steps: [1, 2, 3, 4] }, {}), { now: ctx.now, t: i18n.t })).toBe("0/4");
    expect(col("step").searchText!(obj({}, {}), { now: ctx.now, t: i18n.t })).toBeUndefined();
    expect(col("source").value(obj({ sourceRef: { kind: "GitRepository", name: "podinfo" } }, {}))).toBe("GitRepository/podinfo");
    expect(col("source").value(obj({ sourceRef: { kind: "GitRepository", name: "p", namespace: "infra" } }, {}))).toBe("GitRepository/infra/p");
    expect(col("source").value(obj({ sourceRef: { name: "p" } }, {}))).toBe("p");
  });

  it("offer an action only where its condition holds, saying why not, as a button only on kinds of its own (ADR-0154)", () => {
    const own = { group: "demo.sextant.dev", kind: "Widget" };
    const gadget = { group: "demo.sextant.dev", version: "v1", kind: "Gadget" };
    registerExtension(
      info({
        manifest: {
          ...manifest,
          sextantApi: 4,
          contributes: {
            ...manifest.contributes,
            kinds: [{ ...own, section: "widgets", sectionTitle: "Widget tools", searchByDefault: false, printerColumns: true }],
            actions: [
              {
                id: "resume",
                title: "Resume",
                kinds: [own, { group: "demo.sextant.dev", kind: "Gadget" }],
                danger: false,
                multiple: true,
                headless: false,
                when: { type: "equals", path: ".spec.suspend", value: true },
                whyNot: "It is not suspended.",
                placement: "primary",
              },
            ],
          },
        },
      }),
    );
    const suspended: KubeObject = { ...widget, spec: { suspend: true } };
    expect(getActionsFor([suspended], WIDGET, ["ext:demo.widgets:resume"])).toHaveLength(1);
    expect(getActionsFor([widget], WIDGET, ["ext:demo.widgets:resume"])).toHaveLength(0);
    const [action] = getActionsFor([suspended], WIDGET, ["ext:demo.widgets:resume"]);
    expect(action!.notApplicableReason?.(widget, WIDGET)).toBe("It is not suspended.");
    expect(action!.notApplicableReason?.(suspended, WIDGET)).toBeUndefined();
    // A button on the kind it lists in its own section; in the "Actions" menu on another kind.
    const bar = render(<ActionBar clusterId="c1" kind={WIDGET} obj={suspended} />);
    expect(within(bar.container).getByRole("button", { name: "Resume" })).toBeInTheDocument();
    bar.unmount();
    const other = render(<ActionBar clusterId="c1" kind={gadget} obj={{ ...suspended, kind: "Gadget" }} />);
    expect(within(other.container).queryByRole("button", { name: "Resume" })).toBeNull();
    other.unmount();
  });

  it("send an action that is a fixed patch itself, after its question, with {{now}} filled in (#367)", async () => {
    const own = { group: "demo.sextant.dev", kind: "Widget" };
    registerExtension(
      info({
        manifest: {
          ...manifest,
          sextantApi: 4,
          contributes: {
            ...manifest.contributes,
            actions: [
              {
                id: "poke",
                title: "Poke",
                kinds: [own],
                danger: false,
                multiple: true,
                headless: false,
                patch: { metadata: { annotations: { "demo/requestedAt": "{{now}}" } } },
                done: "Poked",
              },
              {
                id: "stop",
                title: "Stop",
                kinds: [own],
                danger: true,
                multiple: false,
                headless: false,
                patch: { spec: { stopped: true } },
                ask: { title: "Stop {{kind}} {{name}}?", text: "It stops until resumed.", confirm: "Stop it" },
              },
            ],
          },
        },
      }),
    );
    backend.on("extension_call", () => ({ items: [{ object: widget }], sent: 1 }));
    render(<ActionDialogHost />);
    const [poke] = getActionsFor([widget], WIDGET, ["ext:demo.widgets:poke"]);
    await act(() => runAction(poke!, "c1", WIDGET, [widget]));
    // No frame and no question: the patch went at once, in the extension's name.
    expect(document.querySelector("iframe")).toBeNull();
    await waitFor(() => expect(backend.calls.filter((c) => c.cmd === "extension_call")).toHaveLength(1));
    const sent = backend.calls.find((c) => c.cmd === "extension_call")!.args as {
      extensionId: string;
      method: string;
      params: { clusterId: string; items: { ref: unknown; patch: { metadata: { annotations: Record<string, string> } }; patchType: string }[] };
    };
    expect(sent).toMatchObject({ extensionId: "demo.widgets", method: "resources.patchMany", params: { clusterId: "c1" } });
    expect(sent.params.items[0]!.ref).toEqual(widgetRef);
    expect(sent.params.items[0]!.patchType).toBe("merge");
    const at = sent.params.items[0]!.patch.metadata.annotations["demo/requestedAt"]!;
    expect(Number.isNaN(Date.parse(at))).toBe(false);

    // With a question: nothing goes before "Stop it".
    const [stop] = getActionsFor([widget], WIDGET, ["ext:demo.widgets:stop"]);
    await act(() => runAction(stop!, "c1", WIDGET, [widget]));
    // Sextant fills the object's kind and name into its question (#378).
    const dialog = screen.getByRole("dialog", { name: "Stop Widget w1?" });
    expect(within(dialog).getByText("It stops until resumed.")).toBeInTheDocument();
    expect(within(dialog).getByRole("list", { name: "Objects" })).toHaveTextContent("Widget team-a/w1");
    expect(backend.calls.filter((c) => c.cmd === "extension_call")).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop it" }));
    await waitFor(() => expect(backend.calls.filter((c) => c.cmd === "extension_call")).toHaveLength(2));
    const second = backend.calls.filter((c) => c.cmd === "extension_call")[1]!.args as { params: { items: { patch: unknown }[] } };
    expect(second.params.items[0]!.patch).toEqual({ spec: { stopped: true } });
  });

  it("run an action without a window: its frame out of sight until it closes, its failure told as a notice (#379)", async () => {
    await renderShell();
    registerExtension(
      info({
        manifest: {
          ...manifest,
          sextantApi: 4,
          contributes: {
            ...manifest.contributes,
            actions: [{ id: "sync", title: "Sync now", kinds: [{ group: "demo.sextant.dev", kind: "Widget" }], danger: false, multiple: false, headless: true }],
          },
        },
      }),
    );
    const [sync] = getActionsFor([widget], WIDGET, ["ext:demo.widgets:sync"]);
    await act(() => runAction(sync!, "c1", WIDGET, [widget]));
    // No window: the frame is loaded out of sight, with the action's context.
    expect(screen.queryByRole("dialog", { name: "Sync now" })).toBeNull();
    const frame = document.querySelector<HTMLIFrameElement>(".ext-headless iframe")!;
    expect(frame.getAttribute("src")).toBe("sextant-ext://demo.widgets/index.html?view=action&id=sync");
    const posted: unknown[] = [];
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((m: unknown) => void posted.push(m));
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: { sextant: 1, doc: DOC, type: "ready" }, source: frame.contentWindow }));
    });
    expect(posted.at(-1)).toMatchObject({ context: { view: "action", selection: [widgetRef] } });
    // `ui.close` ends it.
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data: { sextant: 1, doc: DOC, id: 1, method: "ui.close" }, source: frame.contentWindow }),
      );
    });
    expect(document.querySelector(".ext-headless iframe")).toBeNull();

    // `ui.close({failed})` ends it as a failed action: Sextant's own failure dialog (#400).
    await act(() => runAction(sync!, "c1", WIDGET, [widget]));
    const failing = document.querySelector<HTMLIFrameElement>(".ext-headless iframe")!;
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { sextant: 1, doc: DOC, id: 2, method: "ui.close", params: { failed: "the source is gone" } },
          source: failing.contentWindow,
        }),
      );
    });
    expect(document.querySelector(".ext-headless iframe")).toBeNull();
    const failure = await screen.findByRole("dialog", { name: "Sync now failed" });
    expect(within(failure).getByText(/the source is gone/)).toBeInTheDocument();
    fireEvent.click(within(failure).getAllByRole("button").at(-1)!);

    // A frame that reports an error is ended and told as the extension's notice.
    await act(() => runAction(sync!, "c1", WIDGET, [widget]));
    const second = document.querySelector<HTMLIFrameElement>(".ext-headless iframe")!;
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data: { sextant: 1, doc: DOC, type: "error", message: "no source" }, source: second.contentWindow }),
      );
    });
    expect(document.querySelector(".ext-headless iframe")).toBeNull();
    expect(screen.getByText("Widgets: Sync now: no source")).toBeInTheDocument();
  });

  it("list kinds in a section of its own with Sextant's table, titled and filtered by its rules (ADR-0152)", async () => {
    resetClusterKinds();
    backend.on("cluster_kinds", () => [
      { kindRef: WIDGET, plural: "widgets", namespaced: true, verbs: ["list", "watch", "get"], printerColumns: [], shortNames: [] },
      {
        kindRef: { group: "demo.sextant.dev", version: "v1", kind: "Gizmo" },
        plural: "gizmos",
        namespaced: true,
        verbs: ["list", "watch", "get"],
        printerColumns: [],
        shortNames: [],
      },
    ]);
    const rule = {
      id: "broken",
      title: "Broken widget",
      kind: { group: "demo.sextant.dev", kind: "Widget" },
      when: { type: "exists" as const, path: ".status.error" },
      graceMinutes: 0,
      notify: true,
      toldThroughOwner: false,
      message: "broken",
      source: { labelSelector: "tier=web", metadataOnly: false },
    };
    list = [
      info({
        manifest: {
          ...manifest,
          sextantApi: 4,
          contributes: {
            ...manifest.contributes,
            pages: [{ id: "board", title: "Widget board", section: "tools", sectionTitle: "Widget tools" }],
            kinds: [
              { group: "demo.sextant.dev", kind: "Widget", section: "tools", title: "Widgets of the demo", order: 1, searchByDefault: false, printerColumns: true },
              // Not served by the cluster: never listed.
              { group: "demo.sextant.dev", kind: "Missing", section: "tools", order: 2, searchByDefault: false, printerColumns: true },
              // "Only problems" of its own (#396), whatever the rules say.
              {
                group: "demo.sextant.dev",
                kind: "Gizmo",
                section: "tools",
                order: 3,
                searchByDefault: false,
                printerColumns: true,
                problemWhen: { type: "equals", path: ".status.phase", value: "Failed" },
              },
            ],
            problems: [rule],
          },
        },
      }),
    ];
    await renderShell();
    const sidebar = screen.getByRole("navigation", { name: "Sections" });
    fireEvent.click(await within(sidebar).findByRole("button", { name: "Widget tools" }));
    expect(within(sidebar).getByRole("button", { name: "Widgets of the demo" })).toBeInTheDocument();
    expect(within(sidebar).queryByRole("button", { name: "Missing" })).toBeNull();
    const def = getResourceDef(WIDGET);
    expect(def.title).toBe("Widgets of the demo");
    const broken = { ...widget, metadata: { ...widget.metadata, labels: { tier: "web" } }, status: { error: "x" } };
    expect(def.problem?.(broken)).toBe(true);
    // An object its rules' source does not pick is never a problem of them.
    expect(def.problem?.({ ...broken, metadata: widget.metadata })).toBe(false);
    expect(def.problem?.({ ...broken, status: {} })).toBe(false);
    const gizmo = getResourceDef({ group: "demo.sextant.dev", version: "v1", kind: "Gizmo" });
    expect(gizmo.problem?.({ ...widget, kind: "Gizmo", status: { phase: "Failed" } })).toBe(true);
    expect(gizmo.problem?.({ ...widget, kind: "Gizmo", status: { phase: "Running" } })).toBe(false);
  });

  it("add an item to a cluster's context menu that opens its window for that cluster (ADR-0157)", async () => {
    list = [
      info({
        manifest: {
          ...manifest,
          sextantApi: 4,
          contributes: { ...manifest.contributes, menuItems: [{ id: "install", title: "Install widgets…", menu: "cluster" }] },
        },
      }),
    ];
    await renderShell();
    const { result } = renderHook(() => useClusterMenuItems());
    const item = result.current.find((i) => i.id === "ext:demo.widgets:install")!;
    expect(item.label).toBe("Install widgets…");
    act(() => item.run("c2"));
    const dialog = screen.getByRole("dialog", { name: "Install widgets…" });
    const frame = frameOf(dialog);
    expect(frame.getAttribute("src")).toBe("sextant-ext://demo.widgets/index.html?view=action&id=install");
    const posted: unknown[] = [];
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((m: unknown) => void posted.push(m));
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: { sextant: 1, doc: DOC, type: "ready" }, source: frame.contentWindow }));
    });
    expect(posted.at(-1)).toMatchObject({ context: { view: "action", clusterId: "c2", selection: [] } });
    await changeList([]);
    await waitFor(() => expect(result.current.some((i) => i.id === "ext:demo.widgets:install")).toBe(false));
    expect(screen.queryByRole("dialog", { name: "Install widgets…" })).toBeNull();
  });

  it("add a tab to a cluster's settings, a section header with an icon and a place, and palette names (ADR-0160)", async () => {
    list = [
      info({
        manifest: {
          ...manifest,
          sextantApi: 4,
          contributes: {
            ...manifest.contributes,
            clusterSettings: { title: "Widget setup" },
            sections: [{ section: "widgets", title: "Widget tools", icon: "flux", after: "workloads" }],
          },
        },
      }),
    ];
    await renderShell();
    const tab = getClusterSettingsTabs().find((t) => t.label === "Widget setup")!;
    expect(tab).toBeDefined();
    const Section = tab.sections[0]!.Component;
    const { container } = render(<Section clusterId="c2" cluster={{ id: "c2" } as never} />);
    expect(frameOf(container).getAttribute("src")).toBe(
      "sextant-ext://demo.widgets/index.html?view=settings&id=clusterSettings",
    );
    const sidebar = screen.getByRole("navigation", { name: "Sections" });
    const names = within(sidebar)
      .getAllByRole("button")
      .map((b) => b.textContent);
    // Right after Workloads, before Sextant's next section.
    const at = names.indexOf("Widget tools");
    expect(at).toBeGreaterThan(names.indexOf("Workloads"));
    await changeList([]);
    await waitFor(() => expect(getClusterSettingsTabs().some((t) => t.label === "Widget setup")).toBe(false));
  });

  it("a section of Sextant's own extensions keeps the place the built-in section had (ADR-0162)", async () => {
    list = [
      info({
        manifest: {
          ...manifest,
          sextantApi: 4,
          contributes: {
            ...manifest.contributes,
            pages: [...manifest.contributes.pages, { id: "apps", title: "Apps", section: "argocd" }],
            sections: [
              { section: "widgets", title: "Widget tools", after: "velero" },
              { section: "argocd", title: "Argo CD", icon: "argocd", after: "workloads" },
            ],
          },
        },
      }),
    ];
    await renderShell();
    const sidebar = screen.getByRole("navigation", { name: "Sections" });
    const names = within(sidebar)
      .getAllByRole("button")
      .map((b) => b.textContent);
    // Not right after Workloads, as its manifest asks, but where Argo CD always was: after Velero, before the other
    // sections placed after Velero.
    expect(names.indexOf("Argo CD")).toBeGreaterThan(names.indexOf("Workloads") + 1);
    expect(names.indexOf("Argo CD")).toBeLessThan(names.indexOf("Widget tools"));
    await changeList([]);
  });

  it("leave a listed kind's printer columns out, tone a case, place by column id, hide an empty section (ADR-0161)", async () => {
    const kind = { group: "demo.sextant.dev", kind: "Widget" };
    list = [
      info({
        manifest: {
          ...manifest,
          sextantApi: 4,
          contributes: {
            ...manifest.contributes,
            kinds: [{ ...kind, section: "tools", sectionTitle: "Widget tools", searchByDefault: false, printerColumns: false }],
            columns: [
              {
                kind,
                id: "ready",
                title: "Ready",
                paths: [".status.ready"],
                afterColumn: "namespace",
                cases: [{ when: { type: "equals", path: ".spec.suspend", value: true }, text: "Angehalten", tone: "warning" }],
              },
              { kind, id: "rev", title: "Rev", paths: [".status.rev"], afterColumn: "ready" },
            ],
          },
        },
      }),
    ];
    await renderShell();
    const withPrinter = {
      kindRef: WIDGET,
      plural: "widgets",
      namespaced: true,
      verbs: ["list", "watch"],
      printerColumns: [{ name: "Size", jsonPath: ".spec.size", type: "string", priority: 0 }],
      shortNames: [],
    } as never;
    const columns = getResourceDef(WIDGET, withPrinter).columns.map((c) => c.id);
    expect(columns.some((id) => id.startsWith("crd:") || id === "Size")).toBe(false);
    const at = columns.indexOf("namespace");
    expect(columns.slice(at + 1, at + 3)).toEqual(["ext:demo.widgets:ready", "ext:demo.widgets:rev"]);
    const ready = getResourceDef(WIDGET).columns.find((c) => c.id === "ext:demo.widgets:ready")!;
    const cell = render(<>{ready.render!({ ...widget, spec: { suspend: true } }, { clusterId: "c1", kind: WIDGET, now: 0 })}</>);
    expect(cell.container.querySelector(".rt-status--warning")?.textContent).toBe("Angehalten");
  });

  it("hide a details section, title included, while its frame says so (ADR-0161)", async () => {
    await renderShell();
    const section = getDetailsSections(WIDGET).find((s) => s.id === "ext:demo.widgets:info")!;
    const Section = section.Component;
    const view = render(<Section clusterId="c1" objectRef={widgetRef} obj={widget} />);
    const frame = frameOf(view.container);
    const send = (method: string, params: unknown) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", { data: { sextant: 1, doc: DOC, id: 1, method, params }, source: frame.contentWindow }),
        );
      });
    send("ui.setHidden", { hidden: true });
    expect(view.container.querySelector(".ext-section")).toHaveAttribute("hidden");
    send("ui.setHidden", { hidden: false });
    expect(view.container.querySelector(".ext-section")).not.toHaveAttribute("hidden");
  });

  it("add a dock button that opens a dock tab with the extension, closed when the extension goes", async () => {
    await renderShell();
    const dock = screen.getByRole("region", { name: "Dock" });
    fireEvent.click(within(dock).getByRole("button", { name: "Widget console" }));
    const tab = within(dock).getByRole("tab", { name: "Widget console" });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(frameOf(dock).getAttribute("src")).toBe("sextant-ext://demo.widgets/index.html?view=dock&id=console");

    await changeList([]);
    await waitFor(() => expect(within(dock).queryByRole("tab", { name: "Widget console" })).toBeNull());
    expect(within(dock).queryByRole("button", { name: "Widget console" })).toBeNull();
    expect(useAppStore.getState().dock.tabs).toEqual([]);
  });

  it("add a settings section frame for the extension", async () => {
    await renderShell();
    const { container } = render(<ExtensionSettingsFrame extensionId="demo.widgets" />);
    expect(frameOf(container).getAttribute("src")).toBe("sextant-ext://demo.widgets/index.html?view=settings&id=settings");
    const none = render(<ExtensionSettingsFrame extensionId="unknown.ext" />);
    expect(none.container.querySelector("iframe")).toBeNull();
  });

  it("count problems on a section of their own, never on one of Sextant's", () => {
    const rule = {
      id: "broken",
      title: "Broken widget",
      kind: { group: "demo.sextant.dev", kind: "Widget" },
      when: { type: "exists" as const, path: ".status.error" },
      graceMinutes: 0,
      notify: true,
      toldThroughOwner: false,
      message: "broken",
    };
    registerExtension(
      info({
        manifest: {
          ...manifest,
          sextantApi: 3,
          contributes: {
            ...manifest.contributes,
            pages: [...manifest.contributes.pages, { id: "list", title: "Widget list", section: "workloads" }],
            problems: [rule],
            sectionBadges: [
              { section: "widgets", rules: [] },
              { section: "workloads", rules: [] },
            ],
          },
        },
      }),
    );
    expect(getSectionBadge("widgets")).toMatchObject({ tone: "danger", labelKey: "extensions:host.sectionBadge" });
    expect(getSectionBadge("workloads")).toBeUndefined();
    unregisterExtension("demo.widgets");
    expect(getSectionBadge("widgets")).toBeUndefined();
  });

  it("are all removed by unregisterExtension and registered only for active extensions", () => {
    registerExtension(info());
    expect(getPage("ext:demo.widgets:board")).toBeDefined();
    expect(getDockActions().map((a) => a.id)).toContain("ext:demo.widgets:console");
    unregisterExtension("demo.widgets");
    expect(getPage("ext:demo.widgets:board")).toBeUndefined();
    expect(getDockActions().map((a) => a.id)).not.toContain("ext:demo.widgets:console");
    expect(getResourceDef(WIDGET).actions).not.toContain("ext:demo.widgets:scale");
    expect(getResourceDef(WIDGET).columns.map((c) => c.id)).not.toContain("ext:demo.widgets:size");
    expect(getDetailsSections(WIDGET).map((s) => s.id)).toEqual([]);

    syncExtensions([info({ state: "needsConsent", needsConsent: true }), info({ id: "broken", state: "failed", manifest: null, entryUrl: null })]);
    expect(getPage("ext:demo.widgets:board")).toBeUndefined();
  });
});
