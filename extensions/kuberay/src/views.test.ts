// The details sections, driven through the SDK's stand-in for Sextant's window, as the built-in view's tests drove it.
import type { KubeObject, WatchUpdate } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestWatch } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import objectsJson from "../fixtures/objects.json";
import { startDetails } from "./details";
import { setLanguage } from "./i18n";
import { HIDDEN } from "./mask";
import { MAX_RAY_PODS } from "./details";
import { MAX_LISTED_PODS, MAX_TEXT } from "./model";

const objects = objectsJson as unknown as KubeObject[];
const find = (kind: string, name: string): KubeObject => structuredClone(objects.find((o) => o.kind === kind && o.metadata.name === name)!);
const st = (o: KubeObject) => o.status as Record<string, unknown>;

const SECTION: Record<string, string> = { RayCluster: "ray-cluster", RayJob: "ray-job", RayService: "ray-service" };

const ref = (o: KubeObject) => ({
  kind: { group: "ray.io", version: "v1", kind: o.kind! },
  namespace: o.metadata.namespace ?? null,
  name: o.metadata.name,
});

let host: TestHost;
let root: HTMLElement;
let stop: () => void = () => undefined;

async function open(obj: KubeObject, handlers: Record<string, (params: unknown) => unknown> = {}, blocks?: Record<string, boolean>): Promise<void> {
  host = await startTestHost({
    context: { view: "details", contribution: SECTION[obj.kind!], selection: [ref(obj)], resourceVersion: "1", ...(blocks ? { blocks } : {}) },
    handlers: { "resources.get": () => structuredClone(obj), "ui.openLogs": () => null, "ui.setBlockOpen": () => null, ...handlers },
  });
  root = document.createElement("main");
  document.body.append(root);
  stop = startDetails(host.sextant, root, SECTION[obj.kind!]!);
  await expect.poll(() => root.querySelector(".sx-loading")).toBeNull();
}

afterEach(() => {
  setLanguage("en");
  stop();
  root?.remove();
  host?.close();
});

