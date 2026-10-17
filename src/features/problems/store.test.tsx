import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KubeObject } from "../../api";
import { resetClustersStore, useClustersStore } from "../clusters/clustersStore";
import { emitDelta, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { useProblemSources } from "./hooks";
import type { ProblemCategory } from "./model";
import { CATEGORY_SOURCES, sourceKey } from "./sources";
import { acquireSource, getSource, LINGER_MS, MAX_PROBLEM_OBJECTS, resetProblemSources } from "./store";

const PODS = CATEGORY_SOURCES.pods[0]!;

function pod(i: number, waiting?: string): KubeObject {
  return {
    metadata: { name: `p${i}`, namespace: "demo", uid: `uid-${i}`, creationTimestamp: new Date(1_700_000_000_000 + i * 1000).toISOString() },
    status: {
      phase: "Running",
      conditions: [{ type: "Ready", status: waiting ? "False" : "True" }],
      containerStatuses: [{ name: "app", state: waiting ? { waiting: { reason: waiting } } : { running: {} } }],
    },
  };
}

let wb: WatchBackend;

beforeEach(() => {
  resetProblemSources();
  wb = watchBackend();
});

afterEach(() => {
  vi.useRealTimers();
  resetProblemSources();
  resetClustersStore();
  wb.backend.restore();
});

const starts = () => wb.backend.calls.filter((c) => c.cmd === "watch_start").length;
const stops = () => wb.backend.calls.filter((c) => c.cmd === "watch_stop").length;

describe("problem sources", () => {
  it("share one watch between users and close it a while after the last one leaves", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const a = acquireSource("c1", PODS);
    const b = acquireSource("c1", PODS);
    await watchOf(wb, "Pod");
    expect(starts()).toBe(1);
    a();
    b();
    // A user coming back within the linger reuses it.
    await act(() => vi.advanceTimersByTimeAsync(LINGER_MS / 2));
    const c = acquireSource("c1", PODS);
    await act(() => vi.advanceTimersByTimeAsync(LINGER_MS * 2));
    expect(starts()).toBe(1);
    expect(stops()).toBe(0);
    c();
    await act(() => vi.advanceTimersByTimeAsync(LINGER_MS + 100));
    await waitFor(() => expect(stops()).toBe(1));
    expect(getSource(sourceKey("c1", PODS))).toBeUndefined();
  });

  it("keep only the problems, and at most a bounded number of objects with them", async () => {
    acquireSource("c1", PODS);
    const id = await watchOf(wb, "Pod");
    const healthy = Array.from({ length: 50 }, (_, i) => pod(100_000 + i));
    const broken = Array.from({ length: MAX_PROBLEM_OBJECTS + 10 }, (_, i) => pod(i, "CrashLoopBackOff"));
    emitSnapshot(wb, id, [...healthy, ...broken]);
    const state = getSource(sourceKey("c1", PODS))!;
    expect(state.status).toBe("ready");
    expect(state.problems).toHaveLength(MAX_PROBLEM_OBJECTS);
    expect(state.truncated).toBe(true);
    // The oldest went.
    expect(state.problems.some((p) => p.object.name === "p0")).toBe(false);
    expect(state.problems.some((p) => p.object.name === `p${MAX_PROBLEM_OBJECTS + 9}`)).toBe(true);
  });

  it("follow deltas: a recovered object leaves, an update of a healthy one changes nothing", async () => {
    acquireSource("c1", PODS);
    const id = await watchOf(wb, "Pod");
    emitSnapshot(wb, id, [pod(1, "ImagePullBackOff"), pod(2)]);
    const before = getSource(sourceKey("c1", PODS))!;
    expect(before.problems.map((p) => p.reason)).toEqual(["ImagePullBackOff"]);
    emitDelta(wb, id, [pod(2)]);
    expect(getSource(sourceKey("c1", PODS))).toBe(before);
    emitDelta(wb, id, [pod(1)]);
    expect(getSource(sourceKey("c1", PODS))!.problems).toEqual([]);
  });

  it("drop a cluster's watches when it disconnects, and watch afresh when it connects again", async () => {
    const PODS_ONLY: ProblemCategory[] = ["pods"];
    useClustersStore.setState({ states: { c1: { state: "connected" } } });
    function Watcher() {
      useProblemSources("c1", PODS_ONLY);
      return null;
    }
    render(<Watcher />);
    emitSnapshot(wb, await watchOf(wb, "Pod"), [pod(1, "CrashLoopBackOff")]);
    expect(getSource(sourceKey("c1", PODS))!.problems).toHaveLength(1);

    // The backend closed the cluster's watches: the source goes at once, not after the linger.
    act(() => useClustersStore.setState({ states: { c1: { state: "disconnected" } } }));
    expect(getSource(sourceKey("c1", PODS))?.problems ?? []).toEqual([]);
    await waitFor(() => expect(stops()).toBe(1));
    // Nothing is watched while it is away.
    const startsBefore = starts();
    expect(startsBefore).toBe(1);
    act(() => useClustersStore.setState({ states: { c1: { state: "connected" } } }));
    await waitFor(() => expect(starts()).toBe(2));
    const state = getSource(sourceKey("c1", PODS))!;
    expect(state.status).toBe("loading");
    expect(state.problems).toEqual([]);
  });
});
