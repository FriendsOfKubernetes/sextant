import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type KindRef, type KubeObject, type MockBackend, type ObjectRef } from "../../api";
import { resetAppStore } from "../../app/store";
import { Dock } from "../../layout/dock/Dock";
import { ActionDialogHost } from "../../layout/main/ActionDialogHost";
import { getAction, runAction } from "../actions/registry";
import { PodDetails } from "../details/kinds/pods";
import { splitCommand } from "./DebugDialog";
import "./index";

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
const REF: ObjectRef = { kind: POD, namespace: "demo", name: "web" };

function webPod(phase = "Running", running = true): KubeObject {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: "web", namespace: "demo", uid: "uid-web" },
    spec: {
      initContainers: [{ name: "setup", image: "busybox" }],
      containers: [
        { name: "app", image: "distroless/app" },
        { name: "proxy", image: "envoy" },
      ],
    },
    status: {
      phase,
      initContainerStatuses: [{ name: "setup", state: { terminated: { exitCode: 0, reason: "Completed" } } }],
      containerStatuses: [
        { name: "app", restartCount: 0, state: running ? { running: {} } : { waiting: { reason: "CrashLoopBackOff" } } },
        { name: "proxy", restartCount: 0, state: running ? { running: {} } : { terminated: { exitCode: 1 } } },
      ],
    },
  };
}

let backend: MockBackend;
let saveAs: string | null;
let openAs: string | null;

beforeEach(() => {
  resetAppStore();
  saveAs = "/home/me/hostname";
  openAs = "/home/me/report.txt";
  backend = mockBackend(
    {
      debug_start: () => undefined,
      exec_start: () => undefined,
      term_input: () => undefined,
      term_resize: () => undefined,
      term_stop: () => undefined,
      resource_get: () => webPod(),
      files_stat: (args) =>
        args.path === "/etc/localtime"
          ? { path: args.path, name: "localtime", kind: "symlink", size: null, linkTarget: "/usr/share/zoneinfo/UTC" }
          : args.path === "/var/log"
            ? { path: args.path, name: "log", kind: "directory", size: 4096, linkTarget: null }
            : { path: args.path, name: "hostname", kind: "file", size: 4, linkTarget: null },
      files_download_start: () => undefined,
      files_upload_start: () => undefined,
    },
    { saveFile: () => saveAs, openFile: () => openAs },
  );
});
afterEach(() => backend.restore());

function calls(cmd: string) {
  return backend.calls.filter((c) => c.cmd === cmd).map((c) => c.args);
}

function Details({ obj }: { obj: KubeObject }) {
  return (
    <>
      <PodDetails obj={obj} clusterId="c1" objectRef={REF} />
      <Dock />
    </>
  );
}

/** The header of container `name` in the details (its tab shown first). */
function containerHead(name: string): HTMLElement {
  const tab = screen.queryByRole("tab", { name: new RegExp(`^${name}`) });
  if (tab) fireEvent.click(tab);
  const box = document.querySelector<HTMLElement>(`.dt-container[data-container="${name}"]`);
  if (!box) throw new Error(`no container ${name}`);
  return box.querySelector<HTMLElement>(".dt-container__head")!;
}

describe("splitCommand", () => {
  it("splits on spaces and keeps quoted words together", () => {
    expect(splitCommand("sleep infinity")).toEqual(["sleep", "infinity"]);
    expect(splitCommand(`  sh -c "echo hi; sleep 1d" '' `)).toEqual(["sh", "-c", "echo hi; sleep 1d", ""]);
    expect(splitCommand("   ")).toEqual([]);
  });
});

