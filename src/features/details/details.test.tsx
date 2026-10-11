import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KubeObject, ObjectRef } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import "../../resources";
import { registerAction, resetActions } from "../actions/registry";
import deploymentJson from "./fixtures/deployment.json";
import nodeJson from "./fixtures/node.json";
import podJson from "./fixtures/pod.json";
import secretJson from "./fixtures/secret.json";
import serviceJson from "./fixtures/service.json";
import widgetJson from "./fixtures/widget.json";
import "./index";
import { copy, emitDelta, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "./testing";

const pod = podJson as KubeObject;
const deployment = deploymentJson as KubeObject;
const service = serviceJson as KubeObject;
const node = nodeJson as KubeObject;
const secret = secretJson as KubeObject;
const widget = widgetJson as KubeObject;

const POD_REF: ObjectRef = {
  kind: { group: "", version: "v1", kind: "Pod" },
  namespace: "sextant-demo",
  name: "nginx-9f755754d-g85tv",
};

let wb: WatchBackend;

beforeEach(() => {
  resetAppStore();
  resetActions();
  wb = watchBackend();
});

afterEach(() => wb.backend.restore());

/** Opens the details of `obj` and delivers it through the panel's own watch. */
async function openDetails(obj: KubeObject, ref: ObjectRef): Promise<string> {
  useAppStore.getState().openDetails(ref);
  render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  const id = await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`);
  emitSnapshot(wb, id, [obj]);
  return id;
}

function section(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-section='${id}']`);
  if (!el) throw new Error(`no section ${id}`);
  return el;
}

describe("details of a pod", () => {
  it("shows containers with image, ports, env, mounts, state and restarts, and the node", async () => {
    const obj = copy(pod);
    const containers = (obj.spec as { containers: Record<string, unknown>[] }).containers;
    containers[0]!.env = [
      { name: "GREETING", value: "hello" },
      { name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: "demo-secret", key: "password" } } },
    ];
    await openDetails(obj, POD_REF);

    const fields = section("fields");
    expect(within(fields).getByText("nginx:stable-alpine")).toBeInTheDocument();
    expect(within(fields).getByText("http: 80/TCP")).toBeInTheDocument();
    expect(within(fields).getByText("GREETING")).toBeInTheDocument();
    expect(within(fields).getByText("hello")).toBeInTheDocument();
    expect(within(fields).getByText("DB_PASSWORD")).toBeInTheDocument();
    // A reference to a secret key is shown as a reference, never as a value.
    expect(within(fields).getByText("secret demo-secret / password")).toBeInTheDocument();
    expect(within(fields).getByText("/var/run/secrets/kubernetes.io/serviceaccount")).toBeInTheDocument();
    expect(within(fields).getAllByText("running").length).toBeGreaterThan(0);
    expect(within(fields).getByText("Restarts")).toBeInTheDocument();
    expect(within(fields).getByRole("button", { name: "Open Node sextant-test-control-plane" })).toBeInTheDocument();
    expect(within(fields).getByText("10.244.0.4")).toBeInTheDocument();
    expect(within(fields).getByText("Burstable")).toBeInTheDocument();
  });

  it("follows the object live and says so when it is deleted", async () => {
    const id = await openDetails(pod, POD_REF);
    expect(within(section("fields")).getByText("nginx:stable-alpine")).toBeInTheDocument();

    const updated = copy(pod);
    (updated.spec as { containers: { image: string }[] }).containers[0]!.image = "nginx:1.27";
    emitDelta(wb, id, [updated]);
    expect(within(section("fields")).getByText("nginx:1.27")).toBeInTheDocument();

    emitDelta(wb, id, [], [pod.metadata!.uid!]);
    expect(screen.getByText("This Pod has been deleted.")).toBeInTheDocument();
    expect(document.querySelector("[data-section='fields']")?.textContent ?? "").not.toContain("nginx:1.27");
  });
});

