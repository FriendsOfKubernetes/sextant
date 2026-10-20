// "Copy namespace/name" (#229): the text, where it is offered, the confirmation and Ctrl+C on a table row.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBackend, type KindRef, type KubeObject, type MockBackend } from "../../api";
import { resetAppStore } from "../../app/store";
import { ResourceTable } from "../../components/Table";
import { getResourceDef } from "../../resources/registry";
import { axeViolations } from "../../test/axe";
import { getAction, getActionsFor, runAction } from "../actions/registry";
import { isCopyKey } from "../../components/Table/ResourceTable";
import { CopyToast } from "./CopyToast";
import "./index";
import { MAX_SHOWN_CHARS, nameOf, namesText, shownName } from "./model";
import { TOAST_MS, useToast } from "./toast";

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const NODE: KindRef = { group: "", version: "v1", kind: "Node" };

function obj(kind: KindRef, name: string, namespace?: string): KubeObject {
  return { apiVersion: "v1", kind: kind.kind, metadata: { name, namespace, uid: `${namespace ?? ""}/${name}` } };
}

let backend: MockBackend;
let clipboard: string[];
let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetAppStore();
  backend = mockBackend();
  clipboard = [];
  writeText = vi.fn(async (text: string) => void clipboard.push(text));
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  useToast.setState({ message: null });
});
afterEach(() => {
  backend.restore();
  vi.useRealTimers();
});

const offered = (kind: KindRef, objects: KubeObject[]) =>
  getActionsFor(objects, kind, getResourceDef(kind).actions)
    .map((a) => a.id)
    .filter((id) => id.startsWith("copy"));

describe("the text", () => {
  it("is namespace/name, or the name alone for a cluster-scoped object, one per line", () => {
    expect(nameOf({ namespace: "demo", name: "web-1" })).toBe("demo/web-1");
    expect(nameOf({ namespace: null, name: "node-a" })).toBe("node-a");
    expect(namesText([{ namespace: "a", name: "x" }, { namespace: "b", name: "y" }])).toBe("a/x\nb/y");
    const long = "n".repeat(MAX_SHOWN_CHARS + 10);
    expect([...shownName(long)]).toHaveLength(MAX_SHOWN_CHARS);
    expect(shownName("short")).toBe("short");
  });
});

describe("the action", () => {
  it("is offered on every kind, for one or several objects, labelled by the kind's scope", () => {
    expect(offered(POD, [obj(POD, "web", "demo")])).toEqual(["copyNamespacedName"]);
    expect(offered(POD, [obj(POD, "a", "demo"), obj(POD, "b", "prod")])).toEqual(["copyNamespacedName"]);
    expect(offered(NODE, [obj(NODE, "node-a")])).toEqual(["copyName"]);
    const crd: KindRef = { group: "example.com", version: "v1", kind: "Widget" };
    expect(offered(crd, [obj(crd, "w", "demo")])).toEqual(["copyNamespacedName"]);
  });

  it("puts the names on the clipboard and confirms it briefly", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<CopyToast />);
    await act(() => runAction(getAction("copyNamespacedName")!, "c1", POD, [obj(POD, "web", "demo")]));
    expect(clipboard).toEqual(["demo/web"]);
    expect(screen.getByRole("status")).toHaveTextContent("Copied demo/web");
    expect(await axeViolations()).toEqual([]);

    await act(() => runAction(getAction("copyNamespacedName")!, "c1", POD, [obj(POD, "a", "x"), obj(POD, "b", "y")]));
    expect(clipboard.at(-1)).toBe("x/a\ny/b");
    expect(screen.getByRole("status")).toHaveTextContent("Copied 2 names, one per line");

    await act(() => runAction(getAction("copyName")!, "c1", NODE, [obj(NODE, "node-a")]));
    expect(clipboard.at(-1)).toBe("node-a");
    act(() => void vi.advanceTimersByTime(TOAST_MS + 10));
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("says so when the clipboard refuses", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    render(<CopyToast />);
    await act(() => runAction(getAction("copyName")!, "c1", NODE, [obj(NODE, "node-a")]));
    expect(screen.getByRole("status")).toHaveTextContent("Could not copy to the clipboard");
  });
});

