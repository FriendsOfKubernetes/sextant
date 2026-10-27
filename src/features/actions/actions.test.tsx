import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type KindRef, type KubeObject, type MockBackend } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { ActionDialogHost } from "../../layout/main/ActionDialogHost";
import "../restart";
import "./index";
import { getAction, getActionsFor, runAction, type ActionId } from "./registry";

const DEPLOYMENT: KindRef = { group: "apps", version: "v1", kind: "Deployment" };
const STATEFUL_SET: KindRef = { group: "apps", version: "v1", kind: "StatefulSet" };
const REPLICA_SET: KindRef = { group: "apps", version: "v1", kind: "ReplicaSet" };
const DAEMON_SET: KindRef = { group: "apps", version: "v1", kind: "DaemonSet" };
const CONFIG_MAP: KindRef = { group: "", version: "v1", kind: "ConfigMap" };
const NODE: KindRef = { group: "", version: "v1", kind: "Node" };
const CRON_JOB: KindRef = { group: "batch", version: "v1", kind: "CronJob" };
const ALL: ActionId[] = ["edit", "delete", "scale", "restart", "cordon", "drain", "trigger", "suspend"];

function obj(kind: KindRef, name: string, namespace: string | undefined, extra: Partial<KubeObject> = {}): KubeObject {
  return {
    apiVersion: kind.group ? `${kind.group}/${kind.version}` : kind.version,
    kind: kind.kind,
    metadata: { name, namespace, uid: `${kind.kind}-${namespace ?? ""}-${name}` },
    ...extra,
  };
}

let backend: MockBackend;
beforeEach(() => {
  resetAppStore();
  backend = mockBackend();
  render(<ActionDialogHost />);
  // Dialogs live in the registry's module state: close the ones a previous test left open.
  while (screen.queryAllByRole("dialog").length > 0) fireEvent.keyDown(window, { key: "Escape" });
});
afterEach(() => backend.restore());

async function run(id: ActionId, kind: KindRef, objects: KubeObject[]) {
  const action = getAction(id);
  if (!action) throw new Error(`action ${id} is not registered`);
  await act(async () => {
    await runAction(action, "c1", kind, objects);
  });
}

const calls = (cmd: string) => backend.calls.filter((c) => c.cmd === cmd).map((c) => c.args);
const ids = (objects: KubeObject[], kind: KindRef) => getActionsFor(objects, kind, ALL).map((a) => a.id);

describe("registered actions", () => {
  it("are offered for the kinds they apply to", () => {
    expect(ids([obj(DEPLOYMENT, "web", "demo")], DEPLOYMENT)).toEqual(["edit", "delete", "scale", "restart"]);
    expect(ids([obj(STATEFUL_SET, "db", "demo")], STATEFUL_SET)).toEqual(["edit", "delete", "scale", "restart"]);
    // A ReplicaSet without an owner restarts its pods (src/features/restart).
    expect(ids([obj(REPLICA_SET, "web-1", "demo")], REPLICA_SET)).toEqual(["edit", "delete", "scale", "restart"]);
    expect(ids([obj(DAEMON_SET, "agent", "demo")], DAEMON_SET)).toEqual(["edit", "delete", "restart"]);
    expect(ids([obj(NODE, "n1", undefined)], NODE)).toEqual(["edit", "delete", "cordon", "drain"]);
    expect(ids([obj(CRON_JOB, "hello", "demo")], CRON_JOB)).toEqual(["edit", "delete", "trigger", "suspend"]);
    expect(ids([obj(CONFIG_MAP, "a", "demo")], CONFIG_MAP)).toEqual(["edit", "delete"]);
    // Several selected rows: delete and restart.
    expect(ids([obj(DEPLOYMENT, "a", "demo"), obj(DEPLOYMENT, "b", "demo")], DEPLOYMENT)).toEqual(["delete", "restart"]);
  });

  it("edit opens the object in a dock tab", async () => {
    await run("edit", DEPLOYMENT, [obj(DEPLOYMENT, "web", "demo")]);
    const { tabs, activeTabId, open } = useAppStore.getState().dock;
    expect(open).toBe(true);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({
      id: activeTabId,
      type: "edit",
      payload: { clusterId: "c1", ref: { kind: DEPLOYMENT, namespace: "demo", name: "web" } },
    });
  });
});

