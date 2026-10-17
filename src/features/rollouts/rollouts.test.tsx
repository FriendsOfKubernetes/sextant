import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { KubeObject, ObjectRef, WatchSpec } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { ActionDialogHost } from "../../layout/main/ActionDialogHost";
import { getDetailsSections } from "../../layout/details/registry";
import { resetClusterKinds } from "../../resources";
import "../details";
import { emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { controllerRevision, deployment, replicaSet, statefulSet, template } from "./fixtures";
import { RollbackDialog } from "./RollbackDialog";
import "./index";

// CodeMirror measures text through Range rects, which jsdom does not implement.
beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) };
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as DOMRectList;
});

const DEPLOYMENT: ObjectRef = { kind: { group: "apps", version: "v1", kind: "Deployment" }, namespace: "shop", name: "web" };
const STATEFUL_SET: ObjectRef = { kind: { group: "apps", version: "v1", kind: "StatefulSet" }, namespace: "shop", name: "web" };

const REPLICA_SETS = [
  replicaSet(1, "nginx:1.25", "first release"),
  replicaSet(2, "nginx:1.26"),
  replicaSet(3, "nginx:1.27", "bump to 1.27"),
  // Same labels, another owner: not a revision of web.
  replicaSet(7, "busybox", "not mine", "someone-else"),
];

let wb: WatchBackend;

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => []);
});

afterEach(() => {
  wb.backend.restore();
  resetClusterKinds();
});

const isRevisionWatch = (spec: WatchSpec) => spec.labelSelector === "app=web" && spec.namespaces?.[0] === "shop";

