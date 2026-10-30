import { SextantError, type KubeObject, type WatchParams } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestHostOptions, type TestWatch } from "@sextant/extension-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixtures from "../fixtures/objects.json";
import { startAction } from "./actions";
import { startDaemons } from "./daemons";
import { startNodeTopology } from "./nodeTopology";
import { startOsds } from "./osds";
import { setLanguage, t } from "./i18n";
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

/** OSD Deployments as Rook labels them: osd.0 running on kind-worker, osd.1 stopped on kind-worker2. */
const OSD_DEPLOYMENTS = [0, 1].map((id) => ({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: {
    name: `rook-ceph-osd-${id}`,
    namespace: "rook-ceph",
    resourceVersion: `90${id}`,
    labels: {
      app: "rook-ceph-osd",
      "ceph-osd-id": String(id),
      "device-class": "hdd",
      "topology-location-root": "default",
      "topology-location-host": id ? "kind-worker2" : "kind-worker",
      ...(id ? { "ceph.rook.io/do-not-reconcile": "true" } : {}),
    },
  },
  spec: { replicas: id ? 0 : 1 },
  status: { readyReplicas: id ? 0 : 1 },
})) as unknown as KubeObject[];
const NODE = {
  apiVersion: "v1",
  kind: "Node",
  metadata: { name: "kind-worker", resourceVersion: "55", labels: { "kubernetes.io/hostname": "kind-worker", "topology.rook.io/rack": "rack1" } },
} as unknown as KubeObject;
ALL.push(...OSD_DEPLOYMENTS, NODE);

