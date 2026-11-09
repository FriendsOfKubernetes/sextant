// The details sections and the "GPU nodes" page, driven through the SDK's stand-in for Sextant's window, as the
// built-in view's tests drove them.
import type { KubeObject, WatchUpdate } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestWatch } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import fixtures from "../fixtures/objects.json";
import { MAX_NAMESPACE_DAEMONSETS, startDetails } from "./details";
import { setLanguage } from "./i18n";
import { GPU_NODE_SELECTOR, MAX_GPU_NODES, startPage } from "./page";

const f = fixtures as unknown as Record<string, KubeObject>;
const fx = (name: string): KubeObject => structuredClone(f[name]!);
const daemonSets = () => [fx("dsDriver"), fx("dsToolkit"), fx("dsDevicePlugin"), fx("dsOwnedByDriver")];

const KINDS: Record<string, { group: string; version: string; kind: string }> = {
  ClusterPolicy: { group: "nvidia.com", version: "v1", kind: "ClusterPolicy" },
  NVIDIADriver: { group: "nvidia.com", version: "v1alpha1", kind: "NVIDIADriver" },
  Node: { group: "", version: "v1", kind: "Node" },
};
const ref = (o: KubeObject) => ({ kind: KINDS[o.kind!]!, namespace: null, name: o.metadata.name });

let host: TestHost;
let root: HTMLElement;
let stop: () => void = () => undefined;

async function open(obj: KubeObject, contribution: string, language = "en"): Promise<void> {
  host = await startTestHost({
    context: { view: "details", contribution, selection: [ref(obj)], resourceVersion: "1", language },
    handlers: { "resources.get": () => structuredClone(obj) },
  });
  setLanguage(language);
  root = document.createElement("main");
  document.body.append(root);
  stop = startDetails(host.sextant, root, contribution);
  await expect.poll(() => root.querySelector(".sx-loading")).toBeNull();
}

async function openPage(language = "en"): Promise<void> {
  host = await startTestHost({ context: { view: "page", contribution: "gpu-nodes", language } });
  setLanguage(language);
  root = document.createElement("main");
  document.body.append(root);
  stop = startPage(host.sextant, root);
}

afterEach(() => {
  setLanguage("en");
  stop();
  root?.remove();
  host?.close();
});

const text = () => root.textContent ?? "";
const byLabel = (label: string) => [...root.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label") === label);
const watchParams = (w: TestWatch) => w.params as { kind: { kind: string }; namespaces?: string[]; labelSelector?: string };
const watchOf = (kind: string) => host.watches.find((w) => watchParams(w).kind.kind === kind && !w.stopped);
const snapshot = (items: KubeObject[]): WatchUpdate => ({ type: "snapshot", items: items as never });
const statusOf = (word: string) => [...root.querySelectorAll(".sx-status")].find((s) => s.textContent === word);
const rows = () => [...root.querySelectorAll("tbody tr")].map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent));

