// The details sections and the action windows, driven through the SDK's stand-in for Sextant's window.
import { SextantError, type KubeObject } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestHostOptions } from "@sextant/extension-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import cronJson from "../fixtures/cronworkflow.json";
import containerSetJson from "../fixtures/workflow-container-set.json";
import failedJson from "../fixtures/workflow-dag-failed.json";
import suspendedJson from "../fixtures/workflow-suspended.json";
import { startAction } from "./actions";
import { startDetails } from "./details";
import { setLanguage, t } from "./i18n";

const workflow = failedJson as unknown as KubeObject;
const containerSet = containerSetJson as unknown as KubeObject;
const suspended = suspendedJson as unknown as KubeObject;
const cron = cronJson as unknown as KubeObject;
const NAME = "dag-diamond-x7k2p";
const POD = `${NAME}-echo-2532386132`;
const W = "suspend-template-kxt9w";
const APPROVE = `${W}-1879311160`;
const ACTOR_NULLS = { "workflows.argoproj.io/actor": null, "workflows.argoproj.io/action": null };
const ALL = [workflow, containerSet, suspended, cron];

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
      "resources.get": ({ ref: r }) =>
        structuredClone(objects.find((o) => o.kind === r.kind.kind && o.metadata.name === r.name && (o.metadata.namespace ?? null) === r.namespace)),
      "ui.openLogs": () => null,
      "ui.setHidden": () => null,
      ...options.handlers,
    },
  });
  root = document.createElement("main");
  document.body.append(root);
}

const text = () => root.textContent ?? "";
const button = (name: string) =>
  [...root.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent) === name) as HTMLButtonElement | undefined;
const treeNames = () => [...root.querySelectorAll(".aw-node__name")].map((n) => n.textContent);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-10-20T09:05:00Z"));
});
afterEach(() => {
  setLanguage("en");
  stop();
  root?.remove();
  host?.close();
  vi.useRealTimers();
});

describe("a Workflow's details", () => {
  it("of a failed Workflow: the failed step, the tree collapsed, then down to the failed pod and its logs", async () => {
    await start({ context: { view: "details", contribution: "workflow", selection: [ref(workflow)], resourceVersion: "1" } });
    stop = startDetails(host.sextant, root, "workflow");
    await expect.poll(text).toContain(t("fields.failedStep"));
    const fields = Object.fromEntries([...root.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]));
    expect(fields).toMatchObject({ Phase: "Failed", Progress: "2/3", Duration: "41s", "Failed step": "C", "Its message": "Error (exit code 1)" });
    expect(root.querySelector(".sx-status--danger")?.textContent).toBe("Failed");
    // The CronWorkflow it came from, a link to its details.
    button("nightly-diamond")!.click();
    await expect.poll(() => host.calls.find((c) => c.method === "ui.openDetails")?.params).toEqual({
      kind: { group: "argoproj.io", version: "v1alpha1", kind: "CronWorkflow" },
      namespace: "argo",
      name: "nightly-diamond",
    });
    // Retry is not an action (ADR-0097): the details say how to do it outside Sextant.
    expect(text()).toContain(`argo retry ${NAME} -n argo`);
    expect(treeNames()).toEqual([NAME, "A"]);
    expect(text()).toContain("4 steps");
    button("Show the failed step")!.click();
    expect(treeNames()).toEqual([NAME, "A", "B", "C"]);
    expect(button(POD)).toBeDefined();
    button(`Logs of ${POD}`)!.click();
    await expect.poll(() => host.calls.find((c) => c.method === "ui.openLogs")?.params).toEqual({ namespace: "argo", pod: POD });
    // A toggle keeps the focus where it was.
    const a = button(`Collapse A`)!;
    a.focus();
    a.click();
    expect(treeNames()).toEqual([NAME, "A"]);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Expand A");
    button("Collapse all")!.click();
    expect(treeNames()).toEqual([NAME, "A"]);
    expect(button(`Collapse ${NAME}`)?.getAttribute("aria-expanded")).toBe("true");
  });

  it("says when a pod's logs cannot be opened, beside its button", async () => {
    await start({
      context: { view: "details", contribution: "workflow", selection: [ref(containerSet)], resourceVersion: "1" },
      handlers: {
        "ui.openLogs": () => {
          throw new SextantError("notFound", 'pods "build-cs-q7v2n-build-set-601456081" not found');
        },
      },
    });
    stop = startDetails(host.sextant, root, "workflow");
    await expect.poll(() => button("Show the failed step")).toBeDefined();
    button("Show the failed step")!.click();
    // The container node runs in its boundary node's pod.
    const logs = root.querySelectorAll(`[aria-label="Logs of build-cs-q7v2n-build-set-601456081"]`);
    expect(logs.length).toBeGreaterThan(1);
    (logs[logs.length - 1] as HTMLButtonElement).click();
    await expect.poll(text).toContain("not found");
  });

  it("of a running Workflow: no failed step, the duration ticking while it runs", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(Date.parse("2026-10-20T09:05:00Z"));
    await start({ context: { view: "details", contribution: "workflow", selection: [ref(suspended)], resourceVersion: "1" } });
    stop = startDetails(host.sextant, root, "workflow");
    await expect.poll(text).toContain(t("fields.duration"));
    const duration = () => [...root.querySelectorAll("dt")].find((dt) => dt.textContent === "Duration")?.nextElementSibling?.textContent;
    expect(duration()).toBe("5m");
    expect(text()).not.toContain("argo retry");
    vi.advanceTimersByTime(60_000);
    expect(duration()).toBe("6m");
  });

  it("says why the steps cannot be shown when the controller keeps them elsewhere", async () => {
    const offloaded = structuredClone(workflow);
    const status = offloaded.status as Record<string, unknown>;
    delete status.nodes;
    status.offloadNodeStatusVersion = "fnv:123";
    await start({ objects: [offloaded], context: { view: "details", contribution: "workflow", selection: [ref(workflow)], resourceVersion: "1" } });
    stop = startDetails(host.sextant, root, "workflow");
    await expect.poll(text).toContain(t("tree.offloaded"));
  });

  it("reads the Workflow again when it changes, keeps what is expanded, and speaks the UI language", async () => {
    setLanguage("ru");
    await start({ context: { view: "details", contribution: "workflow", selection: [ref(workflow)], resourceVersion: "1", language: "ru" } });
    stop = startDetails(host.sextant, root, "workflow");
    await expect.poll(text).toContain(t("sections.nodes"));
    expect(t("sections.nodes")).not.toBe("Steps");
    button(t("tree.expandFailed"))!.click();
    expect(treeNames()).toHaveLength(4);
    host.setContext({ resourceVersion: "2" });
    await expect.poll(() => host.calls.filter((c) => c.method === "resources.get").length).toBe(2);
    expect(treeNames()).toHaveLength(4);
  });
});

