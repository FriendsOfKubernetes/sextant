import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWatch, type FieldManager, type KubeObject, type ObjectManagers, type ObjectRef, type WatchSpec, type WatchUpdate } from "../../api";
import { emitDelta, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { CATEGORY_SOURCES } from "../problems/sources";
import { acquireSource, resetProblemSources } from "../problems/store";
import { resetClustersStore, useClustersStore } from "../clusters/clustersStore";
import {
  baselineCount,
  clearTimeline,
  getTimeline,
  MAX_SAVED_BYTES,
  savedText,
  setMaxBaselines,
  timelineSaveError,
  type ChangeEntry,
  LOOKUP_DELAY_MS,
  MAX_BASELINE_CHARS,
  observe,
  resetRecorder,
  SAVE_DELAY_MS,
  setPersist,
  startRecorder,
} from "./recorder";

const snap = (items: KubeObject[]): WatchUpdate => ({ type: "snapshot", items: items as never[] });
const delta = (upserted: KubeObject[], deleted: string[] = []): WatchUpdate => ({ type: "delta", upserted: upserted as never[], deleted });


const NOW = Date.parse("2026-03-02T10:00:00Z");
const DEPLOYMENTS = CATEGORY_SOURCES.workloads[0]!;
const SPEC = (kind: string, group = "", version = "v1"): WatchSpec => ({
  kind: { group, version, kind },
  namespaces: null,
  labelSelector: null,
  fieldSelector: null,
});

function deployment(rv: number, replicas: number, extra: Record<string, unknown> = {}): KubeObject {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "web", namespace: "shop", uid: "d1", resourceVersion: String(rv), creationTimestamp: "2025-01-01T00:00:00Z", ...extra },
    spec: { replicas },
    status: { readyReplicas: replicas },
  };
}

let wb: WatchBackend;
let managers: Map<string, FieldManager[]>;

beforeEach(() => {
  resetRecorder(() => NOW);
  resetProblemSources();
  wb = watchBackend();
  managers = new Map();
  wb.backend.on("timeline_managers", (args) =>
    (args.refs as ObjectRef[]).map(
      (ref): ObjectManagers => ({
        object: ref,
        uid: "d1",
        resourceVersion: "1",
        managers: managers.get(ref.name) ?? [],
        error: null,
      }),
    ),
  );
  startRecorder();
});

afterEach(() => {
  vi.useRealTimers();
  resetProblemSources();
  resetClustersStore();
  resetRecorder();
  wb.backend.restore();
});

