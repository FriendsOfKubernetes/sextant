// The details sections and the action windows, driven through the SDK's stand-in for Sextant's window.
import { SextantError, type KubeObject, type WatchParams } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestHostOptions } from "@sextant/extension-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import abortedJson from "../fixtures/rollout-aborted.json";
import analysisRunJson from "../fixtures/analysisrun-failed.json";
import blueGreenJson from "../fixtures/rollout-bluegreen.json";
import canaryJson from "../fixtures/rollout-canary-paused.json";
import replicaSetsJson from "../fixtures/replicasets.json";
import { startAction } from "./actions";
import { startDetails } from "./details";
import { setLanguage, t } from "./i18n";

const canary = canaryJson as unknown as KubeObject;
const aborted = abortedJson as unknown as KubeObject;
const blueGreen = blueGreenJson as unknown as KubeObject;
/** The failed AnalysisRun of the aborted Rollout, owned by it. */
const analysisRun = {
  ...structuredClone(analysisRunJson),
  metadata: {
    ...analysisRunJson.metadata,
    name: "rollout-analysis-84c5f9d7b-3-1",
    ownerReferences: [{ apiVersion: "argoproj.io/v1alpha1", kind: "Rollout", name: aborted.metadata.name, uid: aborted.metadata.uid, controller: true }],
  },
} as unknown as KubeObject;
const ALL = [canary, aborted, blueGreen, analysisRun, ...(replicaSetsJson as unknown as KubeObject[])];

const ROLLOUTS = ["Rollout", "AnalysisRun", "AnalysisTemplate", "ClusterAnalysisTemplate", "Experiment"];
const served = (rollouts = true) =>
  [...(rollouts ? ROLLOUTS.map((kind) => ({ group: "argoproj.io", version: "v1alpha1", kind })) : []), { group: "apps", version: "v1", kind: "ReplicaSet" }].map(
    (kindRef) => ({ kindRef, plural: "", namespaced: kindRef.kind !== "ClusterAnalysisTemplate", verbs: ["list", "watch"], printerColumns: [] }),
  );

const ref = (o: KubeObject) => ({
  kind: { group: o.apiVersion!.split("/")[0]!, version: o.apiVersion!.split("/")[1]!, kind: o.kind! },
  namespace: o.metadata.namespace ?? null,
  name: o.metadata.name,
});

let host: TestHost;
let root: HTMLElement;
let stop: () => void = () => undefined;

async function start(options: TestHostOptions & { objects?: KubeObject[] } = {}) {
  const objects = options.objects ?? ALL;
  host = await startTestHost({
    ...options,
    handlers: {
      kinds: () => served(),
      "resources.get": ({ ref: r }) =>
        structuredClone(objects.find((o) => o.kind === r.kind.kind && o.metadata.name === r.name && (o.metadata.namespace ?? null) === r.namespace)),
      ...options.handlers,
    },
  });
  root = document.createElement("main");
  document.body.append(root);
}

/** Answers every watch with the fixtures of its kind and namespaces. */
async function answerWatches(count: number) {
  await expect.poll(() => host.watches.length).toBe(count);
  for (const watch of host.watches) {
    const params = watch.params as WatchParams;
    const items = ALL.filter((o) => o.kind === params.kind.kind && (!params.namespaces || params.namespaces.includes(o.metadata.namespace ?? "")));
    watch.emit({ type: "snapshot", items: items as never[] });
  }
}

const text = () => root.textContent ?? "";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-10-20T09:15:00Z"));
});
afterEach(() => {
  setLanguage("en");
  stop();
  root?.remove();
  host?.close();
  vi.useRealTimers();
});

