import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBackend, type KindRef, type KubeObject, type MockBackend } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { getActionsFor, getAction, runAction } from "../actions/registry";
import { ActionDialogHost } from "../../layout/main/ActionDialogHost";
import { getResourceDef } from "../../resources/registry";
import "../../resources";
import "./index";
import { LogsTab } from "./LogsTab";
import {
  colourOf,
  MAX_STREAMS,
  PALETTE_SIZE,
  parseJsonLine,
  passesLevel,
  splitMatches,
  targetsOf,
  textFilter,
} from "./multi/model";
import type { MultiLogsPayload } from "./multi/open";
import { FLUSH_INTERVAL } from "./multi/session";

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const DEPLOYMENT: KindRef = { group: "apps", version: "v1", kind: "Deployment" };
const REPLICA_SET: KindRef = { group: "apps", version: "v1", kind: "ReplicaSet" };
const SERVICE: KindRef = { group: "", version: "v1", kind: "Service" };

let backend: MockBackend;

/** A running pod `name` with `containers` (all started). */
function podOf(name: string, containers: string[] = ["app"], extra: { restarts?: number; id?: string } = {}): KubeObject {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, namespace: "demo", uid: `uid-${name}`, labels: { app: "web" } },
    spec: { containers: containers.map((c) => ({ name: c })) },
    status: {
      phase: "Running",
      containerStatuses: containers.map((c) => ({
        name: c,
        containerID: `containerd://${name}-${c}-${extra.id ?? "1"}`,
        restartCount: extra.restarts ?? 0,
        state: { running: {} },
        ...(extra.restarts ? { lastState: { terminated: { containerID: `containerd://${name}-${c}-old` } } } : {}),
      })),
    },
  };
}

function pendingPod(name: string): KubeObject {
  return {
    ...podOf(name),
    status: { phase: "Pending", containerStatuses: [{ name: "app", restartCount: 0, state: { waiting: { reason: "ContainerCreating" } } }] },
  };
}

