import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBackend, type KindRef, type KubeObject, type MockBackend, type ResourceKind } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { registerAction, resetActions } from "../../features/actions/registry";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { ActionDialogHost } from "../../layout/main/ActionDialogHost";
import "../../resources";
import { extendColumns } from "../../resources";
import { ResourceTable } from "./ResourceTable";

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const SECRET: KindRef = { group: "", version: "v1", kind: "Secret" };
const WIDGET: KindRef = { group: "demo.sextant.dev", version: "v1", kind: "Widget" };

function pod(i: number, extra: { labels?: Record<string, string>; restarts?: number; namespace?: string } = {}): KubeObject {
  const name = `pod-${String(i).padStart(4, "0")}`;
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      namespace: extra.namespace ?? "default",
      uid: `uid-${i}`,
      creationTimestamp: "2026-10-01T00:00:00Z",
      labels: extra.labels ?? {},
      ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "web-5d8f", controller: true }],
    },
    spec: { nodeName: "node-1", containers: [{ name: "app" }] },
    status: {
      phase: "Running",
      qosClass: "Burstable",
      containerStatuses: [
        { name: "app", ready: true, restartCount: extra.restarts ?? 0, state: { running: { startedAt: "x" } } },
      ],
    },
  };
}

let backend: MockBackend;
let watchCount = 0;

beforeEach(() => {
  resetAppStore();
  resetActions();
  watchCount = 0;
  backend = mockBackend({ watch_start: () => `watch-${++watchCount}`, watch_stop: () => undefined });
  // jsdom has no layout: give the table's scroll container a viewport of 660 px (20 rows of 33 px).
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("rt__scroll") ? 660 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("rt__scroll") ? 1200 : 0;
  });
});

afterEach(() => backend.restore());

async function snapshot(items: KubeObject[], id = "watch-1") {
  await waitFor(() => expect(backend.listenerCount(`watch:${id}`)).toBe(1));
  act(() => backend.emit(`watch:${id}`, { type: "snapshot", items }));
}

function bodyRows(): HTMLElement[] {
  const table = screen.getByRole("table");
  return within(table)
    .getAllByRole("row")
    .filter((r) => r.getAttribute("aria-rowindex") !== "1");
}

function names(): string[] {
  return bodyRows().map((r) => within(r).getAllByRole("cell")[1]!.textContent ?? "");
}

