// Split panes, snippets and broadcast input in a terminal dock tab (#154).
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type MockBackend } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore } from "../../app/store";
import { Dock } from "../../layout/dock/Dock";
import { useClustersStore } from "../clusters/clustersStore";
import { resetBroadcast } from "./broadcast";
import { resetLocalShellKind } from "./PaneLayout";
import "./index";
import { openExecTab, openLocalTerminalTab } from "./tabs";

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

function setUp(settings: Parameters<typeof mockBackend>[1] = {}) {
  backend = mockBackend(
    {
      exec_start: () => undefined,
      terminal_start: () => undefined,
      term_input: () => undefined,
      term_resize: () => undefined,
      term_stop: () => undefined,
    },
    settings,
  );
}

beforeEach(() => {
  resetAppStore();
  resetSettingsCache();
  resetBroadcast();
  resetLocalShellKind();
  useClustersStore.setState({
    clusters: [
      {
        id: "c1",
        context: "kind-sextant-test",
        clusterName: "kind-sextant-test",
        server: "https://127.0.0.1:6443",
        user: "admin",
        namespace: null,
        sourceId: "default",
      },
    ],
  });
});
afterEach(() => backend.restore());

const calls = (cmd: string) => backend.calls.filter((c) => c.cmd === cmd).map((c) => c.args);
const started = () => calls("terminal_start").concat(calls("exec_start")).map((a) => a.streamId as string);
const inputs = () => calls("term_input").map((a) => [a.sessionId, a.data]);
const panes = () => [...document.querySelectorAll<HTMLElement>(".terminal-panes__pane")];
const typeEnter = (pane: HTMLElement) => {
  const input = pane.querySelector("textarea.xterm-helper-textarea");
  if (!input) throw new Error("no xterm input");
  fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: 13 });
};