const text = () => root.textContent ?? "";
const byLabel = (label: string) => [...root.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label") === label);
const byText = (label: string) => [...root.querySelectorAll("button")].find((b) => b.textContent === label);
const watchParams = (w: TestWatch) => w.params as { kind: { kind: string }; namespaces?: string[]; fieldSelector?: string; labelSelector?: string };
const watchOf = (kind: string) => host.watches.find((w) => watchParams(w).kind.kind === kind && !w.stopped);
const snapshot = (items: KubeObject[]): WatchUpdate => ({ type: "snapshot", items: items as never });
const rows = () => [...root.querySelectorAll("tr")].map((r) => r.textContent);
const callOf = (method: string) => host.calls.find((c) => c.method === method)?.params;
/** A block by its title: whether it is open, its toggle and its head's buttons. */
const blockOf = (title: string) => {
  const section = [...root.querySelectorAll<HTMLElement>(".sx-block")].find((b) => b.getAttribute("aria-label") === title);
  const toggle = section?.querySelector<HTMLButtonElement>(".sx-block__toggle");
  return {
    section,
    toggle,
    open: toggle?.getAttribute("aria-expanded") === "true",
    actions: [...(section?.querySelectorAll<HTMLButtonElement>(".sx-block__actions button") ?? [])].map((b) => b.textContent),
  };
};

describe("details of a RayCluster", () => {
  it("the head pod with its logs, the worker groups and the pods by label", async () => {
    await open(find("RayCluster", "raycluster-kuberay"));
    await expect.poll(() => watchOf("Pod")).toBeDefined();
    expect(watchParams(watchOf("Pod")!)).toMatchObject({ namespaces: ["default"], labelSelector: "ray.io/cluster=raycluster-kuberay", maxObjects: MAX_RAY_PODS });
    expect(text()).toContain("Looking for the cluster's pods…");
    watchOf("Pod")!.emit(snapshot(objects.filter((o) => o.kind === "Pod")));
    await expect.poll(() => byText("Head logs")).toBeDefined();
    expect(text()).toContain("1 of 1 ready");
    expect(text()).toContain("1 to 5");
    expect(byLabel("Open Pod raycluster-kuberay-head").length).toBeGreaterThan(0);
    expect(byLabel("Open Service raycluster-kuberay-head-svc")).toHaveLength(1);
    expect(text()).toContain("dashboard: 8265");
    expect(text()).toContain("CPU: 2");
    expect(text()).not.toContain("GPU:");
    expect(rows()).toContain("workergroup11 to 51No");
    expect(root.querySelector(".sx-status--success")?.textContent).toBe("Ready");
    // The logs buttons in the Pods block's head, with the logs icon, as the built-in view's.
    expect(blockOf("Pods").actions).toEqual(["Head logs", "Worker logs"]);
    expect(byText("Head logs")!.querySelector("svg.kr-icon")?.getAttribute("aria-hidden")).toBe("true");
    byText("Head logs")!.click();
    await expect.poll(() => callOf("ui.openLogs")).toEqual({ namespace: "default", pod: "raycluster-kuberay-head" });
    byText("Worker logs")!.click();
    await expect.poll(() => host.calls.filter((c) => c.method === "ui.openLogs").at(-1)?.params).toEqual({
      namespace: "default",
      labelSelector: "ray.io/cluster=raycluster-kuberay,ray.io/node-type=worker",
      title: "raycluster/raycluster-kuberay",
    });
    byLabel("Open Service raycluster-kuberay-head-svc")[0]!.click();
    await expect.poll(() => callOf("ui.openDetails")).toEqual({
      kind: { group: "", version: "v1", kind: "Service" },
      namespace: "default",
      name: "raycluster-kuberay-head-svc",
    });
  });

  it("without an upper limit: no limit, not 2147483647; the pods counted past the listed ones", async () => {
    const unbounded = find("RayCluster", "raycluster-kuberay");
    const groups = (unbounded.spec as { workerGroupSpecs: Record<string, unknown>[] }).workerGroupSpecs;
    groups[0]!.maxReplicas = 2147483647;
    st(unbounded).maxWorkerReplicas = 2147483647;
    await open(unbounded);
    await expect.poll(() => watchOf("Pod")).toBeDefined();
    const pod = objects.find((o) => o.kind === "Pod" && o.metadata.name.includes("worker"))!;
    const many = Array.from({ length: MAX_LISTED_PODS + 3 }, (_, i) => ({ ...structuredClone(pod), metadata: { ...pod.metadata, name: `w-${String(i).padStart(3, "0")}`, uid: `u${i}` } }));
    watchOf("Pod")!.emit(snapshot(many as KubeObject[]));
    await expect.poll(text).toContain("3 more pods are not listed.");
    expect(text().match(/At least 1, no upper limit/g)).toHaveLength(2);
    expect(text()).not.toContain("2147483647");
    // Every ready worker of the group counts, listed or not.
    expect(rows()).toContain(`workergroup1At least 1, no upper limit${MAX_LISTED_PODS + 3}No`);
  });

  it("with more pods than the watch keeps: says the list is incomplete, as the built-in view", async () => {
    await open(find("RayCluster", "raycluster-kuberay"));
    await expect.poll(() => watchOf("Pod")).toBeDefined();
    watchOf("Pod")!.emit(snapshot(objects.filter((o) => o.kind === "Pod")));
    await expect.poll(() => byText("Head logs")).toBeDefined();
    expect(text()).not.toContain("the list is incomplete");
    watchOf("Pod")!.emit({ type: "capped", total: MAX_RAY_PODS + 5 } as never);
    await expect.poll(text).toContain("The cluster has more pods than are kept here: the list is incomplete.");
  });

  it("keeps its blocks open or closed in Sextant's memory, and follows Expand all and Collapse all", async () => {
    await open(find("RayCluster", "raycluster-kuberay"), {}, { pods: false });
    expect(blockOf("Pods").open).toBe(false);
    expect(blockOf("Worker groups").open).toBe(true);
    // The head's buttons stay while the block is closed, as the built-in block's.
    expect(blockOf("Pods").actions).toEqual(["Worker logs"]);
    blockOf("Worker groups").toggle!.click();
    await expect.poll(() => callOf("ui.setBlockOpen")).toEqual({ id: "groups", open: false });
    const toggle = blockOf("Worker groups").toggle;
    // Sextant tells the choice back: the frame keeps what it shows (the toggle keeps its focus).
    host.setContext({ blocks: { pods: false, groups: false } });
    await new Promise((r) => setTimeout(r, 20));
    expect(blockOf("Worker groups").toggle).toBe(toggle);
    host.setContext({ blocks: { "*": true } });
    await expect.poll(() => blockOf("Pods").open).toBe(true);
    expect(blockOf("Worker groups").open).toBe(true);
  });

  it("whose pods cannot be read: says so, and counts no ready pods", async () => {
    await open(find("RayCluster", "raycluster-kuberay"));
    await expect.poll(() => watchOf("Pod")).toBeDefined();
    watchOf("Pod")!.emit({ type: "error", code: "forbidden", message: "no" } as WatchUpdate);
    await expect.poll(text).toContain("The cluster's pods cannot be read.");
    expect(rows()).toContain("workergroup11 to 5No");
    expect(byText("Head logs")).toBeUndefined();
    expect(byText("Worker logs")).toBeDefined();
  });

  it("failed: the operator's message", async () => {
    await open(find("RayCluster", "raycluster-gpu"));
    expect(root.querySelector(".kr-note--danger")?.textContent).toContain("exceeded quota: gpu-quota");
    expect(root.querySelector(".sx-status--danger")?.textContent).toBe("Failed");
    expect(root.querySelector(".sx-status--danger")?.getAttribute("title")).toContain("exceeded quota");
  });

  it("suspended: a muted note", async () => {
    const o = find("RayCluster", "raycluster-kuberay");
    (st(o).conditions as unknown[]).push({ type: "RayClusterSuspended", status: "True" });
    await open(o);
    expect(text()).toContain("The cluster is suspended: KubeRay deleted its pods.");
  });

  it("in another language", async () => {
    setLanguage("de");
    await open(find("RayCluster", "raycluster-kuberay"));
    expect(text()).toContain("Worker-Gruppen");
  });
});

describe("details of a RayJob", () => {
  it("why it failed, the entrypoint, its RayCluster and submitter Job with its logs", async () => {
    await open(find("RayJob", "rayjob-sample"));
    expect(root.querySelector(".kr-note--danger")?.textContent).toContain("No module named 'requests'");
    expect(text()).toContain("python /home/ray/samples/sample_code.py");
    expect(byLabel("Open RayCluster rayjob-sample-raycluster-v6bgw")).toHaveLength(1);
    expect(byLabel("Open Job rayjob-sample")).toHaveLength(1);
    expect(text()).toContain("AppFailed");
    byText("Submitter logs")!.click();
    await expect.poll(() => callOf("ui.openLogs")).toEqual({ namespace: "default", labelSelector: "job-name=rayjob-sample", title: "job-name=rayjob-sample" });
  });

  it("the entrypoint and dashboard URL masked, a long message cut", async () => {
    const job = find("RayJob", "rayjob-sample");
    (job.spec as Record<string, unknown>).entrypoint = "python train.py --hf-token=hf_SECRET --data https://u:pw@h/d?sig=1";
    st(job).dashboardURL = "https://admin:dash_pw@ray.example.com/?auth=1";
    st(job).message = "x".repeat(MAX_TEXT + 10);
    await open(job);
    expect(text()).toContain(`python train.py --hf-token=${HIDDEN} --data https://h/d`);
    expect(text()).toContain("https://ray.example.com/");
    expect(text()).not.toMatch(/hf_SECRET|dash_pw|auth=1/);
    expect(root.querySelector(".kr-note")?.textContent).toHaveLength(MAX_TEXT + 1);
  });

  it("its entrypoint block as Sextant remembers it", async () => {
    await open(find("RayJob", "rayjob-sample"), {}, { "*": false });
    expect(blockOf("Entrypoint").open).toBe(false);
  });

  it("submitted another way: no submitter, no entrypoint", async () => {
    const job = find("RayJob", "rayjob-done");
    delete (job.spec as Record<string, unknown>).entrypoint;
    await open(job);
    expect(text()).toContain("No entrypoint: the job is submitted another way.");
    expect(byText("Submitter logs")).toBeUndefined();
    expect(root.querySelector(".sx-status--success")?.textContent).toBe("Succeeded");
  });
});

describe("details of a RayService", () => {
  it("the failed application of the pending cluster and the serve config", async () => {
    await open(find("RayService", "rayservice-sample"));
    expect(root.querySelector(".kr-note--danger")?.textContent).toContain("No module named 'fruit'");
    expect(text()).toContain("Pending cluster (upgrade)");
    expect(byLabel("Open RayCluster rayservice-sample-raycluster-bk8jd")).toHaveLength(1);
    expect([...root.querySelectorAll(".sx-status--danger")].map((n) => n.textContent)).toContain("DEPLOY_FAILED");
    expect(text()).toContain("3 of 3 healthy");
    expect(text()).toMatch(/import_path: fruit.deployment_graph/);
    expect(byLabel("Open Service rayservice-sample-serve-svc")).toHaveLength(1);
  });

  it("ready: the active cluster and its applications", async () => {
    await open(find("RayService", "rayservice-ready"));
    expect(text()).toContain("Active cluster");
    expect(text()).not.toContain("Pending cluster");
    expect(byLabel("Open RayCluster rayservice-ready-raycluster-2kz9w")).toHaveLength(1);
    expect(text()).toContain("2 of 2 healthy");
    expect(root.querySelector(".kr-note")).toBeNull();
  });

  it("its blocks as Sextant remembers them", async () => {
    await open(find("RayService", "rayservice-sample"), {}, { "serve-config": false, "pending-apps": false });
    expect([blockOf("Serve configuration").open, blockOf("Pending cluster (upgrade)").open]).toEqual([false, false]);
    blockOf("Serve configuration").toggle!.click();
    await expect.poll(() => callOf("ui.setBlockOpen")).toEqual({ id: "serve-config", open: true });
  });

  it("an unreadable serve config is not shown", async () => {
    const svc = find("RayService", "rayservice-ready");
    (svc.spec as Record<string, unknown>).serveConfigV2 = "applications:\n  - name: a\n    runtime_env: {env_vars: {HF_TOKEN: hf_SECRET\n";
    await open(svc);
    expect(text()).toContain("Not shown: the serve configuration could not be read safely. See the YAML section.");
    expect(text()).not.toContain("hf_SECRET");
  });
});