describe("a ClusterPolicy", () => {
  it("its state, the operator's message, and each component with its DaemonSet in the operand namespace", async () => {
    await open(fx("policyNotReady"), "gpu-operator");
    expect(statusOf("Not ready")?.className).toContain("sx-status--warning");
    expect(statusOf("Not ready")?.getAttribute("title")).toBe("ClusterPolicy is not ready, states not ready: [state-driver]");
    expect(root.querySelector(".gpu-message")?.textContent).toBe("ClusterPolicy is not ready, states not ready: [state-driver]");
    expect(root.querySelector(".gpu-note")?.textContent).toContain("The operator has not finished");
    expect(text()).toContain("Not set (the device plugin decides, by default none)");
    await expect.poll(() => watchOf("DaemonSet")).toBeDefined();
    expect(watchParams(watchOf("DaemonSet")!)).toMatchObject({ namespaces: ["gpu-operator"] });
    expect(watchParams(watchOf("DaemonSet")!).labelSelector).toBeUndefined();
    expect(text()).toContain("Loading…");
    // Before the list comes, enabled components cannot be told.
    expect(rows().find((r) => r[0] === "DCGM")).toEqual(["DCGM", "On", "Cannot tell", "nvidia-dcgm"]);
    watchOf("DaemonSet")!.emit(snapshot(daemonSets()));
    await expect.poll(() => statusOf("1 of 2 ready, 2 updated")?.className).toContain("sx-status--warning");
    expect(byLabel("Open DaemonSet nvidia-container-toolkit-daemonset")).toHaveLength(1);
    expect(rows().find((r) => r[0] === "Container toolkit")).toEqual(["Container toolkit", "On", "2 of 2 ready, 2 updated", "nvidia-container-toolkit-daemonset"]);
    expect(rows().find((r) => r[0] === "DCGM")).toEqual(["DCGM", "On", "Not deployed yet", "nvidia-dcgm"]);
    expect(rows().find((r) => r[0] === "Node status exporter")).toEqual(["Node status exporter", "Off", "Not deployed", "nvidia-node-status-exporter"]);
    // Sandbox components only when sandbox workloads are on.
    expect(rows().some((r) => r[0] === "vGPU manager")).toBe(false);
    expect(text()).not.toContain("Loading…");
  });

  it("a ready one with its MIG strategy, and one whose driver comes from NVIDIADriver objects", async () => {
    await open(fx("policyReady"), "gpu-operator");
    expect(statusOf("Ready")?.className).toContain("sx-status--success");
    expect(root.querySelector(".gpu-note")).toBeNull();
    expect(text()).toContain("mixed");
    stop();
    host.close();
    root.remove();
    await open(fx("policyByCrd"), "gpu-operator");
    expect(text()).toContain("Managed by NVIDIADriver objects");
    await expect.poll(() => watchOf("DaemonSet")).toBeDefined();
    watchOf("DaemonSet")!.emit(snapshot([]));
    await expect.poll(() => rows().find((r) => r[0] === "Driver")?.[2]).toBe("See NVIDIADriver");
  });

  it("says what it cannot read: no operand namespace yet, a list refused, a list cut", async () => {
    const pending = fx("policyReady");
    delete (pending.status as Record<string, unknown>).namespace;
    delete (pending.status as Record<string, unknown>).state;
    await open(pending, "gpu-operator");
    expect(text()).toContain("The operator has not reported its operand namespace yet");
    expect(text()).toContain("The operator has not reported a state yet.");
    expect(watchOf("DaemonSet")).toBeUndefined();
    stop();
    host.close();
    root.remove();

    await open(fx("policyReady"), "gpu-operator");
    await expect.poll(() => watchOf("DaemonSet")).toBeDefined();
    watchOf("DaemonSet")!.emit({ type: "forbidden", namespaces: ["gpu-operator"] } as never);
    await expect.poll(() => text()).toContain("The DaemonSets of namespace gpu-operator could not be read.");
    const many = Array.from({ length: MAX_NAMESPACE_DAEMONSETS + 1 }, (_, i) => ({
      apiVersion: "apps/v1",
      kind: "DaemonSet",
      metadata: { name: `ds-${String(i).padStart(4, "0")}`, namespace: "gpu-operator", uid: `u${i}` },
    }));
    watchOf("DaemonSet")!.emit(snapshot(many));
    await expect.poll(() => text()).toContain("Not every DaemonSet of the namespace was read");
  });

  it("speaks the UI language", async () => {
    await open(fx("policyNotReady"), "gpu-operator", "ru");
    expect(statusOf("Не готов")).toBeDefined();
    expect(text()).toContain("Компоненты");
  });
});

