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
// Every details panel of the app has the "Related" tab (resource map, #139): test against the real tab strip.
import "../resource-map";
import { axeViolations } from "../../test/axe";
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

  it("shows each probe's check and timing, defaults muted, and the time failing checks take", async () => {
    const obj = copy(pod);
    const container = (obj.spec as { containers: Record<string, unknown>[] }).containers[0]!;
    container.livenessProbe = {
      httpGet: { path: "/healthz", port: "http", httpHeaders: [{ name: "X-Probe", value: "secret-value" }] },
      periodSeconds: 5,
      failureThreshold: 4,
      terminationGracePeriodSeconds: 7,
    };
    container.readinessProbe = { tcpSocket: { port: 80 } };
    container.startupProbe = { exec: { command: ["sh", "-c", "test -f /tmp/ready"] }, failureThreshold: 30 };
    await openDetails(obj, POD_REF);

    const probes = within(section("fields")).getByRole("heading", { name: "Probes" }).closest(".dt-block") as HTMLElement;
    const rows = within(probes).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.querySelector("td")?.textContent)).toEqual(["Liveness", "Readiness", "Startup"]);

    const [liveness, readiness, startup] = rows.map((row) => within(row));
    expect(liveness!.getByText("HTTP GET")).toBeInTheDocument();
    expect(liveness!.getByText(":http/healthz")).toBeInTheDocument();
    // A header is named, never its value.
    expect(liveness!.getByText("+1 header")).toHaveAttribute("title", "X-Probe");
    expect(probes.textContent).not.toContain("secret-value");
    // Set values are plain; omitted ones are the Kubernetes defaults, muted and said so.
    expect(liveness!.getByText("period").parentElement).not.toHaveClass("dt-muted");
    expect(liveness!.getByText("period").parentElement).toHaveTextContent("period 5s");
    const timeout = liveness!.getByText("timeout").parentElement!;
    expect(timeout).toHaveClass("dt-muted");
    expect(timeout).toHaveAttribute("title", "Kubernetes default");
    expect(timeout).toHaveTextContent("timeout 1s Kubernetes default");
    expect(liveness!.getByText("grace period").parentElement).toHaveTextContent("grace period 7s");
    expect(liveness!.getByText("The container is restarted after about 20 seconds of failed checks")).toBeInTheDocument();

    expect(readiness!.getByText("TCP")).toBeInTheDocument();
    expect(readiness!.getByText(":80")).toBeInTheDocument();
    expect(readiness!.getByText("The Pod is marked not ready after about 30 seconds of failed checks")).toBeInTheDocument();

    expect(startup!.getByText("exec")).toBeInTheDocument();
    expect(startup!.getByText("sh -c 'test -f /tmp/ready'")).toBeInTheDocument();
    expect(startup!.getByText("The container has about 300 seconds to start before it is restarted")).toBeInTheDocument();

    expect(await axeViolations(section("fields"))).toEqual([]);
  });

  it("says a container has no probes", async () => {
    await openDetails(pod, POD_REF);
    const probes = within(section("fields")).getByRole("heading", { name: "Probes" }).closest(".dt-block") as HTMLElement;
    expect(within(probes).getByText("No probes")).toBeInTheDocument();
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

describe("containers of a pod in tabs", () => {
  const OTHER_REF: ObjectRef = { ...POD_REF, name: "other-pod" };

  function containerStatus(name: string, state: Record<string, unknown>, restartCount = 0) {
    return {
      name,
      ready: Object.keys(state)[0] === "running",
      restartCount,
      state,
    };
  }

  /** The nginx pod with a `web` and a `proxy` container and a `setup` init container. */
  function crowded(name = POD_REF.name): KubeObject {
    const obj = copy(pod);
    obj.metadata!.name = name;
    obj.spec = {
      ...(obj.spec as object),
      initContainers: [{ name: "setup", image: "busybox:1.36", command: ["sh", "-c", "true"] }],
      containers: [
        {
          name: "web",
          image: "nginx:stable-alpine",
          ports: [{ containerPort: 80 }],
        },
        { name: "proxy", image: "envoy:v1.30" },
      ],
    };
    obj.status = {
      ...(obj.status as object),
      initContainerStatuses: [
        containerStatus("setup", {
          terminated: { reason: "Completed", exitCode: 0 },
        }),
      ],
      containerStatuses: [
        containerStatus("web", { running: { startedAt: "2026-10-11T18:26:13Z" } }, 2),
        containerStatus("proxy", { waiting: { reason: "CrashLoopBackOff" } }, 5),
      ],
    };
    return obj;
  }

  // The details panel has tabs of its own ("Overview", "Related"): container queries stay inside the containers' tabs.
  const containerList = () => screen.getByRole("tablist", { name: "Containers" });
  const containers = () => within(containerList().parentElement!);
  const tabNames = () => within(containerList()).getAllByRole("tab").map((tab) => tab.textContent);
  const shownContainers = () =>
    [...document.querySelectorAll<HTMLElement>("[data-container]")].map((el) => el.getAttribute("data-container"));

  it("shows init containers first, marked, with state and restarts, and one container at a time", async () => {
    await openDetails(crowded(), POD_REF);
    expect(screen.getByRole("tablist", { name: "Containers" })).toBeInTheDocument();
    expect(tabNames()).toEqual(["setup init terminated", "web running 2 restarts", "proxy waiting 5 restarts"]);
    expect(screen.getByRole("tab", { name: /^setup/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /^proxy/ })).toHaveAttribute("title", "waiting: CrashLoopBackOff");
    expect(shownContainers()).toEqual(["setup"]);
    expect(within(containers().getByRole("tabpanel")).getByText("busybox:1.36")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /^proxy/ }));
    expect(shownContainers()).toEqual(["proxy"]);
    expect(within(containers().getByRole("tabpanel")).getByText("envoy:v1.30")).toBeInTheDocument();
    expect(screen.queryByText("busybox:1.36")).toBeNull();
  });

  it("shows probes for containers and sidecars, not for plain init containers", async () => {
    const obj = crowded();
    const spec = obj.spec as { initContainers: Record<string, unknown>[] };
    spec.initContainers.push({
      name: "mesh",
      image: "envoy:v1.30",
      restartPolicy: "Always",
      readinessProbe: { httpGet: { port: 15021, path: "/healthz/ready" } },
    });
    await openDetails(obj, POD_REF);
    const panel = () => within(containers().getByRole("tabpanel"));

    expect(shownContainers()).toEqual(["setup"]);
    expect(panel().queryByRole("heading", { name: "Probes" })).toBeNull();
    expect(panel().queryByText("No probes")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /^mesh/ }));
    expect(panel().getByRole("heading", { name: "Probes" })).toBeInTheDocument();
    expect(panel().getByText(":15021/healthz/ready")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /^proxy/ }));
    expect(panel().getByText("No probes")).toBeInTheDocument();
  });

  it("is operated from the keyboard: arrows, Home and End move the selection", async () => {
    await openDetails(crowded(), POD_REF);
    const selected = () => containers().getByRole("tab", { selected: true }).textContent;
    screen.getByRole("tab", { name: /^setup/ }).focus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(selected()).toMatch(/^web/);
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /^web/ }));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(selected()).toMatch(/^proxy/);
    expect(shownContainers()).toEqual(["proxy"]);
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(selected()).toMatch(/^setup/);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(selected()).toMatch(/^proxy/);
  });

  it("keeps the selected container when the same pod is updated", async () => {
    const id = await openDetails(crowded(), POD_REF);
    fireEvent.click(screen.getByRole("tab", { name: /^web/ }));
    const updated = crowded();
    (updated.status as { containerStatuses: { restartCount: number }[] }).containerStatuses[0]!.restartCount = 3;
    emitDelta(wb, id, [updated]);
    expect(tabNames()[1]).toBe("web running 3 restarts");
    expect(containers().getByRole("tab", { selected: true }).textContent).toMatch(/^web/);
    expect(shownContainers()).toEqual(["web"]);
  });

  it("falls back to the first container when the selected one is gone", async () => {
    const id = await openDetails(crowded(), POD_REF);
    fireEvent.click(screen.getByRole("tab", { name: /^proxy/ }));
    const updated = crowded();
    (updated.spec as { containers: unknown[] }).containers.pop();
    (updated.status as { containerStatuses: unknown[] }).containerStatuses.pop();
    emitDelta(wb, id, [updated]);
    expect(tabNames()).toHaveLength(2);
    expect(containers().getByRole("tab", { selected: true }).textContent).toMatch(/^setup/);
    expect(shownContainers()).toEqual(["setup"]);
  });

  it("starts at the first container again for another pod", async () => {
    const view = render(<DetailsPanel clusterId="c1" objectRef={POD_REF} />);
    emitSnapshot(wb, await watchOf(wb, "Pod", (s) => s.fieldSelector === `metadata.name=${POD_REF.name}`), [crowded()]);
    fireEvent.click(await screen.findByRole("tab", { name: /^proxy/ }));
    expect(shownContainers()).toEqual(["proxy"]);

    view.rerender(<DetailsPanel clusterId="c1" objectRef={OTHER_REF} />);
    emitSnapshot(wb, await watchOf(wb, "Pod", (s) => s.fieldSelector === `metadata.name=${OTHER_REF.name}`), [
      crowded(OTHER_REF.name),
    ]);
    await waitFor(() => expect(containers().getByRole("tab", { selected: true }).textContent).toMatch(/^setup/));
    expect(shownContainers()).toEqual(["setup"]);
  });

  it("shows a pod with a single container as before, without tabs", async () => {
    await openDetails(pod, POD_REF);
    expect(screen.queryByRole("tablist", { name: "Containers" })).toBeNull();
    // Only the panel's own tabs.
    expect(within(screen.getByRole("tablist", { name: "Details views" })).getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Overview",
      "Related",
    ]);
    expect(shownContainers()).toEqual(["nginx"]);
    expect(screen.getByRole("heading", { name: "Containers" })).toBeInTheDocument();
  });

  it("puts the containers of a pod template in tabs too, without states", async () => {
    const obj = copy(deployment);
    const spec = (obj.spec as { template: { spec: Record<string, unknown> } }).template.spec;
    spec.initContainers = [{ name: "migrate", image: "app:1" }];
    (spec.containers as unknown[]).push({
      name: "metrics",
      image: "exporter:2",
    });
    await openDetails(obj, {
      kind: { group: "apps", version: "v1", kind: "Deployment" },
      namespace: "sextant-demo",
      name: "nginx",
    });
    expect(screen.getByRole("tablist", { name: "Containers" })).toBeInTheDocument();
    expect(tabNames()).toEqual(["migrate init", "nginx", "metrics"]);
    expect(shownContainers()).toEqual(["migrate"]);
    fireEvent.click(screen.getByRole("tab", { name: "metrics" }));
    expect(within(containers().getByRole("tabpanel")).getByText("exporter:2")).toBeInTheDocument();
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

  it("keeps condition words whole: short columns on one line, the message wraps at word boundaries, a wide table scrolls", async () => {
    const gateway = {
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "Gateway",
      metadata: { name: "public-gw", namespace: "sextant-demo", uid: "g1", creationTimestamp: "2026-10-01T00:00:00Z" },
      spec: { gatewayClassName: "eg", listeners: [] },
      status: {
        conditions: [
          {
            type: "Programmed",
            status: "False",
            reason: "ListenersNotValid",
            message: "Listener https references secret sextant-demo/www.example.com-tls which does not exist.",
            lastTransitionTime: "2026-10-01T00:00:00Z",
          },
        ],
      },
    };
    await openDetails(gateway, {
      kind: { group: "gateway.networking.k8s.io", version: "v1", kind: "Gateway" },
      namespace: "sextant-demo",
      name: "public-gw",
    });
    const conditions = section("conditions");
    const table = within(conditions).getByRole("table");
    expect(table.parentElement).toHaveClass("dt-table-wrap");
    expect(table).toHaveClass("dt-table--words");
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((h) => h.classList.contains("dt-col--nowrap"))).toEqual([true, true, true, false, true]);
    const cells = within(table).getAllByRole("cell");
    expect(cells[0]).toHaveTextContent("Programmed");
    expect(cells[0]).toHaveClass("dt-col--nowrap");
    expect(cells[2]).toHaveTextContent("ListenersNotValid");
    expect(cells[2]).toHaveClass("dt-col--nowrap");
    // The message keeps its text and gets break opportunities after "/" and "." only.
    expect(cells[3]).toHaveTextContent("Listener https references secret sextant-demo/www.example.com-tls which does not exist.");
    expect(cells[3]).not.toHaveClass("dt-col--nowrap");
    expect(cells[3]!.querySelectorAll("wbr").length).toBeGreaterThan(0);
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
  const VALUES: Record<string, string> = { password: "not-a-real-password", username: "demo" };

  beforeEach(() => {
    wb.backend.on("secret_value", (args) => VALUES[args.key as string]);
  });

  const valueCalls = () => wb.backend.calls.filter((c) => c.cmd === "secret_value").map((c) => c.args);

  it("hides every value until Show is pressed for that key, then asks the backend for that one value", async () => {
    await openDetails(secret, SECRET_REF);
    const panel = document.querySelector<HTMLElement>(".details")!;
    expect(panel.textContent).not.toContain("not-a-real-password");
    expect(valueCalls()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Show value of password" }));
    expect(await screen.findByText("not-a-real-password")).toBeInTheDocument();
    expect(valueCalls()).toEqual([{ clusterId: "c1", namespace: "sextant-demo", name: "demo-secret", key: "password" }]);
    // The other key stays hidden and is not fetched.
    expect(screen.queryByText("demo")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Hide value of password" }));
    expect(panel.textContent).not.toContain("not-a-real-password");
  });

  it("toggles with an eye button that has no text, a tooltip and aria-pressed", async () => {
    await openDetails(secret, SECRET_REF);
    const show = screen.getByRole("button", { name: "Show value of password" });
    expect(show).toHaveAttribute("title", "Show value of password");
    expect(show).toHaveAttribute("aria-pressed", "false");
    expect(show).toHaveTextContent("");
    expect(show.className).toContain("btn--icon");
    expect(show.querySelector("svg")).not.toBeNull();
    const eye = show.innerHTML;

    fireEvent.click(show);
    await screen.findByText("not-a-real-password");
    const hide = screen.getByRole("button", { name: "Hide value of password" });
    expect(hide).toHaveAttribute("title", "Hide value of password");
    expect(hide).toHaveAttribute("aria-pressed", "true");
    expect(hide.innerHTML).not.toBe(eye);
  });

  it("shows why a binary value cannot be shown", async () => {
    wb.backend.on("secret_value", () => {
      throw { code: "invalid", message: "binary value, 3 bytes" };
    });
    await openDetails(secret, SECRET_REF);
    fireEvent.click(screen.getByRole("button", { name: "Show value of password" }));
    expect(await screen.findByText(/binary value, 3 bytes/)).toBeInTheDocument();
  });

  it("is hidden again when the secret is opened again", async () => {
    await openDetails(secret, SECRET_REF);
    fireEvent.click(screen.getByRole("button", { name: "Show value of username" }));
    expect(await screen.findByText("demo")).toBeInTheDocument();
    cleanup();
    await openDetails(secret, SECRET_REF);
    expect(screen.queryByText("demo")).toBeNull();
    expect(screen.getByRole("button", { name: "Show value of username" })).toBeInTheDocument();
  });

  it("does not list the hidden-values marker among the annotations", async () => {
    await openDetails(secret, SECRET_REF);
    expect(document.querySelector(".details")!.textContent).not.toContain("sextant.dev/values-hidden");
  });
});

describe("actions", () => {
  it("offers the registered actions of the kind in the ActionBar", async () => {
    let ran: string[] = [];
    registerAction("delete", {
      labelKey: "details:actions",
      icon: "delete",
      placement: "primary",
      appliesTo: () => true,
      run: (ctx) => {
        ran = ctx.refs.map((r) => r.name);
      },
    });
    await openDetails(pod, POD_REF);
    const bar = within(section("summary")).getByRole("toolbar");
    fireEvent.click(within(bar).getByRole("button", { name: "Actions" }));
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
    fireEvent.click(within(section("yaml")).getByRole("button", { name: "YAML" }));
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
    fireEvent.click(within(section("yaml")).getByRole("button", { name: "YAML" }));
    const yaml = yamlText();
    expect(yaml).toContain("data:\n  password: <hidden>\n  username: <hidden>");
    expect(yaml).not.toContain("bm90LWEtcmVhbC1wYXNzd29yZA==");
    expect(yaml).not.toContain("not-a-real-password");
  });
});
