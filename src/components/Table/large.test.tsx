// The table on very large clusters (#157): the watch options it asks for, rows of a list that is still loading, the
// cap notice, the question before a kind with very many objects is watched everywhere, and the search's selector
// terms sent to the API server.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBackend, resetWatchRegistry, type KindRef, type MockBackend, type WatchSpec } from "../../api";
import { resetAppStore } from "../../app/store";
import { resetActions } from "../../features/actions/registry";
import "../../resources";
import { resetObjectCounts } from "../../resources/counts";
import { asItems, scalePods } from "../../test/scale";
import { SERVER_FILTER_DELAY_MS, TABLE_MAX_OBJECTS } from "./limits";
import { ResourceTable } from "./ResourceTable";

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
let backend: MockBackend;
let starts: { name: string; spec: WatchSpec; options: unknown }[];
let count: () => unknown;

beforeEach(() => {
  resetAppStore();
  resetActions();
  resetWatchRegistry();
  resetObjectCounts();
  starts = [];
  count = () => {
    throw { code: "other", message: "not implemented" };
  };
  backend = mockBackend({
    watch_start: (args) => {
      const name = `w${starts.length + 1}`;
      starts.push({ name, spec: args.spec as WatchSpec, options: args.options });
      return name;
    },
    watch_stop: () => undefined,
    resource_count: () => count(),
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("rt__scroll") ? 660 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("rt__scroll") ? 1200 : 0;
  });
});

afterEach(() => {
  backend.restore();
  vi.useRealTimers();
});

async function started(n: number) {
  await waitFor(() => expect(starts).toHaveLength(n));
  const last = starts[n - 1]!;
  await waitFor(() => expect(backend.listenerCount(`watch:${last.name}`)).toBe(1));
  return last;
}

describe("a table on a large cluster", () => {
  it("asks for the first list in parts and a cap, and shows rows while the list loads", async () => {
    render(<ResourceTable clusterId="c1" kind={POD} namespaces={["team-1"]} />);
    const watch = await started(1);
    expect(watch.options).toEqual({ progressive: true, maxObjects: TABLE_MAX_OBJECTS });
    const pods = scalePods(30);
    act(() => backend.emit(`watch:${watch.name}`, { type: "snapshotPart", items: asItems(pods.slice(0, 20)) }));
    expect(await screen.findByText("Loading… 20 so far")).toBeInTheDocument();
    expect(screen.getAllByRole("row").length).toBeGreaterThan(1);
    act(() =>
      backend.emit(`watch:${watch.name}`, { type: "snapshotEnd", items: asItems(pods.slice(20)), deleted: [] }),
    );
    expect(await screen.findByText("30 items")).toBeInTheDocument();
    expect(screen.queryByTestId("rt-listing")).toBeNull();
  });

  it("says when the watch keeps only the first objects", async () => {
    render(<ResourceTable clusterId="c1" kind={POD} namespaces={["team-1"]} />);
    const watch = await started(1);
    act(() => backend.emit(`watch:${watch.name}`, { type: "snapshot", items: asItems(scalePods(5)) }));
    act(() => backend.emit(`watch:${watch.name}`, { type: "capped", total: 70_000 }));
    expect(
      await screen.findByText(
        "Showing the first 5 of 70000 objects. Narrow the list by namespace or label to see the rest.",
      ),
    ).toBeInTheDocument();
    act(() => backend.emit(`watch:${watch.name}`, { type: "capped", total: 5 }));
    await waitFor(() => expect(screen.queryByTestId("rt-capped")).toBeNull());
  });

  it("asks before it watches a kind with very many objects in every namespace", async () => {
    count = () => ({ count: 48_000, exact: true });
    render(<ResourceTable clusterId="c1" kind={POD} namespaces={null} />);
    expect(await screen.findByText("Pods: about 48000 objects in all namespaces")).toBeInTheDocument();
    expect(starts).toHaveLength(0);
    const counted = backend.calls.find((c) => c.cmd === "resource_count");
    expect(counted?.args).toMatchObject({ clusterId: "c1", kind: POD, namespaces: null });
    fireEvent.click(screen.getByRole("button", { name: "Show anyway" }));
    const watch = await started(1);
    expect(watch.spec.namespaces).toBeNull();
  });

  it("does not wait for a count that does not come", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    count = () => new Promise(() => undefined);
    // Not Pods: "Show anyway" above is remembered for the session.
    render(<ResourceTable clusterId="c1" kind={{ ...POD, kind: "Service" }} namespaces={null} />);
    await waitFor(() => expect(backend.calls.some((c) => c.cmd === "resource_count")).toBe(true));
    expect(starts).toHaveLength(0);
    await act(() => vi.advanceTimersByTimeAsync(3_100));
    vi.useRealTimers();
    await started(1);
  });

  it("watches at once when the kind has few objects or cannot be counted", async () => {
    count = () => ({ count: 120, exact: true });
    const { unmount } = render(<ResourceTable clusterId="c1" kind={{ ...POD, kind: "ConfigMap" }} namespaces={null} />);
    await started(1);
    unmount();
    count = () => {
      throw { code: "forbidden", message: "no" };
    };
    render(<ResourceTable clusterId="c1" kind={{ ...POD, kind: "Secret" }} namespaces={null} />);
    await started(2);
  });

  it("sends the search's selector terms to the API server and keeps the rows while the narrower watch starts", async () => {
    const { rerender } = render(<ResourceTable clusterId="c1" kind={POD} namespaces={["team-1"]} search="" />);
    const all = await started(1);
    const pods = scalePods(400).filter((p) => p.metadata?.namespace === "team-1");
    act(() => backend.emit(`watch:${all.name}`, { type: "snapshot", items: asItems(pods) }));
    expect(await screen.findByText(`${pods.length} items`)).toBeInTheDocument();

    vi.useFakeTimers({ shouldAdvanceTime: true });
    rerender(<ResourceTable clusterId="c1" kind={POD} namespaces={["team-1"]} search="app=web-1 status.phase=Running web" />);
    // At once: the rows of the old watch, filtered here.
    const matching = pods.filter((p) => (p.metadata?.labels as Record<string, string> | undefined)?.app === "web-1");
    expect(screen.getByTestId("rt-count").textContent).toBe(`${matching.length} of ${pods.length}`);
    await act(() => vi.advanceTimersByTimeAsync(SERVER_FILTER_DELAY_MS + 10));
    vi.useRealTimers();
    const narrow = await started(2);
    expect(narrow.spec).toMatchObject({ labelSelector: "app=web-1", fieldSelector: "status.phase=Running" });
    // While it lists, the old rows stay.
    expect(screen.getByText("Updating…")).toBeInTheDocument();
    expect(screen.getAllByRole("row").length).toBeGreaterThan(1);
    act(() => backend.emit(`watch:${narrow.name}`, { type: "snapshot", items: asItems(matching) }));
    await waitFor(() => expect(screen.queryByText("Updating…")).toBeNull());
  });
});
