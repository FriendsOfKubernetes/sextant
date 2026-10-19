// Split panes, snippets and broadcast input (#154): the pure parts.
import { afterEach, describe, expect, it } from "vitest";
import {
  broadcastInput,
  cancelBroadcast,
  confirmBroadcast,
  registerPane,
  resetBroadcast,
  startBroadcast,
  stopBroadcast,
  useBroadcast,
  type PaneInfo,
} from "./broadcast";
import {
  closePane,
  focusKey,
  MAX_PANES,
  MIN_SIZE,
  neighbour,
  paneNode,
  panesOf,
  resizeSplit,
  splitHandles,
  splitPane,
  type LayoutNode,
} from "./layout";
import {
  fillSnippet,
  isValidSnippet,
  placeholdersOf,
  quoteFor,
  shellQuote,
  snippetInput,
  upsertSnippet,
  visibleText,
} from "./snippets";
import { printable } from "./useTerminal";

const ids = (root: LayoutNode<string> | null) => (root ? panesOf(root).map((p) => p.pane) : []);

/** a | b over c, i.e. a row of [a, column of [b, c]]. */
function grid() {
  const a = paneNode("a", "a");
  let root: LayoutNode<string> = a;
  root = splitPane(root, "a", "row", paneNode("b", "b"));
  root = splitPane(root, "b", "column", paneNode("c", "c"));
  return root;
}

describe("pane layout", () => {
  it("splits a pane next to itself and nests a split of the other direction", () => {
    const root = grid();
    expect(ids(root)).toEqual(["a", "b", "c"]);
    expect(root.type).toBe("split");
    if (root.type !== "split") return;
    expect(root.direction).toBe("row");
    expect(root.sizes).toEqual([0.5, 0.5]);
    const right = root.children[1]!;
    expect(right.type === "split" && right.direction).toBe("column");
  });

  it("adds a pane to a split of the same direction, halving the split pane's share", () => {
    let root: LayoutNode<string> = paneNode("a", "a");
    root = splitPane(root, "a", "row", paneNode("b", "b"));
    root = splitPane(root, "a", "row", paneNode("x", "x"));
    expect(ids(root)).toEqual(["a", "x", "b"]);
    expect(root.type === "split" && root.sizes).toEqual([0.25, 0.25, 0.5]);
  });

  it("does not split an unknown pane or beyond the pane limit", () => {
    const root = grid();
    expect(splitPane(root, "nope", "row", paneNode("x", "x"))).toBe(root);
    let full: LayoutNode<string> = paneNode("p0", "p0");
    for (let i = 1; i < MAX_PANES + 3; i++) full = splitPane(full, `p${i - 1}`, "row", paneNode(`p${i}`, `p${i}`));
    expect(panesOf(full)).toHaveLength(MAX_PANES);
  });

  it("closes a pane, gives its share to the rest and collapses a split left with one child", () => {
    const root = grid();
    const withoutC = closePane(root, "c");
    expect(ids(withoutC)).toEqual(["a", "b"]);
    expect(withoutC?.type === "split" && withoutC.children.every((c) => c.type === "pane")).toBe(true);
    const onlyA = closePane(closePane(root, "c")!, "b");
    expect(onlyA).toEqual(paneNode("a", "a"));
    expect(closePane(paneNode("a", "a"), "a")).toBeNull();
    expect(closePane(root, "nope")).toBe(root);
    let three: LayoutNode<string> = paneNode("a", "a");
    three = splitPane(three, "a", "row", paneNode("b", "b"));
    three = splitPane(three, "b", "row", paneNode("c", "c"));
    const two = closePane(three, "b");
    expect(two?.type === "split" && two.sizes).toEqual([2 / 3, 1 / 3]);
  });

  it("resizes the border between two children within the minimum share", () => {
    const root = grid();
    if (root.type !== "split") throw new Error("not a split");
    const grown = resizeSplit(root, root.id, 0, 0.2);
    expect(grown.type === "split" && grown.sizes[0]).toBeCloseTo(0.7);
    const squeezed = resizeSplit(root, root.id, 0, 5);
    if (squeezed.type !== "split") throw new Error("not a split");
    expect(squeezed.sizes[0]).toBeCloseTo(1 - MIN_SIZE);
    expect(squeezed.sizes[1]).toBeCloseTo(MIN_SIZE);
    expect(resizeSplit(root, root.id, 1, 0.1)).toBe(root);
    expect(resizeSplit(root, "unknown", 0, 0.1)).toBe(root);
    const handles = splitHandles(root);
    expect(handles).toHaveLength(2);
    expect(handles[0]).toMatchObject({ splitId: root.id, index: 0, direction: "row", x: 0.5, length: 1, extent: 1 });
    expect(handles[1]).toMatchObject({ direction: "column", x: 0.5, y: 0.5, length: 0.5, extent: 1 });
  });

  it("moves the focus to the neighbouring pane in each direction", () => {
    const root = grid();
    expect(neighbour(root, "a", "right")).toBe("b");
    expect(neighbour(root, "a", "left")).toBeNull();
    expect(neighbour(root, "b", "down")).toBe("c");
    expect(neighbour(root, "c", "up")).toBe("b");
    expect(neighbour(root, "c", "left")).toBe("a");
    expect(neighbour(root, "b", "up")).toBeNull();
  });

  it("takes Ctrl+Shift+Arrow only", () => {
    const key = (key: string, mods: Partial<KeyboardEvent> = {}) =>
      focusKey({ type: "keydown", key, ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, ...mods });
    expect(key("ArrowLeft")).toBe("left");
    expect(key("ArrowDown")).toBe("down");
    expect(key("ArrowLeft", { shiftKey: false })).toBeNull();
    expect(key("ArrowLeft", { altKey: true })).toBeNull();
    expect(key("k")).toBeNull();
    expect(key("ArrowUp", { type: "keyup" })).toBeNull();
  });
});

