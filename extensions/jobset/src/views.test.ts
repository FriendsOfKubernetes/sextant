// The details section, driven through the SDK's stand-in for Sextant's window, as the built-in view's tests drove it.
import type { KubeObject, WatchUpdate } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestWatch } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import objectsJson from "../fixtures/objects.json";
import { MAX_LISTED_PODS, startDetails } from "./details";
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

async function open(obj: KubeObject, language = "en"): Promise<void> {
  host = await startTestHost({
    context: { view: "details", contribution: "jobset", selection: [ref(obj)], resourceVersion: "1", language },
    handlers: { "resources.get": () => structuredClone(obj) },
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
});
