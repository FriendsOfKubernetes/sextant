import { SextantError, type KubeObject, type WatchParams } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestHostOptions, type TestWatch } from "@sextant/extension-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixtures from "../fixtures/objects.json";
import { startDaemons } from "./daemons";
import { startMetrics } from "./metrics";
import { startPage } from "./page";
import { startStatus } from "./status";
import { startStorage } from "./storageView";

const ALL = [
  ...fixtures.clusters,
  ...fixtures.pools,
  ...fixtures.filesystems,
  ...fixtures.objectStores,
  ...fixtures.others,
  ...fixtures.storageClasses,
  ...fixtures.pvcs,
  ...fixtures.objectBucketClaims,
  ...fixtures.pods,
] as unknown as KubeObject[];

const ROOK_KINDS = ["CephCluster", "CephBlockPool", "CephFilesystem", "CephObjectStore", "CephObjectStoreUser", "CephNFS", "CephClient"];
const servedKinds = (rook = true) => [
  ...(rook ? ROOK_KINDS.map((kind) => ({ group: "ceph.rook.io", version: "v1", kind })) : []),
  ...(rook ? ["ObjectBucketClaim", "ObjectBucket"].map((kind) => ({ group: "objectbucket.io", version: "v1alpha1", kind })) : []),
  { group: "", version: "v1", kind: "Pod" },
  { group: "", version: "v1", kind: "PersistentVolumeClaim" },
  { group: "storage.k8s.io", version: "v1", kind: "StorageClass" },
].map((kindRef) => ({ kindRef, plural: "", namespaced: kindRef.kind !== "StorageClass", verbs: ["list", "watch"], printerColumns: [] }));

const ref = (object: { apiVersion: string; kind: string; metadata: { name: string; namespace?: string } }) => ({
  kind: { group: object.apiVersion.includes("/") ? object.apiVersion.split("/")[0]! : "", version: object.apiVersion.split("/").pop()!, kind: object.kind },
  namespace: object.metadata.namespace ?? null,
  name: object.metadata.name,
});
const CLUSTER = fixtures.clusters[0]!;

/** The fixtures a watch asks for: its kind, namespaces and an `app=` or `app in (…)` label selector. */
function matching(params: WatchParams): KubeObject[] {
  return ALL.filter((o) => {
    if (o.kind !== params.kind.kind) return false;
    if (params.namespaces && !params.namespaces.includes(o.metadata.namespace ?? "")) return false;
    const app = /^app=(.+)$/.exec(params.labelSelector ?? "")?.[1];
    return !app || o.metadata.labels?.app === app;
  });
}

let host: TestHost;
let root: HTMLElement;
let stop: () => void = () => undefined;

async function start(options: TestHostOptions & { rook?: boolean } = {}) {
  host = await startTestHost({
    ...options,
    handlers: {
      kinds: () => servedKinds(options.rook ?? true),
      "resources.get": ({ ref: r }) => ALL.find((o) => o.kind === r.kind.kind && o.metadata.name === r.name && (o.metadata.namespace ?? null) === r.namespace),
      "resources.list": (params) => ({ items: matching({ ...params, namespaces: params.namespace ? [params.namespace] : undefined }), truncated: false }),
      ...options.handlers,
    },
  });
  root = document.createElement("main");
  document.body.append(root);
}

/** Answers every watch opened so far (and not answered yet) with its fixtures. */
const answered = new Set<TestWatch>();
async function answerWatches() {
  await expect.poll(() => host.watches.length).toBeGreaterThan(0);
  await new Promise((r) => setTimeout(r, 0));
  for (const watch of host.watches) {
    if (answered.has(watch)) continue;
    answered.add(watch);
    watch.emit({ type: "snapshot", items: matching(watch.params as WatchParams) as never[] });
  }
}
const text = () => root.textContent ?? "";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-10-30T10:01:10Z"));
});
afterEach(() => {
  stop();
  root?.remove();
  host?.close();
  answered.clear();
  vi.useRealTimers();
});

