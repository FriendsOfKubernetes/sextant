import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ForwardInfo, KubeObject, MockBackend, ObjectRef } from "../../api";
import { mockBackend } from "../../api";
import { resetAppStore } from "../../app/store";
import { getDetailsSections } from "../../layout/details/registry";
import { getPage } from "../../layout/pages";
import { getAction } from "../actions/registry";
import "../actions";
import podJson from "../details/fixtures/pod.json";
import serviceJson from "../details/fixtures/service.json";
import { openInBrowser, urlOf } from "./index";

const pod = podJson as KubeObject;
const service = serviceJson as KubeObject;
const POD_KIND = { group: "", version: "v1", kind: "Pod" };
const SERVICE_KIND = { group: "", version: "v1", kind: "Service" };
const podRef: ObjectRef = { kind: POD_KIND, namespace: "sextant-demo", name: "nginx-9f755754d-g85tv" };
const serviceRef: ObjectRef = { kind: SERVICE_KIND, namespace: "sextant-demo", name: "nginx" };

function info(over: Partial<ForwardInfo> = {}): ForwardInfo {
  return {
    id: "pf-1",
    cluster: "c1",
    target: { type: "service", namespace: "sextant-demo", name: "nginx" },
    remotePort: 80,
    localPort: 41234,
    status: { state: "active" },
    ...over,
  };
}

let backend: MockBackend;
let started: Record<string, unknown>[];
let open: ReturnType<typeof vi.spyOn>;

function setup(handlers: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  started = [];
  backend = mockBackend({
    portforward_list: () => [],
    portforward_start: (args) => {
      started.push(args);
      return info({ localPort: (args.localPort as number | null) ?? 41234 });
    },
    portforward_stop: () => undefined,
    ...handlers,
  });
}

function section(kind: typeof POD_KIND, obj: KubeObject, ref: ObjectRef) {
  const def = getDetailsSections(kind).find((s) => s.id === "portforward");
  if (!def) return null;
  const Section = def.Component;
  return <Section clusterId="c1" objectRef={ref} obj={obj} />;
}

beforeEach(() => {
  resetAppStore();
  open = vi.spyOn(window, "open").mockImplementation(() => null);
});

afterEach(() => {
  backend.restore();
  vi.restoreAllMocks();
});

