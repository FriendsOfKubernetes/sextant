// Delete of one object or a selection (ADR-0126): the confirmation's list and warnings, the typed count, one request
// at a time with the uid as precondition, Stop, and an outcome for every object.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type KindRef, type KubeObject, type MockBackend, type ObjectRef } from "../../api";
import { resetAppStore } from "../../app/store";
import { ActionDialogHost } from "../../layout/main/ActionDialogHost";
import { axeViolations } from "../../test/axe";
import { TYPE_COUNT_ABOVE } from "../hygiene/CleanupDeleteDialog";
import { MAX_LISTED, planDelete } from "./deleteRun";
import "./index";
import { getAction, runAction } from "./registry";

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const CONFIG_MAP: KindRef = { group: "", version: "v1", kind: "ConfigMap" };
const NAMESPACE: KindRef = { group: "", version: "v1", kind: "Namespace" };

function obj(kind: KindRef, name: string, namespace?: string, meta: Record<string, unknown> = {}): KubeObject {
  return { apiVersion: "v1", kind: kind.kind, metadata: { name, namespace, uid: `uid-${name}`, ...meta } };
}
const owned = (name: string) =>
  obj(POD, name, "demo", { ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "web-5d8f", uid: "rs", controller: true }] });

let backend: MockBackend;
beforeEach(() => {
  resetAppStore();
  backend = mockBackend();
  render(<ActionDialogHost />);
  while (screen.queryAllByRole("dialog").length > 0) fireEvent.keyDown(window, { key: "Escape" });
});
afterEach(() => backend.restore());

async function remove(kind: KindRef, objects: KubeObject[]) {
  await act(async () => {
    await runAction(getAction("delete")!, "c1", kind, objects);
  });
  return screen.getByRole("dialog");
}
const names = () => backend.calls.filter((c) => c.cmd === "resource_delete").map((c) => (c.args.ref as ObjectRef).name);

describe("planDelete", () => {
  it("keeps the order given, Namespaces last, with the uid, the controller and a GitOps manager", () => {
    const refs: ObjectRef[] = [
      { kind: NAMESPACE, namespace: null, name: "team-a" },
      { kind: POD, namespace: "demo", name: "web-1" },
      { kind: CONFIG_MAP, namespace: "demo", name: "cfg" },
    ];
    const objects = [
      obj(NAMESPACE, "team-a"),
      owned("web-1"),
      obj(CONFIG_MAP, "cfg", "demo", { labels: { "argocd.argoproj.io/instance": "shop" } }),
    ];
    const items = planDelete(refs, objects);
    expect(items.map((i) => i.ref.name)).toEqual(["web-1", "cfg", "team-a"]);
    expect(items[0]).toMatchObject({ uid: "uid-web-1", controller: { name: "web-5d8f", kind: { kind: "ReplicaSet" } } });
    expect(items[1]).toMatchObject({ uid: "uid-cfg", gitops: { tool: "argocd", name: "shop" } });
    // Without the objects nothing but the names is known: no precondition is sent.
    expect(planDelete(refs).map((i) => i.uid)).toEqual([undefined, undefined, undefined]);
  });
});

