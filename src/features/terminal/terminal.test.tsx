import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBackend, type KindRef, type KubeObject, type MockBackend } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { Dock } from "../../layout/dock/Dock";
import { ActionDialogHost } from "../../layout/main/ActionDialogHost";
import { getAction, getActionsFor, runAction } from "../actions/registry";
import { useClustersStore } from "../clusters/clustersStore";
import "./index";
import { useTerminal } from "./useTerminal";

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

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };

function pod(name: string, containers: string[], extra: Partial<KubeObject> = {}): KubeObject {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, namespace: "demo", uid: `uid-${name}` },
    spec: { containers: containers.map((c) => ({ name: c, image: "nginx" })) },
    status: { phase: "Running" },
    ...extra,
  };
}

const b64 = (text: string) => btoa(text);

let backend: MockBackend;
let sessions: number;
/** Number of `term:<id>` listeners when each `*_start` and each `term_resize` arrived. */
let listenersAtStart: number[];
let listenersAtResize: number[];

beforeEach(() => {
  resetAppStore();
  sessions = 0;
  listenersAtStart = [];
  listenersAtResize = [];
  const start = (args: Record<string, unknown>) => {
    listenersAtStart.push(backend.listenerCount(`term:${args.streamId as string}`));
    return `term-${++sessions}`;
  };
  backend = mockBackend({
    exec_start: start,
    terminal_start: start,
    term_input: () => undefined,
    term_resize: (args) => {
      listenersAtResize.push(backend.listenerCount(`term:${args.sessionId as string}`));
    },
    term_stop: () => undefined,
  });
});
afterEach(() => backend.restore());

function App() {
  return (
    <>
      <Dock />
      <ActionDialogHost />
    </>
  );
}

const screenText = () => document.querySelector(".xterm-rows")?.textContent ?? "";

async function runShell(obj: KubeObject) {
  const action = getAction("exec");
  if (!action) throw new Error("exec action is not registered");
  await act(() => runAction(action, "c1", POD, [obj]));
}

function calls(cmd: string) {
  return backend.calls.filter((c) => c.cmd === cmd).map((c) => c.args);
}

/** The ids the frontend chose for its sessions, in start order. */
function sessionIds() {
  return backend.calls.filter((c) => c.cmd === "exec_start" || c.cmd === "terminal_start").map((c) => c.args.streamId);
}

describe("Shell action", () => {
  it("is offered for running pods only", () => {
    const running = pod("web", ["nginx"]);
    const done = pod("job", ["main"], { status: { phase: "Succeeded" } });
    expect(getActionsFor([running], POD, ["exec"]).map((a) => a.id)).toEqual(["exec"]);
    expect(getActionsFor([done], POD, ["exec"])).toEqual([]);
    const deployment: KindRef = { group: "apps", version: "v1", kind: "Deployment" };
    expect(getActionsFor([running], deployment, ["exec"])).toEqual([]);
  });

  it("opens a shell tab, listens before the session starts and shows the output", async () => {
    render(<App />);
    await runShell(pod("web", ["nginx"]));

    expect(screen.getByRole("tab", { name: "Shell: web" })).toBeInTheDocument();
    await waitFor(() => expect(calls("term_resize")).toHaveLength(1));
    const [start] = calls("exec_start");
    expect(start).toMatchObject({
      clusterId: "c1",
      pod: { kind: POD, namespace: "demo", name: "web" },
      container: "nginx",
    });
    expect(start?.cols).toBeGreaterThan(0);
    expect(start?.rows).toBeGreaterThan(0);
    // The backend sends output as soon as the shell prints it: the frontend listens before the start.
    expect(listenersAtStart).toEqual([1]);
    expect(listenersAtResize).toEqual([1]);
    expect(calls("term_resize")[0]).toMatchObject({ sessionId: start?.streamId });

    act(() => backend.emit("term:term-1", { type: "data", data: b64("root@web:/# ") }));
    await waitFor(() => expect(screenText()).toContain("root@web:/#"));
  });

  it("shows the prompt the shell prints before exec_start answers", async () => {
    backend.on("exec_start", (args) => {
      backend.emit(`term:${args.streamId as string}`, { type: "data", data: b64("early$ ") });
      return undefined;
    });
    render(<App />);
    await runShell(pod("web", ["nginx"]));
    await waitFor(() => expect(screenText()).toContain("early$"));
  });

  it("sends keystrokes to the session", async () => {
    render(<App />);
    await runShell(pod("web", ["nginx"]));
    await waitFor(() => expect(calls("term_resize")).toHaveLength(1));

    const input = document.querySelector("textarea.xterm-helper-textarea");
    if (!input) throw new Error("no xterm input");
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: 13 });
    await waitFor(() => expect(calls("term_input")).toContainEqual({ sessionId: sessionIds()[0], data: "\r" }));
  });

  it("asks for the container of a multi-container pod, the default container first", async () => {
    render(<App />);
    const obj = pod("api", ["app", "sidecar"], {
      metadata: {
        name: "api",
        namespace: "demo",
        uid: "uid-api",
        annotations: { "kubectl.kubernetes.io/default-container": "sidecar" },
      },
    });
    await runShell(obj);

    const dialog = screen.getByRole("dialog", { name: "Open a shell in api" });
    const buttons = within(dialog).getAllByRole("button").filter((b) => b.getAttribute("aria-label") !== "Close");
    expect(buttons.map((b) => b.textContent)).toEqual(["sidecar", "app"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "app" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Shell: api/app" })).toBeInTheDocument();
    await waitFor(() => expect(calls("exec_start")[0]).toMatchObject({ container: "app" }));
  });

  it("shows «session ended» after exit and reconnects with a new session", async () => {
    render(<App />);
    await runShell(pod("web", ["nginx"]));
    await waitFor(() => expect(calls("term_resize")).toHaveLength(1));

    act(() => backend.emit("term:term-1", { type: "exit", code: 0 }));
    expect(await screen.findByRole("status")).toHaveTextContent("Session ended (exit code 0)");

    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(calls("exec_start")).toHaveLength(2));
    await waitFor(() => expect(calls("term_resize").at(-1)).toMatchObject({ sessionId: sessionIds()[1] }));
    expect(calls("term_stop")).toContainEqual({ sessionId: sessionIds()[0] });
    expect(screen.queryByText(/Session ended/)).not.toBeInTheDocument();
  });

  it("shows a broken connection and a start failure with Reconnect", async () => {
    backend.on("exec_start", () => {
      throw { code: "forbidden", message: "pods/exec is forbidden" };
    });
    render(<App />);
    await runShell(pod("web", ["nginx"]));
    const status = await screen.findByRole("status");
    await waitFor(() => expect(status).toHaveTextContent("Session failed"));
    expect(status).toHaveTextContent("pods/exec is forbidden");

    backend.on("exec_start", () => "term-9");
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(calls("term_resize").at(-1)).toMatchObject({ sessionId: sessionIds()[1] }));
    act(() =>
      backend.emit("term:term-9", { type: "error", error: { code: "unreachable", message: "connection reset" } }),
    );
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("connection reset"));
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });

  it("stops the session when its tab is closed", async () => {
    render(<App />);
    await runShell(pod("web", ["nginx"]));
    await waitFor(() => expect(calls("term_resize")).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: /Close.*Shell: web/ }));
    await waitFor(() => expect(calls("term_stop")).toEqual([{ sessionId: sessionIds()[0] }]));
    expect(backend.listenerCount("term:term-1")).toBe(0);
  });
});

