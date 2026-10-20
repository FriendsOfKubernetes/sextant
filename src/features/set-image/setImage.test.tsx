import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type DryRunResult, type KindRef, type KubeObject, type MockBackend, type ObjectRef } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { ActionDialogHost } from "../../layout/main/ActionDialogHost";
import { axeViolations } from "../../test/axe";
import { getAction, getActionsFor, resetActions, runAction } from "../actions/registry";
import { defaultClusterSettings } from "../clusters/clusterSettings";
import { useClustersStore } from "../clusters/clustersStore";
import { registerSetImage } from "./index";

// The preview's side-by-side text measures through Range rects, which jsdom does not implement.
beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) };
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as DOMRectList;
});

const kind = (group: string, k: string): KindRef => ({ group, version: "v1", kind: k });
const DEPLOYMENT = kind("apps", "Deployment");
const POD = kind("", "Pod");
const ref = (k: KindRef, name = "web"): ObjectRef => ({ kind: k, namespace: "shop", name });

const deployment: KubeObject = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "web", namespace: "shop", resourceVersion: "41" },
  spec: {
    template: {
      spec: {
        initContainers: [{ name: "migrate", image: "tool:1" }],
        containers: [
          { name: "web", image: "nginx:1.25" },
          { name: "proxy", image: "envoy:1" },
        ],
      },
    },
  },
};

function pod(extra: Record<string, unknown> = {}): KubeObject {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: "web", namespace: "shop", ...extra },
    spec: {
      containers: [{ name: "web", image: "nginx:1.25" }],
      ephemeralContainers: [{ name: "debugger", image: "busybox" }],
    },
  };
}

const dryRun: DryRunResult = {
  objects: [
    {
      object: ref(DEPLOYMENT),
      label: "",
      before: { kind: "Deployment", spec: { template: { spec: { containers: [{ name: "web", image: "nginx:1.25" }] } } } },
      after: { kind: "Deployment", spec: { template: { spec: { containers: [{ name: "web", image: "nginx:1.27" }] } } } },
      change: "update",
    },
  ],
};

let backend: MockBackend;
const calls = (cmd: string) => backend.calls.filter((c) => c.cmd === cmd);

function start(previewChanges: boolean | null, handlers: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  backend.restore();
  backend = mockBackend(
    { workload_set_image: () => undefined, workload_set_image_dry_run: () => structuredClone(dryRun), ...handlers },
    { settings: { clusters: { c1: { ...defaultClusterSettings(), previewChanges } } } },
  );
}

beforeEach(() => {
  // Forgets the dialogs an earlier test left open.
  resetActions();
  registerSetImage("setImage");
  resetAppStore();
  useClustersStore.setState({ clusters: [] });
  backend = mockBackend();
});
afterEach(() => backend.restore());

async function openFor(k: KindRef, obj: KubeObject): Promise<HTMLElement> {
  render(<ActionDialogHost />);
  const action = getAction("setImage");
  if (!action) throw new Error("setImage is not registered");
  await act(async () => {
    await runAction(action, "c1", k, [obj]);
  });
  return screen.findByRole("dialog");
}

const imageField = (name: string) => screen.getByRole("textbox", { name: `New image of container ${name}` });
const type = (name: string, value: string) => fireEvent.change(imageField(name), { target: { value } });
const button = (name: string) => screen.getByRole("button", { name });

describe("the action", () => {
  it("is offered on Deployments, StatefulSets, DaemonSets, CronJobs and Pods only", () => {
    const offered = (k: KindRef) => getActionsFor([{}], k, ["setImage"]).map((a) => a.id);
    for (const k of [DEPLOYMENT, kind("apps", "StatefulSet"), kind("apps", "DaemonSet"), kind("batch", "CronJob"), POD]) {
      expect(offered(k), k.kind).toEqual(["setImage"]);
    }
    for (const k of [kind("apps", "ReplicaSet"), kind("batch", "Job"), kind("", "Service")]) {
      expect(offered(k), k.kind).toEqual([]);
    }
  });
});