describe("snippets", () => {
  const context = { namespace: "shop", pod: "web-0", container: "nginx", cluster: "Prod EU", context: "kind-prod" };

  it("fills the placeholders from the pane and quotes values only when needed", () => {
    const filled = fillSnippet("kubectl -n {{namespace}} logs {{pod}} -c {{ container }} --context {{context}} # {{cluster}}", context);
    expect(filled).toEqual({
      text: "kubectl -n shop logs web-0 -c nginx --context kind-prod # 'Prod EU'",
      missing: [],
      refused: [],
    });
    expect(placeholdersOf("{{pod}} {{pod}} {{namespace}} {{unknown}}")).toEqual(["pod", "namespace"]);
  });

  it("single-quotes values with quotes, spaces, command substitution and backticks", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
    expect(shellQuote("`reboot`")).toBe("'`reboot`'");
    expect(shellQuote("x;y|z&$HOME")).toBe("'x;y|z&$HOME'");
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("web-0")).toBe("web-0");
    const filled = fillSnippet("echo {{pod}}", { pod: "a'$(id)`b` c" });
    expect(filled.text).toBe(`echo 'a'\\''$(id)\`b\` c'`);
  });

  it("quotes for PowerShell with single quotes, doubling the ASCII and typographic single quotes", () => {
    expect(quoteFor("powershell", "web-0")).toBe("'web-0'");
    expect(quoteFor("powershell", "it's")).toBe("'it''s'");
    expect(quoteFor("powershell", "a’; Remove-Item x")).toBe("'a’’; Remove-Item x'");
    expect(quoteFor("powershell", "‘‚‛")).toBe("'‘‘‚‚‛‛'");
    expect(quoteFor("powershell", '$(Get-Process) `x` "y"')).toBe(`'$(Get-Process) \`x\` "y"'`);
    const filled = fillSnippet("kubectl --context {{context}}", { context: "o'brien’s" }, "powershell");
    expect(filled.text).toBe("kubectl --context 'o''brien’’s'");
  });

  it("refuses values it cannot quote safely: hidden characters and backslashes anywhere, quotes for an unknown shell", () => {
    for (const shell of ["posix", "powershell", "unknown"] as const) {
      expect(quoteFor(shell, "a\\b")).toBeNull();
      expect(quoteFor(shell, "a\rb")).toBeNull();
      expect(quoteFor(shell, "a‮b")).toBeNull();
      expect(quoteFor(shell, "a​b")).toBeNull();
    }
    expect(quoteFor("unknown", "Prod EU")).toBe("'Prod EU'");
    for (const quote of ["'", '"', "`", "’", "“"]) expect(quoteFor("unknown", `a${quote}b`)).toBeNull();
    const filled = fillSnippet("echo {{cluster}} {{pod}}", { cluster: "it's", pod: "web" }, "unknown");
    expect(filled.refused).toEqual(["cluster"]);
    expect(snippetInput(filled, true)).toBeNull();
  });

  it("strips and flags bidi controls and zero-width characters", () => {
    expect(printable("ls‮ -la​﻿ x⁦")).toBe("ls -la x");
    expect(isValidSnippet({ name: "List", command: "ls ‮" })).toBe(false);
    expect(isValidSnippet({ name: "Li‍st", command: "ls" })).toBe(false);
    expect(visibleText("a b\t‮\r")).toBe("a·b→⟨U+202E⟩⟨U+000D⟩");
  });

  it("lists placeholders the pane has no value for and keeps unknown ones as they are", () => {
    const filled = fillSnippet("kubectl logs {{pod}} -c {{container}} {{other}}", { namespace: "shop" });
    expect(filled.missing).toEqual(["pod", "container"]);
    expect(snippetInput(filled, false)).toBeNull();
    expect(fillSnippet("echo {{other}}", {}).text).toBe("echo {{other}}");
  });

  it("inserts without Enter and runs only with Run; control characters never reach the shell", () => {
    const filled = fillSnippet("ls -la\nrm -rf /tmp/x\x1b[A", {});
    expect(filled.text).toBe("ls -la rm -rf /tmp/x [A");
    expect(snippetInput(filled, false)).toBe("ls -la rm -rf /tmp/x [A");
    expect(snippetInput(filled, true)).toBe("ls -la rm -rf /tmp/x [A\r");
    const value = fillSnippet("echo {{pod}}", { pod: "a\rb" });
    expect(value.refused).toEqual(["pod"]);
    expect(snippetInput(value, false)).toBeNull();
  });

  it("validates and updates the list", () => {
    expect(isValidSnippet({ name: " ", command: "ls" })).toBe(false);
    expect(isValidSnippet({ name: "x", command: "x".repeat(4097) })).toBe(false);
    expect(isValidSnippet({ name: "List", command: "ls" })).toBe(true);
    const one = { id: "a", name: "A", command: "ls" };
    const list = upsertSnippet(upsertSnippet([], one), { id: "b", name: "B", command: "pwd" });
    expect(upsertSnippet(list, { ...one, command: "ls -la" }).map((s) => s.command)).toEqual(["ls -la", "pwd"]);
  });
});

