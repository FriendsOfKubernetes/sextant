// The details sections, driven through the SDK's stand-in for Sextant's window, as the built-in view's tests drove them.
import type { KubeObject, WatchUpdate } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestWatch } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import objectsJson from "../fixtures/objects.json";
import en from "./locales/en.json";
import { MAX_LISTED, MAX_WORKLOAD_ROWS, startDetails } from "./details";
import { setLanguage } from "./i18n";

const objects = objectsJson as unknown as KubeObject[];
const find = (kind: string, name: string): KubeObject => structuredClone(objects.find((o) => o.kind === kind && o.metadata.name === name)!);
const cq = () => find("ClusterQueue", "cluster-queue");
const pending = () => find("Workload", "job-sample-job-7f3a1");
const evicted = () => find("Workload", "jobset-trainer-1b2c3");

const refOf = (o: KubeObject) => {
  const api = o.apiVersion ?? "";
  const [group, version] = api.includes("/") ? api.split("/") : ["", api];
  return { kind: { group: group!, version: version!, kind: o.kind ?? "" }, namespace: o.metadata.namespace ?? null, name: o.metadata.name };
};

let host: TestHost;
let root: HTMLElement;
let stop: () => void = () => undefined;

/** Sextant's memory of the section's blocks, as the window keeps it (`context.blocks`, `ui.setBlockOpen`). */
let remembered: Record<string, boolean> = {};
/** Whether Sextant hides the section (`ui.setHidden`; the Queue section starts hidden). */
let hidden = false;
const WORKLOAD_KIND = { kindRef: { group: "kueue.x-k8s.io", version: "v1beta2", kind: "Workload" }, plural: "workloads", namespaced: true, verbs: ["list", "watch"], printerColumns: [] };

interface Options {
  contribution?: string;
  language?: string;
  blocks?: Record<string, boolean>;
  /** What `kinds` answers: the served kinds, or an error. */
  kinds?: unknown[] | Error;
}

async function open(obj: KubeObject, options: Options = {}): Promise<void> {
  const { contribution = "kueue", language = "en", blocks = {}, kinds = [WORKLOAD_KIND] } = options;
  remembered = { ...blocks };
  hidden = contribution === "queue";
  host = await startTestHost({
    context: { view: "details", contribution, selection: [refOf(obj)], resourceVersion: "1", language, blocks: remembered },
    handlers: {
      "resources.get": () => structuredClone(obj),
      kinds: () => {
        if (kinds instanceof Error) throw kinds;
        return kinds;
      },
      "ui.setBlockOpen": ({ id, open }: { id: string; open: boolean }) => {
        remembered = { ...remembered, [id]: open };
        host.setContext({ blocks: remembered });
      },
      "ui.setHidden": ({ hidden: hide }: { hidden: boolean }) => void (hidden = hide),
    },
  });
  setLanguage(language);
  root = document.createElement("main");
  document.body.append(root);
  stop = startDetails(host.sextant, root, contribution);
  await expect.poll(() => root.querySelector(".sx-loading") === null || contribution === "queue").toBe(true);
}

afterEach(() => {
  setLanguage("en");
  stop();
  root?.remove();
  host?.close();
});

const text = () => root.textContent ?? "";
const byLabel = (label: string) => [...root.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label") === label);
const watchParams = (w: TestWatch) =>
  w.params as { kind: { group: string; kind: string; version?: string }; namespaces?: string[]; labelSelector?: string; fieldSelector?: string; maxObjects?: number };
const watchOf = (kind: string) => host.watches.find((w) => watchParams(w).kind.kind === kind && !w.stopped);
const snapshot = (items: KubeObject[]): WatchUpdate => ({ type: "snapshot", items: items as never });
const rows = () => [...root.querySelectorAll("tr")].map((r) => r.textContent);
const statusOf = (word: string) => [...root.querySelectorAll(".sx-status")].find((s) => s.textContent === word);
const toggle = (id: string) => root.querySelector<HTMLButtonElement>(`[data-block="${id}"] .sx-block__toggle`);
const expanded = (id: string) => toggle(id)?.getAttribute("aria-expanded");
const job = (meta: Record<string, unknown> = {}): KubeObject =>
  ({
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: "sample-job", namespace: "default", uid: "job-uid-1", ...meta },
    spec: { suspend: true },
  }) as unknown as KubeObject;