describe("Terminal button", () => {
  it("is shown with an active cluster and opens a local terminal for it", async () => {
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
    const { rerender } = render(<App />);
    expect(screen.queryByRole("button", { name: "Terminal" })).not.toBeInTheDocument();

    act(() => useAppStore.getState().setActiveCluster("c1"));
    rerender(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));

    expect(await screen.findByRole("tab", { name: "Terminal: kind-sextant-test" })).toBeInTheDocument();
    await waitFor(() => expect(calls("term_resize")).toHaveLength(1));
    expect(calls("terminal_start")[0]).toMatchObject({ clusterId: "c1" });
    expect(listenersAtStart).toEqual([1]);
    act(() => backend.emit("term:term-1", { type: "data", data: b64("$ kubectl get pods") }));
    await waitFor(() => expect(screenText()).toContain("$ kubectl get pods"));
  });
});

describe("KUBECONFIG notice", () => {
  // What the backend (src-tauri/src/pty.rs) sends first for a shell whose profile may still set KUBECONFIG.
  const NOTICE = "\x1b]7719;kubeconfig-not-pinned\x07";

  async function openLocalTerminal() {
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
    act(() => useAppStore.getState().setActiveCluster("c1"));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    await waitFor(() => expect(calls("term_resize")).toHaveLength(1));
  }

  it("is shown in a local terminal whose shell may override KUBECONFIG", async () => {
    await openLocalTerminal();
    act(() => backend.emit("term:term-1", { type: "data", data: b64(`${NOTICE}$ `) }));
    await waitFor(() => expect(screenText()).toContain("$"));
    const note = await screen.findByRole("note");
    expect(note).toHaveTextContent(/profile may override KUBECONFIG/);
    expect(screenText()).not.toContain("kubeconfig-not-pinned");
  });

  it("is not shown for a shell that keeps the session's KUBECONFIG", async () => {
    await openLocalTerminal();
    act(() => backend.emit("term:term-1", { type: "data", data: b64("$ ") }));
    await waitFor(() => expect(screenText()).toContain("$"));
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("is not shown in a container shell", async () => {
    render(<App />);
    await runShell(pod("web", ["nginx"]));
    await waitFor(() => expect(calls("term_resize")).toHaveLength(1));
    act(() => backend.emit("term:term-1", { type: "data", data: b64(`${NOTICE}# `) }));
    await waitFor(() => expect(screenText()).toContain("#"));
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });
});

describe("useTerminal", () => {
  it("copies the selection with Ctrl+Shift+C instead of sending it to the shell", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const el = document.createElement("div");
    document.body.appendChild(el);
    const { result } = renderHook(() => {
      const ref = useRef<HTMLElement | null>(el);
      return useTerminal(ref, () => Promise.resolve("term-1"));
    });
    await waitFor(() => expect(calls("term_resize")).toHaveLength(1));
    const term = result.current.terminal;
    if (!term) throw new Error("no terminal");
    await new Promise<void>((resolve) => term.write("copy me", resolve));
    term.selectAll();

    const input = el.querySelector("textarea.xterm-helper-textarea");
    if (!input) throw new Error("no xterm input");
    fireEvent.keyDown(input, { key: "C", code: "KeyC", keyCode: 67, ctrlKey: true, shiftKey: true });
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("copy me"));
    expect(calls("term_input")).toEqual([]);
    el.remove();
  });
});