describe("other details", () => {
  it("a CronWorkflow: schedule, time zone, last run and the active workflows", async () => {
    await start({ context: { view: "details", contribution: "cron-workflow", selection: [ref(cron)], resourceVersion: "1" } });
    stop = startDetails(host.sextant, root, "cron-workflow");
    await expect.poll(text).toContain("0 2 * * *");
    expect(text()).toContain("Europe/Berlin");
    expect(text()).toContain("Replace");
    expect(text()).toContain("9h");
    expect([...root.querySelectorAll("button.sx-link")].map((b) => b.textContent)).toEqual(["nightly-diamond-1760925600"]);
  });

  it("a template: its entrypoint and templates; hidden while it has neither", async () => {
    const template = {
      apiVersion: "argoproj.io/v1alpha1",
      kind: "ClusterWorkflowTemplate",
      metadata: { name: "build" },
      spec: { entrypoint: "main", templates: [{ name: "main" }, { name: "test" }] },
    } as unknown as KubeObject;
    let current: object = { ...template, spec: {} };
    const hidden: boolean[] = [];
    await start({
      context: { view: "details", contribution: "template", selection: [ref(template)], resourceVersion: "1" },
      handlers: { "resources.get": () => structuredClone(current), "ui.setHidden": ({ hidden: value }) => void hidden.push(value as boolean) },
    });
    stop = startDetails(host.sextant, root, "template");
    await expect.poll(() => hidden).toEqual([true]);
    current = template;
    host.setContext({ resourceVersion: "2" });
    await expect.poll(() => hidden).toEqual([true, false]);
    expect([...root.querySelectorAll(".sx-chip")].map((c) => c.textContent)).toEqual(["main", "test"]);
  });
});