const ROOK_KINDS = ["CephCluster", "CephBlockPool", "CephFilesystem", "CephObjectStore", "CephObjectStoreUser", "CephNFS", "CephClient"];
const servedKinds = (rook = true) => [
  ...(rook ? ROOK_KINDS.map((kind) => ({ group: "ceph.rook.io", version: "v1", kind })) : []),
  ...(rook ? ["ObjectBucketClaim", "ObjectBucket"].map((kind) => ({ group: "objectbucket.io", version: "v1alpha1", kind })) : []),
  { group: "", version: "v1", kind: "Pod" },
  { group: "", version: "v1", kind: "PersistentVolumeClaim" },
  { group: "storage.k8s.io", version: "v1", kind: "StorageClass" },
  { group: "apps", version: "v1", kind: "Deployment" },
  { group: "batch", version: "v1", kind: "Job" },
  { group: "", version: "v1", kind: "Node" },
].map((kindRef) => ({ kindRef, plural: "", namespaced: !["StorageClass", "Node"].includes(kindRef.kind), verbs: ["list", "watch"], printerColumns: [] }));

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
  setLanguage("en");
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

  it("speaks the UI language, numbers and plurals included", async () => {
    setLanguage("ru");
    await start({ context: { view: "page", contribution: "overview", language: "ru" } });
    stop = startPage(host.sextant, root);
    await answerWatches();
    await expect.poll(() => root.querySelector("h1")?.textContent).toBe(t("page.title"));
    expect(t("page.storageTitle")).not.toBe("Pools, filesystems and object stores");
    expect(text()).toContain(t("page.storageTitle"));
    expect(text()).toContain(t("page.classesWithClaims", { classes: "rook-ceph-block", count: 1 }));
    // The binary unit symbols are not translated.
    expect(root.querySelector(".card")!.textContent).toContain("90 GiB");
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
    expect(items[0]).toBe("WarningNEW_CHECK_FROM_A_LATER_CEPHsomething newerMute");
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

/** The patches, applies and deletes the frame sent, in order. */
const changes = () => host.calls.filter((c) => /^resources\.(patch|apply|delete)$/.test(c.method));
const button = (label: string) => [...root.querySelectorAll("button")].find((b) => b.textContent === label || b.getAttribute("aria-label") === label);
const CHANGE_HANDLERS = {
  "resources.patch": () => ({}),
  "resources.apply": () => [],
  "resources.delete": () => null,
};

describe("managing a cluster", () => {
  it("mutes a health check with the resourceVersion it was shown with", async () => {
    await start({ context: { view: "details", contribution: "status", selection: [ref(CLUSTER)], resourceVersion: "4021" }, handlers: CHANGE_HANDLERS });
    stop = startStatus(host.sextant, root);
    await expect.poll(() => root.querySelectorAll(".checks > li").length).toBe(3);
    const osdDown = [...root.querySelectorAll(".checks > li")].find((li) => li.textContent?.includes("OSD_DOWN"))!;
    osdDown.querySelector("button")!.click();
    await expect.poll(() => changes()[0]?.params).toMatchObject({
      ref: { name: "my-cluster" },
      patchType: "merge",
      patch: { spec: { healthCheck: { muteHealthWarning: { OSD_DOWN: { policy: "mute" } } } }, metadata: { resourceVersion: "4021" } },
    });
  });

  it("refuses a Ceph upgrade the checks block, and sends the image otherwise", async () => {
    const healthy = structuredClone(CLUSTER) as unknown as KubeObject & { status: { ceph: Record<string, unknown> } };
    healthy.status.ceph.health = "HEALTH_OK";
    healthy.status.ceph.versions = { overall: { "ceph version 20.2.1 (x) tentacle (stable)": 4 } };
    await start({ context: { view: "action", contribution: "upgrade", selection: [ref(CLUSTER)] }, handlers: { ...CHANGE_HANDLERS, "resources.get": () => healthy } });
    stop = startAction(host.sextant, root, "upgrade");
    await expect.poll(() => root.querySelector("input")).not.toBeNull();
    const input = root.querySelector("input")!;
    const apply = button("Upgrade")!;
    expect(apply.disabled).toBe(true);
    input.value = "quay.io/ceph/ceph:v19.2.3";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(text()).toContain("Upgrading is not possible until the blocking checks pass.");
    expect(apply.disabled).toBe(true);
    input.value = "quay.io/ceph/ceph:v20.2.4-20260818";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(apply.disabled).toBe(false);
    apply.click();
    await expect.poll(() => host.closedByFrame).toBe(true);
    expect(changes()).toHaveLength(1);
    expect(changes()[0]!.params).toMatchObject({ patch: { spec: { cephVersion: { image: "quay.io/ceph/ceph:v20.2.4-20260818" } } } });
    expect(host.notices).toEqual(["my-cluster: Rook upgrades Ceph to quay.io/ceph/ceph:v20.2.4-20260818"]);
  });
});

describe("CRUSH and OSDs", () => {
  const operator = { ...fixtures.pods[0], spec: { containers: [{ name: "rook-ceph-operator", image: "docker.io/rook/ceph:v1.21.1" }] } };
  const metric = (series: [string, string, number][]) => ({
    resultType: "vector",
    truncated: false,
    series: series.map(([name, daemon, value]) => ({ labels: { __name__: name, ...(daemon ? { ceph_daemon: daemon } : {}) }, points: [[1, value]] })),
  });

  async function startTab(pgsClean: boolean) {
    await start({
      context: { view: "details", contribution: "osds", selection: [ref(CLUSTER)], resourceVersion: "4021" },
      handlers: {
        ...CHANGE_HANDLERS,
        "resources.list": (params) =>
          params.labelSelector === "app=rook-ceph-operator"
            ? { items: [operator], truncated: false }
            : { items: matching({ ...params, namespaces: params.namespace ? [params.namespace] : undefined }), truncated: false },
        "metrics.query": ({ id }) =>
          id === "pgs"
            ? metric([["ceph_pg_total", "", 49], ["ceph_pg_active", "", 49], ["ceph_pg_clean", "", pgsClean ? 49 : 30]])
            : metric([["ceph_osd_up", "osd.0", 1], ["ceph_osd_in", "osd.0", 1], ["ceph_osd_stat_bytes", "osd.0", 100 * 2 ** 30], ["ceph_osd_stat_bytes_used", "osd.0", 25 * 2 ** 30]]),
      },
    });
    stop = startOsds(host.sextant, root);
    await answerWatches();
    await expect.poll(() => root.querySelectorAll(".crush-osd").length).toBe(2);
  }

  it("draws the tree from the Deployments' labels and stops an OSD as Rook's guide does", async () => {
    await startTab(true);
    expect([...root.querySelectorAll(".crush-bucket")].map((b) => b.textContent)).toEqual(["root default", "host kind-worker", "host kind-worker2"]);
    await expect.poll(() => root.querySelector(".crush-osd")?.textContent).toContain("25 GiB / 100 GiB (25%)");
    button("Stop osd.0")!.click();
    await expect.poll(() => changes()[0]?.params).toMatchObject({
      ref: { kind: { group: "apps", kind: "Deployment" }, namespace: "rook-ceph", name: "rook-ceph-osd-0" },
      patch: { metadata: { labels: { "ceph.rook.io/do-not-reconcile": "true" }, resourceVersion: "900" }, spec: { replicas: 0 } },
    });
  });

  it("removes a stopped OSD with Rook's purge Job only when the placement groups are clean", async () => {
    await startTab(false);
    const box = root.querySelector<HTMLDetailsElement>(".remove-osd")!;
    expect(box.textContent).toContain("osd.1");
    expect(button("Remove osd.1")!.disabled).toBe(false);
    expect(box.textContent).toMatch(/not (all )?(active and )?clean|clean/i);
    stop();
    root.replaceChildren();
    await startTab(true);
    button("Remove osd.1")!.click();
    await expect.poll(() => changes()[0]?.method).toBe("resources.apply");
    const job = JSON.parse((changes()[0]!.params as { yaml: string }).yaml);
    expect(job.metadata.name).toBe("rook-ceph-purge-osd-1");
    expect(job.spec.template.spec.containers[0].image).toBe("docker.io/rook/ceph:v1.21.1");
    expect(job.spec.template.spec.containers[0].args).toContain("--force-osd-removal");
  });
});

describe("a node's Rook Ceph topology", () => {
  it("changes only the CRUSH labels and refuses names CRUSH does not take", async () => {
    await start({ context: { view: "details", contribution: "topology", selection: [ref(NODE as never)], resourceVersion: "55" }, handlers: CHANGE_HANDLERS });
    stop = startNodeTopology(host.sextant, root);
    await expect.poll(() => root.querySelectorAll("input").length).toBeGreaterThan(5);
    const inputs = [...root.querySelectorAll("input")];
    const rack = inputs.find((i) => i.value === "rack1")!;
    const apply = button("Apply")!;
    expect(apply.disabled).toBe(true);
    rack.value = "rack 2";
    rack.dispatchEvent(new Event("input", { bubbles: true }));
    expect(text()).toContain("rack 2 is not a CRUSH name");
    expect(apply.disabled).toBe(true);
    rack.value = "rack2";
    rack.dispatchEvent(new Event("input", { bubbles: true }));
    apply.click();
    await expect.poll(() => changes()[0]?.params).toMatchObject({
      ref: { kind: { kind: "Node" }, name: "kind-worker" },
      patch: { metadata: { labels: { "topology.rook.io/rack": "rack2" }, resourceVersion: "55" } },
    });
  });
});