/** Opens the details of `obj` on its History tab and answers the watch of its revisions with `revisions`. */
async function openHistory(ref: ObjectRef, obj: KubeObject, revisions: KubeObject[]): Promise<void> {
  useAppStore.getState().openDetails(ref);
  render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  emitSnapshot(wb, await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`), [obj]);
  fireEvent.click(await screen.findByRole("tab", { name: "History" }));
  const holder = ref.kind.kind === "Deployment" ? "ReplicaSet" : "ControllerRevision";
  emitSnapshot(wb, await watchOf(wb, holder, isRevisionWatch), revisions);
}

function rows(): string[][] {
  const table = screen.getByRole("table");
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((tr) => [...tr.querySelectorAll("td")].slice(1, 5).map((td) => td.textContent ?? ""));
}

describe("the History tab", () => {
  it("is a tab of Deployments, StatefulSets and DaemonSets only", () => {
    const has = (kind: string, group = "apps") =>
      getDetailsSections({ group, version: "v1", kind }).some((s) => s.id === "rolloutHistory" && s.placement === "tab");
    expect([has("Deployment"), has("StatefulSet"), has("DaemonSet")]).toEqual([true, true, true]);
    expect([has("ReplicaSet"), has("Pod", "")]).toEqual([false, false]);
  });

  it("lists the revisions newest first with time, change-cause and images, the current one marked", async () => {
    await openHistory(DEPLOYMENT, deployment(), REPLICA_SETS);
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(rows().map(([revision, , cause, images]) => [revision, cause, images])).toEqual([
      ["3current", "bump to 1.27", "nginx:1.27"],
      ["2", "", "nginx:1.26"],
      ["1", "first release", "nginx:1.25"],
    ]);
    // The current revision has nothing to roll back to; the others do.
    expect(screen.queryByRole("button", { name: "Roll back to revision 3" })).toBeNull();
    expect(screen.getByRole("button", { name: "Roll back to revision 1" })).toBeInTheDocument();
    expect(screen.getByText("Complete")).toBeInTheDocument();
  });

  it("compares two selected revisions side by side, older on the left", async () => {
    await openHistory(DEPLOYMENT, deployment(), REPLICA_SETS);
    expect(await screen.findByText("Select two revisions to compare their pod templates.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare revision 3" }));
    expect(screen.getByText("Select one more revision to compare.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare revision 1" }));
    const left = await screen.findByLabelText("Revision 1", { selector: "[contenteditable]" });
    const right = screen.getByLabelText("Revision 3", { selector: "[contenteditable]" });
    expect(left.textContent).toContain("nginx:1.25");
    expect(right.textContent).toContain("nginx:1.27");
    // The ReplicaSets' hash label is not a difference.
    expect(left.textContent).not.toContain("pod-template-hash");
    // A third choice replaces the older of the two.
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare revision 2" }));
    expect(screen.getByRole("checkbox", { name: "Compare revision 3" })).not.toBeChecked();
    expect(screen.getByLabelText("Revision 1", { selector: "[contenteditable]" })).toBeInTheDocument();
    expect(screen.getByLabelText("Revision 2", { selector: "[contenteditable]" })).toBeInTheDocument();
  });

  it("shows a rollout that is progressing and one that is stuck, with the reason", async () => {
    const stuck = deployment();
    stuck.status = {
      observedGeneration: 4,
      replicas: 4,
      updatedReplicas: 1,
      readyReplicas: 3,
      availableReplicas: 3,
      conditions: [
        {
          type: "Progressing",
          status: "False",
          reason: "ProgressDeadlineExceeded",
          message: 'ReplicaSet "web-4" has timed out progressing.',
        },
      ],
    };
    await openHistory(DEPLOYMENT, stuck, REPLICA_SETS);
    expect(await screen.findByText("Stuck")).toBeInTheDocument();
    expect(screen.getByText("1 of 3 updated · 3 ready · 3 available")).toBeInTheDocument();
    expect(screen.getByText('ProgressDeadlineExceeded: ReplicaSet "web-4" has timed out progressing.')).toBeInTheDocument();
  });

  it("rolls back after a confirmation that shows the change, with kubectl's patch", async () => {
    await openHistory(DEPLOYMENT, deployment(), REPLICA_SETS);
    wb.backend.on("resource_patch", () => deployment({ image: "nginx:1.25" }));
    fireEvent.click(await screen.findByRole("button", { name: "Roll back to revision 1" }));

    const dialog = await screen.findByRole("dialog", { name: "Roll back web" });
    expect(within(dialog).getByLabelText("Current template", { selector: "[contenteditable]" }).textContent).toContain("nginx:1.27");
    expect(within(dialog).getByLabelText("Revision 1", { selector: "[contenteditable]" }).textContent).toContain("nginx:1.25");
    expect(wb.backend.calls.some((c) => c.cmd === "resource_patch")).toBe(false);

    fireEvent.click(within(dialog).getByRole("button", { name: "Roll back to revision 1" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const patch = wb.backend.calls.find((c) => c.cmd === "resource_patch");
    expect(patch?.args).toEqual({
      clusterId: "c1",
      ref: DEPLOYMENT,
      patchType: "json",
      patch: [
        { op: "replace", path: "/spec/template", value: template("nginx:1.25") },
        {
          op: "replace",
          path: "/metadata/annotations",
          value: {
            "deployment.kubernetes.io/revision": "3",
            "kubectl.kubernetes.io/last-applied-configuration": "{}",
            "kubernetes.io/change-cause": "first release",
            team: "shop",
          },
        },
      ],
    });
  });

  it("keeps the dialog open with the error when the patch fails, and cancels without sending", async () => {
    await openHistory(DEPLOYMENT, deployment(), REPLICA_SETS);
    wb.backend.on("resource_patch", () => {
      throw { code: "forbidden", message: "deployments.apps \"web\" is forbidden" };
    });
    fireEvent.click(await screen.findByRole("button", { name: "Roll back to revision 2" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Roll back to revision 2" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("is forbidden");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not roll back a paused Deployment", async () => {
    await openHistory(DEPLOYMENT, deployment({ paused: true }), REPLICA_SETS);
    expect(await screen.findByText("Paused")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Roll back to revision 1" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("This Deployment is paused. Resume it before rolling it back.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Roll back to revision 1" })).toBeDisabled();
  });

  it("rolls a StatefulSet back to the template of its ControllerRevision", async () => {
    const revisions = [
      controllerRevision("StatefulSet", "web-a", 1, "redis:7.0"),
      controllerRevision("StatefulSet", "web-b", 2, "redis:7.2"),
    ];
    await openHistory(STATEFUL_SET, statefulSet(), revisions);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows()[0]![0]).toBe("2current");
    wb.backend.on("resource_patch", () => statefulSet());
    fireEvent.click(screen.getByRole("button", { name: "Roll back to revision 1" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Roll back to revision 1" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const patch = wb.backend.calls.find((c) => c.cmd === "resource_patch");
    expect(patch?.args.patch).toEqual([
      {
        op: "replace",
        path: "/spec/template",
        value: { ...template("redis:7.0"), metadata: { creationTimestamp: null, labels: { app: "web" } } },
      },
    ]);
  });
});

describe("the rollback dialog on its own (the Roll back… action)", () => {
  it("watches the revisions and offers the one before the newest, as kubectl rollout undo", async () => {
    render(
      <RollbackDialog clusterId="c1" objectRef={DEPLOYMENT} workload={deployment()} kind="Deployment" close={() => undefined} />,
    );
    emitSnapshot(wb, await watchOf(wb, "ReplicaSet", isRevisionWatch), REPLICA_SETS);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("combobox")).toHaveValue("2");
    expect(within(dialog).getByRole("button", { name: "Roll back to revision 2" })).toBeEnabled();
    // The current revision changes nothing.
    act(() => {
      fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "3" } });
    });
    expect(within(dialog).getByText("The current template already matches revision 3: there is nothing to change.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Roll back to revision 3" })).toBeDisabled();
  });
});

describe("the Roll back… action", () => {
  it("is offered on a Deployment and opens the confirmation with the previous revision", async () => {
    useAppStore.getState().openDetails(DEPLOYMENT);
    render(
      <>
        <DetailsPanel clusterId="c1" objectRef={DEPLOYMENT} />
        <ActionDialogHost />
      </>,
    );
    emitSnapshot(wb, await watchOf(wb, "Deployment", (s) => s.fieldSelector === "metadata.name=web"), [deployment()]);
    fireEvent.click(await screen.findByRole("button", { name: "Roll back…" }));
    emitSnapshot(wb, await watchOf(wb, "ReplicaSet", isRevisionWatch), REPLICA_SETS);
    const dialog = await screen.findByRole("dialog", { name: "Roll back web" });
    expect(within(dialog).getByRole("combobox")).toHaveValue("2");
    expect(within(dialog).getByRole("button", { name: "Roll back to revision 2" })).toBeEnabled();
    expect(wb.backend.calls.some((c) => c.cmd === "resource_patch")).toBe(false);
  });
});