describe("the Rook Ceph page", () => {
  it("shows each cluster's health and the objects on Ceph", async () => {
    await start({ context: { view: "page", contribution: "overview" } });
    stop = startPage(host.sextant, root);
    await answerWatches();
    await expect.poll(() => root.querySelectorAll(".card").length).toBe(2);
    const card = root.querySelector(".card")!;
    expect(card.textContent).toContain("HEALTH_WARN");
    expect(card.textContent).toContain("OSD_DOWN 1 osds down");
    expect(card.textContent).toContain("Rook checked Ceph's health 2 minutes ago");
    expect(card.textContent).toContain("90 GiB used of 300 GiB raw (30%), 210 GiB available.");
    expect(text()).toContain("rook-ceph-block (1 claim)");
    expect(text()).toContain("rook-ceph-delete-bucket (1 claim)");
    expect(text()).toContain("pool replicapool");
    expect(text()).not.toContain("local-path-example");
    expect([...root.querySelectorAll("tr")].find((r) => r.textContent?.includes("my-store"))?.textContent).toContain("Progressing");
  });

  it("follows the namespace filter for Rook's objects only", async () => {
    await start({ context: { view: "page", contribution: "overview", namespaces: ["rook-ceph-external"] } });
    stop = startPage(host.sextant, root);
    await answerWatches();
    const params = host.watches.map((w) => w.params as WatchParams);
    expect(params.find((p) => p.kind.kind === "CephCluster")?.namespaces).toEqual(["rook-ceph-external"]);
    expect(params.find((p) => p.kind.kind === "PersistentVolumeClaim")?.namespaces).toBeUndefined();
    await expect.poll(() => root.querySelectorAll(".card").length).toBe(1);
    expect(root.querySelector(".card")!.textContent).toContain("External");
  });

  it("says when Rook is not installed and watches none of its kinds", async () => {
    await start({ context: { view: "page", contribution: "overview" }, rook: false });
    stop = startPage(host.sextant, root);
    await answerWatches();
    await expect.poll(text).toContain("Rook is not installed here");
    expect(host.watches.map((w) => (w.params as WatchParams).kind.kind).sort()).toEqual(["PersistentVolumeClaim", "StorageClass"]);
  });

  it("marks a status nobody has refreshed as stale", async () => {
    vi.setSystemTime(Date.parse("2026-10-30T10:30:00Z"));
    await start({ context: { view: "page", contribution: "overview" } });
    stop = startPage(host.sextant, root);
    await answerWatches();
    await expect.poll(() => root.querySelector(".card")?.textContent).toContain("Stale");
    expect(root.querySelector(".card")!.textContent).toContain("the Rook operator may not be running");
  });
});

