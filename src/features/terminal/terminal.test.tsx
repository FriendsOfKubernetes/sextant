import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api, mockBackend, type KindRef, type KubeObject, type MockBackend } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { Dock } from "../../layout/dock/Dock";
import { ActionDialogHost } from "../../layout/main/ActionDialogHost";
import { cssRule } from "../../test/css";
import { getAction, getActionsFor, runAction } from "../actions/registry";
import { useClustersStore } from "../clusters/clustersStore";
import { CloudProblemView } from "../clusters/CloudClusters";
import "./index";
import { ACK_BYTES, useTerminal } from "./useTerminal";

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

/** Output as the backend sends it: raw bytes (an `ArrayBuffer`). */
const out = (text: string) => new TextEncoder().encode(text).buffer;

let backend: MockBackend;
let sessions: number;
/** Number of `term:<id>` listeners (the session's channel in the mock) when each `*_start` and `term_resize` came. */
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
    node_shell_start: start,
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
  return backend.calls
    .filter((c) => c.cmd === "exec_start" || c.cmd === "terminal_start" || c.cmd === "node_shell_start")
    .map((c) => c.args.streamId);
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
    // The backend sends output as soon as the shell prints it: the frontend's channel exists before the start.
    expect(listenersAtStart).toEqual([1]);
    expect(listenersAtResize).toEqual([1]);
    expect(calls("term_resize")[0]).toMatchObject({ sessionId: start?.streamId });

    act(() => backend.emit("term:term-1", out("root@web:/# ")));
    await waitFor(() => expect(screenText()).toContain("root@web:/#"));
  });

  it("shows the prompt the shell prints before exec_start answers", async () => {
    backend.on("exec_start", (args) => {
      backend.emit(`term:${args.streamId as string}`, out("early$ "));
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

  it("shows the leave key over the screen's corner while the focus is in a running terminal", async () => {
    render(<App />);
    await runShell(pod("web", ["nginx"]));
    const hint = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(".terminal__leave-hint");
      if (!found) throw new Error("no hint yet");
      return found;
    });
    expect(hint).toHaveTextContent("Ctrl+Shift+E — leave the terminal");
    // Screen readers have it as the input's description already; the visible one is laid over, so it moves nothing.
    expect(hint).toHaveAttribute("aria-hidden", "true");
    expect(cssRule("src/features/terminal/terminal.css", ".terminal__leave-hint")).toMatchObject({
      position: "absolute",
      visibility: "hidden",
      "pointer-events": "none",
    });
    expect(cssRule("src/features/terminal/terminal.css", ".terminal__body:focus-within .terminal__leave-hint")).toEqual({
      visibility: "visible",
    });

    act(() => backend.emit("term:term-1", { type: "exit", code: 0 }));
    await waitFor(() => expect(document.querySelector(".terminal__leave-hint")).toBeNull());
  });

  it("keeps the screen's gap out of the height the fit measures, so the last row is not cut off", () => {
    // The fit reads the computed height of the screen element; with border-box that height includes its padding.
    const rule = cssRule("src/features/terminal/terminal.css", ".terminal__screen");
    expect(rule.padding).toBeUndefined();
    expect(rule.margin).toBe("4px 0 0 6px");
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

const NODE: KindRef = { group: "", version: "v1", kind: "Node" };

function node(name: string): KubeObject {
  return { apiVersion: "v1", kind: "Node", metadata: { name, uid: `uid-${name}` }, spec: {}, status: {} };
}

describe("Shell on a node", () => {
  it("is offered for nodes", () => {
    expect(getActionsFor([node("worker-1")], NODE, ["exec"]).map((a) => a.id)).toEqual(["exec"]);
  });

  it("asks first and creates nothing when cancelled", async () => {
    render(<App />);
    const action = getAction("exec")!;
    await act(() => runAction(action, "c1", NODE, [node("worker-1")]));
    const dialog = await screen.findByRole("dialog", { name: "Open a shell on node worker-1?" });
    expect(dialog).toHaveTextContent(
      "Sextant will create a privileged pod on node worker-1 in kube-system. It is deleted when you close the shell.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls("node_shell_start")).toEqual([]);
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("after Open runs the node's shell in a dock tab named after the node, and closing the tab stops it", async () => {
    render(<App />);
    const action = getAction("exec")!;
    await act(() => runAction(action, "c1", NODE, [node("worker-1")]));
    const dialog = await screen.findByRole("dialog", { name: "Open a shell on node worker-1?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Open" }));

    expect(await screen.findByRole("tab", { name: "Node: worker-1" })).toBeInTheDocument();
    await waitFor(() => expect(calls("term_resize")).toHaveLength(1));
    expect(calls("node_shell_start")[0]).toMatchObject({ clusterId: "c1", node: "worker-1" });
    expect(listenersAtStart).toEqual([1]);

    fireEvent.click(screen.getByRole("button", { name: /Close.*Node: worker-1/ }));
    await waitFor(() => expect(calls("term_stop")).toEqual([{ sessionId: sessionIds()[0] }]));
  });

  it("says why the pod could not start", async () => {
    backend.on("node_shell_start", () => {
      throw { code: "forbidden", message: "You need permission to create privileged pods in kube-system" };
    });
    render(<App />);
    const action = getAction("exec")!;
    await act(() => runAction(action, "c1", NODE, [node("worker-1")]));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Open a shell on node worker-1?" })).getByRole("button", {
        name: "Open",
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "You need permission to create privileged pods in kube-system",
    );
  });
});

describe("Reconnect in a node shell tab", () => {
  it("asks again before it makes a new privileged pod", async () => {
    let starts = 0;
    backend.on("node_shell_start", () => {
      starts++;
      throw { code: "timeout", message: "The node shell pod did not start" };
    });
    render(<App />);
    await act(() => runAction(getAction("exec")!, "c1", NODE, [node("worker-1")]));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Open a shell on node worker-1?" })).getByRole("button", {
        name: "Open",
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
    const again = await screen.findByRole("dialog", { name: "Open a shell on node worker-1?" });
    expect(again).toHaveTextContent("Sextant will create a privileged pod on node worker-1 in kube-system.");
    fireEvent.click(within(again).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(starts).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Open a shell on node worker-1?" })).getByRole("button", {
        name: "Open",
      }),
    );
    await waitFor(() => expect(starts).toBe(2));
  });

  it("a container shell reconnects without asking", async () => {
    render(<App />);
    await runShell(pod("web", ["nginx"]));
    await waitFor(() => expect(calls("term_resize")).toHaveLength(1));
    act(() => backend.emit(`term:${sessionIds()[0] as string}`, { type: "exit", code: 0 }));
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(calls("exec_start")).toHaveLength(2));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("Open terminal with a sign-in command", () => {
  const COMMAND = "aws sso login --profile dev";

  it("opens a terminal without a cluster and types the command without running it", async () => {
    render(
      <>
        <CloudProblemView
          problem={{ provider: "aws", kind: "notLoggedIn", scope: "dev", message: "", command: COMMAND, url: null }}
        />
        <App />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open terminal" }));

    expect(await screen.findByRole("tab", { name: "Terminal" })).toBeInTheDocument();
    await waitFor(() => expect(calls("term_resize")).toHaveLength(1));
    expect(calls("terminal_start")[0]).toMatchObject({ clusterId: null });
    // Typed once the shell printed its prompt; never with Enter.
    act(() => backend.emit(`term:${sessionIds()[0] as string}`, out("$ ")));
    await waitFor(() => expect(calls("term_input")).toEqual([{ sessionId: sessionIds()[0], data: COMMAND }]), {
      timeout: 3000,
    });
    // Without a cluster there is no KUBECONFIG to warn about.
    expect(screen.queryByRole("note", { name: /KUBECONFIG/ })).not.toBeInTheDocument();
  });
});

describe("a command typed into a terminal", () => {
  it("loses every control character: no Enter, no escape sequences", async () => {
    const { openCommandTerminalTab } = await import("./tabs");
    render(<App />);
    act(() => {
      openCommandTerminalTab("aws sso login\r\n--profile dev\x1b[201~\x03\x7f\x00x\u009b\t");
    });
    await waitFor(() => expect(calls("term_resize")).toHaveLength(1));
    act(() => backend.emit(`term:${sessionIds()[0] as string}`, out("$ ")));
    await waitFor(() => expect(calls("term_input")).toHaveLength(1), { timeout: 3000 });
    const typed = calls("term_input")[0]!.data as string;
    expect(typed).toBe("aws sso login --profile dev [201~ x");
    expect([...typed].every((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)).toBe(true);
  });
});

describe("Terminal button", () => {
  it("is drawn with an icon of the set, like the other dock buttons", () => {
    useClustersStore.setState({ clusters: [] });
    act(() => useAppStore.getState().setActiveCluster("c1"));
    render(<App />);
    const button = screen.getByRole("button", { name: "Terminal" });
    expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(button.textContent).toBe("");
  });

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
    act(() => backend.emit("term:term-1", out("$ kubectl get pods")));
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
    act(() => backend.emit("term:term-1", out(`${NOTICE}$ `)));
    await waitFor(() => expect(screenText()).toContain("$"));
    const note = await screen.findByRole("note");
    expect(note).toHaveTextContent(/profile may override KUBECONFIG/);
    expect(screenText()).not.toContain("kubeconfig-not-pinned");
  });

  it("is not shown for a shell that keeps the session's KUBECONFIG", async () => {
    await openLocalTerminal();
    act(() => backend.emit("term:term-1", out("$ ")));
    await waitFor(() => expect(screenText()).toContain("$"));
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("is not shown in a container shell", async () => {
    render(<App />);
    await runShell(pod("web", ["nginx"]));
    await waitFor(() => expect(calls("term_resize")).toHaveLength(1));
    act(() => backend.emit("term:term-1", out(`${NOTICE}# `)));
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

  it("acknowledges the output once xterm has written it, in batches, under the session's id", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    let streamId = "";
    const { result, unmount } = renderHook(() => {
      const ref = useRef<HTMLElement | null>(el);
      return useTerminal(ref, (cols, rows, id, onEvent) => {
        streamId = id;
        return api.terminal.local(null, cols, rows, id, onEvent);
      });
    });
    await waitFor(() => expect(calls("term_resize")).toHaveLength(1));
    const term = result.current.terminal;
    if (!term) throw new Error("no terminal");
    const written = () => new Promise<void>((resolve) => term.write("", resolve));

    // A little output is acknowledged a moment after it is written.
    act(() => backend.emit(`term:${streamId}`, out("hello")));
    await written();
    await waitFor(() => expect(calls("term_ack")).toEqual([{ sessionId: streamId, bytes: 5 }]));

    // A lot of it at once, as soon as it is written: every byte, counted once.
    const big = "y\n".repeat(ACK_BYTES);
    act(() => backend.emit(`term:${streamId}`, out(big)));
    act(() => backend.emit(`term:${streamId}`, out("!")));
    await written();
    await waitFor(() => {
      const acked = calls("term_ack").reduce((sum, c) => sum + (c.bytes as number), 0);
      expect(acked).toBe(5 + big.length + 1);
    });
    expect(calls("term_ack")[1]).toEqual({ sessionId: streamId, bytes: big.length });

    // Output written after the tab is closed is not acknowledged.
    const before = calls("term_ack").length;
    act(() => backend.emit(`term:${streamId}`, out("late")));
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls("term_ack")).toHaveLength(before);
    el.remove();
  });

  it("keeps what is typed before the start answers and sends it first, in order", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    let answer: () => void = () => undefined;
    // The shell prints its prompt before the start answers (#107).
    backend.on("terminal_start", (args) => {
      backend.emit(`term:${args.streamId as string}`, out("$ "));
      return new Promise((resolve) => {
        answer = () => resolve(undefined);
      });
    });
    const { result } = renderHook(() => {
      const ref = useRef<HTMLElement | null>(el);
      return useTerminal(ref, (cols, rows, id, onEvent) => api.terminal.local(null, cols, rows, id, onEvent));
    });
    await waitFor(() => expect(screenText()).toContain("$"));
    const term = result.current.terminal;
    if (!term) throw new Error("no terminal");
    term.input("e");
    term.input("cho hi");
    expect(calls("term_input")).toEqual([]);

    await act(async () => answer());
    await waitFor(() => expect(calls("term_resize")).toHaveLength(1));
    term.input("\r");
    await waitFor(() => expect(calls("term_input")).toHaveLength(2));
    const sent = calls("term_input");
    expect(sent.map((c) => c.data).join("")).toBe("echo hi\r");
    expect(new Set(sent.map((c) => c.sessionId)).size).toBe(1);
    const order = backend.calls.map((c) => c.cmd).filter((cmd) => cmd === "term_input" || cmd === "term_resize");
    expect(order[0]).toBe("term_input");
    el.remove();
  });
});
