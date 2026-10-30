import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBackend, type ExtensionInfo, type ExtensionManifest, type KubeObject, type MockBackend } from "../api";
import { resetAppStore, useAppStore } from "../app/store";
import { getActionsFor, resetActions, runAction } from "../features/actions/registry";
import { ActionBar } from "../features/details/ActionBar";
import { ActionDialogHost } from "../layout/main/ActionDialogHost";
import { AppShell } from "../layout/AppShell";
import { getDetailsSections } from "../layout/details/registry";
import { getDockActions } from "../layout/dock/registry";
import { getPage, registerPage, unregisterPage } from "../layout/pages";
import { i18n } from "../i18n";
import { getResourceDef } from "../resources/registry";
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
      },
    ],
    columns: [{ kind: { group: "demo.sextant.dev", kind: "Widget" }, id: "size", title: "Size", jsonPath: ".spec.size", after: "name" }],
    dockActions: [{ id: "console", title: "Widget console" }],
    problems: [],
    metricQueries: [],
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