describe("details section", () => {
  it("sits between conditions (30) and events (80) and applies to pods and services only", () => {
    setup();
    const pods = getDetailsSections(POD_KIND).find((s) => s.id === "portforward");
    expect(pods?.order).toBeGreaterThan(30);
    expect(pods?.order).toBeLessThan(80);
    expect(getDetailsSections(SERVICE_KIND).some((s) => s.id === "portforward")).toBe(true);
    expect(getDetailsSections({ group: "apps", version: "v1", kind: "Deployment" }).some((s) => s.id === "portforward")).toBe(false);
  });

  it("forwards a pod port to a free local port and opens it in the browser", async () => {
    setup();
    render(section(POD_KIND, pod, podRef));

    fireEvent.click(screen.getByRole("button", { name: "Forward port 80" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByRole("radio", { name: "Random free port" })).toBeChecked();
    fireEvent.click(dialog.getByRole("button", { name: "Start forwarding" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Open in browser" })).toBeInTheDocument());
    expect(started).toEqual([
      {
        clusterId: "c1",
        target: { type: "pod", namespace: "sextant-demo", name: "nginx-9f755754d-g85tv" },
        remotePort: 80,
        localPort: null,
      },
    ]);
    expect(screen.getByRole("dialog")).toHaveTextContent("localhost:41234");
    fireEvent.click(screen.getByRole("button", { name: "Open in browser" }));
    await waitFor(() => expect(backend.openedUrls).toEqual(["http://localhost:41234"]));
    expect(open).not.toHaveBeenCalled();
  });

  it("forwards a service port to a port the user chose", async () => {
    setup();
    render(section(SERVICE_KIND, service, serviceRef));

    fireEvent.click(screen.getByRole("button", { name: "Forward port 80" }));
    fireEvent.click(screen.getByRole("radio", { name: "Specific port" }));
    fireEvent.change(screen.getByLabelText("Local port"), { target: { value: "8080" } });
    fireEvent.click(screen.getByRole("button", { name: "Start forwarding" }));

    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toEqual({
      clusterId: "c1",
      target: { type: "service", namespace: "sextant-demo", name: "nginx" },
      remotePort: 80,
      localPort: 8080,
    });
  });

  it("does not start with an invalid local port", () => {
    setup();
    render(section(SERVICE_KIND, service, serviceRef));

    fireEvent.click(screen.getByRole("button", { name: "Forward port 80" }));
    fireEvent.click(screen.getByRole("radio", { name: "Specific port" }));
    fireEvent.change(screen.getByLabelText("Local port"), { target: { value: "70000" } });

    expect(screen.getByRole("button", { name: "Start forwarding" })).toBeDisabled();
  });

  it("offers a free port when the chosen one is taken", async () => {
    let attempts = 0;
    setup({
      portforward_start: (args) => {
        started.push(args);
        if (args.localPort === 8080 && attempts++ === 0) {
          throw { code: "portInUse", message: "local port 8080 is already in use" };
        }
        return info({ localPort: 41999 });
      },
    });
    render(section(SERVICE_KIND, service, serviceRef));
    fireEvent.click(screen.getByRole("button", { name: "Forward port 80" }));
    fireEvent.click(screen.getByRole("radio", { name: "Specific port" }));
    fireEvent.change(screen.getByLabelText("Local port"), { target: { value: "8080" } });
    fireEvent.click(screen.getByRole("button", { name: "Start forwarding" }));

    const useFree = await screen.findByRole("button", { name: "Use a free port" });
    expect(screen.getByRole("dialog")).toHaveTextContent("Local port 8080 is already in use.");
    fireEvent.click(useFree);

    await waitFor(() => expect(screen.getByRole("dialog")).toHaveTextContent("localhost:41999"));
    expect(started.map((s) => s.localPort)).toEqual([8080, null]);
  });

  it("shows other failures with the translated text of their code", async () => {
    setup({
      portforward_start: () => {
        throw { code: "notFound", message: "service demo/nginx has no ready pods" };
      },
    });
    render(section(SERVICE_KIND, service, serviceRef));
    fireEvent.click(screen.getByRole("button", { name: "Forward port 80" }));
    fireEvent.click(screen.getByRole("button", { name: "Start forwarding" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Not found.");
    expect(alert).toHaveTextContent("service demo/nginx has no ready pods");
    expect(screen.queryByRole("button", { name: "Use a free port" })).toBeNull();
  });

  it("renders nothing for a pod that declares no ports", () => {
    setup();
    const bare = structuredClone(pod);
    for (const c of (bare.spec as { containers: { ports?: unknown }[] }).containers) delete c.ports;
    const { container } = render(section(POD_KIND, bare, podRef));
    expect(container).toBeEmptyDOMElement();
  });

  it("is also an action of pods and services that opens the same dialog", async () => {
    setup();
    const action = getAction("portForward");
    expect(action?.appliesTo(pod, POD_KIND)).toBe(true);
    expect(action?.appliesTo(service, SERVICE_KIND)).toBe(true);
    const dialogs: ((close: () => void) => ReactNode)[] = [];

    await action?.run({
      clusterId: "c1",
      kind: SERVICE_KIND,
      objects: [service],
      refs: [serviceRef],
      openDialog: (renderDialog) => {
        dialogs.push(renderDialog);
        return () => undefined;
      },
    });
    expect(dialogs).toHaveLength(1);
    render(<>{dialogs[0]!(() => undefined)}</>);
    fireEvent.click(screen.getByRole("button", { name: "Start forwarding" }));

    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ target: { type: "service", name: "nginx" }, remotePort: 80, localPort: null });
  });
});

describe("Port Forwarding page", () => {
  it("is a page of the Network section", () => {
    const page = getPage("portforward");
    expect(page?.section).toBe("network");
    expect(page?.labelKey).toBe("portforward:sidebar");
  });

  it("lists the forwards of the cluster with their status and follows the portforwards event", async () => {
    setup({
      portforward_list: () => [info(), info({ id: "pf-9", cluster: "other", localPort: 5000 })],
    });
    const Page = getPage("portforward")!.Component;
    render(<Page clusterId="c1" />);

    const rows = async () => (await screen.findAllByRole("row")).slice(1);
    expect(await rows()).toHaveLength(1);
    expect(screen.getByText("Service sextant-demo/nginx")).toBeInTheDocument();
    expect(screen.getByText("localhost:41234 → 80")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();

    // The pod behind the forward died: the backend pushes the whole list again.
    act(() =>
      backend.emit("portforwards", [
        info({ status: { state: "error", code: "notFound", message: "pod nginx-1 was deleted" } }),
      ]),
    );
    await waitFor(() => expect(screen.getByText("Error")).toBeInTheDocument());
    expect(screen.getByText(/pod nginx-1 was deleted/)).toBeInTheDocument();

    act(() => backend.emit("portforwards", []));
    await waitFor(() => expect(screen.getByText("No active port forwards.")).toBeInTheDocument());
  });

  it("stops a forward and opens it in the browser", async () => {
    setup({ portforward_list: () => [info()] });
    const Page = getPage("portforward")!.Component;
    render(<Page clusterId="c1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Open in browser" }));
    await waitFor(() => expect(backend.openedUrls).toEqual(["http://localhost:41234"]));
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => expect(backend.calls.some((c) => c.cmd === "portforward_stop")).toBe(true));
    expect(backend.calls.find((c) => c.cmd === "portforward_stop")?.args).toEqual({ id: "pf-1" });
  });

  it("shows why a forward could not be stopped", async () => {
    setup({
      portforward_list: () => [info()],
      portforward_stop: () => {
        throw { code: "notFound", message: "no port forward pf-1" };
      },
    });
    const Page = getPage("portforward")!.Component;
    render(<Page clusterId="c1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("no port forward pf-1");
  });
});

describe("opening a forward in the browser", () => {
  it("uses http by default and https when asked (a TLS server such as argocd-server)", async () => {
    setup();
    expect(urlOf(info())).toBe("http://localhost:41234");
    expect(urlOf(info(), "https")).toBe("https://localhost:41234");
    openInBrowser(info({ localPort: 8443 }), "https");
    openInBrowser(info());
    await waitFor(() => expect(backend.openedUrls).toEqual(["https://localhost:8443", "http://localhost:41234"]));
    expect(open).not.toHaveBeenCalled();
  });
});