describe("delete", () => {
  it("deletes nothing until confirmed and lists every name", async () => {
    backend.on("resource_delete", () => undefined);
    const objects = [obj(CONFIG_MAP, "a", "demo"), obj(CONFIG_MAP, "b", "demo"), obj(CONFIG_MAP, "c", "other")];
    await run("delete", CONFIG_MAP, objects);

    const dialog = screen.getByRole("dialog", { name: "Delete 3 ConfigMap objects?" });
    const names = within(dialog).getAllByRole("listitem").map((li) => li.textContent);
    expect(names).toEqual(["demo/a", "demo/b", "other/c"]);
    expect(calls("resource_delete")).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls("resource_delete")).toHaveLength(0);

    await run("delete", CONFIG_MAP, objects);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // One at a time, in the order shown, each with the uid the user saw (ADR-0126).
    const pre = (uid: string) => ({ uid, resourceVersion: null });
    expect(calls("resource_delete")).toEqual([
      { clusterId: "c1", ref: { kind: CONFIG_MAP, namespace: "demo", name: "a" }, preconditions: pre("ConfigMap-demo-a") },
      { clusterId: "c1", ref: { kind: CONFIG_MAP, namespace: "demo", name: "b" }, preconditions: pre("ConfigMap-demo-b") },
      { clusterId: "c1", ref: { kind: CONFIG_MAP, namespace: "other", name: "c" }, preconditions: pre("ConfigMap-other-c") },
    ]);
  });

  it("cannot be cancelled halfway: while deleting, Escape and × leave the dialog running; only Stop is offered", async () => {
    let release: () => void = () => undefined;
    const first = new Promise<void>((resolve) => (release = resolve));
    backend.on("resource_delete", (args) => ((args.ref as { name: string }).name === "a" ? first : undefined));
    await run("delete", CONFIG_MAP, [obj(CONFIG_MAP, "a", "demo"), obj(CONFIG_MAP, "b", "demo")]);
    const dialog = screen.getByRole("dialog", { name: "Delete 2 ConfigMap objects?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls("resource_delete")).toHaveLength(1));

    expect(within(dialog).queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Stop" })).toBeEnabled();
    expect(within(dialog).getByRole("status")).toHaveTextContent("Deleting demo/a (1 of 2)…");
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.getByRole("dialog", { name: "Delete 2 ConfigMap objects?" })).toBeInTheDocument();

    await act(async () => release());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls("resource_delete").map((a) => (a.ref as { name: string }).name)).toEqual(["a", "b"]);
  });

  it("closes the details of a deleted object", async () => {
    backend.on("resource_delete", () => undefined);
    useAppStore.getState().openDetails({ kind: CONFIG_MAP, namespace: "demo", name: "a" });
    await run("delete", CONFIG_MAP, [obj(CONFIG_MAP, "a", "demo")]);
    const dialog = screen.getByRole("dialog", { name: "Delete ConfigMap?" });
    expect(within(dialog).getByRole("listitem")).toHaveTextContent("demo/a");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(useAppStore.getState().details).toBeNull());
  });

  it("explains which objects were not deleted, e.g. without permission", async () => {
    backend.on("resource_delete", (args) => {
      const ref = args.ref as { name: string };
      if (ref.name === "b") throw { code: "forbidden", message: 'configmaps "b" is forbidden: User cannot delete' };
      return undefined;
    });
    await run("delete", CONFIG_MAP, [obj(CONFIG_MAP, "a", "demo"), obj(CONFIG_MAP, "b", "demo")]);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("You don't have permission to do this (403).");
    expect(alert).toHaveTextContent('configmaps "b" is forbidden');
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("1 of 2 deleted.");
    expect(dialog).toHaveTextContent("Deleted: demo/a");
    expect(dialog).toHaveTextContent("Not deleted, no permission: demo/b");
    expect(calls("resource_delete")).toHaveLength(2);
  });
});

