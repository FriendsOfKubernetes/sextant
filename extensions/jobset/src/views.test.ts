// The details section, driven through the SDK's stand-in for Sextant's window, as the built-in view's tests drove it.
import type { KubeObject, WatchUpdate } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestWatch } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import objectsJson from "../fixtures/objects.json";
import { MAX_CHILDREN, MAX_LISTED_PODS, startDetails } from "./details";
import { setLanguage } from "./i18n";

const objects = objectsJson as unknown as KubeObject[];
const find = (kind: string, name: string): KubeObject => structuredClone(objects.find((o) => o.kind === kind && o.metadata.name === name)!);
const failed = () => find("JobSet", "failure-policy");
const running = () => find("JobSet", "success-policy");

const ref = (o: KubeObject) => ({
  kind: { group: "jobset.x-k8s.io", version: "v1alpha2", kind: "JobSet" },
  namespace: o.metadata.namespace ?? null,
  name: o.metadata.name,
});

let host: TestHost;
let root: HTMLElement;
let stop: () => void = () => undefined;

/** Sextant's memory of the section's blocks, as the window keeps it (`context.blocks`, `ui.setBlockOpen`). */
let remembered: Record<string, boolean> = {};

async function open(obj: KubeObject, language = "en", blocks: Record<string, boolean> = {}): Promise<void> {
  remembered = { ...blocks };
  host = await startTestHost({
    context: { view: "details", contribution: "jobset", selection: [ref(obj)], resourceVersion: "1", language, blocks: remembered },
    handlers: {
      "resources.get": () => structuredClone(obj),
      "ui.setBlockOpen": ({ id, open }: { id: string; open: boolean }) => {
        remembered = { ...remembered, [id]: open };
        host.setContext({ blocks: remembered });
      },
    },
  });
  setLanguage(language);
  root = document.createElement("main");
  document.body.append(root);
  stop = startDetails(host.sextant, root, "jobset");
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
const watchParams = (w: TestWatch) => w.params as { kind: { kind: string }; namespaces?: string[]; labelSelector?: string };
const watchOf = (kind: string) => host.watches.find((w) => watchParams(w).kind.kind === kind && !w.stopped);
const snapshot = (items: KubeObject[]): WatchUpdate => ({ type: "snapshot", items: items as never });
const rows = () => [...root.querySelectorAll("tr")].map((r) => r.textContent);

describe("details", () => {
  it("of a failed JobSet: the reason, the first failed Job and its own reason, its Jobs and pods", async () => {
    await open(failed());
    expect(text()).toContain("ReachedMaxRestarts: jobset failed due to reaching max number of restarts (first failed job: failure-policy-leader-0)");
    await expect.poll(() => watchOf("Job")).toBeDefined();
    expect(watchParams(watchOf("Job")!)).toMatchObject({ namespaces: ["default"], labelSelector: "jobset.sigs.k8s.io/jobset-name=failure-policy" });
    expect(watchParams(watchOf("Pod")!)).toMatchObject({ namespaces: ["default"], labelSelector: "jobset.sigs.k8s.io/jobset-name=failure-policy" });
    expect(text()).toContain("Loading…");
    watchOf("Job")!.emit(snapshot([find("Job", "failure-policy-leader-0")]));
    watchOf("Pod")!.emit(snapshot([find("Pod", "failure-policy-leader-0-0-x7k2p")]));
    // In the note under the failure and in the Jobs table.
    await expect.poll(() => [...root.querySelectorAll(".jobset-note--danger")].map((n) => n.textContent)).toContain("BackoffLimitExceeded: Job has reached the specified backoff limit");
    expect(byLabel("Open Job failure-policy-leader-0")).toHaveLength(2);
    expect(byLabel("Open Pod failure-policy-leader-0-0-x7k2p")).toHaveLength(1);
    expect(text()).toContain("3 of 3 allowed (3 in all)");
    expect(rows()).toContain("fail-on-oomFailJobSetPodFailurePolicyleader");
    expect(rows()).toContain("leader12/20001");
    expect(root.querySelector(".sx-status--danger")?.textContent).toBe("Failed");
    expect(root.querySelector(".sx-status--danger")?.getAttribute("title")).toContain("ReachedMaxRestarts: ");
    byLabel("Open Pod failure-policy-leader-0-0-x7k2p")[0]!.click();
    await expect.poll(() => host.calls.find((c) => c.method === "ui.openDetails")?.params).toEqual({
      kind: { group: "", version: "v1", kind: "Pod" },
      namespace: "default",
      name: "failure-policy-leader-0-0-x7k2p",
    });
  });

  it("of a failed JobSet whose first failed Job is gone: says so", async () => {
    await open(failed());
    await expect.poll(() => watchOf("Job")).toBeDefined();
    watchOf("Job")!.emit(snapshot([]));
    await expect.poll(text).toContain("That Job no longer exists.");
    expect(text()).toContain("No Job exists.");
  });

  it("of a running JobSet near its restart limit: the warning and the success policy", async () => {
    await open(running());
    expect(text()).toContain("1 of 2 allowed restarts used: a failure past the limit fails the JobSet.");
    expect(text()).toContain("Every Job of workers completes");
    expect(text()).toContain("Recreate");
    await expect.poll(() => watchOf("Pod")).toBeDefined();
    watchOf("Job")!.emit(snapshot([]));
    watchOf("Pod")!.emit(snapshot([]));
    await expect.poll(text).toContain("No Job exists.");
    expect(text()).toContain("No Pod exists.");
  });

  it("lists at most 50 pods, those not running first, and says when a list cannot be read", async () => {
    await open(running());
    await expect.poll(() => watchOf("Pod")).toBeDefined();
    const pod = (name: string, phase: string) => ({ ...find("Pod", "failure-policy-leader-0-0-x7k2p"), metadata: { name, namespace: "default", uid: name }, status: { phase } });
    const pods = [...Array.from({ length: 55 }, (_, i) => pod(`run-${String(i).padStart(2, "0")}`, "Running")), pod("waiting", "Pending")];
    watchOf("Pod")!.emit(snapshot(pods as KubeObject[]));
    watchOf("Job")!.emit({ type: "error", code: "forbidden", message: "no" } as WatchUpdate);
    await expect.poll(text).toContain(`The first ${MAX_LISTED_PODS} of 56 are shown, those not running first.`);
    expect(byLabel("Open Pod waiting")).toHaveLength(1);
    expect(byLabel("Open Pod run-54")).toHaveLength(0);
    expect(text()).toContain("The list could not be read.");
  });

  it("of a suspended JobSet: the remark; in Sextant's language", async () => {
    const suspended = running();
    (suspended.spec as Record<string, unknown>).suspend = true;
    await open(suspended, "ru");
    expect(text()).toContain("Приостановлен");
    expect(root.querySelector(".jobset-muted")).not.toBeNull();
  });
  it("watches the Jobs and pods at most 500 each, and says when a list is cut", async () => {
    await open(running());
    await expect.poll(() => watchOf("Pod")).toBeDefined();
    expect((watchOf("Job")!.params as { maxObjects?: number }).maxObjects).toBe(MAX_CHILDREN);
    expect((watchOf("Pod")!.params as { maxObjects?: number }).maxObjects).toBe(MAX_CHILDREN);
    watchOf("Job")!.emit(snapshot([]));
    watchOf("Pod")!.emit(snapshot([find("Pod", "failure-policy-leader-0-0-x7k2p")]));
    watchOf("Pod")!.emit({ type: "capped", total: 1200 } as unknown as WatchUpdate);
    await expect.poll(() => root.querySelector('[data-block="pods"]')?.textContent).toContain("Only the first 500 are read: the list is incomplete.");
    expect(root.querySelector('[data-block="jobs"]')?.textContent).not.toContain("incomplete");
  });

  it("keeps its blocks in Sextant's memory, and watches a block's list only while it is open", async () => {
    await open(running());
    await expect.poll(() => watchOf("Pod")).toBeDefined();
    const toggle = (id: string) => root.querySelector<HTMLButtonElement>(`[data-block="${id}"] .sx-block__toggle`)!;
    toggle("pods").focus();
    toggle("pods").click();
    await expect.poll(() => watchOf("Pod")).toBeUndefined();
    expect(host.calls.filter((c) => c.method === "ui.setBlockOpen").map((c) => c.params)).toEqual([{ id: "pods", open: false }]);
    await expect.poll(() => remembered).toEqual({ pods: false });
    expect(toggle("pods").getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle("pods"));
    toggle("jobs").click();
    await expect.poll(() => watchOf("Job")).toBeUndefined();
    expect(remembered).toEqual({ pods: false, jobs: false });
    toggle("pods").click();
    await expect.poll(() => watchOf("Pod")).toBeDefined();
    expect(remembered).toEqual({ pods: true, jobs: false });
  });

  it("follows the panel's Expand all and Collapse all", async () => {
    await open(running(), "en", { pods: false });
    const expanded = (id: string) => root.querySelector(`[data-block="${id}"] .sx-block__toggle`)?.getAttribute("aria-expanded");
    expect(expanded("pods")).toBe("false");
    expect(expanded("jobs")).toBe("true");
    host.setContext({ blocks: { "*": false } });
    await expect.poll(() => ["jobs", "pods", "replicated"].map(expanded)).toEqual(["false", "false", "false"]);
    await expect.poll(() => watchOf("Pod")).toBeUndefined();
    expect(watchOf("Job")).toBeUndefined();
    host.setContext({ blocks: { "*": true } });
    await expect.poll(() => ["jobs", "pods", "replicated"].map(expanded)).toEqual(["true", "true", "true"]);
    await expect.poll(() => watchOf("Pod")).toBeDefined();
  });

  it("opens with the blocks closed before closed, and watches a failed JobSet's Jobs even so", async () => {
    await open(failed(), "en", { jobs: false, pods: false, replicated: false, rules: false });
    for (const id of ["jobs", "pods", "replicated", "rules"])
      expect(root.querySelector(`[data-block="${id}"] .sx-block__toggle`)?.getAttribute("aria-expanded"), id).toBe("false");
    await expect.poll(() => watchOf("Job")).toBeDefined();
    expect(watchOf("Pod")).toBeUndefined();
    watchOf("Job")!.emit(snapshot([find("Job", "failure-policy-leader-0")]));
    await expect.poll(() => [...root.querySelectorAll(".jobset-note--danger")].map((n) => n.textContent)).toContain("BackoffLimitExceeded: Job has reached the specified backoff limit");
  });
});
