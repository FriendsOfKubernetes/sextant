import { act, cleanup, render, screen } from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockBackend, type KubeObject, type MockBackend } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import type { CellContext } from "../../resources/registry";
import { nodeColumns, podColumns } from "../metrics/columns";
import { IDLE_TTL_MS, metricsCacheStats, POLL_INTERVAL_MS, resetMetricsCache } from "../metrics/hooks";
import { readFilterValue } from "./model";

let backend: MockBackend | undefined;
afterEach(() => { cleanup(); backend?.restore(); resetMetricsCache(); resetAppStore(); vi.useRealTimers(); });
const pod = { metadata: { name: "p", namespace: "demo" } };
function Observed({ clusterId }: { clusterId: string }) {
  const [, setRevision] = useState(0);
  const update = useCallback(() => setRevision((value) => value + 1), []);
  const context: CellContext = { clusterId, kind: { group: "", version: "v1", kind: "Pod" }, now: 0 };
  const Observer = podColumns[0]!.filter!.observer!;
  return <><Observer context={context} onChange={update} /><output data-testid={clusterId}>{String(readFilterValue(podColumns[0]!, pod, context))}</output>
    <output data-testid={`${clusterId}-memory`}>{String(readFilterValue(podColumns[1]!, pod, context))}</output></>;
}

const node: KubeObject = { metadata: { name: "worker" }, status: { allocatable: { cpu: "2", memory: "4Gi" } } };
const nodeContext = (clusterId: string): CellContext => ({ clusterId, kind: { group: "", version: "v1", kind: "Node" }, now: 0 });
function ObservedNode({ clusterId, metric }: { clusterId: string; metric: "cpu" | "memory" }) {
  const [, setRevision] = useState(0);
  const update = useCallback(() => setRevision((value) => value + 1), []);
  const column = nodeColumns.find((column) => column.id === metric)!;
  const Observer = column.filter!.observer!;
  const context = nodeContext(clusterId);
  return <><Observer context={context} onChange={update} /><output data-testid={`${clusterId}-${metric}`}>{String(readFilterValue(column, node, context))}</output></>;
}

describe("metric filters without visible metric cells", () => {
  it("filters Node CPU and memory as raw values in the explicit cluster through a shared poller and releases it", async () => {
    vi.useFakeTimers(); resetAppStore(); resetMetricsCache();
    useAppStore.getState().setActiveCluster("b");
    let failed = false;
    let usage = { cpuMillicores: 250, memoryBytes: 1_048_576 };
    backend = mockBackend({ metrics_nodes: ({ clusterId }) => {
      if (failed && clusterId === "a") throw { code: "network", message: "synthetic node metrics unavailable" };
      return [{ name: "worker", usage: clusterId === "a" ? usage : { cpuMillicores: 900, memoryBytes: 2_097_152 } }];
    } });
    const { rerender, unmount } = render(<><ObservedNode clusterId="a" metric="cpu" /><ObservedNode clusterId="a" metric="memory" />
      <ObservedNode clusterId="b" metric="cpu" /><ObservedNode clusterId="b" metric="memory" /></>);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByTestId("a-cpu")).toHaveTextContent(/^250$/);
    expect(screen.getByTestId("a-memory")).toHaveTextContent(/^1048576$/);
    expect(screen.getByTestId("b-cpu")).toHaveTextContent(/^900$/);
    expect(screen.getByTestId("b-memory")).toHaveTextContent(/^2097152$/);
    const calls = () => backend!.calls.filter((call) => call.cmd === "metrics_nodes");
    expect(calls().map((call) => call.args.clusterId).sort()).toEqual(["a", "b"]);
    expect(metricsCacheStats()).toEqual({ entries: 2, podClusters: 0, nodeClusters: 2 });

    failed = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });
    expect(screen.getByTestId("a-cpu")).toHaveTextContent(/^undefined$/);
    expect(screen.getByTestId("a-memory")).toHaveTextContent(/^undefined$/);
    expect(screen.getByTestId("b-cpu")).toHaveTextContent(/^900$/);
    expect(screen.getByTestId("b-memory")).toHaveTextContent(/^2097152$/);
    expect(calls()).toHaveLength(4);

    failed = false; usage = { cpuMillicores: 0, memoryBytes: 0 };
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });
    expect(screen.getByTestId("a-cpu")).toHaveTextContent(/^0$/);
    expect(screen.getByTestId("a-memory")).toHaveTextContent(/^0$/);
    expect(calls()).toHaveLength(6);
    rerender(<ObservedNode clusterId="a" metric="memory" />);
    expect(screen.getByTestId("a-memory")).toHaveTextContent(/^0$/);
    expect(nodeColumns.map((column) => readFilterValue(column, node, nodeContext("b")))).toEqual([undefined, undefined]);
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });
    expect(calls()).toHaveLength(7);
    expect(calls().at(-1)!.args.clusterId).toBe("a");
    expect(screen.getByTestId("a-memory")).toHaveTextContent(/^0$/);
    unmount();
    expect(nodeColumns.map((column) => readFilterValue(column, node, nodeContext("a")))).toEqual([undefined, undefined]);
    expect(nodeColumns.map((column) => readFilterValue(column, node, nodeContext("b")))).toEqual([undefined, undefined]);
    await act(async () => { await vi.advanceTimersByTimeAsync(IDLE_TTL_MS + POLL_INTERVAL_MS); });
    expect(calls()).toHaveLength(7);
    expect(metricsCacheStats()).toEqual({ entries: 0, podClusters: 0, nodeClusters: 0 });
  });

  it("shares the poller and handles missing data, recovery and explicit cluster scope", async () => {
    vi.useFakeTimers(); resetAppStore(); resetMetricsCache();
    useAppStore.getState().setNamespaces("a", null);
    useAppStore.getState().setNamespaces("b", null);
    useAppStore.getState().setActiveCluster("b");
    let failed = false;
    let cpu = 250;
    backend = mockBackend({ metrics_pods: ({ clusterId }) => {
      if (failed && clusterId === "a") throw { code: "network", message: "synthetic metrics unavailable" };
      return [{ namespace: "demo", name: "p", usage: { cpuMillicores: clusterId === "a" ? cpu : 900, memoryBytes: 0 }, containers: [] }];
    } });
    const { rerender, unmount } = render(<><Observed clusterId="a" /><Observed clusterId="a" /><Observed clusterId="b" /></>);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getAllByTestId("a").every((node) => node.textContent === "250")).toBe(true);
    expect(screen.getByTestId("b")).toHaveTextContent("900");
    expect(screen.getAllByTestId("a-memory").every((node) => node.textContent === "0")).toBe(true);
    expect(backend.calls.filter((call) => call.cmd === "metrics_pods")).toHaveLength(2);
    failed = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });
    expect(screen.getAllByTestId("a").every((node) => node.textContent === "undefined")).toBe(true);
    expect(screen.getByTestId("b")).toHaveTextContent("900");
    failed = false; cpu = 0;
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });
    expect(screen.getAllByTestId("a").every((node) => node.textContent === "0")).toBe(true);
    rerender(<Observed clusterId="a" />);
    expect(screen.getByTestId("a")).toHaveTextContent("0");
    unmount();
    expect(readFilterValue(podColumns[0]!, pod, { clusterId: "a", kind: { group: "", version: "v1", kind: "Pod" }, now: 0 })).toBeUndefined();
  });
});