describe("links between objects", () => {
  it("opens the ReplicaSet owning a pod and the node it runs on", async () => {
    await openDetails(pod, POD_REF);
    fireEvent.click(screen.getByRole("button", { name: "Open ReplicaSet nginx-9f755754d" }));
    expect(useAppStore.getState().details).toEqual({
      kind: { group: "apps", version: "v1", kind: "ReplicaSet" },
      namespace: "sextant-demo",
      name: "nginx-9f755754d",
    });
    fireEvent.click(screen.getByRole("button", { name: "Open Node sextant-test-control-plane" }));
    expect(useAppStore.getState().details).toEqual({
      kind: { group: "", version: "v1", kind: "Node" },
      namespace: null,
      name: "sextant-test-control-plane",
    });
  });
});

describe("links between objects: storage", () => {
  it("opens the PersistentVolume bound to a claim", async () => {
    const pvc: KubeObject = {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name: "data", namespace: "sextant-demo", uid: "pvc-uid", creationTimestamp: "2026-10-11T17:16:38Z" },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: "1Gi" } },
        storageClassName: "standard",
        volumeName: "pvc-0a1b2c",
        volumeMode: "Filesystem",
      },
      status: { phase: "Bound", accessModes: ["ReadWriteOnce"], capacity: { storage: "1Gi" } },
    };
    await openDetails(pvc, { kind: { group: "", version: "v1", kind: "PersistentVolumeClaim" }, namespace: "sextant-demo", name: "data" });
    fireEvent.click(within(section("fields")).getByRole("button", { name: "Open PersistentVolume pvc-0a1b2c" }));
    expect(useAppStore.getState().details).toEqual({
      kind: { group: "", version: "v1", kind: "PersistentVolume" },
      namespace: null,
      name: "pvc-0a1b2c",
    });
  });
});

describe("details of other kinds", () => {
  it("shows replicas, selector, strategy and conditions of a deployment", async () => {
    await openDetails(deployment, { kind: { group: "apps", version: "v1", kind: "Deployment" }, namespace: "sextant-demo", name: "nginx" });
    const fields = section("fields");
    expect(within(fields).getByText("2 desired, 2 updated, 2 total, 2 ready, 2 available")).toBeInTheDocument();
    expect(within(fields).getByText("app=nginx")).toBeInTheDocument();
    expect(within(fields).getByText("RollingUpdate (max surge 25%, max unavailable 25%)")).toBeInTheDocument();
    expect(within(fields).getByText("nginx:stable-alpine")).toBeInTheDocument();
    const conditions = section("conditions");
    expect(within(conditions).getByText("Available")).toBeInTheDocument();
    expect(within(conditions).getByText("MinimumReplicasAvailable")).toBeInTheDocument();
  });

  it("shows type, cluster IP, ports and selector of a service, with a link to its endpoints", async () => {
    await openDetails(service, { kind: { group: "", version: "v1", kind: "Service" }, namespace: "sextant-demo", name: "nginx" });
    const fields = section("fields");
    expect(within(fields).getByText("ClusterIP")).toBeInTheDocument();
    expect(within(fields).getByText("10.96.74.36")).toBeInTheDocument();
    const ports = within(fields).getByRole("table");
    expect(within(ports).getByText("80")).toBeInTheDocument();
    expect(within(ports).getByText("TCP")).toBeInTheDocument();
    expect(within(fields).getByText("app=nginx")).toBeInTheDocument();
    fireEvent.click(within(fields).getByRole("button", { name: "Open Endpoints nginx" }));
    expect(useAppStore.getState().details).toEqual({
      kind: { group: "", version: "v1", kind: "Endpoints" },
      namespace: "sextant-demo",
      name: "nginx",
    });
  });

  it("shows addresses, capacity, system info and taints of a node", async () => {
    const obj = copy(node);
    (obj.spec as Record<string, unknown>).taints = [{ key: "dedicated", value: "gpu", effect: "NoSchedule" }];
    await openDetails(obj, { kind: { group: "", version: "v1", kind: "Node" }, namespace: null, name: "sextant-test-control-plane" });
    const fields = section("fields");
    expect(within(fields).getByText("InternalIP: 172.25.0.2")).toBeInTheDocument();
    // Capacity and allocatable of the kind node are equal.
    expect(within(fields).getAllByText("28578828Ki")).toHaveLength(2);
    expect(within(fields).getAllByText("110")).toHaveLength(2);
    expect(within(fields).getByText("dedicated=gpu:NoSchedule")).toBeInTheDocument();
    const info = (obj.status as { nodeInfo: Record<string, string> }).nodeInfo;
    expect(within(fields).getByText(info.kubeletVersion!)).toBeInTheDocument();
    expect(within(fields).getByText(info.containerRuntimeVersion!)).toBeInTheDocument();
    expect(within(section("conditions")).getByText("KubeletReady")).toBeInTheDocument();
  });
});