describe("Ceph status", () => {
  it("explains the health checks, the versions and the toolbox", async () => {
    await start({ context: { view: "details", contribution: "status", selection: [ref(CLUSTER)], resourceVersion: "4021" } });
    stop = startStatus(host.sextant, root);
    await expect.poll(() => root.querySelector(".checks")?.children.length).toBe(3);
    const items = [...root.querySelectorAll(".checks > li")].map((li) => li.textContent ?? "");
    expect(items[1]).toContain("OSD_DOWN");
    expect(items[1]).toContain("their data is served by the other copies");
    expect(items[0]).toBe("WarningNEW_CHECK_FROM_A_LATER_CEPHsomething newer");
    expect(text()).toContain("The daemons run 2 Ceph versions (20.2.0 tentacle (stable): 3; 19.2.3 squid (stable): 1)");
    await expect.poll(text).toContain("Toolbox: rook-ceph-tools-6c7d8e9f0-st45u");
    root.querySelector<HTMLButtonElement>("section:last-child button.link")!.click();
    await expect.poll(() => host.calls.find((c) => c.method === "ui.openDetails")?.params).toMatchObject({
      kind: { kind: "Pod" },
      namespace: "rook-ceph",
      name: "rook-ceph-tools-6c7d8e9f0-st45u",
    });
    expect(root.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("30.0");
  });

  it("says how to start a toolbox when there is none", async () => {
    const other = fixtures.clusters[1]!;
    await start({ context: { view: "details", contribution: "status", selection: [ref(other)], resourceVersion: "77" } });
    stop = startStatus(host.sextant, root);
    await expect.poll(text).toContain("No toolbox runs here");
    expect(text()).toContain("Ceph reports no health checks.");
    expect(root.querySelector("code")?.textContent).toBe("deploy/examples/toolbox.yaml");
  });
});

describe("Daemons", () => {
  it("lists the components with their ready pods and the OSDs by node", async () => {
    await start({ context: { view: "details", contribution: "daemons", selection: [ref(CLUSTER)] } });
    stop = startDaemons(host.sextant, root);
    await answerWatches();
    await expect.poll(() => root.querySelectorAll("section").length).toBe(6);
    const heads = [...root.querySelectorAll("section > h3")].map((h) => h.textContent);
    expect(heads).toEqual([
      "Operator 1 of 1 ready",
      "Monitors 1 of 1 ready",
      "Managers 1 of 1 ready",
      "OSDs 1 of 2 ready",
      "Metadata servers (CephFS) 1 of 1 ready",
      "CSI drivers 3 of 3 ready",
    ]);
    expect([...root.querySelectorAll("h4")].map((h) => h.textContent)).toEqual(["kind-worker (1 of 1 ready)", "kind-worker2 (0 of 1 ready)"]);
    expect(text()).toContain("CrashLoopBackOff");
    expect(text()).not.toContain("unrelated");
  });

  it("warns when no operator pod is found", async () => {
    await start({
      context: { view: "details", contribution: "daemons", selection: [ref(CLUSTER)] },
      handlers: { kinds: () => servedKinds() },
    });
    stop = startDaemons(host.sextant, root);
    await expect.poll(() => host.watches.length).toBe(2);
    for (const watch of host.watches) {
      const items = matching(watch.params as WatchParams).filter((o) => o.metadata.labels?.app !== "rook-ceph-operator");
      watch.emit({ type: "snapshot", items: items as never[] });
    }
    await expect.poll(text).toContain("No Rook operator pod");
  });
});

describe("Metrics", () => {
  const series = (labels: Record<string, string>, values: number[]) => ({
    labels,
    points: values.map((v, i) => [1_000 + i * 900, v] as [number, number]),
  });
  const answers: Record<string, unknown> = {
    health: { resultType: "matrix", series: [series({}, [0, 1, 1])], truncated: false },
    capacity: {
      resultType: "matrix",
      series: [series({ __name__: "ceph_cluster_total_bytes" }, [300, 300, 300]), series({ __name__: "ceph_cluster_total_used_raw_bytes" }, [90, 95, 100])],
      truncated: false,
    },
    osds: {
      resultType: "matrix",
      series: [series({ state: "up" }, [2, 1, 1]), series({ state: "in" }, [2, 2, 2]), series({ state: "total" }, [2, 2, 2])],
      truncated: false,
    },
    pgs: { resultType: "matrix", series: [series({ __name__: "ceph_pg_total" }, [49, 49, 49])], truncated: false },
  };

  it("runs the manifest's queries for the cluster's namespace and draws them", async () => {
    await start({
      context: { view: "details", contribution: "metrics", selection: [ref(CLUSTER)] },
      handlers: { "metrics.query": ({ id }) => answers[id] },
    });
    stop = startMetrics(host.sextant, root);
    await expect.poll(() => root.querySelectorAll("figure").length).toBe(4);
    const calls = host.calls.filter((c) => c.method === "metrics.query").map((c) => c.params);
    expect(calls).toEqual(
      ["health", "capacity", "osds", "pgs"].map((id) => ({
        clusterId: "test-cluster",
        id,
        params: { namespace: "rook-ceph" },
        range: { minutes: 1440, step: "15m" },
      })),
    );
    expect(root.querySelector("figure svg")?.getAttribute("aria-label")).toBe("Ceph health: Health HEALTH_WARN");
    expect(root.querySelectorAll("figure")[2]!.textContent).toContain("Up 1");
    [...root.querySelectorAll("button")].find((b) => b.textContent === "7 days")!.click();
    await expect.poll(() => host.calls.filter((c) => c.method === "metrics.query").length).toBe(8);
    expect(host.calls.at(-1)!.params).toMatchObject({ range: { minutes: 10080, step: "1h" } });
    await expect.poll(() => host.storage.get("metricsRange")).toBe("7d");
  });

  it("says when there is no Prometheus-compatible source", async () => {
    await start({
      context: { view: "details", contribution: "metrics", selection: [ref(CLUSTER)] },
      handlers: {
        "metrics.query": () => {
          throw new SextantError("notFound", "no source");
        },
      },
    });
    stop = startMetrics(host.sextant, root);
    await expect.poll(text).toContain("no Prometheus-compatible source");
  });
});

describe("Storage classes and claims", () => {
  it("lists a pool's StorageClasses and the claims on them", async () => {
    const pool = fixtures.pools[0]!;
    await start({ context: { view: "details", contribution: "storage", selection: [ref(pool)], resourceVersion: "1" } });
    stop = startStorage(host.sextant, root);
    await answerWatches();
    await expect.poll(() => root.querySelector("tbody")?.textContent).toContain("rbd-pvc");
    expect(text()).toContain("StorageClass: rook-ceph-block");
    expect(root.querySelector("tbody")!.textContent).toBe("rbd-pvcdefaultrook-ceph-blockBound1Gi");
  });

  it("lists an object store's bucket claims", async () => {
    const store = fixtures.objectStores[0]!;
    await start({ context: { view: "details", contribution: "storage", selection: [ref(store)], resourceVersion: "1" } });
    stop = startStorage(host.sextant, root);
    await answerWatches();
    await expect.poll(() => root.querySelector("tbody")?.textContent).toContain("ceph-delete-bucket");
    expect((host.watches.map((w) => w.params as WatchParams).find((p) => p.kind.group === "objectbucket.io"))?.kind.kind).toBe("ObjectBucketClaim");
  });

  it("says when nothing puts volumes on it", async () => {
    const pool = fixtures.pools[1]!;
    await start({ context: { view: "details", contribution: "storage", selection: [ref(pool)], resourceVersion: "1" } });
    stop = startStorage(host.sextant, root);
    await answerWatches();
    await expect.poll(text).toContain("No StorageClass puts volumes here");
  });
});
