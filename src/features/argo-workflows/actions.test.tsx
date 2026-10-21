import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings, type KindRef, type KubeObject, type ObjectRef } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore } from "../../app/store";
import { ActionDialogHost } from "../../layout/main/ActionDialogHost";
import { getResourceDef, kindFromApiVersion, resetClusterKinds } from "../../resources";
import { axeViolations } from "../../test/axe";
import "../actions";
import { getAction, getActionsFor, runAction, type ActionId } from "../actions/registry";
import { copy, watchBackend, type WatchBackend } from "../details/testing";
import suspendedJson from "./fixtures/workflow-suspended.json";
import failedJson from "./fixtures/workflow-dag-failed.json";
import "./index";
import { CRON_WORKFLOW, WORKFLOW } from "./model";
import { nowStamp, patchToSend, planFor } from "./patches";

const suspended = suspendedJson as unknown as KubeObject;
const failed = failedJson as unknown as KubeObject;
const W = "suspend-template-kxt9w";
const APPROVE = `${W}-1879311160`;
const ACTOR_NULLS = { "workflows.argoproj.io/actor": null, "workflows.argoproj.io/action": null };

const kindOf = (obj: KubeObject): KindRef => kindFromApiVersion(obj.apiVersion ?? "", obj.kind ?? "");
const refTo = (obj: KubeObject): ObjectRef => ({ kind: kindOf(obj), namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" });
const spec = (obj: KubeObject) => obj.spec as Record<string, unknown>;
const st = (obj: KubeObject) => obj.status as Record<string, unknown>;
const node = (obj: KubeObject, id: string) => (st(obj).nodes as Record<string, Record<string, unknown>>)[id]!;

/** The fixture without `spec.suspend`: waiting only at its `approve` suspend step. */
function atApproval(): KubeObject {
  const wf = copy(suspended);
  delete spec(wf).suspend;
  return wf;
}

describe("the patches, as util.go builds them", () => {
  it("suspend: spec.suspend with the actor labels removed (no claims), versioned; refused once completed", () => {
    const plan = planFor("suspend", atApproval());
    expect(plan).toEqual({ versioned: true, stamped: [], patch: { metadata: { labels: ACTOR_NULLS }, spec: { suspend: true } } });
    expect(patchToSend(plan, "48211", "2026-10-21T10:00:00Z")).toEqual({
      metadata: { resourceVersion: "48211", labels: ACTOR_NULLS },
      spec: { suspend: true },
    });
    expect(planFor("suspend", suspended).patch).toBeUndefined();
    expect(planFor("suspend", failed).refusal).toEqual({ reason: "completed" });
  });

  it("resume: lifts spec.suspend and marks the running suspend node Succeeded at the time of sending", () => {
    const plan = planFor("resume", suspended);
    expect(plan.stamped).toEqual([APPROVE]);
    expect(patchToSend(plan, "48211", "2026-10-21T10:00:00Z")).toEqual({
      metadata: { resourceVersion: "48211", labels: ACTOR_NULLS },
      spec: { suspend: null },
      status: { nodes: { [APPROVE]: { phase: "Succeeded", finishedAt: "2026-10-21T10:00:00Z" } } },
    });
    // Only the suspend step: no spec part, and a message is kept with util.go's "; " (no user to name).
    const wf = atApproval();
    node(wf, APPROVE).message = "waiting for approval";
    expect(planFor("resume", wf).patch).toEqual({
      metadata: { labels: ACTOR_NULLS },
      status: { nodes: { [APPROVE]: { phase: "Succeeded", message: "waiting for approval; " } } },
    });
    expect(nowStamp(new Date("2026-10-21T10:00:00.123Z"))).toBe("2026-10-21T10:00:00Z");
  });

  it("resume: a supplied output takes valueFrom.default and is exported to the global outputs; no default refuses", () => {
    // workflow/util/util.go `OverrideOutputParametersWithDefault`: `param.ValueFrom.Default` is checked and becomes
    // the value; `valueFrom` stays as it is.
    const wf = atApproval();
    node(wf, APPROVE).outputs = {
      parameters: [{ name: "message", globalName: "approval", valueFrom: { supplied: {}, default: "approved" } }],
    };
    st(wf).outputs = { parameters: [{ name: "other", value: "x" }] };
    expect(planFor("resume", wf).patch).toEqual({
      metadata: { labels: ACTOR_NULLS },
      status: {
        nodes: {
          [APPROVE]: {
            phase: "Succeeded",
            outputs: { parameters: [{ name: "message", globalName: "approval", valueFrom: { supplied: {}, default: "approved" }, value: "approved" }] },
          },
        },
        outputs: { parameters: [{ name: "other", value: "x" }, { name: "approval", value: "approved" }] },
      },
    });
    // The parameter's own `default` is not what util.go reads: without `valueFrom.default` the resume is refused.
    const params = (node(wf, APPROVE).outputs as { parameters: Record<string, unknown>[] }).parameters;
    params[0] = { name: "message", default: "approved", globalName: "approval", valueFrom: { supplied: {} } };
    expect(planFor("resume", wf)).toMatchObject({ refusal: { reason: "noDefault", step: "approve", parameter: "message" } });
  });

  it("resume: refused when the nodes are compressed or offloaded; nothing when nothing waits", () => {
    const compressed = copy(suspended);
    st(compressed).compressedNodes = "H4sIAAAAAAAA/6quBQQAAP//";
    expect(planFor("resume", compressed).refusal).toEqual({ reason: "nodesElsewhere" });
    expect(planFor("resume", failed)).toEqual({ versioned: true, stamped: [] });
  });

  it("stop and terminate: spec.shutdown, unversioned and without labels; refused once finished", () => {
    expect(planFor("stop", suspended)).toEqual({ versioned: false, stamped: [], patch: { spec: { shutdown: "Stop" } } });
    expect(planFor("terminate", suspended).patch).toEqual({ spec: { shutdown: "Terminate" } });
    const stopping = copy(suspended);
    spec(stopping).shutdown = "Stop";
    expect(planFor("stop", stopping).patch).toBeUndefined();
    expect(planFor("terminate", stopping).patch).toEqual({ spec: { shutdown: "Terminate" } });
    expect(planFor("stop", failed).refusal).toEqual({ reason: "finished" });
  });
});

// ---------- In the app ----------

const ACTIONS: ActionId[] = ["workflowSuspend", "workflowResume", "workflowStop", "workflowTerminate"];
const offered = (obj: KubeObject) => getActionsFor([obj], kindOf(obj), ACTIONS).map((a) => a.id);

let wb: WatchBackend;
let live: KubeObject;
const calls = (cmd: string) => wb.backend.calls.filter((c) => c.cmd === cmd).map((c) => c.args);

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetSettingsCache();
  wb = watchBackend();
  wb.backend.on("settings_get", () => defaultAppSettings());
  live = copy(suspended);
  wb.backend.on("resource_get", () => copy(live));
  wb.backend.on("resource_patch", () => copy(live));
  render(<ActionDialogHost />);
});