describe("a Rollout's details", () => {
  it("of a canary: status, steps with the current one, weights and its ReplicaSets by role", async () => {
    await start({ context: { view: "details", contribution: "rollout", selection: [ref(canary)], resourceVersion: "8812" } });
    stop = startDetails(host.sextant, root, "rollout");
    await answerWatches(2);
    await expect.poll(() => root.querySelectorAll("tbody tr").length).toBe(2);
    expect(root.querySelector(".sx-status--warning")?.textContent).toBe("Paused");
    expect(text()).toContain("CanaryPauseStep");
    const steps = [...root.querySelectorAll(".steps li")];
    expect(steps).toHaveLength(8);
    expect(steps[1]?.getAttribute("aria-current")).toBe("step");
    expect(steps[1]?.textContent).toContain("pause");
    // The ReplicaSets of the namespace, only the Rollout's own (by owner uid).
    const params = host.watches.map((w) => w.params as WatchParams);
    expect(params.map((p) => [p.kind.kind, p.namespaces])).toEqual([
      ["ReplicaSet", ["shop"]],
      ["AnalysisRun", ["shop"]],
    ]);
    const rows = [...root.querySelectorAll("tbody tr")].map((r) => r.textContent);
    expect(rows[0]).toContain("rollout-canary-7d8c6f9b5");
    expect(rows[0]).toContain("canary");
    expect(rows[1]).toContain("stable");
    expect(text()).not.toContain("other-5c5c5c5c5");
    // Set weight 20% and the actual weight: 1 of 5 available pods.
    const dd = [...root.querySelectorAll("dd")].map((d) => d.textContent);
    expect(dd.filter((d) => d === "20%")).toHaveLength(2);
  });

  it("of an aborted Rollout: says so and lists its failed analysis run with the reason", async () => {
    await start({ context: { view: "details", contribution: "rollout", selection: [ref(aborted)], resourceVersion: "1" } });
    stop = startDetails(host.sextant, root, "rollout");
    await answerWatches(2);
    await expect.poll(text).toContain("rollout-analysis-84c5f9d7b-3-1");
    expect(text()).toContain("The update was aborted");
    expect(text()).toContain("failureLimit (2)");
    const service = [...root.querySelectorAll("button.sx-link")].find((b) => b.textContent === "rollout-analysis-canary") as HTMLButtonElement;
    service.click();
    await expect.poll(() => host.calls.find((c) => c.method === "ui.openDetails")?.params).toEqual({
      kind: { group: "", kind: "Service" },
      namespace: "shop",
      name: "rollout-analysis-canary",
    });
  });

  it("of a blue-green Rollout: the active and preview Services with what they select", async () => {
    await start({ context: { view: "details", contribution: "rollout", selection: [ref(blueGreen)], resourceVersion: "1" } });
    stop = startDetails(host.sextant, root, "rollout");
    await answerWatches(2);
    await expect.poll(text).toContain("rollout-bluegreen-active → 7b9f6c4d8");
    expect(text()).toContain("rollout-bluegreen-preview → 55d6b9f8c");
  });

  it("reads the Rollout again when it changes, and speaks the UI language", async () => {
    setLanguage("ru");
    await start({ context: { view: "details", contribution: "rollout", selection: [ref(canary)], resourceVersion: "1", language: "ru" } });
    stop = startDetails(host.sextant, root, "rollout");
    await answerWatches(2);
    await expect.poll(text).toContain(t("sections.steps"));
    expect(t("sections.steps")).not.toBe("Steps");
    host.setContext({ resourceVersion: "2" });
    await expect.poll(() => host.calls.filter((c) => c.method === "resources.get").length).toBe(2);
  });
});