describe("pod details", () => {
  it("offers Debug and Files on running regular containers, Debug only on a crashed pod, nothing on init ones", () => {
    const { unmount } = render(<Details obj={webPod()} />);
    const app = within(containerHead("app"));
    expect(app.getByRole("button", { name: "Debug" })).toBeInTheDocument();
    expect(app.getByRole("button", { name: "Files" })).toBeInTheDocument();
    expect(within(containerHead("setup")).queryByRole("button")).toBeNull();
    unmount();

    render(<Details obj={webPod("Failed", false)} />);
    const crashed = within(containerHead("app"));
    expect(crashed.getByRole("button", { name: "Debug" })).toBeInTheDocument();
    expect(crashed.queryByRole("button", { name: "Files" })).toBeNull();
  });

  it("debugs a copy with another image and command, remembers the image and opens a debug tab", async () => {
    render(<Details obj={webPod()} />);
    fireEvent.click(within(containerHead("proxy")).getByRole("button", { name: "Debug" }));
    const dialog = screen.getByRole("dialog", { name: "Debug pod web" });
    expect(within(dialog).getByLabelText("Image")).toHaveValue("busybox:stable");
    // The container it was opened from is the target.
    expect(within(dialog).getByRole("radio", { name: "proxy" })).toBeChecked();
    fireEvent.click(within(dialog).getByRole("button", { name: "nicolaka/netshoot:latest" }));
    fireEvent.click(within(dialog).getByRole("radio", { name: "app" }));
    fireEvent.click(within(dialog).getByRole("radio", { name: "A copy of the pod" }));
    fireEvent.change(within(dialog).getByLabelText("Command of the container in the copy"), {
      target: { value: "sleep 1d" },
    });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Use this image by default" }));
    // Nothing is created before Start.
    expect(calls("debug_start")).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Start" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("tab", { name: "Debug copy: web" })).toBeInTheDocument();
    await waitFor(() => expect(calls("debug_start")).toHaveLength(1));
    const [start] = calls("debug_start");
    expect(start).toMatchObject({
      clusterId: "c1",
      pod: REF,
      spec: { image: "nicolaka/netshoot:latest", target: "app", copy: { command: ["sleep", "1d"] } },
    });
    expect(backend.listenerCount(`term:${start!.streamId as string}`)).toBe(1);
    await waitFor(() => expect(backend.settings.debugImage).toBe("nicolaka/netshoot:latest"));
  });

  it("starts an ephemeral container with the default image without touching the settings", async () => {
    render(<Details obj={webPod()} />);
    fireEvent.click(within(containerHead("app")).getByRole("button", { name: "Debug" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(screen.getByRole("tab", { name: "Debug: web" })).toBeInTheDocument();
    await waitFor(() => expect(calls("debug_start")).toHaveLength(1));
    expect(calls("debug_start")[0]!.spec).toEqual({ image: "busybox:stable", target: "app", copy: null });
    expect(calls("settings_update")).toEqual([]);
  });
});

describe("debug tab", () => {
  it("asks before reconnecting, since that adds another debug container", async () => {
    backend.on("debug_start", () => {
      throw { code: "forbidden", message: "You need permission to update pods/ephemeralcontainers" };
    });
    render(<Details obj={webPod()} />);
    fireEvent.click(within(containerHead("app")).getByRole("button", { name: "Debug" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    const reconnect = await screen.findByRole("button", { name: "Reconnect" });
    expect(calls("debug_start")).toHaveLength(1);
    fireEvent.click(reconnect);
    const confirm = screen.getByRole("dialog", { name: "Start another debug container?" });
    expect(confirm).toHaveTextContent("adds another ephemeral container (busybox:stable) to pod web");
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(calls("debug_start")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(calls("debug_start")).toHaveLength(2));
  });
});

describe("files dialog", () => {
  async function openFiles() {
    render(<Details obj={webPod()} />);
    fireEvent.click(within(containerHead("app")).getByRole("button", { name: "Files" }));
    return screen.getByRole("dialog", { name: "Files of web/app" });
  }

  it("downloads a file to the chosen path with its progress", async () => {
    const dialog = await openFiles();
    fireEvent.change(within(dialog).getByLabelText("Download a file or folder from the container"), {
      target: { value: "/etc/hostname" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Download…" }));
    await waitFor(() => expect(calls("files_download_start")).toHaveLength(1));
    expect(calls("files_stat")[0]).toEqual({ clusterId: "c1", pod: REF, container: "app", path: "/etc/hostname" });
    const [start] = calls("files_download_start");
    expect(start).toMatchObject({
      container: "app",
      path: "/etc/hostname",
      kind: "file",
      destination: "/home/me/hostname",
    });
    const event = `files:${start!.streamId as string}`;
    // Listening before the start: nothing is lost.
    expect(backend.listenerCount(event)).toBe(1);

    act(() => backend.emit(event, { type: "progress", transferred: 2, total: 4 }));
    expect(within(dialog).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    expect(within(dialog).getByText("2B of 4B (50%)")).toBeInTheDocument();
    act(() => backend.emit(event, { type: "done", bytes: 4 }));
    expect(within(dialog).getByText("Downloaded 4B to /home/me/hostname")).toBeInTheDocument();
    expect(backend.listenerCount(event)).toBe(0);
  });

  it("saves a folder as .tar.gz and says what a link points to instead of saving it", async () => {
    let asked: string | undefined;
    backend.restore();
    backend = mockBackend(
      {
        files_stat: (args) =>
          args.path === "/var/log"
            ? { path: args.path, name: "log", kind: "directory", size: 4096, linkTarget: null }
            : { path: args.path, name: "localtime", kind: "symlink", size: null, linkTarget: "/usr/share/zoneinfo/UTC" },
        files_download_start: () => undefined,
      },
      {
        saveFile: (options) => {
          asked = options.defaultPath;
          return null;
        },
      },
    );
    const dialog = await openFiles();
    const input = within(dialog).getByLabelText("Download a file or folder from the container");
    fireEvent.change(input, { target: { value: "/var/log" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Download…" }));
    await waitFor(() => expect(asked).toBe("log.tar.gz"));
    // The save dialog was cancelled: nothing starts.
    expect(calls("files_download_start")).toEqual([]);

    asked = undefined;
    fireEvent.change(input, { target: { value: "/etc/localtime" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Download…" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "/etc/localtime is a symbolic link to /usr/share/zoneinfo/UTC",
    );
    expect(asked).toBeUndefined();
  });

  it("cancels a running transfer", async () => {
    const dialog = await openFiles();
    fireEvent.change(within(dialog).getByLabelText("Download a file or folder from the container"), {
      target: { value: "/etc/hostname" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Download…" }));
    await waitFor(() => expect(calls("files_download_start")).toHaveLength(1));
    const id = calls("files_download_start")[0]!.streamId;
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel transfer" }));
    await waitFor(() => expect(calls("files_transfer_stop")).toEqual([{ streamId: id }]));
    expect(within(dialog).getByText("The transfer was cancelled.")).toBeInTheDocument();
  });

  it("uploads a local file only after a confirmation", async () => {
    const dialog = await openFiles();
    fireEvent.click(within(dialog).getByRole("button", { name: "Choose file…" }));
    const target = await within(dialog).findByLabelText("Path in the container");
    expect(target).toHaveValue("/tmp/report.txt");
    fireEvent.change(target, { target: { value: "/data/report.txt" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Upload" }));

    const confirm = screen.getByRole("dialog", { name: "Upload into the container?" });
    expect(confirm).toHaveTextContent("report.txt will be written to /data/report.txt in container app of pod web");
    expect(confirm).toHaveTextContent("A file already there is replaced");
    expect(confirm).toHaveTextContent("a cancelled or failed upload can leave a partly written file");
    expect(calls("files_upload_start")).toEqual([]);
    fireEvent.click(within(confirm).getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(calls("files_upload_start")).toHaveLength(1));
    expect(calls("files_upload_start")[0]).toMatchObject({
      clusterId: "c1",
      pod: REF,
      container: "app",
      source: "/home/me/report.txt",
      path: "/data/report.txt",
    });
    const event = `files:${calls("files_upload_start")[0]!.streamId as string}`;
    act(() => backend.emit(event, { type: "error", error: { code: "notFound", message: "Container app has no tar" } }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Container app has no tar");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("may be partly written");
  });
});

describe("shell tab", () => {
  it("has Files and Debug for its container", async () => {
    render(
      <>
        <Dock />
        <ActionDialogHost />
      </>,
    );
    const action = getAction("exec");
    const obj = webPod();
    obj.spec = { containers: [{ name: "app", image: "x" }] };
    await act(() => runAction(action!, "c1", POD, [obj]));
    fireEvent.click(await screen.findByRole("button", { name: "Files" }));
    const files = screen.getByRole("dialog", { name: "Files of web/app" });
    fireEvent.click(within(files).getAllByRole("button", { name: "Close" }).at(-1)!);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Debug" }));
    // The pod's containers are read first.
    const dialog = await screen.findByRole("dialog", { name: "Debug pod web" });
    expect(within(dialog).getByRole("radio", { name: "app" })).toBeChecked();
  });
});