describe("ResourceTable", () => {
  it("shows the pod columns of Lens and the values of a pod", async () => {
    render(<ResourceTable clusterId="c1" kind={POD} />);
    await snapshot([pod(1, { restarts: 3 })]);
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent?.replace(/[▲▼]/g, ""));
    expect(headers.filter(Boolean)).toEqual([
      "Name",
      "Namespace",
      "Containers",
      "Restarts",
      "Controlled By",
      "Node",
      "QoS",
      "Age",
      "Status",
    ]);
    const cells = within(bodyRows()[0]!).getAllByRole("cell").map((c) => c.textContent);
    expect(cells).toEqual(expect.arrayContaining(["pod-0001", "default", "3", "ReplicaSet", "node-1", "Burstable", "Running"]));
    expect(within(bodyRows()[0]!).getByRole("img", { name: "app: running" })).toBeInTheDocument();
  });

  it("renders only the visible rows of 5 000 and follows scrolling", async () => {
    render(<ResourceTable clusterId="c1" kind={POD} />);
    await snapshot(Array.from({ length: 5000 }, (_, i) => pod(i)));
    expect(screen.getByTestId("rt-count")).toHaveTextContent("5000 items");
    expect(screen.getByRole("table")).toHaveAttribute("aria-rowcount", "5001");
    const rendered = bodyRows();
    expect(rendered.length).toBeGreaterThan(10);
    expect(rendered.length).toBeLessThan(60);
    expect(names()[0]).toBe("pod-0000");
    expect(screen.queryByText("pod-4999")).not.toBeInTheDocument();

    const scroller = document.querySelector(".rt__scroll") as HTMLElement;
    act(() => {
      scroller.scrollTop = 33 * 2500;
      fireEvent.scroll(scroller);
    });
    await waitFor(() => expect(screen.getByText("pod-2500")).toBeInTheDocument());
    expect(screen.queryByText("pod-0000")).not.toBeInTheDocument();
    expect(bodyRows().length).toBeLessThan(60);
  });

  it("applies a delta batch at once: new, changed and deleted rows", async () => {
    render(<ResourceTable clusterId="c1" kind={POD} />);
    await snapshot([pod(1), pod(2), pod(3)]);
    act(() =>
      backend.emit("watch:watch-1", {
        type: "delta",
        upserted: [pod(4), { ...pod(2), status: { phase: "Pending" } }],
        deleted: ["uid-1"],
      }),
    );
    expect(names()).toEqual(["pod-0002", "pod-0003", "pod-0004"]);
    expect(within(bodyRows()[0]!).getByText("Pending")).toBeInTheDocument();
    expect(screen.getByTestId("rt-count")).toHaveTextContent("3 items");
  });

  it("filters by part of the name, by label selector and by namespace, on the fly", async () => {
    render(<ResourceTable clusterId="c1" kind={POD} />);
    await snapshot([
      pod(1, { labels: { app: "nginx" } }),
      pod(2, { labels: { app: "web" } }),
      pod(30, { labels: { app: "nginx" }, namespace: "kube-system" }),
    ]);
    act(() => useAppStore.getState().setSearch("c1", "app=nginx"));
    expect(names()).toEqual(["pod-0001", "pod-0030"]);
    expect(screen.getByTestId("rt-count")).toHaveTextContent("2 of 3");
    act(() => useAppStore.getState().setSearch("c1", "0002"));
    expect(names()).toEqual(["pod-0002"]);
    act(() => useAppStore.getState().setSearch("c1", "kube-sys"));
    expect(names()).toEqual(["pod-0030"]);
    act(() => useAppStore.getState().setSearch("c1", "app=nginx 0030"));
    expect(names()).toEqual(["pod-0030"]);
    act(() => useAppStore.getState().setSearch("c1", "nothing-like-this"));
    expect(screen.getByText("Nothing matches “nothing-like-this”")).toBeInTheDocument();
  });

  it("sorts by any column, numbers numerically, both directions", async () => {
    render(<ResourceTable clusterId="c1" kind={POD} />);
    await snapshot([pod(1, { restarts: 10 }), pod(2, { restarts: 2 }), pod(3, { restarts: 0 })]);
    expect(names()).toEqual(["pod-0001", "pod-0002", "pod-0003"]);
    const restarts = screen.getByRole("button", { name: "Restarts" });
    fireEvent.click(restarts);
    expect(names()).toEqual(["pod-0003", "pod-0002", "pod-0001"]);
    expect(restarts.closest("[role='columnheader']")).toHaveAttribute("aria-sort", "ascending");
    fireEvent.click(restarts);
    expect(names()).toEqual(["pod-0001", "pod-0002", "pod-0003"]);
    expect(restarts.closest("[role='columnheader']")).toHaveAttribute("aria-sort", "descending");
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(names()).toEqual(["pod-0001", "pod-0002", "pod-0003"]);
  });

  it("opens the details of a clicked row", async () => {
    render(<ResourceTable clusterId="c1" kind={POD} />);
    await snapshot([pod(1), pod(2)]);
    fireEvent.click(screen.getByText("pod-0002"));
    expect(useAppStore.getState().details).toEqual({ kind: POD, namespace: "default", name: "pod-0002" });
  });

  it("builds the context menu from registered actions and runs them on the selection", async () => {
    const logs = vi.fn();
    const remove = vi.fn();
    registerAction("logs", { labelKey: "Logs", icon: "≡", appliesTo: (_o, k) => k.kind === "Pod", run: logs });
    registerAction("delete", { labelKey: "Delete", icon: "×", danger: true, multiple: true, appliesTo: () => true, run: remove });
    registerAction("scale", { labelKey: "Scale", icon: "↕", appliesTo: () => false, run: vi.fn() });
    registerAction("edit", { labelKey: "Edit", icon: "✎", appliesTo: () => true, run: vi.fn() });
    render(<ResourceTable clusterId="c1" kind={POD} actions={["logs", "scale", "delete", "exec"]} />);
    await snapshot([pod(1), pod(2), pod(3)]);

    fireEvent.contextMenu(screen.getByText("pod-0001"));
    const menu = screen.getByRole("menu");
    // Only listed ids that are registered and apply; in the order of the list.
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["≡Logs", "×Delete"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Logs" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(logs).toHaveBeenCalledTimes(1);
    expect(logs.mock.calls[0]![0]).toMatchObject({
      clusterId: "c1",
      kind: POD,
      refs: [{ kind: POD, namespace: "default", name: "pod-0001" }],
    });

    // Two selected rows: only actions for several objects, run with both.
    fireEvent.click(screen.getByRole("checkbox", { name: "Select pod-0001" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select pod-0003" }));
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Actions for pod-0003" }));
    const multi = screen.getByRole("menu");
    expect(within(multi).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["×Delete"]);
    fireEvent.click(within(multi).getByRole("menuitem", { name: "Delete" }));
    expect(remove.mock.calls[0]![0].refs.map((r: { name: string }) => r.name)).toEqual(["pod-0001", "pod-0003"]);
  });

  it("Escape closes the open context menu and leaves the details panel open", async () => {
    registerAction("edit", { labelKey: "Edit", icon: "✎", appliesTo: () => true, run: vi.fn() });
    const ref = { kind: POD, namespace: "default", name: "web-1" };
    act(() => useAppStore.getState().openDetails(ref));
    render(
      <>
        <ResourceTable clusterId="c1" kind={POD} actions={["edit"]} />
        <DetailsPanel clusterId="c1" objectRef={ref} />
      </>,
    );
    await snapshot([pod(1)]);
    fireEvent.contextMenu(screen.getByText("pod-0001"));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(useAppStore.getState().details).toEqual(ref);

    // With no menu open, Escape closes the details panel as before.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useAppStore.getState().details).toBeNull();
  });

  it("shows a failed action as an error dialog", async () => {
    registerAction("edit", {
      labelKey: "Edit",
      icon: "✎",
      appliesTo: () => true,
      run: () => Promise.reject({ code: "forbidden", message: "pods is forbidden" }),
    });
    render(
      <>
        <ResourceTable clusterId="c1" kind={POD} actions={["edit"]} />
        <ActionDialogHost />
      </>,
    );
    await snapshot([pod(1)]);
    fireEvent.contextMenu(screen.getByText("pod-0001"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit failed" });
    expect(dialog).toHaveTextContent("pods is forbidden");
  });

  it("before the first snapshot shows loading, not an empty table, also after a reconnect or a stray delta", async () => {
    render(<ResourceTable clusterId="c1" kind={POD} />);
    await waitFor(() => expect(backend.listenerCount("watch:watch-1")).toBe(1));
    act(() => backend.emit("watch:watch-1", { type: "reconnecting" }));
    expect(screen.queryByText(/No Pods found/)).not.toBeInTheDocument();
    expect(screen.getByText("Loading Pods…")).toBeInTheDocument();
    act(() => backend.emit("watch:watch-1", { type: "delta", upserted: [], deleted: ["uid-9"] }));
    expect(screen.queryByText(/No Pods found/)).not.toBeInTheDocument();
    expect(screen.getByText("Loading Pods…")).toBeInTheDocument();

    act(() => backend.emit("watch:watch-1", { type: "snapshot", items: [] }));
    expect(screen.getByText(/No Pods found/)).toBeInTheDocument();
  });

  it("while loading counts the seconds and after 5 s says that the cluster is slow", () => {
    vi.useFakeTimers();
    try {
      render(<ResourceTable clusterId="c1" kind={{ group: "", version: "v1", kind: "Node" }} />);
      const status = screen.getByRole("status");
      expect(status).toHaveTextContent(/^Loading Nodes…$/);
      act(() => vi.advanceTimersByTime(3_000));
      expect(status).toHaveTextContent(/^Loading Nodes…\s*3 s$/);
      expect(screen.queryByText("The cluster is slow to respond")).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(4_000));
      expect(status).toHaveTextContent(/^Loading Nodes…\s*7 s/);
      expect(screen.getByText("The cluster is slow to respond")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts the loading time from when the table was asked for", () => {
    vi.useFakeTimers();
    try {
      const askedAt = Date.now() - 6_000;
      render(<ResourceTable clusterId="c1" kind={POD} loadingSince={askedAt} />);
      expect(screen.getByRole("status")).toHaveTextContent(/^Loading Pods…\s*6 s/);
      expect(screen.getByText("The cluster is slow to respond")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says when the selected namespaces have no objects", async () => {
    act(() => useAppStore.getState().setNamespaces("c1", ["empty-ns"]));
    render(<ResourceTable clusterId="c1" kind={POD} />);
    await snapshot([]);
    expect(backend.calls.find((c) => c.cmd === "watch_start")?.args.spec).toMatchObject({ namespaces: ["empty-ns"] });
    expect(screen.getByText("No Pods found in selected namespaces")).toBeInTheDocument();
  });

  it("says when listing the kind is forbidden", async () => {
    render(<ResourceTable clusterId="c1" kind={SECRET} />);
    await waitFor(() => expect(backend.listenerCount("watch:watch-1")).toBe(1));
    act(() =>
      backend.emit("watch:watch-1", { type: "error", code: "forbidden", message: "secrets is forbidden: User …" }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("You don't have permission to list Secrets");
  });

  it("shows the rows of the allowed namespaces and names the namespaces without permission", async () => {
    act(() => useAppStore.getState().setNamespaces("c1", ["team-a", "team-b", "team-c"]));
    render(<ResourceTable clusterId="c1" kind={POD} />);
    await waitFor(() => expect(backend.calls.some((c) => c.cmd === "watch_start")).toBe(true));
    const streamId = backend.calls.find((c) => c.cmd === "watch_start")!.args.streamId as string;
    await waitFor(() => expect(backend.listenerCount(`watch:${streamId}`)).toBe(1));
    act(() => backend.emit(`watch:${streamId}`, { type: "forbidden", namespaces: ["team-b", "team-c"] }));
    act(() =>
      backend.emit(`watch:${streamId}`, { type: "snapshot", items: [pod(1, { namespace: "team-a" }), pod(2, { namespace: "team-a" })] }),
    );
    expect(names()).toEqual(["pod-0001", "pod-0002"]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("rt-forbidden")).toHaveTextContent("No permission in: team-b, team-c");

    // Later batches keep the note.
    act(() => backend.emit(`watch:${streamId}`, { type: "delta", upserted: [pod(3, { namespace: "team-a" })], deleted: [] }));
    expect(names()).toEqual(["pod-0001", "pod-0002", "pod-0003"]);
    expect(screen.getByTestId("rt-forbidden")).toHaveTextContent("No permission in: team-b, team-c");
  });

  it("marks the header while reconnecting and keeps the rows", async () => {
    render(<ResourceTable clusterId="c1" kind={POD} />);
    await snapshot([pod(1), pod(2)]);
    act(() => backend.emit("watch:watch-1", { type: "reconnecting" }));
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting…");
    expect(names()).toEqual(["pod-0001", "pod-0002"]);
    act(() => backend.emit("watch:watch-1", { type: "snapshot", items: [pod(3)] }));
    expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
    expect(names()).toEqual(["pod-0003"]);
  });

  it("shows custom resources with their printer columns", async () => {
    const resourceKind: ResourceKind = {
      kindRef: WIDGET,
      plural: "widgets",
      namespaced: true,
      verbs: ["list", "watch"],
      printerColumns: [
        { name: "Size", jsonPath: ".spec.size", type: "string", priority: 0 },
        { name: "Replicas", jsonPath: ".spec.replicas", type: "integer", priority: 0 },
        { name: "Hidden", jsonPath: ".spec.secretSauce", type: "string", priority: 1 },
        { name: "Age", jsonPath: ".metadata.creationTimestamp", type: "date", priority: 0 },
      ],
    };
    render(<ResourceTable clusterId="c1" kind={WIDGET} resourceKind={resourceKind} />);
    await snapshot([
      {
        apiVersion: "demo.sextant.dev/v1",
        kind: "Widget",
        metadata: { name: "demo-widget", namespace: "sextant-demo", uid: "w1", creationTimestamp: "2026-10-01T00:00:00Z" },
        spec: { size: "large", replicas: 3, secretSauce: "x" },
      },
    ]);
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent?.replace(/[▲▼]/g, ""));
    expect(headers.filter(Boolean)).toEqual(["Name", "Namespace", "Size", "Replicas", "Age"]);
    const cells = within(bodyRows()[0]!).getAllByRole("cell").map((c) => c.textContent);
    expect(cells).toEqual(expect.arrayContaining(["demo-widget", "sextant-demo", "large", "3"]));
    expect(screen.getByRole("heading", { name: "Widget" })).toBeInTheDocument();
  });

  it("takes columns added through extendColumns, at the asked position", async () => {
    const remove = extendColumns({ group: "", kind: "Pod" }, [
      { id: "cpu", title: "CPU", after: "containers", value: () => 42 },
    ]);
    try {
      render(<ResourceTable clusterId="c1" kind={POD} />);
      await snapshot([pod(1)]);
      const headers = screen.getAllByRole("columnheader").map((h) => h.textContent?.replace(/[▲▼]/g, ""));
      expect(headers.filter(Boolean).slice(0, 4)).toEqual(["Name", "Namespace", "Containers", "CPU"]);
      expect(within(bodyRows()[0]!).getByText("42")).toBeInTheDocument();
    } finally {
      remove();
    }
  });
});