describe("the recorder", () => {
  it("records changes of the watches already open, with who made them", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // The problem sources' watch of Deployments: no watch of the timeline's own.
    acquireSource("c1", DEPLOYMENTS);
    const id = await watchOf(wb, "Deployment");
    const starts = () => wb.backend.calls.filter((c) => c.cmd === "watch_start").length;
    expect(starts()).toBe(1);

    emitSnapshot(wb, id, [deployment(10, 2)]);
    expect(getTimeline("c1")).toHaveLength(0);

    // A status-only update is not a change.
    const statusOnly = deployment(11, 2);
    (statusOnly.status as Record<string, unknown>).readyReplicas = 0;
    emitDelta(wb, id, [statusOnly]);
    expect(getTimeline("c1")).toHaveLength(0);

    managers.set("web", [
      { manager: "helm", operation: "Update", subresource: null, time: "2026-03-01T10:00:00Z" },
      { manager: "kubectl-scale", operation: "Update", subresource: "scale", time: "2026-03-02T09:59:59Z" },
    ]);
    emitDelta(wb, id, [deployment(12, 5)]);
    const [entry] = getTimeline("c1");
    expect(entry).toMatchObject({
      action: "updated",
      late: false,
      at: NOW,
      kind: { group: "apps", kind: "Deployment" },
      namespace: "shop",
      name: "web",
      changes: [{ path: "spec.replicas", op: "changed", before: "2", after: "5" }],
    });
    expect(entry!.who).toBeUndefined();
    await act(() => vi.advanceTimersByTimeAsync(LOOKUP_DELAY_MS + 10));
    await waitFor(() => expect(getTimeline("c1")[0]!.who).toBeDefined());
    // The first look can only guess: the most recent manager.
    expect(getTimeline("c1")[0]!.who).toEqual({ managers: [managers.get("web")![1]], exact: false });

    // The next change: the manager whose time moved.
    managers.set("web", [
      { manager: "helm", operation: "Update", subresource: null, time: "2026-03-02T10:05:00Z" },
      { manager: "kubectl-scale", operation: "Update", subresource: "scale", time: "2026-03-02T09:59:59Z" },
    ]);
    emitDelta(wb, id, [deployment(13, 5, { labels: { release: "2" } })]);
    await act(() => vi.advanceTimersByTimeAsync(LOOKUP_DELAY_MS + 10));
    await waitFor(() => expect(getTimeline("c1")[1]!.who).toBeDefined());
    expect(getTimeline("c1")[1]!.who).toEqual({ managers: [managers.get("web")![0]], exact: true });
    const lookups = wb.backend.calls.filter((c) => c.cmd === "timeline_managers");
    expect(lookups).toHaveLength(2);
    expect(starts()).toBe(1);
  });

  it("ignores older versions another watch delivers late, and the same version twice", () => {
    observe("c1", SPEC("Deployment", "apps"), snap([deployment(10, 2)]));
    observe("c1", SPEC("Deployment", "apps"), delta([deployment(12, 3)], []));
    observe("c1", SPEC("Deployment", "apps"), delta([deployment(11, 2)], []));
    observe("c1", SPEC("Deployment", "apps"), delta([deployment(12, 3)], []));
    expect(getTimeline("c1")).toHaveLength(1);
  });

  it("records creations and deletions of objects nothing owns, and changes seen in a fresh list as late", () => {
    const spec = SPEC("ConfigMap");
    const cm = (rv: number, data: Record<string, string>, created = "2026-03-02T09:58:00Z", owned = false): KubeObject => ({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: "settings",
        namespace: "shop",
        uid: "cm1",
        resourceVersion: String(rv),
        creationTimestamp: created,
        ...(owned ? { ownerReferences: [{ kind: "Thing", name: "x", controller: true }] } : {}),
      },
      data,
    });
    observe("c1", spec, snap([]));
    observe("c1", spec, delta([cm(1, { mode: "a" })], []));
    observe("c1", spec, snap([cm(2, { mode: "b" })]));
    observe("c1", spec, delta([], ["cm1"]));
    expect(getTimeline("c1").map((e) => [e.action, e.late])).toEqual([
      ["created", false],
      ["updated", true],
      ["deleted", false],
    ]);
    expect(getTimeline("c1")[2]!.who).toBeNull();
    // An old object first seen in a delta is not "created"; an owned one neither.
    observe("c1", spec, delta([{ ...cm(5, {}, "2020-01-01T00:00:00Z"), metadata: { ...cm(5, {}).metadata, uid: "old", creationTimestamp: "2020-01-01T00:00:00Z" } }], []));
    observe("c1", spec, delta([{ ...cm(6, {}, undefined, true), metadata: { ...cm(6, {}, undefined, true).metadata, uid: "owned" } }], ["owned"]));
    expect(getTimeline("c1")).toHaveLength(3);
  });

  it("takes a list in parts as a baseline and prunes with its end, unless a cap may have left objects out", () => {
    const spec = SPEC("ConfigMap");
    const cm = (uid: string, rv: number, mode: string): KubeObject => ({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: uid, namespace: "shop", uid, resourceVersion: String(rv), creationTimestamp: "2026-03-02T09:59:00Z" },
      data: { mode },
    });
    const part = (items: KubeObject[]): WatchUpdate => ({ type: "snapshotPart", items: items as never[] });
    const end = (items: KubeObject[], deleted: string[]): WatchUpdate => ({ type: "snapshotEnd", items: items as never[], deleted });
    const options = { progressive: true, maxObjects: 10 };
    observe("c1", spec, part([cm("a", 1, "x")]), options);
    observe("c1", spec, part([cm("b", 1, "x")]), options);
    observe("c1", spec, end([cm("c", 1, "x")], ["b"]), options);
    // Parts are no creations; the first change after them is recorded.
    expect(getTimeline("c1")).toHaveLength(0);
    observe("c1", spec, delta([cm("a", 2, "y")]), options);
    expect(getTimeline("c1").map((e) => [e.name, e.action])).toEqual([["a", "updated"]]);
    // A whole fresh list without "c" forgets it: its deletion later is not recorded.
    observe("c1", spec, snap([cm("a", 2, "y")]), options);
    observe("c1", spec, delta([], ["c"]), options);
    expect(getTimeline("c1")).toHaveLength(1);
    // A list as long as the cap may have left objects out: nothing is forgotten.
    observe("c1", spec, delta([cm("d", 1, "x")]), options);
    observe("c1", spec, snap([cm("a", 2, "y")]), { progressive: true, maxObjects: 1 });
    observe("c1", spec, delta([], ["d"]), options);
    expect(getTimeline("c1").map((e) => [e.name, e.action]).at(-1)).toEqual(["d", "deleted"]);
  });

  it("records nothing of churning kinds, metadata-only watches or a CronJob's runs", () => {
    const pod = (rv: number, image: string): KubeObject => ({
      metadata: { name: "p", namespace: "shop", uid: "p1", resourceVersion: String(rv) },
      spec: { containers: [{ name: "c", image }] },
    });
    observe("c1", SPEC("Pod"), snap([pod(1, "a")]));
    observe("c1", SPEC("Pod"), delta([pod(2, "b")], []));
    const meta = { ...SPEC("Deployment", "apps"), metadataOnly: true };
    observe("c1", meta, snap([{ metadata: { name: "web", uid: "d1", resourceVersion: "1" } }]));
    observe("c1", meta, delta([{ metadata: { name: "web", uid: "d1", resourceVersion: "2", labels: { a: "b" } } }], []));
    const run = (rv: number, parallelism: number): KubeObject => ({
      metadata: { name: "n-1", uid: "j1", resourceVersion: String(rv), ownerReferences: [{ kind: "CronJob", name: "n", controller: true }] },
      spec: { parallelism },
    });
    observe("c1", SPEC("Job", "batch"), snap([run(1, 1)]));
    observe("c1", SPEC("Job", "batch"), delta([run(2, 2)], ["j1"]));
    expect(getTimeline("c1")).toHaveLength(0);
  });

  it("keeps a huge object as a hash: the change is noticed without its fields", () => {
    const spec = SPEC("ConfigMap");
    const big = (rv: number, fill: string): KubeObject => ({
      metadata: { name: "big", namespace: "shop", uid: "b1", resourceVersion: String(rv) },
      data: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, fill.repeat(2000)])),
    });
    expect(JSON.stringify(big(1, "a")).length).toBeGreaterThan(MAX_BASELINE_CHARS);
    observe("c1", spec, snap([big(1, "a")]));
    observe("c1", spec, delta([big(2, "b")], []));
    expect(getTimeline("c1")).toMatchObject([{ action: "updated", summaryOnly: true, changes: [] }]);
  });

  it("sees the updates of useWatch (tables) too", async () => {
    renderHook(() => useWatch("c1", SPEC("Service")));
    const id = await watchOf(wb, "Service");
    const svc = (rv: number, port: number): KubeObject => ({
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "api", namespace: "shop", uid: "s1", resourceVersion: String(rv) },
      spec: { ports: [{ name: "http", port }] },
    });
    emitSnapshot(wb, id, [svc(1, 80)]);
    emitDelta(wb, id, [svc(2, 8080)]);
    expect(getTimeline("c1")[0]!.changes).toEqual([{ path: "spec.ports[http].port", op: "changed", before: "80", after: "8080" }]);
  });

  it("keeps the timeline in a file only when asked, and removes it when turned off", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const saved = new Map<string, string | null>();
    wb.backend.on("timeline_save", (args) => {
      saved.set(args.clusterId as string, args.text as string | null);
    });
    wb.backend.on("timeline_load", () => null);
    observe("c1", SPEC("Deployment", "apps"), snap([deployment(1, 1)]));
    observe("c1", SPEC("Deployment", "apps"), delta([deployment(2, 2)], []));
    await act(() => vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + LOOKUP_DELAY_MS + 100));
    expect(saved.size).toBe(0);

    await act(() => setPersist(true));
    expect(wb.backend.settings.timeline.persist).toBe(true);
    const doc = JSON.parse(saved.get("c1")!) as { version: number; cluster: string; entries: unknown[] };
    expect(doc).toMatchObject({ version: 1, cluster: "c1" });
    expect(doc.entries).toHaveLength(1);

    clearTimeline("c1");
    expect(getTimeline("c1")).toHaveLength(0);
    await act(() => setPersist(false));
    expect(saved.get("c1")).toBeNull();
    expect(wb.backend.settings.timeline.persist).toBe(false);
  });

  it("forgets objects a fresh list no longer has, and the least recently seen past the cap", () => {
    const spec = { ...SPEC("ConfigMap"), namespaces: ["shop"] };
    const cm = (uid: string, rv: number, ns = "shop", mode = "a"): KubeObject => ({
      metadata: { name: uid, namespace: ns, uid, resourceVersion: String(rv) },
      data: { mode },
    });
    observe("c1", spec, snap([cm("a", 1), cm("b", 1)]));
    observe("c1", SPEC("ConfigMap"), snap([cm("a", 1), cm("b", 1), cm("other", 1, "blog")]));
    expect(baselineCount("c1")).toBe(3);
    // Deleted while nothing watched: the namespace's next list lacks it; another namespace's object stays.
    observe("c1", spec, snap([cm("a", 2)]));
    expect(baselineCount("c1")).toBe(2);
    // Coming back is a new object, not a change of a forgotten one.
    observe("c1", spec, snap([cm("a", 2), cm("b", 9, "shop", "z")]));
    expect(getTimeline("c1")).toHaveLength(0);

    setMaxBaselines(3);
    observe("c1", SPEC("ConfigMap"), delta([cm("a", 3, "shop", "seen")]));
    observe("c1", SPEC("ConfigMap"), delta([cm("new", 1)]));
    // `other` was seen least recently: forgotten for the new one, which is followed.
    expect(baselineCount("c1")).toBe(3);
    observe("c1", SPEC("ConfigMap"), delta([cm("new", 2, "shop", "b")]));
    expect(getTimeline("c1").at(-1)).toMatchObject({ name: "new", action: "updated" });
    observe("c1", SPEC("ConfigMap"), delta([cm("other", 2, "blog", "changed")]));
    expect(getTimeline("c1").some((e) => e.name === "other")).toBe(false);
  });

  it("does not take leaving a narrowed list for a deletion", () => {
    const labelled = { ...SPEC("ConfigMap"), labelSelector: "app=web" };
    const cm: KubeObject = { metadata: { name: "c", namespace: "shop", uid: "c1", resourceVersion: "1" }, data: { a: "1" } };
    observe("c1", labelled, snap([cm]));
    observe("c1", labelled, delta([], ["c1"]));
    const byField = { ...SPEC("Deployment", "apps"), fieldSelector: "status.replicas=0" };
    observe("c1", byField, snap([deployment(1, 0)]));
    observe("c1", byField, delta([], ["d1"]));
    expect(getTimeline("c1")).toHaveLength(0);
    // A list of one object by name does tell its deletion.
    const byName = { ...SPEC("ConfigMap"), fieldSelector: "metadata.name=c" };
    observe("c1", byName, snap([cm]));
    observe("c1", byName, delta([], ["c1"]));
    expect(getTimeline("c1").map((e) => e.action)).toEqual(["deleted"]);
  });

  it("forgets a cluster when it disconnects, saving its changes first while persistence is on", async () => {
    const saved: (string | null)[] = [];
    wb.backend.on("timeline_save", (args) => {
      saved.push(args.text as string | null);
    });
    wb.backend.on("timeline_load", () => null);
    act(() => useClustersStore.setState({ states: { c1: { state: "connected" } as never } }));
    observe("c1", SPEC("Deployment", "apps"), snap([deployment(1, 1)]));
    observe("c1", SPEC("Deployment", "apps"), delta([deployment(2, 2)]));
    await act(() => setPersist(true));
    saved.length = 0;
    act(() => useClustersStore.setState({ states: { c1: { state: "disconnected" } as never } }));
    expect(getTimeline("c1")).toHaveLength(0);
    expect(baselineCount("c1")).toBe(0);
    await waitFor(() => expect(saved).toHaveLength(1));
    expect((JSON.parse(saved[0]!) as { entries: unknown[] }).entries).toHaveLength(1);
  });

  it("saves the newest changes that fit the file, one write at a time, and tells when a save fails", async () => {
    const long = "é".repeat(150_000);
    const entries = Array.from({ length: 40 }, (_, i): ChangeEntry => ({
      id: i,
      at: i,
      late: false,
      action: "updated",
      kind: { group: "", version: "v1", kind: "ConfigMap" },
      namespace: "shop",
      name: `cm-${i}`,
      uid: `u${i}`,
      changes: [{ path: "data.x", op: "changed", before: long, after: long }],
      more: 0,
      who: null,
    }));
    const text = savedText("c1", entries);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(MAX_SAVED_BYTES);
    const kept = (JSON.parse(text) as { entries: ChangeEntry[] }).entries;
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(40);
    expect(kept.at(-1)!.name).toBe("cm-39");

    let running = 0;
    let most = 0;
    const order: string[] = [];
    wb.backend.on("timeline_load", () => null);
    wb.backend.on("timeline_save", async (args) => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 20));
      order.push(args.text === null ? "remove" : "write");
      running--;
    });
    observe("c1", SPEC("Deployment", "apps"), snap([deployment(1, 1)]));
    observe("c1", SPEC("Deployment", "apps"), delta([deployment(2, 2)]));
    await act(() => setPersist(true));
    expect(order).toEqual(["write"]);
    // Two writes of one cluster at once: the second waits for the first.
    act(() => {
      clearTimeline("c1");
      clearTimeline("c1");
    });
    await waitFor(() => expect(order).toEqual(["write", "remove", "remove"]));
    expect(most).toBe(1);

    wb.backend.on("timeline_save", () => {
      throw { code: "invalid", message: "too big" };
    });
    observe("c1", SPEC("Deployment", "apps"), delta([deployment(3, 3)]));
    await act(() => setPersist(true));
    expect(timelineSaveError()?.message).toBe("too big");

    let removedAll = 0;
    wb.backend.on("timeline_remove_all", () => {
      removedAll++;
    });
    await act(() => setPersist(false));
    expect(removedAll).toBe(1);
    expect(timelineSaveError()).toBeNull();
  });
});