describe("secrets", () => {
  const SECRET_REF: ObjectRef = { kind: { group: "", version: "v1", kind: "Secret" }, namespace: "sextant-demo", name: "demo-secret" };

  it("hides every value until Show is pressed for that key, then shows it decoded", async () => {
    await openDetails(secret, SECRET_REF);
    const panel = document.querySelector<HTMLElement>(".details")!;
    expect(panel.textContent).not.toContain("not-a-real-password");
    expect(panel.textContent).not.toContain("bm90LWEtcmVhbC1wYXNzd29yZA==");
    expect(panel.textContent).not.toContain("ZGVtbw==");

    fireEvent.click(screen.getByRole("button", { name: "Show value of password" }));
    expect(screen.getByText("not-a-real-password")).toBeInTheDocument();
    // The other key stays hidden.
    expect(screen.queryByText("demo")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Hide value of password" }));
    expect(panel.textContent).not.toContain("not-a-real-password");
  });

  it("is hidden again when the secret is opened again", async () => {
    await openDetails(secret, SECRET_REF);
    fireEvent.click(screen.getByRole("button", { name: "Show value of username" }));
    expect(screen.getByText("demo")).toBeInTheDocument();
    cleanup();
    await openDetails(secret, SECRET_REF);
    expect(screen.queryByText("demo")).toBeNull();
    expect(screen.getByRole("button", { name: "Show value of username" })).toBeInTheDocument();
  });
});

describe("actions", () => {
  it("offers the registered actions of the kind in the ActionBar", async () => {
    let ran: string[] = [];
    registerAction("delete", {
      labelKey: "details:actions",
      icon: "x",
      appliesTo: () => true,
      run: (ctx) => {
        ran = ctx.refs.map((r) => r.name);
      },
    });
    await openDetails(pod, POD_REF);
    const bar = within(section("summary")).getByRole("toolbar");
    fireEvent.click(within(bar).getByRole("button", { name: /Actions/ }));
    await waitFor(() => expect(ran).toEqual(["nginx-9f755754d-g85tv"]));
  });
});

describe("YAML", () => {
  function yamlText(): string {
    const editor = section("yaml").querySelector(".cm-content");
    if (!editor) throw new Error("no YAML editor");
    // CodeMirror renders one element per line.
    return [...editor.querySelectorAll(".cm-line")].map((l) => l.textContent).join("\n");
  }

  it("shows any kind, including a custom resource, as YAML without managedFields", async () => {
    const obj = copy(widget);
    obj.metadata!.managedFields = [{ manager: "kubectl", operation: "Apply", fieldsV1: { "f:spec": {} } }];
    await openDetails(obj, {
      kind: { group: "demo.sextant.dev", version: "v1", kind: "Widget" },
      namespace: "sextant-demo",
      name: "demo-widget",
    });
    fireEvent.click(within(section("yaml")).getByRole("button", { name: "Show YAML" }));
    const yaml = yamlText();
    expect(yaml).toMatch(/^apiVersion: demo\.sextant\.dev\/v1\nkind: Widget\nmetadata:\n/);
    expect(yaml).toContain("  name: demo-widget\n");
    expect(yaml).toContain("spec:\n  replicas: 3\n  size: large");
    expect(yaml).not.toContain("managedFields");
    expect(yaml).not.toContain("f:spec");
    // Read only: the editor does not accept input.
    expect(section("yaml").querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("false");
  });

  it("does not reveal secret values", async () => {
    await openDetails(secret, { kind: { group: "", version: "v1", kind: "Secret" }, namespace: "sextant-demo", name: "demo-secret" });
    fireEvent.click(within(section("yaml")).getByRole("button", { name: "Show YAML" }));
    const yaml = yamlText();
    expect(yaml).toContain("data:\n  password: <hidden>\n  username: <hidden>");
    expect(yaml).not.toContain("bm90LWEtcmVhbC1wYXNzd29yZA==");
    expect(yaml).not.toContain("not-a-real-password");
  });
});