describe("in a table", () => {
  async function table() {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("rt__scroll") ? 660 : 0;
    });
    backend.on("watch_start", () => "w1");
    backend.on("watch_stop", () => undefined);
    render(
      <>
        <ResourceTable clusterId="c1" kind={POD} />
        <CopyToast />
      </>,
    );
    await waitFor(() => expect(backend.listenerCount("watch:w1")).toBe(1));
    act(() => backend.emit("watch:w1", { type: "snapshot", items: [obj(POD, "web", "demo"), obj(POD, "db", "prod")] }));
    await screen.findByRole("button", { name: "Actions for web" });
    const rows = () => screen.getAllByRole("row").filter((row) => row.dataset.uid);
    return rows;
  }
  afterEach(() => vi.restoreAllMocks());

  it("the row menu offers it; Ctrl+C on a focused row copies that row, or every selected row", async () => {
    const rows = await table();
    fireEvent.click(screen.getByRole("button", { name: "Actions for web" }));
    expect(await screen.findByRole("menuitem", { name: /Copy namespace\/name/ })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });

    const web = rows().find((row) => row.dataset.uid === "demo/web")!;
    web.focus();
    fireEvent.keyDown(web, { key: "c", ctrlKey: true });
    await waitFor(() => expect(clipboard).toEqual(["demo/web"]));
    // On a non-Latin layout the key is another letter; the physical key decides (Cyrillic "с" on KeyC).
    fireEvent.keyDown(web, { key: "с", code: "KeyC", ctrlKey: true });
    await waitFor(() => expect(clipboard).toEqual(["demo/web", "demo/web"]));
    clipboard.length = 0;
    writeText.mockClear();
    // Ctrl+Shift+C and plain "c" do nothing.
    fireEvent.keyDown(web, { key: "C", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(web, { key: "c" });
    expect(writeText).not.toHaveBeenCalled();

    // Both rows selected (Space): ⌘C copies both, one per line.
    for (const row of rows()) fireEvent.keyDown(row, { key: " " });
    fireEvent.keyDown(web, { key: "c", metaKey: true });
    await waitFor(() => expect(clipboard).toHaveLength(1));
    expect(clipboard[0]!.split("\n").sort()).toEqual(["demo/web", "prod/db"]);
    expect(within(screen.getByRole("status")).getByText("Copied 2 names, one per line")).toBeInTheDocument();
  });
});

describe("the copy key", () => {
  it("is Ctrl+C or ⌘C by the letter or by the physical key, never with Shift or Alt", () => {
    const key = (init: Partial<KeyboardEvent>) =>
      isCopyKey({ key: "", code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init });
    expect(key({ key: "c", code: "KeyC", ctrlKey: true })).toBe(true);
    expect(key({ key: "C", code: "KeyC", metaKey: true })).toBe(true);
    expect(key({ key: "с", code: "KeyC", ctrlKey: true })).toBe(true);
    expect(key({ key: "c", code: "KeyC" })).toBe(false);
    expect(key({ key: "c", code: "KeyC", ctrlKey: true, shiftKey: true })).toBe(false);
    expect(key({ key: "c", code: "KeyC", ctrlKey: true, altKey: true })).toBe(false);
    expect(key({ key: "v", code: "KeyV", ctrlKey: true })).toBe(false);
  });
});

describe("in a narrow window", () => {
  it("the confirmation stays visible and announced inside the closed drawer", async () => {
    const style = document.createElement("style");
    // The stylesheets themselves (vitest leaves CSS imports out): the drawer's rule and the toast's.
    style.textContent = ["src/layout/layout.css", "src/features/copy-name/copyName.css"]
      .map((file) => readFileSync(join(process.cwd(), file), "utf8"))
      .join("\n");
    document.head.append(style);
    try {
      render(
        <div className="drawer">
          <CopyToast />
        </div>,
      );
      await act(() => runAction(getAction("copyName")!, "c1", NODE, [obj(NODE, "node-a")]));
      const status = screen.getByRole("status");
      expect(getComputedStyle(status.closest(".drawer")!).visibility).toBe("hidden");
      expect(getComputedStyle(status).visibility).toBe("visible");
      expect(getComputedStyle(status.firstElementChild!).visibility).toBe("visible");
      expect(status).toHaveTextContent("Copied node-a");
    } finally {
      style.remove();
    }
  });
});