const QUEUED = { labels: { "kueue.x-k8s.io/queue-name": "user-queue" } };

describe("details", () => {
  it("of a ClusterQueue: quota against usage, its LocalQueues and the Workloads waiting with why", async () => {
    await open(cq());
    expect(rows()).toContain("default-flavorcpu910 (111%), 1 borrowed102");
    expect(rows()).toContain("default-flavormemory36Gi6Gi (17%)6Gi");
    await expect.poll(() => watchOf("LocalQueue")).toBeDefined();
    // Every LocalQueue and Workload of the cluster, by kind only (the version the cluster serves); the Workloads at most
    // as many as the built-in problems source kept.
    expect(watchParams(watchOf("LocalQueue")!)).toMatchObject({ kind: { group: "kueue.x-k8s.io", kind: "LocalQueue" } });
    expect(watchParams(watchOf("Workload")!)).toMatchObject({ kind: { group: "kueue.x-k8s.io", kind: "Workload" }, maxObjects: MAX_WORKLOAD_ROWS });
    expect([watchOf("LocalQueue")!, watchOf("Workload")!].map((w) => [watchParams(w).namespaces, watchParams(w).labelSelector, watchParams(w).kind.version])).toEqual([
      [undefined, undefined, undefined],
      [undefined, undefined, undefined],
    ]);
    // No heading of its own: the blocks come first after the fields.
    expect(root.querySelector("h1, h2, h3")?.textContent).not.toBe("Kueue");
    expect(text()).toContain("Loading…");
    watchOf("LocalQueue")!.emit(snapshot([find("LocalQueue", "user-queue"), find("LocalQueue", "team-queue")]));
    watchOf("Workload")!.emit(snapshot([pending(), evicted()]));
    await expect.poll(() => byLabel("Open Workload job-sample-job-7f3a1")).toHaveLength(1);
    // In the LocalQueues and in the waiting list.
    expect(byLabel("Open LocalQueue user-queue")).toHaveLength(2);
    expect(byLabel("Open LocalQueue team-queue")).toHaveLength(0);
    expect(text()).toContain("insufficient unused quota for cpu in flavor default-flavor");
    expect(byLabel("Open Workload jobset-trainer-1b2c3")).toHaveLength(0);
    expect(text()).toContain("Preemption within the queue");
    expect(text()).toContain("All namespaces");
    expect(byLabel("Open Cohort research")).toHaveLength(1);
    byLabel("Open LocalQueue user-queue")[0]!.click();
    await expect.poll(() => host.calls.find((c) => c.method === "ui.openDetails")?.params).toEqual({
      kind: { group: "kueue.x-k8s.io", version: "v1beta2", kind: "LocalQueue" },
      namespace: "default",
      name: "user-queue",
    });
  });

  it("of a ClusterQueue: the oldest 50 waiting, a list that cannot be read", async () => {
    await open(cq());
    await expect.poll(() => watchOf("Workload")).toBeDefined();
    watchOf("LocalQueue")!.emit(snapshot([find("LocalQueue", "user-queue")]));
    const many = Array.from({ length: MAX_LISTED + 5 }, (_, i) => {
      const w = pending();
      w.metadata.name = `w-${String(i).padStart(3, "0")}`;
      w.metadata.uid = `u-${i}`;
      return w;
    });
    watchOf("Workload")!.emit(snapshot(many));
    await expect.poll(() => text()).toContain("The oldest 50 of 55 are shown.");
    watchOf("Workload")!.emit({ type: "capped", total: MAX_WORKLOAD_ROWS + 1 } as unknown as WatchUpdate);
    await expect.poll(() => root.querySelector('[data-block="waiting"]')?.textContent).toContain(en.workloadsTruncated);
    watchOf("Workload")!.emit({ type: "error", message: "boom" } as never);
    await expect.poll(() => text()).toContain("The Workloads could not be read: what waits is not known.");
  });

  it("of a ClusterQueue: keeps its blocks in Sextant's memory, and watches a block's lists only while it is open", async () => {
    await open(cq());
    await expect.poll(() => watchOf("Workload")).toBeDefined();
    toggle("waiting")!.focus();
    toggle("waiting")!.click();
    // The LocalQueues stay for their own block; the Workloads were for the waiting list only.
    await expect.poll(() => watchOf("Workload")).toBeUndefined();
    expect(watchOf("LocalQueue")).toBeDefined();
    expect(host.calls.filter((c) => c.method === "ui.setBlockOpen").map((c) => c.params)).toEqual([{ id: "waiting", open: false }]);
    await expect.poll(() => remembered).toEqual({ waiting: false });
    expect(expanded("waiting")).toBe("false");
    expect(document.activeElement).toBe(toggle("waiting"));
    toggle("localQueues")!.click();
    await expect.poll(() => watchOf("LocalQueue")).toBeUndefined();
    toggle("waiting")!.click();
    await expect.poll(() => watchOf("Workload")).toBeDefined();
    expect(watchOf("LocalQueue")).toBeDefined();
    expect(remembered).toEqual({ waiting: true, localQueues: false });
  });

  it("of a ClusterQueue: follows the panel's Expand all and Collapse all, and opens as it was left", async () => {
    await open(cq(), { blocks: { quota: false } });
    expect(["quota", "localQueues", "waiting"].map(expanded)).toEqual(["false", "true", "true"]);
    host.setContext({ blocks: { "*": false } });
    await expect.poll(() => ["quota", "localQueues", "waiting"].map(expanded)).toEqual(["false", "false", "false"]);
    await expect.poll(() => watchOf("Workload")).toBeUndefined();
    expect(watchOf("LocalQueue")).toBeUndefined();
    host.setContext({ blocks: { "*": true } });
    await expect.poll(() => ["quota", "localQueues", "waiting"].map(expanded)).toEqual(["true", "true", "true"]);
    await expect.poll(() => watchOf("Workload")).toBeDefined();
  });

  it("of an inactive ClusterQueue: why it admits nothing", async () => {
    await open(find("ClusterQueue", "gpu-queue"));
    expect(text()).toContain("FlavorNotFound: Can't admit new workloads: references missing ResourceFlavor(s): gpu-flavor.");
    expect(statusOf("Inactive")?.className).toContain("sx-status--danger");
    await expect.poll(() => watchOf("LocalQueue")).toBeDefined();
    watchOf("LocalQueue")!.emit(snapshot([find("LocalQueue", "user-queue")]));
    watchOf("Workload")!.emit(snapshot([]));
    await expect.poll(() => text()).toContain("No LocalQueue points at this ClusterQueue.");
    expect(text()).toContain("No Workload waits.");
  });

  it("of a LocalQueue: its ClusterQueue, its usage, and the Workloads waiting in it", async () => {
    await open(find("LocalQueue", "user-queue"));
    expect(byLabel("Open ClusterQueue cluster-queue")).toHaveLength(1);
    expect(rows()).toContain("default-flavorcpu1010");
    await expect.poll(() => watchOf("Workload")).toBeDefined();
    // The same list of every Workload as a ClusterQueue's, as the built-in view's.
    expect(watchParams(watchOf("Workload")!)).toMatchObject({ kind: { group: "kueue.x-k8s.io", kind: "Workload" }, maxObjects: MAX_WORKLOAD_ROWS });
    expect(watchParams(watchOf("Workload")!).namespaces).toBeUndefined();
    const elsewhere = pending();
    elsewhere.metadata.namespace = "other";
    elsewhere.metadata.name = "elsewhere";
    elsewhere.metadata.uid = "u-elsewhere";
    watchOf("Workload")!.emit(snapshot([pending(), evicted(), elsewhere]));
    await expect.poll(() => byLabel("Open Workload job-sample-job-7f3a1")).toHaveLength(1);
    expect(byLabel("Open Workload elsewhere")).toHaveLength(0);
    expect(rows().some((r) => r?.startsWith("job-sample-job-7f3a1default"))).toBe(true);
    toggle("waiting")!.click();
    await expect.poll(() => watchOf("Workload")).toBeUndefined();
  });

  it("of a LocalQueue of a missing ClusterQueue: why", async () => {
    await open(find("LocalQueue", "team-queue"));
    expect(text()).toContain("ClusterQueueDoesNotExist: Can't submit new workloads to clusterQueue");
  });

  it("of a Workload: why it waits, its job and queues, pod sets", async () => {
    await open(pending());
    expect(text()).toContain("Waiting in its queue: Kueue has not reserved quota for it yet.");
    expect(byLabel("Open Job sample-job")).toHaveLength(1);
    expect(byLabel("Open Job sample-job")[0]!.textContent).toBe("Job/sample-job");
    expect(byLabel("Open LocalQueue user-queue")).toHaveLength(1);
    expect(text()).toContain("cpu: 3");
    expect(statusOf("Pending")?.className).toContain("sx-status--warning");
    byLabel("Open Job sample-job")[0]!.click();
    await expect.poll(() => host.calls.find((c) => c.method === "ui.openDetails")?.params).toEqual({
      kind: { group: "batch", version: "v1", kind: "Job" },
      namespace: "default",
      name: "sample-job",
    });
  });

  it("of an evicted and admitted Workload: the evictions and the admission check", async () => {
    await open(evicted());
    expect(byLabel("Open JobSet trainer")).toHaveLength(1);
    expect(rows()).toContain("PodsReadyTimeout3");
    expect(text()).toContain("4 (at least 2)");
    expect(statusOf("Ready")?.className).toContain("sx-status--success");
    expect(byLabel("Open AdmissionCheck prov-check")).toHaveLength(1);
    expect(text()).toContain("high-priority");
  });

  it("of a ResourceFlavor: its taints and the ClusterQueues that use it", async () => {
    await open(find("ResourceFlavor", "default-flavor"));
    await expect.poll(() => watchOf("ClusterQueue")).toBeDefined();
    watchOf("ClusterQueue")!.emit(snapshot([cq(), find("ClusterQueue", "gpu-queue")]));
    await expect.poll(() => byLabel("Open ClusterQueue cluster-queue")).toHaveLength(1);
    expect(byLabel("Open ClusterQueue gpu-queue")).toHaveLength(0);
    stop();
    root.remove();
    host.close();
    await open(find("ResourceFlavor", "spot"));
    expect(text()).toContain("instance-type=spot");
    expect(text()).toContain("spot=true:NoSchedule");
    await expect.poll(() => watchOf("ClusterQueue")).toBeDefined();
    watchOf("ClusterQueue")!.emit(snapshot([cq()]));
    await expect.poll(() => text()).toContain("No ClusterQueue uses it.");
  });

  it("of a Cohort, an AdmissionCheck and a priority class", async () => {
    await open(find("Cohort", "research"));
    await expect.poll(() => watchOf("ClusterQueue")).toBeDefined();
    watchOf("ClusterQueue")!.emit(snapshot([cq(), find("ClusterQueue", "gpu-queue")]));
    await expect.poll(() => byLabel("Open ClusterQueue gpu-queue")).toHaveLength(1);
    stop();
    root.remove();
    host.close();
    await open(find("AdmissionCheck", "prov-check"));
    expect(text()).toContain("ProvisioningRequestConfig/prov-config");
    expect(statusOf("Active")?.className).toContain("sx-status--success");
    stop();
    root.remove();
    host.close();
    await open(find("WorkloadPriorityClass", "high-priority"));
    expect(text()).toContain("10000");
    expect(host.watches).toHaveLength(0);
  });

  it("of a Job Kueue queues: the Queue block with its Workload, found by the job's uid", async () => {
    await open(job(QUEUED), { contribution: "queue" });
    await expect.poll(() => hidden).toBe(false);
    expect(byLabel("Open LocalQueue user-queue")).toHaveLength(1);
    expect(root.querySelector('[data-block="queue"]')?.textContent).toContain("Queue");
    await expect.poll(() => watchOf("Workload")).toBeDefined();
    expect(watchParams(watchOf("Workload")!)).toMatchObject({ kind: { group: "kueue.x-k8s.io", kind: "Workload" }, namespaces: ["default"], labelSelector: "kueue.x-k8s.io/job-uid=job-uid-1" });
    expect(text()).toContain("Loading…");
    watchOf("Workload")!.emit(snapshot([pending()]));
    await expect.poll(() => byLabel("Open Workload job-sample-job-7f3a1")).toHaveLength(1);
    expect(statusOf("Pending")?.className).toContain("sx-status--warning");
    expect(text()).toContain("insufficient unused quota for cpu");
  });

  it("of a job with a prebuilt Workload: by its name too; none yet says so", async () => {
    await open(job({ name: "j", uid: "job-uid-9", annotations: { "kueue.x-k8s.io/prebuilt-workload-name": "prebuilt" } }), { contribution: "queue" });
    await expect.poll(() => host.watches.filter((w) => !w.stopped)).toHaveLength(2);
    const byName = host.watches.find((w) => watchParams(w).fieldSelector === "metadata.name=prebuilt")!;
    const byUid = host.watches.find((w) => watchParams(w).labelSelector === "kueue.x-k8s.io/job-uid=job-uid-9")!;
    const prebuilt = pending();
    prebuilt.metadata.name = "prebuilt";
    byUid.emit(snapshot([]));
    byName.emit(snapshot([prebuilt]));
    await expect.poll(() => hidden).toBe(false);
    await expect.poll(() => byLabel("Open Workload prebuilt")).toHaveLength(1);
    // No queue label and no Workload: nothing to show, as the built-in section showed nothing.
    byName.emit(snapshot([]));
    await expect.poll(() => hidden).toBe(true);
    stop();
    root.remove();
    host.close();
    // With the label, it says so.
    await open(job(QUEUED), { contribution: "queue" });
    await expect.poll(() => watchOf("Workload")).toBeDefined();
    watchOf("Workload")!.emit(snapshot([]));
    await expect.poll(() => text()).toContain("No Workload yet: Kueue has not picked up this job.");
  });

  it("of a job without the queue label: shown once Kueue made a Workload for it (manageJobsWithoutQueueName)", async () => {
    await open(job(), { contribution: "queue" });
    await expect.poll(() => watchOf("Workload")).toBeDefined();
    watchOf("Workload")!.emit(snapshot([]));
    await new Promise((r) => setTimeout(r, 20));
    expect(hidden).toBe(true);
    expect(host.calls.some((c) => c.method === "ui.setHidden")).toBe(false);
    watchOf("Workload")!.emit(snapshot([pending()]));
    await expect.poll(() => hidden).toBe(false);
    await expect.poll(() => byLabel("Open Workload job-sample-job-7f3a1")).toHaveLength(1);
    stop();
    root.remove();
    host.close();
    // A list that cannot be read tells nothing either way: shown, saying so.
    await open(job(), { contribution: "queue" });
    await expect.poll(() => watchOf("Workload")).toBeDefined();
    watchOf("Workload")!.emit({ type: "error", message: "boom" } as never);
    await expect.poll(() => hidden).toBe(false);
    expect(text()).toContain(en.listUnknown);
  });

  it("of a job on a cluster without Kueue: hidden, the queue label notwithstanding; shown when the kinds cannot be told", async () => {
    await open(job(QUEUED), { contribution: "queue", kinds: [] });
    await expect.poll(() => host.calls.some((c) => c.method === "kinds")).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(hidden).toBe(true);
    expect(host.watches).toHaveLength(0);
    stop();
    root.remove();
    host.close();
    await open(job(), { contribution: "queue", kinds: new Error("discovery failed") });
    await expect.poll(() => hidden).toBe(false);
    expect(text()).toContain(en.listUnknown);
  });

  it("of a job whose Queue block was closed: checks once, keeps the answer and watches nothing", async () => {
    await open(job(QUEUED), { contribution: "queue", blocks: { queue: false } });
    await expect.poll(() => hidden).toBe(false);
    expect(expanded("queue")).toBe("false");
    // The queue label answers at once: nothing to watch while closed.
    await new Promise((r) => setTimeout(r, 20));
    expect(host.watches.filter((w) => !w.stopped)).toHaveLength(0);
    toggle("queue")!.click();
    await expect.poll(() => watchOf("Workload")).toBeDefined();
    watchOf("Workload")!.emit(snapshot([pending()]));
    await expect.poll(() => byLabel("Open Workload job-sample-job-7f3a1")).toHaveLength(1);
    toggle("queue")!.click();
    await expect.poll(() => watchOf("Workload")).toBeUndefined();
    expect(hidden).toBe(false);
    expect(expanded("queue")).toBe("false");
    stop();
    root.remove();
    host.close();
    // Without the label the closed block looks once for a Workload, then stops.
    await open(job(), { contribution: "queue", blocks: { queue: false } });
    await expect.poll(() => watchOf("Workload")).toBeDefined();
    watchOf("Workload")!.emit(snapshot([pending()]));
    await expect.poll(() => hidden).toBe(false);
    await expect.poll(() => watchOf("Workload")).toBeUndefined();
    expect(expanded("queue")).toBe("false");
  });

  it("in another language", async () => {
    await open(find("ClusterQueue", "gpu-queue"), { language: "ru" });
    expect(text()).toContain("Квота и использование");
    expect(statusOf("Неактивна")).toBeDefined();
  });
});