describe("other details", () => {
  it("an AnalysisRun: its Rollout and each metric with the failing measurement", async () => {
    await start({ context: { view: "details", contribution: "analysis-run", selection: [ref(analysisRun)], resourceVersion: "1" } });
    stop = startDetails(host.sextant, root, "analysis-run");
    await expect.poll(text).toContain("success-rate");
    expect(text()).toContain("[0.62]");
    expect(text()).toContain("result[0] >= 0.95 is false");
    expect([...root.querySelectorAll("button.sx-link")].map((b) => b.textContent)).toEqual(["rollout-analysis"]);
    expect(host.watches).toHaveLength(0);
  });

  it("hides a section with nothing to show, and shows it again when it has something", async () => {
    const empty = { apiVersion: "argoproj.io/v1alpha1", kind: "AnalysisTemplate", metadata: { name: "empty", namespace: "shop" }, spec: {} };
    const full = { ...empty, spec: analysisRunJson.spec };
    let current: object = empty;
    const hidden: boolean[] = [];
    await start({
      context: { view: "details", contribution: "template-metrics", selection: [ref(empty as unknown as KubeObject)], resourceVersion: "1" },
      handlers: {
        "resources.get": () => structuredClone(current),
        "ui.setHidden": ({ hidden: value }) => void hidden.push(value as boolean),
      },
    });
    stop = startDetails(host.sextant, root, "template-metrics");
    await expect.poll(() => hidden).toEqual([true]);
    expect(root.childElementCount).toBe(0);
    current = full;
    host.setContext({ resourceVersion: "2" });
    await expect.poll(() => hidden).toEqual([true, false]);
    expect(text()).toContain("success-rate");
  });

  it("an AnalysisTemplate: its metrics and providers", async () => {
    const template = { apiVersion: "argoproj.io/v1alpha1", kind: "AnalysisTemplate", metadata: { name: "success-rate", namespace: "shop" }, spec: analysisRunJson.spec };
    await start({
      objects: [template as unknown as KubeObject],
      context: { view: "details", contribution: "template-metrics", selection: [ref(template as unknown as KubeObject)], resourceVersion: "1" },
    });
    stop = startDetails(host.sextant, root, "template-metrics");
    await expect.poll(text).toContain("success-rateprometheus");
  });
});