describe("Delete of a selection", () => {
  it("lists a bounded number of names and counts the rest", async () => {
    const many = Array.from({ length: MAX_LISTED + 10 }, (_, i) => obj(CONFIG_MAP, `cm-${i}`, "demo"));
    const dialog = await remove(CONFIG_MAP, many);
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(MAX_LISTED);
    expect(dialog).toHaveTextContent("…and 10 more objects.");
  });

  it("asks for the count to be typed above TYPE_COUNT_ABOVE objects, not at it", async () => {
    const at = Array.from({ length: TYPE_COUNT_ABOVE }, (_, i) => obj(CONFIG_MAP, `cm-${i}`, "demo"));
    let dialog = await remove(CONFIG_MAP, at);
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Delete" })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    const above = [...at, obj(CONFIG_MAP, "one-more", "demo")];
    dialog = await remove(CONFIG_MAP, above);
    const input = within(dialog).getByRole("textbox", { name: "To confirm, type the number of objects (21):" });
    const confirm = within(dialog).getByRole("button", { name: "Delete" });
    expect(confirm).toBeDisabled();
    fireEvent.change(input, { target: { value: "20" } });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(names()).toEqual([]);
    fireEvent.change(input, { target: { value: " 21 " } });
    expect(confirm).toBeEnabled();
  });

  it("warns that a controller's objects come back and marks them in the list", async () => {
    const dialog = await remove(POD, [owned("web-1"), obj(POD, "bare", "demo")]);
    expect(within(dialog).getByTestId("delete-owned")).toHaveTextContent(
      "1 of these objects has a controller (marked in the list) that will likely create it again",
    );
    const items = within(dialog).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["demo/web-1comes back: ReplicaSet web-5d8f", "demo/bare"]);
    expect(await axeViolations(dialog)).toEqual([]);
  });

  it("warns about one owned object in a sentence of its own, and about namespaces", async () => {
    let dialog = await remove(POD, [owned("web-1")]);
    expect(within(dialog).getByTestId("delete-owned")).toHaveTextContent("It has a controller that will likely create it again");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    dialog = await remove(NAMESPACE, [obj(NAMESPACE, "team-a"), obj(NAMESPACE, "team-b")]);
    expect(within(dialog).getByTestId("delete-namespaces")).toHaveTextContent("Deleting a namespace deletes everything inside it");
    expect(within(dialog).queryByTestId("delete-owned")).not.toBeInTheDocument();
  });

  it("gives every object its outcome: deleted, already gone, replaced, forbidden, failed", async () => {
    backend.on("resource_delete", (args) => {
      const name = (args.ref as ObjectRef).name;
      if (name === "gone") throw { code: "notFound", message: 'configmaps "gone" not found' };
      if (name === "replaced") throw { code: "conflict", message: "Precondition failed: UID in precondition: uid-replaced" };
      if (name === "secret") throw { code: "forbidden", message: 'configmaps "secret" is forbidden' };
      if (name === "webhook") throw { code: "other", message: "admission webhook denied the request" };
      return undefined;
    });
    const objects = ["ok", "gone", "replaced", "secret", "webhook"].map((n) => obj(CONFIG_MAP, n, "demo"));
    let dialog = await remove(CONFIG_MAP, objects);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    const results = await screen.findByRole("list", { name: "Result for each object" });
    dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("1 of 5 deleted.");
    const outcomes = within(results).getAllByRole("listitem").map((li) => li.dataset.outcome);
    expect(outcomes).toEqual(["deleted", "gone", "changed", "forbidden", "failed"]);
    expect(results).toHaveTextContent("Kept: demo/replaced was replaced by another object of the same name");
    const alerts = within(results).getAllByRole("alert");
    expect(alerts.map((a) => a.textContent)).toEqual([
      expect.stringContaining('configmaps "secret" is forbidden'),
      expect.stringContaining("admission webhook denied the request"),
    ]);
    // Each object was asked for once; nothing was repeated.
    expect(names()).toEqual(["ok", "gone", "replaced", "secret", "webhook"]);
  });

  it("Stop finishes the object being deleted and starts no other", async () => {
    let release: () => void = () => undefined;
    const first = new Promise<void>((resolve) => (release = resolve));
    backend.on("resource_delete", (args) => ((args.ref as ObjectRef).name === "a" ? first : undefined));
    const dialog = await remove(CONFIG_MAP, ["a", "b", "c"].map((n) => obj(CONFIG_MAP, n, "demo")));
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(names()).toEqual(["a"]));
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop" }));
    expect(within(dialog).getByRole("button", { name: "Stopping after the current object…" })).toBeDisabled();
    await act(async () => release());

    const results = await screen.findByRole("list", { name: "Result for each object" });
    expect(within(results).getAllByRole("listitem").map((li) => li.dataset.outcome)).toEqual(["deleted", "stopped", "stopped"]);
    expect(names()).toEqual(["a"]);
  });
});

describe("Delete of one object", () => {
  it("closes when it is deleted or already gone, and says why it was kept when it was replaced", async () => {
    backend.on("resource_delete", (args) => {
      const name = (args.ref as ObjectRef).name;
      if (name === "gone") throw { code: "notFound", message: "not found" };
      if (name === "replaced") throw { code: "conflict", message: "Precondition failed" };
      return undefined;
    });
    for (const name of ["ok", "gone"]) {
      const dialog = await remove(CONFIG_MAP, [obj(CONFIG_MAP, name, "demo")]);
      // The look of a single delete: Cancel and Delete, no Stop, no progress line.
      expect(within(dialog).queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    }
    const dialog = await remove(CONFIG_MAP, [obj(CONFIG_MAP, "replaced", "demo")]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText(/Kept: demo\/replaced was replaced/)).toBeInTheDocument();
    expect(backend.calls.filter((c) => c.cmd === "resource_delete").at(-1)?.args.preconditions).toEqual({
      uid: "uid-replaced",
      resourceVersion: null,
    });
  });
});

describe("the run of a Delete dialog entry", () => {
  it("survives the dialog unmounting: a remount shows the running deletion, and a second start sends nothing more", async () => {
    let release: () => void = () => undefined;
    const first = new Promise<void>((resolve) => (release = resolve));
    backend.on("resource_delete", (args) => ((args.ref as ObjectRef).name === "a" ? first : undefined));
    const dialog = await remove(CONFIG_MAP, ["a", "b"].map((n) => obj(CONFIG_MAP, n, "demo")));
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(names()).toEqual(["a"]));

    // The main view (and its dialog host) goes away and comes back while the first object is being deleted.
    cleanup();
    render(<ActionDialogHost />);
    const again = screen.getByRole("dialog", { name: "Delete 2 ConfigMap objects?" });
    expect(within(again).getByRole("button", { name: "Stop" })).toBeEnabled();
    expect(within(again).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    await act(async () => release());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(names()).toEqual(["a", "b"]);
  });
});