afterEach(() => {
  wb.backend.restore();
  resetClusterKinds();
  resetSettingsCache();
});

async function run(id: ActionId, obj: KubeObject) {
  await act(async () => {
    await runAction(getAction(id)!, "c1", kindOf(obj), [obj]);
  });
}

describe("the Workflow actions", () => {
  it("are offered as util.go would act, on Workflows only", () => {
    expect(offered(suspended)).toEqual(["workflowResume", "workflowStop", "workflowTerminate"]);
    const running = copy(suspended);
    delete spec(running).suspend;
    st(running).nodes = {};
    expect(offered(running)).toEqual(["workflowSuspend", "workflowStop", "workflowTerminate"]);
    expect(offered(failed)).toEqual([]);
    expect(getResourceDef(WORKFLOW).actions).toEqual(expect.arrayContaining(ACTIONS));
    expect(getResourceDef(CRON_WORKFLOW).actions).toEqual(["edit", "delete"]);
  });

  it("Resume lists the exact patch, then sends it to the object once with the re-read resourceVersion", async () => {
    await run("workflowResume", suspended);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText(/"spec":\{"suspend":null\}/)).toBeInTheDocument());
    expect(within(dialog).getByText(/"resourceVersion":"48211"/)).toBeInTheDocument();
    // The resourceVersion and finishedAt shown are those of the dialog's opening: both are refreshed when sent.
    expect(within(dialog).getByText(/read again right before sending and the fresh one is sent/)).toBeInTheDocument();
    expect(within(dialog).getByText(/finishedAt shown is set anew to the time of sending/)).toBeInTheDocument();
    expect(await axeViolations(dialog)).toEqual([]);
    live.metadata!.resourceVersion = "48212"; // an unrelated update by the controller meanwhile
    fireEvent.click(within(dialog).getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const sent = calls("resource_patch");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ clusterId: "c1", ref: refTo(suspended), patchType: "merge" });
    const patch = sent[0]!.patch as Record<string, Record<string, unknown>>;
    expect(patch.metadata).toEqual({ resourceVersion: "48212", labels: ACTOR_NULLS });
    expect(patch.spec).toEqual({ suspend: null });
    const approve = (patch.status!.nodes as Record<string, Record<string, unknown>>)[APPROVE]!;
    expect(approve.phase).toBe("Succeeded");
    expect(approve.finishedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(calls("resource_patch_status")).toEqual([]);
  });

  it("Stop sends spec.shutdown once; nothing when the workflow changed since the dialog showed the patch", async () => {
    await run("workflowStop", suspended);
    let dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText('{"spec":{"shutdown":"Stop"}}')).toBeInTheDocument());
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls("resource_patch")).toEqual([{ clusterId: "c1", ref: refTo(suspended), patch: { spec: { shutdown: "Stop" } }, patchType: "merge" }]);

    await run("workflowTerminate", suspended);
    dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText('{"spec":{"shutdown":"Terminate"}}')).toBeInTheDocument());
    st(live).phase = "Failed";
    fireEvent.click(within(dialog).getByRole("button", { name: "Terminate" }));
    await waitFor(() => expect(within(dialog).getByText(/changed while this dialog was open/)).toBeInTheDocument());
    expect(within(dialog).getByText(/already finished/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Terminate" })).toBeDisabled();
    expect(calls("resource_patch")).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