describe("an action's window", () => {
  /** What each `resources.patchMany` and `resources.patch` call sent. */
  const sent = () =>
    host.calls
      .filter((c) => c.method === "resources.patchMany" || c.method === "resources.patch")
      .map((c) => ({ method: c.method, params: c.params }));
  const answerAll = ({ items }: { items: unknown[] }) => ({ items: items.map(() => ({ object: canary })), sent: items.length });

  it("Promote lists the exact patch, then sends it to the status subresource once", async () => {
    await start({ context: { view: "action", contribution: "promote", selection: [ref(canary)] }, handlers: { "resources.patchMany": answerAll } });
    stop = startAction(host.sextant, root, "promote");
    await expect.poll(() => [...root.querySelectorAll("pre")].map((p) => p.textContent)).toEqual([
      '{"status":{"pauseConditions":null}}',
      '{"spec":{"paused":false},"status":{"pauseConditions":null}}',
    ]);
    expect(text()).toContain("Promote rollout rollout-canary?");
    const confirm = root.querySelector("button.primary") as HTMLButtonElement;
    expect(confirm.textContent).toBe("Promote");
    confirm.click();
    await expect.poll(() => host.closedByFrame).toBe(true);
    expect(sent()).toEqual([
      {
        method: "resources.patchMany",
        params: {
          clusterId: "test-cluster",
          items: [{ ref: ref(canary), patch: { status: { pauseConditions: null } }, patchType: "merge", subresource: "status" }],
        },
      },
    ]);
  });

  it("sends the status and the spec patch under one confirmation, in the plugin's order", async () => {
    const paused = structuredClone(canary);
    (paused.spec as Record<string, unknown>).paused = true;
    await start({
      objects: [paused],
      context: { view: "action", contribution: "promote", selection: [ref(canary)] },
      handlers: { "resources.patchMany": answerAll },
    });
    stop = startAction(host.sextant, root, "promote");
    await expect.poll(() => root.querySelectorAll("pre").length).toBe(3);
    (root.querySelector("button.primary") as HTMLButtonElement).click();
    await expect.poll(() => host.closedByFrame).toBe(true);
    expect(sent()).toHaveLength(1);
    const [call] = sent();
    expect(call?.method).toBe("resources.patchMany");
    expect((call?.params as { items: unknown[] }).items).toEqual([
      { ref: ref(canary), patch: { status: { pauseConditions: null } }, patchType: "merge", subresource: "status" },
      { ref: ref(canary), patch: { spec: { paused: false } }, patchType: "merge" },
    ]);
  });

  it("without a status subresource (v0.9) sends the unified patch to the rollout, as the plugin does", async () => {
    await start({
      context: { view: "action", contribution: "abort", selection: [ref(canary)] },
      handlers: {
        "resources.patchMany": () => ({ items: [{ error: { code: "notFound", message: "the server could not find the requested resource" } }], sent: 0 }),
        "resources.patch": () => canary,
      },
    });
    stop = startAction(host.sextant, root, "abort");
    await expect.poll(() => root.querySelectorAll("pre").length).toBe(2);
    const confirm = root.querySelector("button.danger") as HTMLButtonElement;
    confirm.click();
    await expect.poll(() => host.closedByFrame).toBe(true);
    // Sextant refused the status item before sending or asking anything; exactly one more call follows (#374).
    expect(sent()).toHaveLength(2);
    expect(sent()[1]).toEqual({
      method: "resources.patch",
      params: { clusterId: "test-cluster", ref: ref(canary), patch: { status: { abort: true } }, patchType: "merge" },
    });
  });

  it("on v0.9, a status and a spec patch refused before any question become exactly one unified patch", async () => {
    const paused = structuredClone(canary);
    (paused.spec as Record<string, unknown>).paused = true;
    await start({
      objects: [paused],
      context: { view: "action", contribution: "promote", selection: [ref(canary)] },
      handlers: {
        // Sextant refuses the whole call before sending or asking anything: the kind has no status subresource.
        "resources.patchMany": () => {
          throw new SextantError("notFound", "Rollout has no status subresource in this cluster: patch the object instead");
        },
        "resources.patch": () => paused,
      },
    });
    stop = startAction(host.sextant, root, "promote");
    await expect.poll(() => root.querySelectorAll("pre").length).toBe(3);
    (root.querySelector("button.primary") as HTMLButtonElement).click();
    await expect.poll(() => host.closedByFrame).toBe(true);
    expect(sent().map((c) => c.method)).toEqual(["resources.patchMany", "resources.patch"]);
    expect((sent()[0]?.params as { items: unknown[] }).items).toHaveLength(2);
    expect(sent()[1]?.params).toEqual({
      clusterId: "test-cluster",
      ref: ref(canary),
      patch: { spec: { paused: false }, status: { pauseConditions: null } },
      patchType: "merge",
    });
  });

  it("sends no fallback when Sextant refuses the call for another reason", async () => {
    await start({
      context: { view: "action", contribution: "abort", selection: [ref(canary)] },
      handlers: {
        "resources.patchMany": () => {
          throw new SextantError("denied", "Sextant denied patching the status");
        },
      },
    });
    stop = startAction(host.sextant, root, "abort");
    await expect.poll(() => root.querySelectorAll("pre").length).toBe(2);
    (root.querySelector("button.danger") as HTMLButtonElement).click();
    await expect.poll(text).toContain("Sextant denied patching the status");
    expect(sent().map((c) => c.method)).toEqual(["resources.patchMany"]);
  });

  it("says why when a patch fails, and sends no fallback for another error", async () => {
    await start({
      context: { view: "action", contribution: "abort", selection: [ref(canary)] },
      handlers: { "resources.patchMany": () => ({ items: [{ error: { code: "conflict", message: "the object was modified" } }], sent: 0 }) },
    });
    stop = startAction(host.sextant, root, "abort");
    await expect.poll(() => root.querySelectorAll("pre").length).toBe(2);
    (root.querySelector("button.danger") as HTMLButtonElement).click();
    await expect.poll(text).toContain("the object was modified");
    expect(sent()).toHaveLength(1);
  });

  it("sends nothing when the Rollout changed since the patches were shown, and shows the new ones", async () => {
    let reads = 0;
    const paused = structuredClone(canary);
    (paused.spec as Record<string, unknown>).paused = true;
    await start({
      context: { view: "action", contribution: "promote", selection: [ref(canary)] },
      handlers: { "resources.get": () => (++reads === 1 ? canary : paused), "resources.patchMany": answerAll },
    });
    stop = startAction(host.sextant, root, "promote");
    await expect.poll(() => root.querySelectorAll("pre").length).toBe(2);
    (root.querySelector("button.primary") as HTMLButtonElement).click();
    await expect.poll(text).toContain("The rollout changed while this dialog was open");
    expect(sent()).toEqual([]);
    expect([...root.querySelectorAll("pre")].map((p) => p.textContent)).toContain('{"spec":{"paused":false}}');
    // Confirmed again, the new patches go together: the status first, then the spec.
    (root.querySelector("button.primary") as HTMLButtonElement).click();
    await expect.poll(() => sent()).toHaveLength(1);
    const items = (sent()[0]?.params as { items: { subresource?: string }[] }).items;
    expect(items.map((i) => i.subresource)).toEqual(["status", undefined]);
  });

  it("says why an action no longer applies and offers nothing to send", async () => {
    await start({ context: { view: "action", contribution: "abort", selection: [ref(aborted)] } });
    stop = startAction(host.sextant, root, "abort");
    await expect.poll(text).toContain(t("whyNot.abort"));
    expect((root.querySelector("button.danger") as HTMLButtonElement).disabled).toBe(true);
    expect(root.querySelectorAll("pre")).toHaveLength(0);
  });

  it("Pause sends the plugin's spec patch to the rollout once", async () => {
    await start({ context: { view: "action", contribution: "pause", selection: [ref(canary)] }, handlers: { "resources.patchMany": answerAll } });
    stop = startAction(host.sextant, root, "pause");
    await expect.poll(() => [...root.querySelectorAll("pre")].map((p) => p.textContent)).toEqual(['{"spec":{"paused":true}}']);
    (root.querySelector("button.primary") as HTMLButtonElement).click();
    await expect.poll(() => sent()).toHaveLength(1);
    expect(sent()[0]?.params).toEqual({
      clusterId: "test-cluster",
      items: [{ ref: ref(canary), patch: { spec: { paused: true } }, patchType: "merge" }],
    });
  });
});

