import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type KindRef, type KubeObject, type ObjectRef } from "../../api";
import { resetAppStore } from "../../app/store";
import { ActionDialogHost } from "../../layout/main/ActionDialogHost";
import { axeViolations } from "../../test/axe";
import { getAction, runAction } from "../actions/registry";
import { ROLLOUT } from "../argo-rollouts/model";
import { emitDelta, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import "./index";
import { planRestart, POD, REPLICA_SET } from "./model";
import { RestartDialog } from "./RestartDialog";

const DEPLOYMENT: KindRef = { group: "apps", version: "v1", kind: "Deployment" };

function obj(kind: KindRef, name: string, extra: Record<string, unknown> = {}, meta: Record<string, unknown> = {}): KubeObject {
  return {
    apiVersion: kind.group ? `${kind.group}/${kind.version}` : kind.version,
    kind: kind.kind,
    metadata: { name, namespace: "demo", uid: `uid-${name}`, ...meta },
    ...extra,
  } as KubeObject;
}

const controller = (apiVersion: string, kind: string, name: string) => ({ apiVersion, kind, name, uid: `uid-${name}`, controller: true });

let wb: WatchBackend;
/** What `resource_get` answers, by object name. */
let live: Map<string, KubeObject>;
beforeEach(() => {
  resetAppStore();
  wb = watchBackend();
  live = new Map();
  wb.backend.on("resource_get", (args) => {
    const found = live.get((args.ref as ObjectRef).name);
    if (!found) throw { code: "notFound", message: "not found" };
    return found;
  });
  render(<ActionDialogHost />);
  while (screen.queryAllByRole("dialog").length > 0) fireEvent.keyDown(window, { key: "Escape" });
});
afterEach(() => wb.backend.restore());

const calls = (cmd: string) => wb.backend.calls.filter((c) => c.cmd === cmd).map((c) => c.args);
const sent = () => wb.backend.calls.filter((c) => ["workload_restart", "resource_patch", "resource_delete"].includes(c.cmd)).map((c) => c.cmd);

async function run(kind: KindRef, objects: KubeObject[]) {
  for (const o of objects) if (!live.has(o.metadata?.name ?? "")) live.set(o.metadata?.name ?? "", o);
  const action = getAction("restart")!;
  await act(async () => {
    await runAction(action, "c1", kind, objects);
  });
}

describe("several objects at once", () => {
  it("lists every object, sends one at a time, never retries, and tells which failed and why", async () => {
    wb.backend.on("workload_restart", (args) => {
      if ((args.ref as ObjectRef).name === "b") throw { code: "forbidden", message: "deployments.apps \"b\" is forbidden" };
    });
    await run(DEPLOYMENT, [obj(DEPLOYMENT, "a"), obj(DEPLOYMENT, "b"), obj(DEPLOYMENT, "c")]);
    const dialog = screen.getByRole("dialog", { name: "Restart 3 objects?" });
    expect(within(dialog).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Deployment demo/a: its pods are replaced one by one (rollout restart).",
      "Deployment demo/b: its pods are replaced one by one (rollout restart).",
      "Deployment demo/c: its pods are replaced one by one (rollout restart).",
    ]);
    expect(dialog).toHaveTextContent("kubectl.kubernetes.io/restartedAt");
    expect(await axeViolations(dialog)).toEqual([]);
    expect(sent()).toEqual([]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Restart" }));
    await screen.findByText("2 of 3 restarted.");
    expect(calls("workload_restart").map((a) => (a.ref as ObjectRef).name)).toEqual(["a", "b", "c"]);
    const result = screen.getByRole("dialog");
    expect(result).toHaveTextContent("Restarted: Deployment demo/a");
    expect(within(result).getByRole("alert")).toHaveTextContent("Not restarted: Deployment demo/b");
    expect(within(result).getByRole("alert")).toHaveTextContent("is forbidden");
    expect(result).toHaveTextContent("Restarted: Deployment demo/c");
    expect(await axeViolations(result)).toEqual([]);
  });

  it("names the first 20 and counts the rest", async () => {
    const many = Array.from({ length: 23 }, (_, i) => obj(DEPLOYMENT, `d${i}`));
    await run(DEPLOYMENT, many);
    const dialog = screen.getByRole("dialog", { name: "Restart 23 objects?" });
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(20);
    expect(dialog).toHaveTextContent("…and 3 more objects.");
  });

  it("Stop lets the current request finish and starts nothing more", async () => {
    let finish: () => void = () => {};
    wb.backend.on("workload_restart", () => new Promise<void>((resolve) => (finish = resolve)));
    await run(DEPLOYMENT, [obj(DEPLOYMENT, "a"), obj(DEPLOYMENT, "b"), obj(DEPLOYMENT, "c")]);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(calls("workload_restart")).toHaveLength(1));
    // Escape does not close a running restart.
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.getByRole("button", { name: "Stopping after the current step…" })).toBeDisabled();
    await act(async () => finish());
    await screen.findByText("Stopped: 1 of 3 restarted; the rest were not started.");
    expect(calls("workload_restart")).toHaveLength(1);
    expect(screen.getByRole("dialog")).toHaveTextContent("Not started: Deployment demo/c");
  });

  it("reads each object again and sends nothing for one replaced or paused since", async () => {
    wb.backend.on("workload_restart", () => undefined);
    await run(DEPLOYMENT, [obj(DEPLOYMENT, "a"), obj(DEPLOYMENT, "b")]);
    live.set("a", obj(DEPLOYMENT, "a", {}, { uid: "another" }));
    live.set("b", obj(DEPLOYMENT, "b", { spec: { paused: true } }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Restart" }));
    await screen.findByText("0 of 2 restarted.");
    expect(sent()).toEqual([]);
    expect(screen.getByRole("dialog")).toHaveTextContent("was replaced by another object of the same name");
    expect(screen.getByRole("dialog")).toHaveTextContent("is paused");
  });
});

describe("Argo Rollouts", () => {
  it("sends exactly kubectl argo rollouts restart's merge patch to the Rollout", async () => {
    wb.backend.on("resource_patch", (args) => args.patch);
    const ro = obj(ROLLOUT, "ro");
    live.set("ro", ro);
    const at = new Date("2026-10-23T10:11:12.345Z");
    render(<RestartDialog clusterId="c1" steps={planRestart([ro], ROLLOUT)} close={() => {}} control={{ now: () => at }} />);
    const dialog = screen.getByRole("dialog", { name: "Restart Rollout ro?" });
    expect(dialog).toHaveTextContent('{"spec":{"restartAt":"2026-10-23T10:11:12Z"}}');
    fireEvent.click(within(dialog).getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(calls("resource_patch")).toHaveLength(1));
    expect(calls("resource_patch")[0]).toEqual({
      clusterId: "c1",
      ref: { kind: ROLLOUT, namespace: "demo", name: "ro" },
      patch: { spec: { restartAt: "2026-10-23T10:11:12Z" } },
      patchType: "merge",
    });
    expect(wb.backend.calls.map((c) => c.cmd)).not.toContain("resource_patch_status");
  });
});

describe("ReplicaSets", () => {
  it("restarts the owning Deployment, read again, instead of the ReplicaSet", async () => {
    wb.backend.on("workload_restart", () => undefined);
    const rs = obj(REPLICA_SET, "web-1", {}, { ownerReferences: [controller("apps/v1", "Deployment", "web")] });
    live.set("web", obj(DEPLOYMENT, "web"));
    await run(REPLICA_SET, [rs]);
    const dialog = screen.getByRole("dialog", { name: "Restart Deployment web?" });
    expect(dialog).toHaveTextContent("Deployment demo/web is restarted in place of its ReplicaSet web-1");
    fireEvent.click(within(dialog).getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls("resource_get").map((a) => (a.ref as ObjectRef).name)).toEqual(["web-1", "web"]);
    expect(calls("workload_restart")).toEqual([{ clusterId: "c1", ref: { kind: DEPLOYMENT, namespace: "demo", name: "web" } }]);
  });

  it("sends nothing when the ReplicaSet's owner changed since", async () => {
    const rs = obj(REPLICA_SET, "web-1", {}, { ownerReferences: [controller("apps/v1", "Deployment", "web")] });
    await run(REPLICA_SET, [rs]);
    live.set("web-1", obj(REPLICA_SET, "web-1", {}, { ownerReferences: [controller("apps/v1", "Deployment", "other")] }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Restart" }));
    await screen.findByText("0 of 1 restarted.");
    expect(sent()).toEqual([]);
    expect(screen.getByRole("dialog")).toHaveTextContent("The owner of ReplicaSet demo/web-1 changed");
  });

  const SELECTOR = { matchLabels: { app: "legacy" } };
  const bare = obj(REPLICA_SET, "legacy", { spec: { replicas: 2, selector: SELECTOR } });
  const pod = (name: string, ready: boolean) =>
    obj(POD, name, { status: { conditions: [{ type: "Ready", status: ready ? "True" : "False" }] } }, {
      labels: { app: "legacy" },
      ownerReferences: [controller("apps/v1", "ReplicaSet", "legacy")],
    });

  it("deletes the pods of an unowned ReplicaSet one at a time, each after the last replacement is ready", async () => {
    wb.backend.on("resource_delete", () => undefined);
    for (const p of [pod("legacy-a", true), pod("legacy-b", true)]) live.set(p.metadata!.name!, p);
    render(<RestartDialog clusterId="c1" steps={planRestart([bare], REPLICA_SET)} close={() => {}} />);
    live.set("legacy", bare);
    const dialog = screen.getByRole("dialog", { name: "Restart the pods of ReplicaSet legacy?" });
    expect(dialog).toHaveTextContent("its pods are deleted one at a time");
    expect(await axeViolations(dialog)).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Restart" }));

    const id = await watchOf(wb, "Pod");
    expect(wb.specs.get(id)).toMatchObject({ namespaces: ["demo"], labelSelector: "app=legacy" });
    emitSnapshot(wb, id, [pod("legacy-a", true), pod("legacy-b", true)]);
    await waitFor(() => expect(calls("resource_delete")).toHaveLength(1));
    expect(calls("resource_delete")[0]).toMatchObject({ ref: { name: "legacy-a" }, preconditions: { uid: "uid-legacy-a", resourceVersion: null } });
    expect(await screen.findByRole("status")).toHaveTextContent("ReplicaSet demo/legacy: 0 of 2 pods restarted");

    // The replacement exists but is not ready yet: the next pod waits.
    emitDelta(wb, id, [pod("legacy-c", false)], ["uid-legacy-a"]);
    await new Promise((r) => setTimeout(r, 300));
    expect(calls("resource_delete")).toHaveLength(1);
    emitDelta(wb, id, [pod("legacy-c", true)]);
    await waitFor(() => expect(calls("resource_delete")).toHaveLength(2));
    expect(calls("resource_delete")[1]).toMatchObject({ ref: { name: "legacy-b" } });
    emitDelta(wb, id, [pod("legacy-d", true)], ["uid-legacy-b"]);
    await screen.findByText("1 of 1 restarted.");
    expect(screen.getByRole("dialog")).toHaveTextContent("2 of 2 pods restarted.");
    // The pod watch is released.
    await waitFor(() => expect(calls("watch_stop")).toHaveLength(1));
  });

  it("leaves the other pods alone when a replacement is not ready in time", async () => {
    wb.backend.on("resource_delete", () => undefined);
    for (const p of [pod("legacy-a", true), pod("legacy-b", true)]) live.set(p.metadata!.name!, p);
    live.set("legacy", bare);
    const steps = planRestart([bare], REPLICA_SET);
    render(<RestartDialog clusterId="c1" steps={steps} close={() => {}} control={{ replacementTimeoutMs: 300 }} />);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Restart" }));
    emitSnapshot(wb, await watchOf(wb, "Pod"), [pod("legacy-a", true), pod("legacy-b", true)]);
    await screen.findByText("0 of 1 restarted.");
    expect(calls("resource_delete")).toHaveLength(1);
    expect(screen.getByRole("dialog")).toHaveTextContent("was not ready within 5 minutes");
    expect(screen.getByRole("dialog")).toHaveTextContent("1 of 2 pods restarted.");
  });
});

describe("Pods", () => {
  it("deletes a pod with a controller, with its uid as a precondition", async () => {
    wb.backend.on("resource_delete", () => undefined);
    const p = obj(POD, "web-1-abc", {}, { ownerReferences: [controller("apps/v1", "ReplicaSet", "web-1")] });
    await run(POD, [p]);
    const dialog = screen.getByRole("dialog", { name: "Restart Pod web-1-abc?" });
    expect(dialog).toHaveTextContent("Pod demo/web-1-abc is deleted, and its ReplicaSet demo/web-1 creates a new pod");
    expect(await axeViolations(dialog)).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls("resource_delete")).toEqual([
      { clusterId: "c1", ref: { kind: POD, namespace: "demo", name: "web-1-abc" }, preconditions: { uid: "uid-web-1-abc", resourceVersion: null } },
    ]);
  });

  it("is not offered for a pod nothing recreates", () => {
    const action = getAction("restart")!;
    expect(action.appliesTo(obj(POD, "bare"), POD)).toBe(false);
  });
});