describe("an NVIDIADriver", () => {
  it("its type, version, node selector and the DaemonSets it owns", async () => {
    await open(fx("driver"), "gpu-operator");
    expect(text()).toContain("570.86.15");
    expect(text()).toContain("gpu");
    expect([...root.querySelectorAll(".sx-chip")].map((c) => c.textContent)).toEqual(["nvidia.com/gpu.present=true"]);
    expect(root.querySelector(".gpu-message")?.textContent).toBe("Driver is not ready");
    await expect.poll(() => watchOf("DaemonSet")).toBeDefined();
    watchOf("DaemonSet")!.emit(snapshot(daemonSets()));
    await expect.poll(() => byLabel("Open DaemonSet nvidia-gpu-driver-ubuntu22.04-7c6d5b9f8")).toHaveLength(1);
    expect(rows()).toEqual([["nvidia-gpu-driver-ubuntu22.04-7c6d5b9f8", "0 of 1 ready, 1 updated"]]);
    watchOf("DaemonSet")!.emit(snapshot([fx("dsToolkit")]));
    await expect.poll(() => text()).toContain("No DaemonSet of this NVIDIADriver yet.");
  });
});

describe("a node", () => {
  it("its GPUs, the MIG configuration and its state, and the GPU and MIG resources", async () => {
    await open(fx("nodeMigFailed"), "gpu-node");
    expect(text()).toContain("NVIDIA-H100-80GB-HBM3");
    expect(statusOf("failed")?.className).toContain("sx-status--danger");
    expect(root.querySelector(".gpu-message")?.textContent).toBe("The MIG manager could not apply the MIG configuration all-3g.40gb on this node.");
    expect(rows()).toEqual([["nvidia.com/gpu", "8", "8"]]);
    expect(host.watches).toHaveLength(0);
  });

  it("MIG resources and memory per GPU; nothing on a node without GPUs", async () => {
    const node = fx("nodeMig");
    node.metadata.labels!["nvidia.com/gpu.memory"] = "40960";
    await open(node, "gpu-node");
    expect(text()).toContain("40960 MiB");
    expect(statusOf("success")?.className).toContain("sx-status--success");
    expect(rows()).toEqual([
      ["nvidia.com/gpu", "0", "0"],
      ["nvidia.com/mig-1g.5gb", "56", "54"],
    ]);
    stop();
    host.close();
    root.remove();
    await open(fx("nodePlain"), "gpu-node");
    expect(root.childElementCount).toBe(0);
  });
});

describe("the GPU nodes page", () => {
  it("lists the GPU nodes with their GPUs and MIG resources", async () => {
    await openPage();
    expect(text()).toContain("Loading…");
    await expect.poll(() => watchOf("Node")).toBeDefined();
    expect(watchParams(watchOf("Node")!)).toMatchObject({ labelSelector: GPU_NODE_SELECTOR });
    watchOf("Node")!.emit(snapshot([fx("nodeMigFailed"), fx("nodeMig")]));
    await expect.poll(() => root.querySelector('[role="status"]')?.textContent).toBe("2 nodes");
    expect(rows()).toEqual([
      ["gpu-node-1", "NVIDIA-A100-SXM4-40GB", "8", "0 of 0", "mig-1g.5gb: 54/56", "all-1g.5gb", "success"],
      ["gpu-node-2", "NVIDIA-H100-80GB-HBM3", "8", "8 of 8", "", "all-3g.40gb", "failed"],
    ]);
    expect(byLabel("Open Node gpu-node-1")).toHaveLength(1);
  });

  it("says when the list is cut or cannot be read", async () => {
    await openPage();
    await expect.poll(() => watchOf("Node")).toBeDefined();
    const many = Array.from({ length: MAX_GPU_NODES + 1 }, (_, i) => ({ apiVersion: "v1", kind: "Node", metadata: { name: `n${i}`, uid: `n${i}` } }));
    watchOf("Node")!.emit(snapshot(many));
    await expect.poll(() => text()).toContain(`Only the first ${MAX_GPU_NODES} nodes are read.`);
    expect(root.querySelector('[role="status"]')?.textContent).toBe(`${MAX_GPU_NODES} nodes`);
    watchOf("Node")!.emit({ type: "error", code: "network", message: "down" } as never);
    await expect.poll(() => text()).toContain("The nodes could not be read.");
  });
});