describe("scale", () => {
  it("asks for the number of replicas, starting from the current one", async () => {
    backend.on("workload_scale", () => undefined);
    await run("scale", DEPLOYMENT, [obj(DEPLOYMENT, "nginx", "demo", { spec: { replicas: 2 } })]);
    const dialog = screen.getByRole("dialog", { name: "Scale Deployment nginx" });
    const input = within(dialog).getByRole("spinbutton", { name: "Replicas" });
    expect(input).toHaveValue(2);

    fireEvent.change(input, { target: { value: "-1" } });
    expect(within(dialog).getByRole("button", { name: "Scale" })).toBeDisabled();
    expect(dialog).toHaveTextContent("Enter a whole number, 0 or more.");

    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Scale" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls("workload_scale")).toEqual([
      { clusterId: "c1", ref: { kind: DEPLOYMENT, namespace: "demo", name: "nginx" }, replicas: 5 },
    ]);
  });

  it("keeps the dialog open with the reason when the server refuses", async () => {
    backend.on("workload_scale", () => {
      throw { code: "forbidden", message: "deployments.apps \"nginx\" is forbidden" };
    });
    await run("scale", DEPLOYMENT, [obj(DEPLOYMENT, "nginx", "demo", { spec: { replicas: 2 } })]);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Scale" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("You don't have permission to do this (403).");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("restart", () => {
  it("restarts after confirmation", async () => {
    backend.on("workload_restart", () => undefined);
    backend.on("resource_get", () => obj(DAEMON_SET, "agent", "kube-system"));
    await run("restart", DAEMON_SET, [obj(DAEMON_SET, "agent", "kube-system")]);
    const dialog = screen.getByRole("dialog", { name: "Restart DaemonSet agent?" });
    expect(calls("workload_restart")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls("workload_restart")).toEqual([
      { clusterId: "c1", ref: { kind: DAEMON_SET, namespace: "kube-system", name: "agent" } },
    ]);
  });
});