describe("the dialog", () => {
  it("lists init containers and containers and sends only the changed image", async () => {
    start(false);
    const dialog = await openFor(DEPLOYMENT, deployment);
    const rows = within(dialog).getAllByRole("row").slice(1).map((r) => r.textContent);
    expect(rows).toEqual(["migrateinit containertool:1", "webnginx:1.25", "proxyenvoy:1"]);
    expect(button("Set image")).toBeDisabled();
    expect(within(dialog).getByText("Change at least one image.")).toBeInTheDocument();

    type("web", " nginx:1.27 ");
    expect(within(dialog).getByText("web: nginx:1.25 → nginx:1.27")).toBeInTheDocument();
    fireEvent.click(button("Set image"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls("workload_set_image_dry_run")).toEqual([]);
    expect(calls("workload_set_image").map((c) => c.args)).toEqual([
      {
        clusterId: "c1",
        ref: ref(DEPLOYMENT),
        changes: [{ container: "web", init: false, from: "nginx:1.25", image: "nginx:1.27" }],
      },
    ]);
  });

  it("checks each changed image and warns about latest", async () => {
    start(false);
    const dialog = await openFor(DEPLOYMENT, deployment);
    type("web", "Nginx:1");
    expect(imageField("web")).toHaveAttribute("aria-invalid", "true");
    expect(imageField("web")).toHaveAccessibleDescription("The repository path must be in lowercase.");
    expect(button("Set image")).toBeDisabled();
    type("web", "nginx:latest");
    expect(imageField("web")).not.toHaveAttribute("aria-invalid");
    expect(within(dialog).getByText(/The tag “latest” can point/)).toBeInTheDocument();
    type("migrate", "tool");
    expect(within(dialog).getByText(/Without a tag/)).toBeInTheDocument();
    expect(within(dialog).getByText("migrate (init container): tool:1 → tool")).toBeInTheDocument();
    expect(button("Set image")).toBeEnabled();
    expect(await axeViolations(dialog)).toEqual([]);
  });

  it("shows the server's dry run first on a cluster that asks for previews", async () => {
    start(true);
    const dialog = await openFor(DEPLOYMENT, deployment);
    expect(within(dialog).queryByRole("button", { name: "Preview changes" })).toBeNull();
    type("web", "nginx:1.27");
    fireEvent.click(button("Preview and set image…"));
    const preview = await within(dialog).findByRole("region", { name: "Change preview" });
    expect(preview).toBeInTheDocument();
    const changes = [{ container: "web", init: false, from: "nginx:1.25", image: "nginx:1.27" }];
    expect(calls("workload_set_image_dry_run").map((c) => c.args)).toEqual([{ clusterId: "c1", ref: ref(DEPLOYMENT), changes }]);
    expect(calls("workload_set_image")).toEqual([]);
    expect(await axeViolations(dialog)).toEqual([]);

    fireEvent.click(button("Set image"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls("workload_set_image").map((c) => c.args)).toEqual([{ clusterId: "c1", ref: ref(DEPLOYMENT), changes }]);
  });

  it("offers the preview as a button elsewhere, and goes back to editing from it", async () => {
    start(false);
    const dialog = await openFor(DEPLOYMENT, deployment);
    type("web", "nginx:1.27");
    fireEvent.click(button("Preview changes"));
    await within(dialog).findByRole("region", { name: "Change preview" });
    fireEvent.click(button("Back to editing"));
    expect(imageField("web")).toHaveValue("nginx:1.27");
    expect(calls("workload_set_image")).toEqual([]);
  });

  it("keeps the dialog open with the error when the change is refused", async () => {
    start(false, {
      workload_set_image: () => {
        throw { code: "conflict", message: "the image of container web has changed since it was shown; reopen the dialog" };
      },
    });
    const dialog = await openFor(DEPLOYMENT, deployment);
    type("web", "nginx:1.27");
    fireEvent.click(button("Set image"));
    expect(await within(dialog).findByText(/has changed since it was shown/)).toBeInTheDocument();
    expect(calls("workload_set_image")).toHaveLength(1);
  });

  it("changes a bare Pod's containers and never lists its ephemeral containers", async () => {
    start(false);
    const dialog = await openFor(POD, pod());
    expect(within(dialog).getByText(/Kubernetes lets a running Pod change only the images/)).toBeInTheDocument();
    expect(within(dialog).getAllByRole("textbox")).toHaveLength(1);
    expect(within(dialog).queryByText("debugger")).toBeNull();
  });
});

describe("a Pod a controller owns", () => {
  const owned = () =>
    pod({ ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "web-7d9f", uid: "u1", controller: true }] });

  it("offers the Deployment behind its ReplicaSet instead", async () => {
    start(false, {
      resource_get: () => ({
        apiVersion: "apps/v1",
        kind: "ReplicaSet",
        metadata: {
          name: "web-7d9f",
          namespace: "shop",
          ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "web", uid: "u0", controller: true }],
        },
      }),
    });
    const dialog = await openFor(POD, owned());
    const open = await within(dialog).findByRole("button", { name: "Open Deployment web" });
    expect(within(dialog).getByText(/managed by Deployment web/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect(await axeViolations(dialog)).toEqual([]);
    fireEvent.click(open);
    expect(useAppStore.getState().details).toEqual(ref(DEPLOYMENT));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls("workload_set_image")).toEqual([]);
  });

  it("falls back to the direct owner when it cannot be read", async () => {
    start(false, {
      resource_get: () => {
        throw { code: "forbidden", message: "no" };
      },
    });
    const dialog = await openFor(POD, owned());
    expect(await within(dialog).findByRole("button", { name: "Open ReplicaSet web-7d9f" })).toBeInTheDocument();
  });

  it("says where a static Pod's image is set", async () => {
    start(false);
    const dialog = await openFor(POD, pod({ annotations: { "kubernetes.io/config.mirror": "abc" } }));
    expect(within(dialog).getByText(/static Pod/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("textbox")).toBeNull();
  });
});
