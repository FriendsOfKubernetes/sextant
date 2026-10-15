import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBackend, type KindRef, type KubeObject, type MockBackend } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { getAction, runAction } from "../actions/registry";
import { ActionDialogHost } from "../../layout/main/ActionDialogHost";
import { getDockTabComponent } from "../../layout/dock/registry";
import "./index";
import { LOG_BUFFER_LIMIT } from "./buffer";
import { LogsTab, type LogsPayload } from "./LogsTab";

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const DEPLOYMENT: KindRef = { group: "apps", version: "v1", kind: "Deployment" };
const CONFIG_MAP: KindRef = { group: "", version: "v1", kind: "ConfigMap" };

const payload: LogsPayload = {
  clusterId: "c1",
  pod: { kind: POD, namespace: "demo", name: "web-1" },
  containers: [
    { name: "setup", init: true },
    { name: "app", init: false },
    { name: "sidecar", init: false },
  ],
};

let backend: MockBackend;
let streams = 0;

beforeEach(() => {
  resetAppStore();
  streams = 0;
  backend = mockBackend({
    logs_start: () => `s${++streams}`,
    logs_stop: () => undefined,
    file_save: () => undefined,
  });
  // jsdom has no layout: the log viewport is 400 px high (20 lines of 20 px).
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("logs__scroll") ? 400 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("logs__scroll") ? 800 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("logs__scroll") ? 400 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    const body = this.querySelector<HTMLElement>(".logs__body");
    return body ? Number.parseInt(body.style.height || "0", 10) : 0;
  });
  // ... and no element.scrollTo: do what the browser does, so the virtual list reacts to scrollToIndex.
  HTMLElement.prototype.scrollTo = function (this: HTMLElement, options?: ScrollToOptions | number) {
    this.scrollTop = typeof options === "object" ? (options.top ?? 0) : 0;
    fireEvent.scroll(this);
  } as typeof HTMLElement.prototype.scrollTo;
});
afterEach(() => {
  backend.restore();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

const calls = (cmd: string) => backend.calls.filter((c) => c.cmd === cmd).map((c) => c.args);
/** The ids the tab chose for its streams, in start order. */
const streamIds = () => calls("logs_start").map((args) => args.streamId);

function renderTab(overrides: Partial<LogsPayload> = {}) {
  const tab = { id: "logs-1", type: "logs" as const, title: "web-1", payload: { ...payload, ...overrides } };
  return render(<LogsTab tab={tab} active />);
}

/** Renders the tab and waits until its first stream is listened to. */
async function opened(overrides: Partial<LogsPayload> = {}) {
  const view = renderTab(overrides);
  await waitFor(() => expect(backend.listenerCount("logs:s1")).toBe(1));
  return view;
}

const emitLines = (lines: string[], stream = "s1") => act(() => backend.emit(`logs:${stream}`, { type: "lines", lines }));
const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`);

describe("log stream", () => {
  it("starts with the first regular container, follow on and a tail of 1000 lines, and shows lines as they arrive", async () => {
    await opened();
    expect(calls("logs_start")).toEqual([
      {
        clusterId: "c1",
        pod: payload.pod,
        opts: { container: "app", follow: true, previous: false, timestamps: false, tailLines: 1000 },
        streamId: expect.any(String),
      },
    ]);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Live"));
    emitLines(["hello", "world"]);
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByText("world")).toBeInTheDocument();
    expect(screen.getByTestId("logs-count")).toHaveTextContent("2 lines");
    emitLines(["again"]);
    expect(screen.getByText("again")).toBeInTheDocument();
    expect(screen.getByTestId("logs-count")).toHaveTextContent("3 lines");
  });

  it("honours the container named in the payload", async () => {
    await opened({ container: "sidecar" });
    expect(calls("logs_start")[0]?.opts).toMatchObject({ container: "sidecar" });
  });

  it("restarts the stream when the container, follow, timestamps or previous change, clearing the text", async () => {
    await opened();
    emitLines(["from app"]);

    fireEvent.change(screen.getByRole("combobox", { name: "Container" }), { target: { value: "setup" } });
    await waitFor(() => expect(backend.listenerCount("logs:s2")).toBe(1));
    expect(calls("logs_stop")).toEqual([{ streamId: streamIds()[0] }]);
    expect(calls("logs_start")[1]?.opts).toMatchObject({ container: "setup" });
    expect(screen.queryByText("from app")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Timestamps" }));
    await waitFor(() => expect(backend.listenerCount("logs:s3")).toBe(1));
    expect(calls("logs_start")[2]?.opts).toMatchObject({ container: "setup", timestamps: true });

    fireEvent.click(screen.getByRole("checkbox", { name: "Previous container" }));
    await waitFor(() => expect(backend.listenerCount("logs:s4")).toBe(1));
    expect(calls("logs_start")[3]?.opts).toMatchObject({ previous: true, timestamps: true });

    fireEvent.click(screen.getByRole("checkbox", { name: "Follow" }));
    await waitFor(() => expect(backend.listenerCount("logs:s5")).toBe(1));
    expect(calls("logs_start")[4]?.opts).toMatchObject({ follow: false, previous: true });
    expect(backend.listenerCount("logs:s1")).toBe(0);
  });

  it("closing the tab stops the stream", async () => {
    const { unmount } = await opened();
    unmount();
    await waitFor(() => expect(calls("logs_stop")).toEqual([{ streamId: streamIds()[0] }]));
    expect(backend.listenerCount("logs:s1")).toBe(0);
  });

  it("a stream that is stopped before the start answered is stopped when it does", async () => {
    let answer: (id: string) => void = () => undefined;
    backend.on("logs_start", () => new Promise((resolve) => (answer = resolve as (id: string) => void)));
    const { unmount } = renderTab();
    await waitFor(() => expect(calls("logs_start")).toHaveLength(1));
    unmount();
    expect(calls("logs_stop")).toEqual([]);
    answer("late");
    await waitFor(() => expect(calls("logs_stop")).toEqual([{ streamId: streamIds()[0] }]));
    expect(backend.listenerCount("logs:late")).toBe(0);
  });
});

describe("first output", () => {
  it("lines the backend sends before logs_start answers are shown", async () => {
    backend.on("logs_start", (args) => {
      // The backend streams the tail at once; its answer reaches the window later.
      backend.emit(`logs:${args.streamId as string}`, { type: "lines", lines: ["first line"] });
      return undefined;
    });
    renderTab();
    expect(await screen.findByText("first line")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Live"));
  });
});

describe("end of the stream", () => {
  it("shows 'Stream ended' with a Reconnect button that starts a fresh stream", async () => {
    await opened();
    emitLines(["last words"]);
    act(() => backend.emit("logs:s1", { type: "ended" }));
    expect(screen.getByRole("status")).toHaveTextContent("Stream ended");
    expect(screen.getByText("last words")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(backend.listenerCount("logs:s2")).toBe(1));
    expect(calls("logs_start")).toHaveLength(2);
    expect(screen.getByRole("status")).toHaveTextContent("Live");
    expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
  });

  it("a deleted pod: reconnecting fails with the error and offers Reconnect again", async () => {
    await opened();
    act(() => backend.emit("logs:s1", { type: "ended" }));
    backend.on("logs_start", () => {
      throw { code: "notFound", message: 'pods "web-1" not found' };
    });
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Not found.");
    expect(alert).toHaveTextContent('pods "web-1" not found');
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });

  it("an error update from the stream is shown", async () => {
    await opened();
    act(() => backend.emit("logs:s1", { type: "error", code: "unreachable", message: "connection reset" }));
    expect(screen.getByRole("alert")).toHaveTextContent("connection reset");
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });
});

describe("buffer limit", () => {
  it("keeps the newest 100 000 of 150 000 lines and says how many were discarded", async () => {
    await opened();
    emitLines(numbered(150_000));
    expect(screen.getByTestId("logs-count")).toHaveTextContent("100000 lines");
    expect(screen.getByTestId("logs-dropped")).toHaveTextContent(
      `50000 older lines discarded (the newest ${LOG_BUFFER_LIMIT} lines, up to 32 MiB of text, are kept)`,
    );
    // Following: the view sits at the end, so the newest line is rendered and the oldest are gone.
    expect(screen.getByText("line 149999")).toBeInTheDocument();
    expect(screen.queryByText("line 0")).not.toBeInTheDocument();
    expect(screen.queryByText("line 49999")).not.toBeInTheDocument();
  });

  it("marks a line the backend cut at its cap", async () => {
    await opened();
    act(() => backend.emit("logs:s1", { type: "lines", lines: ["head of a long line", "its rest"], cut: [0] }));
    expect(screen.getByText("head of a long line … [line cut at 64 KiB, continued on the next line]")).toBeInTheDocument();
    expect(screen.getByText("its rest")).toBeInTheDocument();
  });

  it("shows no marker while nothing was discarded", async () => {
    await opened();
    emitLines(numbered(10));
    expect(screen.queryByTestId("logs-dropped")).not.toBeInTheDocument();
  });
});

describe("search", () => {
  it("highlights every match and steps through them", async () => {
    await opened();
    emitLines(["alpha", "Error one", "beta", "error two and ERROR three"]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search logs" }), { target: { value: "error" } });

    const marks = () => Array.from(document.querySelectorAll("mark"));
    expect(marks().map((m) => m.textContent)).toEqual(["Error", "error", "ERROR"]);
    expect(screen.getByTestId("logs-match-count")).toHaveTextContent("1 of 3");
    const current = () => marks().filter((m) => m.classList.contains("logs__mark--current"));
    expect(current().map((m) => m.textContent)).toEqual(["Error"]);

    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(screen.getByTestId("logs-match-count")).toHaveTextContent("2 of 3");
    expect(current().map((m) => m.textContent)).toEqual(["error"]);
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(screen.getByTestId("logs-match-count")).toHaveTextContent("1 of 3");
    fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
    expect(screen.getByTestId("logs-match-count")).toHaveTextContent("3 of 3");
    expect(current().map((m) => m.textContent)).toEqual(["ERROR"]);
  });

  it("Enter and Shift+Enter in the search box step through the matches", async () => {
    await opened();
    emitLines(["x1", "x2"]);
    const box = screen.getByRole("searchbox", { name: "Search logs" });
    fireEvent.change(box, { target: { value: "x" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByTestId("logs-match-count")).toHaveTextContent("2 of 2");
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(screen.getByTestId("logs-match-count")).toHaveTextContent("1 of 2");
  });

  it("scrolls to a match that is far outside the rendered window", async () => {
    await opened();
    const lines = numbered(5000);
    lines[2500] = "the needle";
    // Following would keep the view at the end: stop following, as a reader looking for something does.
    fireEvent.click(screen.getByRole("checkbox", { name: "Follow" }));
    await waitFor(() => expect(backend.listenerCount("logs:s2")).toBe(1));
    emitLines(lines, "s2");
    expect(screen.queryByText("the needle")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search logs" }), { target: { value: "needle" } });
    expect(await screen.findByText("needle")).toBeInTheDocument();
    expect(screen.queryByText("line 0")).not.toBeInTheDocument();
  });

  it("says when nothing matches", async () => {
    await opened();
    emitLines(["alpha"]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search logs" }), { target: { value: "zzz" } });
    expect(screen.getByTestId("logs-match-count")).toHaveTextContent("No matches");
    expect(document.querySelectorAll("mark")).toHaveLength(0);
  });
});

describe("wrap and save", () => {
  it("wrap lines toggles the wrapping of long lines", async () => {
    await opened();
    emitLines(["a very long line"]);
    const view = screen.getByRole("log");
    expect(view).not.toHaveClass("logs__scroll--wrap");
    fireEvent.click(screen.getByRole("checkbox", { name: "Wrap lines" }));
    expect(view).toHaveClass("logs__scroll--wrap");
    fireEvent.click(screen.getByRole("checkbox", { name: "Wrap lines" }));
    expect(view).not.toHaveClass("logs__scroll--wrap");
  });

  it("Save writes the lines in the buffer to the file chosen in the system dialog", async () => {
    backend.restore();
    const picked: unknown[] = [];
    backend = mockBackend(
      { logs_start: () => `s${++streams}`, logs_stop: () => undefined, file_save: () => undefined },
      {
        saveFile: (options) => {
          picked.push(options);
          return "/home/me/web-1-app.log";
        },
      },
    );
    await opened();
    emitLines(["one", "two"]);
    emitLines(["three"]);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls("file_save")).toHaveLength(1));
    expect(calls("file_save")[0]).toEqual({ path: "/home/me/web-1-app.log", contents: "one\ntwo\nthree\n" });
    expect(picked[0]).toMatchObject({ defaultPath: "web-1-app.log" });
  });

  it("cancelling the dialog saves nothing; a failing save shows an error", async () => {
    await opened();
    emitLines(["one"]);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => undefined);
    expect(calls("file_save")).toHaveLength(0);

    backend.restore();
    backend = mockBackend(
      {
        logs_start: () => `s${++streams}`,
        logs_stop: () => undefined,
        file_save: () => {
          throw { code: "forbidden", message: "cannot write /root/x.log: permission denied" };
        },
      },
      { saveFile: () => "/root/x.log" },
    );
    streams = 0;
    document.body.innerHTML = "";
    await opened();
    emitLines(["one"]);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The logs could not be saved.");
    expect(alert).toHaveTextContent("permission denied");
  });
});

describe("the Logs action", () => {
  const pod: KubeObject = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: "web-1", namespace: "demo", uid: "p1", annotations: { "kubectl.kubernetes.io/default-container": "sidecar" } },
    spec: { initContainers: [{ name: "setup" }], containers: [{ name: "app" }, { name: "sidecar" }] },
  };
  const deployment: KubeObject = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "web", namespace: "demo", uid: "d1" },
    spec: { selector: { matchLabels: { app: "web" } } },
  };

  it("is registered and offered for pods and pod-owning workloads only", () => {
    const action = getAction("logs");
    expect(action?.labelKey).toBe("logs:action.label");
    const applies = (kind: KindRef, obj: KubeObject) => action!.appliesTo(obj, kind);
    expect(applies(POD, pod)).toBe(true);
    expect(applies(DEPLOYMENT, deployment)).toBe(true);
    expect(applies({ group: "apps", version: "v1", kind: "StatefulSet" }, deployment)).toBe(true);
    expect(applies({ group: "apps", version: "v1", kind: "DaemonSet" }, deployment)).toBe(true);
    expect(applies({ group: "batch", version: "v1", kind: "Job" }, deployment)).toBe(true);
    expect(applies(CONFIG_MAP, pod)).toBe(false);
    expect(applies(DEPLOYMENT, { ...deployment, spec: {} })).toBe(false);
  });

  it("on a pod opens a logs tab in the dock, with the containers and the default one", async () => {
    await act(async () => {
      await runAction(getAction("logs")!, "c1", POD, [pod]);
    });
    const { dock } = useAppStore.getState();
    expect(dock.open).toBe(true);
    expect(dock.tabs).toHaveLength(1);
    expect(dock.tabs[0]).toMatchObject({ type: "logs", title: "web-1" });
    expect(dock.tabs[0]?.payload).toEqual({
      clusterId: "c1",
      pod: { kind: POD, namespace: "demo", name: "web-1" },
      containers: [
        { name: "setup", init: true },
        { name: "app", init: false },
        { name: "sidecar", init: false },
      ],
      container: "sidecar",
    });
    expect(getDockTabComponent("logs")).toBe(LogsTab);

    // Running it again re-activates the same tab.
    await act(async () => {
      await runAction(getAction("logs")!, "c1", POD, [pod]);
    });
    expect(useAppStore.getState().dock.tabs).toHaveLength(1);
  });

  it("on a deployment lets the user pick one of its pods", async () => {
    backend.on("watch_start", () => "w1");
    backend.on("watch_stop", () => undefined);
    render(<ActionDialogHost />);
    await act(async () => {
      await runAction(getAction("logs")!, "c1", DEPLOYMENT, [deployment]);
    });
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(backend.listenerCount("watch:w1")).toBe(1));
    expect(calls("watch_start")[0]).toMatchObject({
      clusterId: "c1",
      spec: { kind: POD, namespaces: ["demo"], labelSelector: "app=web" },
    });
    const podOf = (name: string, phase: string): KubeObject => ({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name, namespace: "demo", uid: name },
      spec: { containers: [{ name: "app" }] },
      status: { phase },
    });
    act(() => backend.emit("watch:w1", { type: "snapshot", items: [podOf("web-b", "Running"), podOf("web-a", "Pending")] }));
    const buttons = within(dialog).getAllByRole("button", { name: /^web-/ });
    expect(buttons.map((b) => b.textContent)).toEqual(["web-aPending", "web-bRunning"]);
    fireEvent.click(buttons[1]!);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const tab = useAppStore.getState().dock.tabs[0];
    expect(tab).toMatchObject({ type: "logs", title: "web-b" });
    expect((tab?.payload as LogsPayload).pod).toEqual({ kind: POD, namespace: "demo", name: "web-b" });
  });
});