describe("nodes", () => {
  it("cordons a schedulable node and uncordons a cordoned one", async () => {
    backend.on("node_cordon", () => undefined);
    await run("cordon", NODE, [obj(NODE, "n1", undefined, { spec: {} })]);
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Cordon node n1?" })).getByRole("button", { name: "Cordon" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await run("cordon", NODE, [obj(NODE, "n1", undefined, { spec: { unschedulable: true } })]);
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Uncordon node n1?" })).getByRole("button", { name: "Uncordon" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls("node_cordon")).toEqual([
      { clusterId: "c1", name: "n1", unschedulable: true },
      { clusterId: "c1", name: "n1", unschedulable: false },
    ]);
  });

  const PREVIEW = {
    evict: [{ namespace: "demo", name: "web-1" }],
    unmanaged: [{ namespace: "demo", name: "lonely" }],
    emptyDir: [{ namespace: "demo", name: "cache-0" }],
    daemonSet: [{ namespace: "kube-system", name: "kube-proxy-x" }],
  };
  const podsIn = (dialog: HTMLElement, list: RegExp) =>
    within(within(dialog).getByRole("list", { name: list }))
      .getAllByRole("listitem")
      .map((li) => li.textContent);

  it("lists every pod of the node before draining, with the risky options off", async () => {
    backend.on("node_drain_preview", () => PREVIEW);
    backend.on("node_drain", () => undefined);
    await run("drain", NODE, [obj(NODE, "n1", undefined)]);
    const dialog = screen.getByRole("dialog", { name: "Drain node n1?" });
    await within(dialog).findByText("demo/web-1");
    expect(calls("node_drain_preview")).toEqual([{ clusterId: "c1", name: "n1" }]);

    expect(podsIn(dialog, /^Evicted/)).toEqual(["demo/web-1"]);
    expect(podsIn(dialog, /^Without a controller/)).toEqual(["demo/lonely"]);
    expect(podsIn(dialog, /^With emptyDir data/)).toEqual(["demo/cache-0"]);
    expect(podsIn(dialog, /^Stay: DaemonSet pods/)).toEqual(["kube-system/kube-proxy-x"]);
    const force = within(dialog).getByRole("checkbox", { name: /without a controller \(force\)/ });
    const emptyDir = within(dialog).getByRole("checkbox", { name: /delete emptyDir data/ });
    expect(force).not.toBeChecked();
    expect(emptyDir).not.toBeChecked();
    expect(calls("node_drain")).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "Drain" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls("node_drain")).toEqual([
      { clusterId: "c1", name: "n1", options: { force: false, deleteEmptyDirData: false } },
    ]);
  });

  it("sends the options the user ticked", async () => {
    backend.on("node_drain_preview", () => PREVIEW);
    backend.on("node_drain", () => undefined);
    await run("drain", NODE, [obj(NODE, "n1", undefined)]);
    const dialog = screen.getByRole("dialog", { name: "Drain node n1?" });
    fireEvent.click(await within(dialog).findByRole("checkbox", { name: /without a controller \(force\)/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Drain" }));
    await waitFor(() => expect(calls("node_drain")).toHaveLength(1));
    expect(calls("node_drain")[0]).toEqual({
      clusterId: "c1",
      name: "n1",
      options: { force: true, deleteEmptyDirData: false },
    });
  });

  it("offers no option when the node has no such pods", async () => {
    backend.on("node_drain_preview", () => ({ ...PREVIEW, unmanaged: [], emptyDir: [] }));
    await run("drain", NODE, [obj(NODE, "n1", undefined)]);
    const dialog = screen.getByRole("dialog", { name: "Drain node n1?" });
    await within(dialog).findByText("demo/web-1");
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("cannot drain without the list of pods", async () => {
    backend.on("node_drain_preview", () => {
      throw { code: "forbidden", message: "pods is forbidden" };
    });
    await run("drain", NODE, [obj(NODE, "n1", undefined)]);
    const dialog = screen.getByRole("dialog", { name: "Drain node n1?" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("pods is forbidden");
    expect(within(dialog).getByRole("button", { name: "Drain" })).toBeDisabled();
  });

  it("drains only after confirmation and shows why pods were not evicted", async () => {
    backend.on("node_drain_preview", () => ({ evict: [{ namespace: "demo", name: "db-0" }], unmanaged: [], emptyDir: [], daemonSet: [] }));
    backend.on("node_drain", () => {
      throw {
        code: "other",
        message:
          "node n1 is cordoned, but 1 pod(s) could not be evicted: demo/db-0: Cannot evict pod as it would violate the pod's disruption budget.",
      };
    });
    await run("drain", NODE, [obj(NODE, "n1", undefined)]);
    const dialog = screen.getByRole("dialog", { name: "Drain node n1?" });
    expect(dialog).toHaveTextContent("Pods of DaemonSets and static (mirror) pods stay");
    expect(calls("node_drain")).toHaveLength(0);

    await within(dialog).findByText("demo/db-0");
    fireEvent.click(within(dialog).getByRole("button", { name: "Drain" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The node is cordoned, but some pods could not be evicted");
    expect(alert).toHaveTextContent("demo/db-0: Cannot evict pod as it would violate the pod's disruption budget.");
    expect(calls("node_drain")).toEqual([
      { clusterId: "c1", name: "n1", options: { force: false, deleteEmptyDirData: false } },
    ]);
  });
});

describe("CronJob", () => {
  it("triggers a Job and names it", async () => {
    backend.on("cronjob_trigger", () => ({
      kind: { group: "batch", version: "v1", kind: "Job" },
      namespace: "demo",
      name: "hello-manual-1760000000",
    }));
    await run("trigger", CRON_JOB, [obj(CRON_JOB, "hello", "demo")]);
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Run CronJob hello now?" })).getByRole("button", { name: "Trigger" }),
    );
    expect(await screen.findByText("Job hello-manual-1760000000 created.")).toBeInTheDocument();
    expect(calls("cronjob_trigger")).toEqual([{ clusterId: "c1", ref: { kind: CRON_JOB, namespace: "demo", name: "hello" } }]);
  });

  it("suspends an active CronJob and resumes a suspended one", async () => {
    backend.on("cronjob_suspend", () => undefined);
    await run("suspend", CRON_JOB, [obj(CRON_JOB, "hello", "demo", { spec: { suspend: false } })]);
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Suspend CronJob hello?" })).getByRole("button", { name: "Suspend" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await run("suspend", CRON_JOB, [obj(CRON_JOB, "hello", "demo", { spec: { suspend: true } })]);
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Resume CronJob hello?" })).getByRole("button", { name: "Resume" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const ref = { kind: CRON_JOB, namespace: "demo", name: "hello" };
    expect(calls("cronjob_suspend")).toEqual([
      { clusterId: "c1", ref, suspend: true },
      { clusterId: "c1", ref, suspend: false },
    ]);
  });
});