describe("the Deployment section (#341)", () => {
  const deployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "shop", namespace: "shop", uid: "d-1" },
    spec: { replicas: 0 },
  } as unknown as KubeObject;
  const managing = { ...structuredClone(canary), spec: { ...structuredClone(canary.spec as object), workloadRef: { apiVersion: "apps/v1", kind: "Deployment", name: "shop", scaleDown: "onsuccess" } } } as unknown as KubeObject;

  it("shows itself with the Rollout and what 0 replicas mean, and stays hidden for other Deployments", async () => {
    await start({
      objects: [deployment],
      context: { view: "details", contribution: "managed-by-rollout", selection: [ref(deployment)], resourceVersion: "1" },
      handlers: { "resources.list": () => ({ items: [structuredClone(managing)], truncated: false }) },
    });
    const { startWorkload } = await import("./workload");
    stop = startWorkload(host.sextant, root);
    await expect.poll(text).toContain("takes its pod template from this Deployment");
    expect(text()).toContain("rollout-canary");
    expect(text()).toContain("scaleDown onsuccess");
    expect(host.calls.filter((c) => c.method === "ui.setHidden").map((c) => c.params)).toEqual([{ hidden: false }]);
  });

  it("stays hidden when no Rollout names the Deployment", async () => {
    await start({
      objects: [deployment],
      context: { view: "details", contribution: "managed-by-rollout", selection: [ref(deployment)], resourceVersion: "1" },
      handlers: { "resources.list": () => ({ items: [structuredClone(canary)], truncated: false }) },
    });
    const { startWorkload } = await import("./workload");
    stop = startWorkload(host.sextant, root);
    await expect.poll(() => host.calls.some((c) => c.method === "resources.list")).toBe(true);
    expect(text()).toBe("");
    expect(host.calls.some((c) => c.method === "ui.setHidden")).toBe(false);
  });
});