describe("broadcast input", () => {
  afterEach(() => resetBroadcast());

  function pane(id: string, clusterId: string | null = "c1") {
    const sent: string[] = [];
    const info: PaneInfo = { id, tabId: "t1", tabTitle: "Terminal", clusterId, label: id };
    const unregister = registerPane(info, (data) => sent.push(data));
    return { sent, unregister };
  }

  it("is off by default and needs at least two live target panes", () => {
    const a = pane("a");
    pane("b");
    expect(useBroadcast.getState().targets).toBeNull();
    expect(broadcastInput("a", "x")).toBe(false);
    expect(startBroadcast(["a"])).toBe(false);
    expect(startBroadcast(["a", "gone"])).toBe(false);
    expect(startBroadcast(["a", "a"])).toBe(false);
    expect(a.sent).toEqual([]);
  });

  it("sends nothing typed before the confirmation, not even after it, and what follows to every target", () => {
    const a = pane("a");
    const b = pane("b");
    const c = pane("c", "c2");
    expect(startBroadcast(["a", "b"])).toBe(true);
    expect(broadcastInput("a", "l")).toBe(true);
    expect(broadcastInput("a", "s")).toBe(true);
    expect(useBroadcast.getState().asking).toBe("a");
    expect([a.sent, b.sent, c.sent]).toEqual([[], [], []]);
    // A pane that is not a target types into itself only.
    expect(broadcastInput("c", "x")).toBe(false);

    confirmBroadcast();
    expect([a.sent, b.sent]).toEqual([[], []]);
    expect(broadcastInput("b", "\r")).toBe(true);
    expect(a.sent).toEqual(["\r"]);
    expect(b.sent).toEqual(["\r"]);
    expect(c.sent).toEqual([]);
  });

  it("asks again after each activation and drops the input when refused", () => {
    const a = pane("a");
    const b = pane("b");
    startBroadcast(["a", "b"]);
    broadcastInput("a", "rm -rf");
    cancelBroadcast();
    expect(useBroadcast.getState()).toEqual({ targets: null, confirmed: false, asking: null });
    expect(a.sent).toEqual([]);
    expect(broadcastInput("a", "x")).toBe(false);

    startBroadcast(["a", "b"]);
    broadcastInput("a", "1");
    confirmBroadcast();
    broadcastInput("a", "2");
    stopBroadcast();
    startBroadcast(["a", "b"]);
    expect(useBroadcast.getState().confirmed).toBe(false);
    broadcastInput("b", "3");
    expect(b.sent).toEqual(["2"]);
  });

  it("stops when a target pane closes, not when another one does", () => {
    pane("a");
    const b = pane("b");
    const c = pane("c");
    startBroadcast(["a", "b"]);
    c.unregister();
    expect(useBroadcast.getState().targets).toEqual(["a", "b"]);
    b.unregister();
    expect(useBroadcast.getState().targets).toBeNull();
  });
});