describe("an action's window", () => {
  const sent = () => host.calls.filter((c) => c.method === "resources.patch").map((c) => c.params);
  const shownPatches = () => [...root.querySelectorAll("pre")].map((p) => p.textContent);

  it("Resume lists the exact patch, then sends it to the object once with the re-read resourceVersion", async () => {
    let reads = 0;
    await start({
      context: { view: "action", contribution: "resume", selection: [ref(suspended)] },
      handlers: {
        "resources.get": () => {
          const wf = structuredClone(suspended);
          // An unrelated update by the controller between showing and sending.
          if (++reads > 1) wf.metadata.resourceVersion = "48212";
          return wf;
        },
        "resources.patch": () => suspended,
      },
    });
    stop = startAction(host.sextant, root, "resume");
    await expect.poll(shownPatches).toHaveLength(1);
    expect(shownPatches()[0]).toContain('"spec":{"suspend":null}');
    expect(shownPatches()[0]).toContain('"resourceVersion":"48211"');
    expect(text()).toContain("Resume workflow suspend-template-kxt9w?");
    expect(text()).toContain(t("dialog.versioned"));
    expect(text()).toContain(t("dialog.stamped"));
    const confirm = root.querySelector("button.primary") as HTMLButtonElement;
    expect(confirm.textContent).toBe("Resume");
    confirm.click();
    await expect.poll(() => host.closedByFrame).toBe(true);
    expect(sent()).toHaveLength(1);
    const params = sent()[0] as { clusterId: string; ref: unknown; patchType: string; patch: Record<string, Record<string, unknown>> };
    expect(params).toMatchObject({ clusterId: "test-cluster", ref: ref(suspended), patchType: "merge" });
    expect(params.patch.metadata).toEqual({ resourceVersion: "48212", labels: ACTOR_NULLS });
    expect(params.patch.spec).toEqual({ suspend: null });
    const approve = (params.patch.status!.nodes as Record<string, Record<string, unknown>>)[APPROVE]!;
    expect(approve.phase).toBe("Succeeded");
    expect(approve.finishedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  it("Stop sends spec.shutdown once, marked dangerous", async () => {
    await start({ context: { view: "action", contribution: "stop", selection: [ref(suspended)] }, handlers: { "resources.patch": () => suspended } });
    stop = startAction(host.sextant, root, "stop");
    await expect.poll(shownPatches).toEqual(['{"spec":{"shutdown":"Stop"}}']);
    expect(text()).not.toContain(t("dialog.versioned"));
    (root.querySelector("button.danger") as HTMLButtonElement).click();
    await expect.poll(() => host.closedByFrame).toBe(true);
    expect(sent()).toEqual([{ clusterId: "test-cluster", ref: ref(suspended), patch: { spec: { shutdown: "Stop" } }, patchType: "merge" }]);
  });

  it("sends nothing when the Workflow changed since the patch was shown, and shows why", async () => {
    let reads = 0;
    await start({
      context: { view: "action", contribution: "terminate", selection: [ref(suspended)] },
      handlers: {
        "resources.get": () => {
          const wf = structuredClone(suspended);
          if (++reads > 1) (wf.status as Record<string, unknown>).phase = "Failed";
          return wf;
        },
      },
    });
    stop = startAction(host.sextant, root, "terminate");
    await expect.poll(shownPatches).toEqual(['{"spec":{"shutdown":"Terminate"}}']);
    const confirm = root.querySelector("button.danger") as HTMLButtonElement;
    confirm.click();
    await expect.poll(text).toContain(t("dialog.changed"));
    expect(text()).toContain(t("dialog.refusal.finished"));
    expect(confirm.disabled).toBe(true);
    expect(sent()).toEqual([]);
  });

  it("says why Suspend cannot be sent to a completed Workflow, and Resume what it cannot resume", async () => {
    await start({ context: { view: "action", contribution: "suspend", selection: [ref(workflow)] } });
    stop = startAction(host.sextant, root, "suspend");
    await expect.poll(text).toContain(t("dialog.refusal.completed"));
    expect((root.querySelector("button.primary") as HTMLButtonElement).disabled).toBe(true);
    stop();
    root.remove();
    host.close();
    const compressed = structuredClone(suspended);
    (compressed.status as Record<string, unknown>).compressedNodes = "H4sIAAAAAAAA/6quBQQAAP//";
    await start({ objects: [compressed], context: { view: "action", contribution: "resume", selection: [ref(suspended)] } });
    stop = startAction(host.sextant, root, "resume");
    await expect.poll(text).toContain(`argo resume ${W} -n argo`);
    expect(root.querySelectorAll("pre")).toHaveLength(0);
  });

  it("says what Sextant or the cluster answered when the patch is refused", async () => {
    await start({
      context: { view: "action", contribution: "stop", selection: [ref(suspended)] },
      handlers: {
        "resources.patch": () => {
          throw new SextantError("denied", "the extension may not modify Workflow argo/suspend-template-kxt9w");
        },
      },
    });
    stop = startAction(host.sextant, root, "stop");
    await expect.poll(shownPatches).toHaveLength(1);
    (root.querySelector("button.danger") as HTMLButtonElement).click();
    await expect.poll(text).toContain("Sextant refused: the extension may not modify");
    expect(host.closedByFrame).toBe(false);
  });
});