async function twoLocalPanes() {
  render(<Dock />);
  act(() => void openLocalTerminalTab("c1", "kind"));
  await waitFor(() => expect(calls("term_resize")).toHaveLength(1));
  fireEvent.click(screen.getByRole("button", { name: "Split right" }));
  const dialog = await screen.findByRole("dialog", { name: "New pane on the right" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Open" }));
  await waitFor(() => expect(calls("term_resize")).toHaveLength(2));
  expect(panes()).toHaveLength(2);
}

describe("split panes", () => {
  it("splits a tab without restarting its shell and closes one pane only", async () => {
    setUp();
    await twoLocalPanes();
    const [first, second] = started();
    expect(calls("terminal_start")).toHaveLength(2);
    expect(calls("term_stop")).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Close pane" }));
    await waitFor(() => expect(calls("term_stop")).toEqual([{ sessionId: second }]));
    expect(panes()).toHaveLength(1);
    expect(calls("term_stop")).not.toContainEqual({ sessionId: first });
    expect(screen.queryByRole("button", { name: "Close pane" })).not.toBeInTheDocument();
  });
});

describe("broadcast", () => {
  it("needs an explicit choice, shows a banner on every target and sends nothing before the confirmation", async () => {
    setUp();
    await twoLocalPanes();
    const [first, second] = started();
    fireEvent.click(screen.getByRole("button", { name: "Broadcast…" }));
    const dialog = await screen.findByRole("dialog", { name: "Broadcast input" });
    const boxes = within(dialog).getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    expect(boxes.every((b) => !(b as HTMLInputElement).checked)).toBe(true);
    const start = within(dialog).getByRole("button", { name: "Start broadcast" });
    expect(start).toBeDisabled();
    boxes.forEach((b) => fireEvent.click(b));
    fireEvent.click(start);

    await waitFor(() => expect(screen.getAllByText(/Broadcast is on: your input goes to 2 panes/)).toHaveLength(2));
    expect(screen.getAllByText(/Clusters: kind-sextant-test/).length).toBeGreaterThan(0);

    typeEnter(panes()[0]!);
    const confirm = await screen.findByRole("dialog", { name: "Send your input to several panes?" });
    // The dialog has the keyboard; keys that still reach a terminal before confirming are dropped, also afterwards.
    await waitFor(() => expect(confirm.contains(document.activeElement)).toBe(true));
    typeEnter(panes()[1]!);
    expect(inputs()).toEqual([]);
    fireEvent.click(within(confirm).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 50));
    expect(inputs()).toEqual([]);
    typeEnter(panes()[0]!);
    await waitFor(() =>
      expect(inputs()).toEqual([
        [first, "\r"],
        [second, "\r"],
      ]),
    );

    // Closing a target pane ends the broadcast.
    fireEvent.click(screen.getByRole("button", { name: "Close pane" }));
    await waitFor(() => expect(screen.queryByText(/Broadcast is on/)).not.toBeInTheDocument());
    typeEnter(panes()[0]!);
    await waitFor(() => expect(inputs()).toHaveLength(3));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("refusing the confirmation drops the input and turns broadcast off", async () => {
    setUp();
    await twoLocalPanes();
    fireEvent.click(screen.getByRole("button", { name: "Broadcast…" }));
    const dialog = await screen.findByRole("dialog", { name: "Broadcast input" });
    within(dialog).getAllByRole("checkbox").forEach((b) => fireEvent.click(b));
    fireEvent.click(within(dialog).getByRole("button", { name: "Start broadcast" }));
    typeEnter(panes()[1]!);
    const confirm = await screen.findByRole("dialog", { name: "Send your input to several panes?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText(/Broadcast is on/)).not.toBeInTheDocument());
    expect(inputs()).toEqual([]);
    expect(screen.getByRole("button", { name: "Broadcast…" })).toBeInTheDocument();
  });
});

describe("snippets", () => {
  const snippets = [
    { id: "logs", name: "Logs", command: "kubectl -n {{namespace}} logs {{pod}} -c {{container}} --context {{context}}" },
    { id: "node", name: "Node", command: "echo {{namespace}}" },
  ];

  it("inserts a snippet filled from the pane without Enter, and runs it only with Run", async () => {
    setUp({ settings: { snippets } });
    render(<Dock />);
    const pod = { kind: { group: "", version: "v1", kind: "Pod" }, namespace: "shop", name: "web-0" };
    act(() => void openExecTab("c1", pod, "nginx"));
    await waitFor(() => expect(calls("term_resize")).toHaveLength(1));
    const [session] = started();

    fireEvent.click(screen.getByRole("button", { name: "Snippets" }));
    fireEvent.click(await screen.findByRole("button", { name: "Insert Logs" }));
    const filled = "kubectl -n shop logs web-0 -c nginx --context kind-sextant-test";
    await waitFor(() => expect(inputs()).toEqual([[session, filled]]));

    fireEvent.click(screen.getByRole("button", { name: "Snippets" }));
    fireEvent.click(await screen.findByRole("button", { name: "Run Logs" }));
    await waitFor(() => expect(inputs()).toEqual([[session, filled], [session, `${filled}\r`]]));
  });

  it("quotes values for PowerShell in a local terminal on Windows", async () => {
    setUp({ settings: { snippets: [{ id: "ctx", name: "Ctx", command: "kubectl config use-context {{cluster}}" }], clusters: { c1: { displayName: "O'Brien\u2019s" } } as never } });
    backend.on("about_info", () => ({ os: "Windows", arch: "x86_64", osVersion: null, webviewVersion: null, tauriVersion: "2" }));
    render(<Dock />);
    act(() => void openLocalTerminalTab("c1", "kind"));
    await waitFor(() => expect(calls("term_resize")).toHaveLength(1));
    const [session] = started();
    fireEvent.click(screen.getByRole("button", { name: "Snippets" }));
    await waitFor(() => expect(calls("about_info")).toHaveLength(1));
    fireEvent.click(await screen.findByRole("button", { name: "Insert Ctx" }));
    await waitFor(() => expect(inputs()).toEqual([[session, "kubectl config use-context 'O''Brien\u2019\u2019s'"]]));
  });

  it("offers a snippet only where every placeholder has a value", async () => {
    setUp({ settings: { snippets } });
    render(<Dock />);
    act(() => void openLocalTerminalTab("c1", "kind"));
    await waitFor(() => expect(calls("term_resize")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Snippets" }));
    expect(await screen.findByRole("button", { name: "Insert Logs" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Run Node" })).toBeDisabled();
    expect(screen.getAllByText(/it needs: \{\{namespace\}\}/).length).toBeGreaterThan(0);
  });

  it("adds a snippet in the manager and saves it in the settings", async () => {
    setUp();
    render(<Dock />);
    act(() => void openLocalTerminalTab("c1", "kind"));
    fireEvent.click(screen.getByRole("button", { name: "Snippets" }));
    fireEvent.click(await screen.findByRole("button", { name: "Manage snippets…" }));
    const dialog = await screen.findByRole("dialog", { name: "Snippets" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add snippet" }));
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Pods" } });
    fireEvent.change(within(dialog).getByLabelText("Command"), { target: { value: "kubectl get pods" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(backend.settings.snippets).toMatchObject([{ name: "Pods", command: "kubectl get pods" }]));
    expect(within(dialog).getByText("Pods")).toBeInTheDocument();
  });
});