beforeEach(() => {
  resetAppStore();
  backend = mockBackend({
    // The stream is named after its pod and container, so a test can emit to it.
    logs_start: (args) => {
      const { pod, opts } = args as { pod: { name: string }; opts: { container: string } };
      return `${pod.name}/${opts.container}`;
    },
    logs_stop: () => undefined,
    watch_start: () => "pods",
    watch_stop: () => undefined,
    file_save: () => undefined,
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("logs__scroll") ? 4000 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("logs__scroll") ? 800 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("logs__scroll") ? 4000 : 0;
  });
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
const started = () => calls("logs_start").map((a) => `${(a.pod as { name: string }).name}/${(a.opts as { container: string }).container}`);

const selectorPayload: MultiLogsPayload = { multi: true, clusterId: "c1", selector: { namespace: "demo", labelSelector: "app=web" } };

async function openTab(payload: MultiLogsPayload = selectorPayload) {
  const tab = { id: "logs-m", type: "logs" as const, title: "deployment/web", payload };
  const view = render(<LogsTab tab={tab} active />);
  await waitFor(() => expect(backend.listenerCount("watch:pods")).toBe(1));
  return view;
}

const snapshot = (pods: KubeObject[]) => act(() => backend.emit("watch:pods", { type: "snapshot", items: pods }));
const delta = (upserted: KubeObject[], deleted: string[] = []) =>
  act(() => backend.emit("watch:pods", { type: "delta", upserted, deleted }));
/** Emits lines on a stream and lets the tab flush them (it does so every `FLUSH_INTERVAL` ms). */
const emit = async (stream: string, lines: string[]) => {
  act(() => backend.emit(`logs:${stream}`, { type: "lines", lines }));
  await act(() => new Promise((r) => setTimeout(r, FLUSH_INTERVAL + 10)));
};
const listening = (stream: string) => waitFor(() => expect(backend.listenerCount(`logs:${stream}`)).toBe(1));
const shownLines = () => [...screen.getByRole("log").querySelectorAll(".logs__line")].map((l) => l.textContent);
const openSources = () => fireEvent.click(screen.getByRole("button", { name: /^Pods and containers/ }));

describe("merged logs of several pods", () => {
  it("watches the selector's pods and merges their lines, each prefixed with its pod and container", async () => {
    await openTab();
    expect(calls("watch_start")[0]).toMatchObject({
      clusterId: "c1",
      spec: { kind: POD, namespaces: ["demo"], labelSelector: "app=web" },
    });
    snapshot([podOf("web-a"), podOf("web-b")]);
    await listening("web-a/app");
    await listening("web-b/app");
    expect(calls("logs_start")[0]).toMatchObject({
      clusterId: "c1",
      pod: { kind: POD, namespace: "demo", name: "web-a" },
      opts: { container: "app", follow: true, previous: false, timestamps: false, tailLines: 200 },
    });
    await emit("web-a/app", ["hello from a"]);
    await emit("web-b/app", ["hello from b"]);
    await emit("web-a/app", ["again a"]);
    await waitFor(() => expect(shownLines()).toEqual(["web-a app hello from a", "web-b app hello from b", "web-a app again a"]));
    // The prefix carries the pod's colour.
    const prefixes = [...screen.getByRole("log").querySelectorAll(".logs__prefix")];
    expect(prefixes[0]).toHaveClass(`logs__src--${colourOf("web-a")}`);
    expect(prefixes[1]).toHaveClass(`logs__src--${colourOf("web-b")}`);
    expect(screen.getByRole("status")).toHaveTextContent("Live");
  });

  it("follows a pod created during a rollout and ends the stream of a deleted one, keeping its lines", async () => {
    await openTab();
    snapshot([podOf("web-old")]);
    await listening("web-old/app");
    await emit("web-old/app", ["old line"]);

    // A new pod that has not started yet is not read; once its container runs, it is.
    delta([pendingPod("web-new")]);
    expect(started()).toEqual(["web-old/app"]);
    delta([podOf("web-new")]);
    await listening("web-new/app");
    await emit("web-new/app", ["new line"]);

    delta([], ["uid-web-old"]);
    await waitFor(() => expect(calls("logs_stop")).toHaveLength(1));
    expect(backend.listenerCount("logs:web-old/app")).toBe(0);
    await waitFor(() => expect(shownLines()).toEqual(["web-old app old line", "web-new app new line"]));
    openSources();
    expect(screen.getByTestId("source-status-demo/web-old/app")).toHaveTextContent("pod gone");
    expect(screen.getByTestId("source-status-demo/web-new/app")).toHaveTextContent("live");
  });

  it("restarts a container's stream when the container restarts", async () => {
    await openTab();
    snapshot([podOf("web-a")]);
    await listening("web-a/app");
    act(() => backend.emit("logs:web-a/app", { type: "ended" }));
    await waitFor(() => expect(backend.listenerCount("logs:web-a/app")).toBe(0));
    delta([podOf("web-a", ["app"], { restarts: 1, id: "2" })]);
    await waitFor(() => expect(started()).toEqual(["web-a/app", "web-a/app"]));
  });

  it(`runs at most ${MAX_STREAMS} streams at once and says so; a freed slot goes to a waiting container`, async () => {
    await openTab();
    const pods = Array.from({ length: 25 }, (_, i) => podOf(`web-${String(i).padStart(2, "0")}`));
    snapshot(pods);
    await waitFor(() => expect(calls("logs_start")).toHaveLength(MAX_STREAMS));
    expect(screen.getByTestId("logs-cap")).toHaveTextContent("5 more containers wait: at most 20 log streams run at once");
    expect(started()).not.toContain("web-24/app");

    await listening("web-00/app");
    act(() => backend.emit("logs:web-00/app", { type: "ended" }));
    await waitFor(() => expect(calls("logs_start")).toHaveLength(MAX_STREAMS + 1));
    expect(screen.getByTestId("logs-cap")).toHaveTextContent("4 more containers wait");

    // Unticking containers frees their slots for the waiting ones.
    openSources();
    for (const n of ["01", "02", "03", "04"]) fireEvent.click(screen.getByRole("checkbox", { name: `web-${n} app` }));
    await waitFor(() => expect(calls("logs_start")).toHaveLength(MAX_STREAMS + 5));
    expect(screen.queryByTestId("logs-cap")).not.toBeInTheDocument();
    expect(started()).toContain("web-24/app");
  });

  it("filters by pod and container, by text and by regular expression", async () => {
    await openTab();
    snapshot([podOf("web-a", ["app", "proxy"]), podOf("web-b")]);
    await listening("web-a/app");
    await listening("web-a/proxy");
    await listening("web-b/app");
    await emit("web-a/app", ["GET /health 200", "GET /orders 500"]);
    await emit("web-a/proxy", ["proxy up"]);
    await emit("web-b/app", ["GET /orders 200"]);
    await waitFor(() => expect(shownLines()).toHaveLength(4));

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter" }), { target: { value: "orders" } });
    expect(shownLines()).toEqual(["web-a app GET /orders 500", "web-b app GET /orders 200"]);
    expect(screen.getAllByText("orders", { selector: "mark" })).toHaveLength(2);

    fireEvent.click(screen.getByRole("checkbox", { name: "Regex" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter" }), { target: { value: "\\s5\\d\\d$" } });
    expect(shownLines()).toEqual(["web-a app GET /orders 500"]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter" }), { target: { value: "(" } });
    expect(screen.getByRole("searchbox", { name: "Filter" })).toHaveAttribute("aria-invalid", "true");
    expect(shownLines()).toHaveLength(4);
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter" }), { target: { value: "" } });

    openSources();
    fireEvent.click(screen.getByRole("checkbox", { name: "web-a proxy" }));
    expect(shownLines()).toEqual(["web-a app GET /health 200", "web-a app GET /orders 500", "web-b app GET /orders 200"]);
    await waitFor(() => expect(backend.listenerCount("logs:web-a/proxy")).toBe(0));
  });

  it("parses JSON lines, filters them by level and highlights the level", async () => {
    await openTab();
    snapshot([podOf("api")]);
    await listening("api/app");
    await emit("api/app", [
      '{"level":"info","msg":"started","port":8080}',
      '{"level":"debug","msg":"tick"}',
      '{"severity":"WARNING","message":"slow"}',
      '{"level":50,"msg":"boom"}',
      "plain text",
    ]);
    await waitFor(() => expect(shownLines()).toHaveLength(5));
    fireEvent.click(screen.getByRole("checkbox", { name: "Parse JSON" }));
    expect(shownLines()[0]).toBe("api app INFO started port=8080");
    fireEvent.change(screen.getByRole("combobox", { name: "Level" }), { target: { value: "warn" } });
    expect(shownLines()).toEqual(["api app WARN slow", "api app ERROR boom"]);
    const lines = screen.getByRole("log").querySelectorAll(".logs__line");
    expect(lines[0]).toHaveClass("logs__line--warn");
    expect(lines[1]).toHaveClass("logs__line--error");
  });

  it("restarts every stream with timestamps or the previous containers", async () => {
    await openTab();
    snapshot([podOf("web-a", ["app"], { restarts: 1 }), podOf("web-b")]);
    await listening("web-a/app");
    fireEvent.click(screen.getByRole("checkbox", { name: "Timestamps" }));
    await waitFor(() => expect(calls("logs_start")).toHaveLength(4));
    expect(calls("logs_start")[2]?.opts).toMatchObject({ timestamps: true });
    // Only containers that ran before have a previous log.
    fireEvent.click(screen.getByRole("checkbox", { name: "Previous container" }));
    await waitFor(() => expect(calls("logs_start")).toHaveLength(5));
    expect(calls("logs_start")[4]).toMatchObject({ pod: { name: "web-a" }, opts: { previous: true, timestamps: true } });
  });

  it("saves the shown lines with their prefixes", async () => {
    backend.restore();
    backend = mockBackend(
      {
        logs_start: (args) => `${(args.pod as { name: string }).name}/${(args.opts as { container: string }).container}`,
        logs_stop: () => undefined,
        watch_start: () => "pods",
        watch_stop: () => undefined,
        file_save: () => undefined,
      },
      { saveFile: () => "/home/me/web.log" },
    );
    await openTab();
    snapshot([podOf("web-a"), podOf("web-b")]);
    await listening("web-b/app");
    await emit("web-a/app", ["one"]);
    await emit("web-b/app", ["two"]);
    await waitFor(() => expect(shownLines()).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls("file_save")).toHaveLength(1));
    expect(calls("file_save")[0]).toEqual({ path: "/home/me/web.log", contents: "web-a app one\nweb-b app two\n" });
  });

  it("a fixed set of pods (selected rows) reads only those pods", async () => {
    await openTab({
      multi: true,
      clusterId: "c1",
      pods: [{ kind: POD, namespace: "demo", name: "web-b" }],
    });
    expect(calls("watch_start")[0]).toMatchObject({ spec: { namespaces: ["demo"], labelSelector: null } });
    snapshot([podOf("web-a"), podOf("web-b")]);
    await listening("web-b/app");
    expect(started()).toEqual(["web-b/app"]);
  });
});

describe("entry points", () => {
  const deployment: KubeObject = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "web", namespace: "demo", uid: "d1" },
    spec: { selector: { matchLabels: { app: "web" } } },
  };
  const service: KubeObject = {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: "web", namespace: "demo", uid: "s1" },
    spec: { selector: { app: "web", tier: "front" } },
  };

  it("the pod picker of a workload offers All pods, which opens a merged tab following the selector", async () => {
    render(<ActionDialogHost />);
    await act(async () => {
      await runAction(getAction("logs")!, "c1", DEPLOYMENT, [deployment]);
    });
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "All pods" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const tab = useAppStore.getState().dock.tabs[0];
    expect(tab).toMatchObject({ type: "logs", title: "deployment/web" });
    expect(tab?.payload).toEqual({ multi: true, clusterId: "c1", selector: { namespace: "demo", labelSelector: "app=web" } });
  });

  it("is offered for ReplicaSets and Services (their label selector), and for several selected pods", async () => {
    const action = getAction("logs")!;
    expect(getResourceDef(REPLICA_SET).actions).toContain("logs");
    expect(getResourceDef(SERVICE).actions).toContain("logs");
    expect(action.appliesTo(service, SERVICE)).toBe(true);
    expect(action.appliesTo({ ...service, spec: {} }, SERVICE)).toBe(false);
    expect(action.appliesTo(deployment, REPLICA_SET)).toBe(true);

    render(<ActionDialogHost />);
    await act(async () => {
      await runAction(action, "c1", SERVICE, [service]);
    });
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "All pods" }));
    expect(useAppStore.getState().dock.tabs[0]?.payload).toMatchObject({
      selector: { namespace: "demo", labelSelector: "app=web,tier=front" },
    });

    const pods = [podOf("web-b"), podOf("web-a")];
    expect(getActionsFor(pods, POD, ["logs"]).map((a) => a.id)).toEqual(["logs"]);
    await act(async () => {
      await runAction(action, "c1", POD, pods);
    });
    const tab = useAppStore.getState().dock.tabs.at(-1);
    expect(tab).toMatchObject({ type: "logs", title: "2 pods" });
    expect((tab?.payload as MultiLogsPayload).pods?.map((p) => p.name)).toEqual(["web-a", "web-b"]);
  });
});

describe("model", () => {
  it("colours are stable per pod name, within the palette, and spread over it", () => {
    expect(colourOf("web-7d9f-abcde")).toBe(colourOf("web-7d9f-abcde"));
    const colours = Array.from({ length: 50 }, (_, i) => colourOf(`web-${i}`));
    for (const c of colours) expect(c >= 0 && c < PALETTE_SIZE).toBe(true);
    expect(new Set(colours).size).toBeGreaterThanOrEqual(PALETTE_SIZE - 2);
    // Every palette colour is defined for the light and for the dark theme.
    const css = readFileSync(resolve(__dirname, "logs.css"), "utf8");
    for (const theme of ["light", "dark"]) {
      const block = new RegExp(`:root\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
      for (let i = 0; i < PALETTE_SIZE; i++) expect(block, `${theme} ${i}`).toContain(`--logs-src-${i}:`);
    }
  });

  it("parses JSON lines: level words and numbers, message, other fields, a timestamp before the object", () => {
    expect(parseJsonLine('{"level":"info","msg":"hi","n":1,"o":{"a":true}}', false)).toEqual({
      level: "info",
      message: "hi",
      fields: ["n=1", 'o={"a":true}'],
    });
    expect(parseJsonLine('2024-05-01T10:00:00Z {"lvl":"ERR","message":"x"}', true)).toEqual({
      timestamp: "2024-05-01T10:00:00Z",
      level: "error",
      message: "x",
      fields: [],
    });
    expect(parseJsonLine('{"level":30,"msg":"pino"}', false)?.level).toBe("info");
    expect(parseJsonLine('{"severity":"CRITICAL"}', false)?.level).toBe("fatal");
    expect(parseJsonLine("not json", false)).toBeNull();
    expect(parseJsonLine("{broken", false)).toBeNull();
    expect(parseJsonLine("[1,2]", false)).toBeNull();
  });

  it("the level filter keeps that level and above; lines without a level only with All", () => {
    expect(passesLevel("warn", "warn")).toBe(true);
    expect(passesLevel("fatal", "warn")).toBe(true);
    expect(passesLevel("info", "warn")).toBe(false);
    expect(passesLevel(undefined, "info")).toBe(false);
    expect(passesLevel(undefined, null)).toBe(true);
  });

  it("text filters are case-insensitive; a bad regex filters nothing", () => {
    expect(textFilter("a.b", false).pattern?.test("xA.Bx")).toBe(true);
    expect(textFilter("a.b", false).pattern?.test("axb")).toBe(false);
    expect(textFilter("a.b", true).pattern?.test("axb")).toBe(true);
    expect(textFilter("(", true)).toEqual({ pattern: null, invalid: true });
    expect(splitMatches("foo bar foo", /foo/i)).toEqual([
      { text: "foo", match: true },
      { text: " bar ", match: false },
      { text: "foo", match: true },
    ]);
  });

  it("streams started containers only; with previous, those that ran before", () => {
    const pods = [podOf("b", ["app"], { restarts: 2 }), pendingPod("c"), podOf("a", ["app", "proxy"])];
    expect(targetsOf(pods, false).map((t) => t.key)).toEqual(["demo/a/app", "demo/a/proxy", "demo/b/app"]);
    expect(targetsOf(pods, true).map((t) => t.runKey)).toEqual(["demo/b/app#containerd://b-app-old"]);
  });
});
