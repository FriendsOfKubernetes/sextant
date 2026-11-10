// The details sections and the "Devices" page, driven through the SDK's stand-in for Sextant's window, as the
// built-in view's tests drove them.
import type { KubeObject, WatchUpdate } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestWatch } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import fixtures from "../fixtures/objects.json";
import { startDetails } from "./details";
import { setLanguage } from "./i18n";
import { startPage } from "./page";

const f = fixtures as unknown as Record<string, KubeObject>;
const copy = <T>(value: T): T => structuredClone(value);

const refTo = (o: KubeObject) => {
  const [group, version] = (o.apiVersion ?? "").includes("/") ? (o.apiVersion ?? "").split("/") : ["", o.apiVersion ?? "v1"];
  return { kind: { group: group!, version: version!, kind: o.kind! }, namespace: o.metadata.namespace ?? null, name: o.metadata.name };
};

const served = (...kinds: string[]) =>
  kinds.map((kind) => ({ kindRef: { group: "resource.k8s.io", version: "v1", kind }, plural: `${kind.toLowerCase()}s`, namespaced: kind.startsWith("ResourceClaim"), verbs: ["list", "watch"], printerColumns: [] }));
const ALL_KINDS = served("ResourceClaim", "ResourceClaimTemplate", "DeviceClass", "ResourceSlice");

let host: TestHost;
let root: HTMLElement;
let stop: () => void = () => undefined;
let hidden: boolean[] = [];

async function start(context: Parameters<typeof startTestHost>[0], run: (h: TestHost) => () => void): Promise<void> {
  hidden = [];
  host = await startTestHost({
    ...context,
    handlers: {
      kinds: () => ALL_KINDS,
      "ui.setHidden": ({ hidden: h }: { hidden: boolean }) => void hidden.push(h),
      ...context?.handlers,
    },
  });
  root = document.createElement("main");
  document.body.append(root);
  stop = run(host);
}

async function open(obj: KubeObject, section: string, handlers: Record<string, (params: unknown) => unknown> = {}): Promise<void> {
  await start(
    { context: { view: "details", contribution: section, selection: [refTo(obj)], resourceVersion: "1" }, handlers: { "resources.get": () => copy(obj), ...handlers } },
    (h) => startDetails(h.sextant, root, section),
  );
  if (section !== "node-devices") await expect.poll(() => root.querySelector(".sx-loading")).toBeNull();
}

afterEach(() => {
  setLanguage("en");
  stop();
  root?.remove();
  host?.close();
});

const text = () => root.textContent ?? "";
const byLabel = (label: string) => [...root.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label") === label);
type Params = { kind: { group?: string; kind: string }; namespaces?: string[]; fieldSelector?: string; labelSelector?: string; maxObjects?: number };
const watchParams = (w: TestWatch) => w.params as Params;
const watchOf = (kind: string, test: (p: Params) => boolean = () => true) => host.watches.find((w) => watchParams(w).kind.kind === kind && !w.stopped && test(watchParams(w)));
const snapshot = (items: KubeObject[]): WatchUpdate => ({ type: "snapshot", items: items as never });
const statusOf = (word: string) => [...root.querySelectorAll(".sx-status")].find((s) => s.textContent === word);

describe("details of a ResourceClaim", () => {
  it("an allocated claim: state, node, consumer, requests and the devices", async () => {
    await open(f.claimAllocated!, "resource-claim");
    expect(statusOf("In use")?.className).toContain("sx-status--success");
    expect(byLabel("Open Node kind-worker")).toHaveLength(1);
    expect(byLabel("Open Pod pod0").length).toBeGreaterThan(0);
    expect(text()).toContain("kind-worker / gpu-0");
    expect(byLabel("Open DeviceClass gpu.example.com")).toHaveLength(1);
    expect(text()).toContain("Devices are allocated and reserved for the consumers below.");
    // Allocated: no Pending pods are watched.
    expect(watchOf("Pod")).toBeUndefined();
    byLabel("Open DeviceClass gpu.example.com")[0]!.click();
    await expect.poll(() => host.calls.find((c) => c.method === "ui.openDetails")?.params).toEqual({
      kind: { group: "resource.k8s.io", version: "v1", kind: "DeviceClass" },
      namespace: null,
      name: "gpu.example.com",
    });
  });

  it("a pending claim: CEL selectors as text, the choices, and the pods that wait with the scheduler's words", async () => {
    await open(f.claimPending!, "resource-claim");
    expect(text()).toMatch(/compareTo\(quantity\('80Gi'\)\)/);
    expect(text()).toContain("gpu: choice 2 (small)");
    expect(text()).toContain("2 devices");
    await expect.poll(() => watchOf("Pod")).toBeDefined();
    expect(watchParams(watchOf("Pod")!)).toMatchObject({ namespaces: ["gpu-test1"], fieldSelector: "status.phase=Pending" });
    expect(text()).toContain("Loading…");
    watchOf("Pod")!.emit(snapshot([f.podWaiting!]));
    await expect.poll(() => byLabel("Open Pod pod1")).toHaveLength(1);
    expect(text()).toContain("No node has free devices that match every request");
    expect(text()).toContain("cannot allocate all claims");
  });

  it("says when no Pending pod uses it, or when they cannot be read", async () => {
    await open(f.claimPending!, "resource-claim");
    await expect.poll(() => watchOf("Pod")).toBeDefined();
    watchOf("Pod")!.emit(snapshot([]));
    await expect.poll(() => text()).toContain("No Pending Pod of this namespace uses this claim.");
    watchOf("Pod")!.emit({ type: "forbidden", namespaces: ["gpu-test1"] } as never);
    await expect.poll(() => text()).toContain("The Pending Pods of this namespace could not be read.");
  });

  it("a claim whose binding failed: the driver's words, admin access and the conditions", async () => {
    await open(f.claimV1beta1!, "resource-claim");
    expect(statusOf("Binding failed")?.className).toContain("sx-status--danger");
    expect(root.querySelector(".dra-message")?.textContent).toContain("binding a device failed");
    expect(text()).toContain("Admin access. Binding failed: FabricFailed.");
    expect(text()).toContain("All matching devices, with admin access");
    expect(text()).toContain("topology.kubernetes.io/zone In zone-a");
  });
});

describe("details of the other kinds", () => {
  it("a template: the requests its claims will have", async () => {
    await open(f.templateV1beta1!, "resource-claim-template");
    expect(text()).toContain("2 devices");
    // The class link keeps the template's version.
    byLabel("Open DeviceClass gpu.example.com")[0]!.click();
    await expect.poll(() => host.calls.find((c) => c.method === "ui.openDetails")?.params).toMatchObject({ kind: { version: "v1beta1", kind: "DeviceClass" } });
  });

  it("a device class: its CEL as text, the drivers' configuration", async () => {
    await open(f.deviceClass!, "device-class");
    expect(root.querySelector(".dra-cel__expr")?.textContent).toBe("device.driver == 'gpu.example.com'");
    expect(text()).toContain("The expressions are shown as written; Sextant does not evaluate them.");
    expect(text()).toContain("TimeSlicing");
  });

  it("a slice: its devices, with the claim that holds each once every claim is read", async () => {
    await open(f.sliceV1!, "resource-slice");
    expect(text()).toContain("Cannot tell");
    await expect.poll(() => watchOf("ResourceClaim")).toBeDefined();
    expect(watchParams(watchOf("ResourceClaim")!).namespaces).toBeUndefined();
    watchOf("ResourceClaim")!.emit(snapshot([f.claimAllocated!]));
    await expect.poll(() => byLabel("Open ResourceClaim pod0-gpu-x7k2p")).toHaveLength(1);
    expect(text()).toContain("Free");
    expect(text()).toContain("LATEST-GPU-MODEL");
    expect(text()).toContain("memory=80Gi");
  });
});

describe("the Pod's devices", () => {
  it("its claims, their state, and why it waits", async () => {
    await open(f.podWaiting!, "pod-devices");
    await expect.poll(() => watchOf("ResourceClaim")).toBeDefined();
    expect(watchParams(watchOf("ResourceClaim")!).namespaces).toEqual(["gpu-test1"]);
    watchOf("ResourceClaim")!.emit(snapshot([f.claimPending!]));
    await expect.poll(() => statusOf("Pending")?.className).toContain("sx-status--warning");
    expect(statusOf("Does not exist")?.className).toContain("sx-status--danger");
    expect(text()).toContain("No node has free devices");
    expect(text()).toContain("trainer (gpu)");
  });

  it("a claim not made yet from its template", async () => {
    await open(f.podNotCreated!, "pod-devices");
    await expect.poll(() => watchOf("ResourceClaim")).toBeDefined();
    watchOf("ResourceClaim")!.emit(snapshot([]));
    await expect.poll(() => statusOf("Not created yet")).toBeDefined();
    expect(text()).toContain("From template two-gpus");
    expect(text()).toContain("The claim the Pod makes from its template does not exist yet");
  });

  it("where the cluster serves no ResourceClaims: nothing watched, and it says so", async () => {
    await open(f.podWaiting!, "pod-devices", { kinds: () => [] });
    await expect.poll(() => text()).toContain("The cluster does not serve resource.k8s.io ResourceClaims.");
    expect(watchOf("ResourceClaim")).toBeUndefined();
    expect(text()).toContain("Cannot tell");
  });
});

describe("the Node's DRA devices", () => {
  const node: KubeObject = { apiVersion: "v1", kind: "Node", metadata: { name: "kind-worker", uid: "n1" } };

  it("from its slices, with the claim that holds each; shown once it has some", async () => {
    await open(node, "node-devices");
    await expect.poll(() => watchOf("ResourceSlice")).toBeDefined();
    // The section starts hidden (`startHidden`): nothing to ask yet.
    expect(hidden).toEqual([]);
    expect(watchParams(watchOf("ResourceSlice")!)).toMatchObject({ fieldSelector: "spec.nodeName=kind-worker", maxObjects: 500 });
    watchOf("ResourceSlice")!.emit(snapshot([f.sliceV1!]));
    await expect.poll(() => watchOf("ResourceClaim")).toBeDefined();
    watchOf("ResourceClaim")!.emit(snapshot([f.claimAllocated!]));
    await expect.poll(() => byLabel("Open ResourceClaim pod0-gpu-x7k2p")).toHaveLength(1);
    expect(text()).toContain("Free");
    expect(hidden).toEqual([false]);
    expect(watchParams(watchOf("ResourceClaim")!).maxObjects).toBe(5000);
    // Its block, titled as the built-in one.
    expect(root.querySelector(".sx-block__toggle")?.textContent).toBe("DRA devices");
    // The Node itself is never read.
    expect(host.calls.some((c) => c.method === "resources.get")).toBe(false);
  });

  it("stays hidden for a node without slices, and where the cluster serves none", async () => {
    await open(node, "node-devices");
    await expect.poll(() => watchOf("ResourceSlice")).toBeDefined();
    watchOf("ResourceSlice")!.emit(snapshot([]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hidden).toEqual([]);
    expect(watchOf("ResourceClaim")).toBeUndefined();
    stop();
    host.close();
    await open(node, "node-devices", { kinds: () => [] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hidden).toEqual([]);
    expect(host.watches).toEqual([]);
  });

  it("says it cannot tell when the slices cannot be read", async () => {
    await open(node, "node-devices");
    await expect.poll(() => watchOf("ResourceSlice")).toBeDefined();
    watchOf("ResourceSlice")!.emit({ type: "forbidden", namespaces: [] } as never);
    await expect.poll(() => hidden).toEqual([false]);
    expect(text()).toContain("Cannot tell");
  });

  it("cannot tell either when the slices are cut at 500, and says so", async () => {
    await open(node, "node-devices");
    await expect.poll(() => watchOf("ResourceSlice")).toBeDefined();
    watchOf("ResourceSlice")!.emit({ type: "capped", total: 900 } as never);
    watchOf("ResourceSlice")!.emit(snapshot([]));
    await expect.poll(() => hidden).toEqual([false]);
    expect(text()).toContain("Cannot tell");
    expect(text()).toContain("Only the first 500 ResourceSlices are read.");
  });

  it("closed, looks at the slices once and keeps the answer, watching nothing", async () => {
    await start(
      { context: { view: "details", contribution: "node-devices", selection: [refTo(node)], resourceVersion: "1", blocks: { node: false } } },
      (h) => startDetails(h.sextant, root, "node-devices"),
    );
    await expect.poll(() => watchOf("ResourceSlice")).toBeDefined();
    watchOf("ResourceSlice")!.emit(snapshot([f.sliceV1!]));
    await expect.poll(() => hidden).toEqual([false]);
    await expect.poll(() => watchOf("ResourceSlice")).toBeUndefined();
    expect(watchOf("ResourceClaim")).toBeUndefined();
    expect(root.querySelector(".sx-block__toggle")?.getAttribute("aria-expanded")).toBe("false");
    // Opened: the slices and the claims are watched.
    root.querySelector<HTMLButtonElement>(".sx-block__toggle")!.click();
    await expect.poll(() => host.calls.find((c) => c.method === "ui.setBlockOpen")?.params).toEqual({ id: "node", open: true });
    await expect.poll(() => watchOf("ResourceSlice")).toBeDefined();
    watchOf("ResourceSlice")!.emit(snapshot([f.sliceV1!]));
    await expect.poll(() => watchOf("ResourceClaim")).toBeDefined();
  });
});

describe("the Devices page", () => {
  it("lists every slice's devices by node with the totals", async () => {
    await start({ context: { view: "page", contribution: "devices" } }, (h) => startPage(h.sextant, root));
    await expect.poll(() => watchOf("ResourceSlice")).toBeDefined();
    expect(watchParams(watchOf("ResourceSlice")!).fieldSelector).toBeUndefined();
    watchOf("ResourceSlice")!.emit(snapshot([f.sliceV1!, f.sliceV1beta1!]));
    watchOf("ResourceClaim")!.emit(snapshot([f.claimAllocated!]));
    await expect.poll(() => root.querySelector("[role=status]")?.textContent).toBe("3 devices, 1 allocated");
    expect(text()).toContain("All nodes");
    expect(text()).toContain("fabric / link-0");
  });

  it("without the claims: the total only, and why", async () => {
    await start({ context: { view: "page", contribution: "devices" } }, (h) => startPage(h.sextant, root));
    await expect.poll(() => watchOf("ResourceSlice")).toBeDefined();
    watchOf("ResourceSlice")!.emit(snapshot([f.sliceV1!]));
    watchOf("ResourceClaim")!.emit({ type: "error", code: "forbidden", message: "no" } as never);
    await expect.poll(() => root.querySelector("[role=status]")?.textContent).toBe("2 devices");
    expect(text()).toContain("could not be read in full");
  });

  it("in another language", async () => {
    await start({ context: { view: "page", contribution: "devices" } }, (h) => {
      setLanguage("de");
      return startPage(h.sextant, root);
    });
    await expect.poll(() => watchOf("ResourceSlice")).toBeDefined();
    watchOf("ResourceSlice")!.emit(snapshot([]));
    watchOf("ResourceClaim")!.emit(snapshot([]));
    await expect.poll(() => root.querySelector("h2")?.textContent).toBe("Geräte");
  });
});

describe("the blocks, in Sextant's memory of details sections", () => {
  const toggles = () => [...root.querySelectorAll<HTMLButtonElement>(".sx-block__toggle")];
  const expanded = () => toggles().map((b) => [b.textContent, b.getAttribute("aria-expanded")]);
  /** Sextant's memory: `ui.setBlockOpen` writes it, the context tells it back, as the window does. */
  const remembering = (blocks: Record<string, boolean> = {}) => ({
    "resources.get": () => copy(f.claimPending!),
    "ui.setBlockOpen": ({ id, open }: { id: string; open: boolean }) => {
      blocks = { ...blocks, [id]: open };
      setTimeout(() => host.setContext({ blocks }));
      return null;
    },
  });
  const openClaim = async (blocks: Record<string, boolean> = {}) => {
    await start(
      { context: { view: "details", contribution: "resource-claim", selection: [refTo(f.claimPending!)], resourceVersion: "1", blocks }, handlers: remembering(blocks) as never },
      (h) => startDetails(h.sextant, root, "resource-claim"),
    );
    await expect.poll(() => root.querySelector(".sx-loading")).toBeNull();
  };

  it("open and close with their titles, remembered; the Pending pods are watched only while their block is open", async () => {
    await openClaim();
    expect(expanded()).toEqual([
      ["Requests", "true"],
      ["Pods waiting for this claim", "true"],
    ]);
    await expect.poll(() => watchOf("Pod")).toBeDefined();
    expect(watchParams(watchOf("Pod")!)).toMatchObject({ maxObjects: 500 });
    toggles()[1]!.click();
    await expect.poll(() => host.calls.filter((c) => c.method === "ui.setBlockOpen").map((c) => c.params)).toEqual([{ id: "waiting", open: false }]);
    await expect.poll(() => watchOf("Pod")).toBeUndefined();
    expect(expanded()[1]).toEqual(["Pods waiting for this claim", "false"]);
    // Read again on a change: still closed.
    host.setContext({ resourceVersion: "2" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(expanded()[1]).toEqual(["Pods waiting for this claim", "false"]);
    expect(watchOf("Pod")).toBeUndefined();
  });

  it("follow \"Expand all\" and \"Collapse all\", a block's own choice first", async () => {
    await openClaim({ "*": false });
    expect(expanded()).toEqual([
      ["Requests", "false"],
      ["Pods waiting for this claim", "false"],
    ]);
    expect(watchOf("Pod")).toBeUndefined();
    host.setContext({ blocks: { "*": false, waiting: true } });
    await expect.poll(expanded).toEqual([
      ["Requests", "false"],
      ["Pods waiting for this claim", "true"],
    ]);
    await expect.poll(() => watchOf("Pod")).toBeDefined();
  });

  it("a slice watches every claim (at most 5000) only while its devices show, and a cut list cannot tell", async () => {
    await open(f.sliceV1!, "resource-slice");
    await expect.poll(() => watchOf("ResourceClaim")).toBeDefined();
    expect(watchParams(watchOf("ResourceClaim")!).maxObjects).toBe(5000);
    watchOf("ResourceClaim")!.emit({ type: "capped", total: 6000 } as never);
    watchOf("ResourceClaim")!.emit(snapshot([f.claimAllocated!]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(byLabel("Open ResourceClaim pod0-gpu-x7k2p")).toHaveLength(0);
    expect(text()).toContain("Cannot tell");
    root.querySelector<HTMLButtonElement>(".sx-block__toggle")!.click();
    await expect.poll(() => watchOf("ResourceClaim")).toBeUndefined();
  });

  it("the Pod's block: titled, its namespace's claims (at most 1000) watched while open; a cut list cannot tell a claim is missing", async () => {
    await open(f.podWaiting!, "pod-devices");
    expect(root.querySelector(".sx-block__toggle")?.textContent).toBe("Devices");
    await expect.poll(() => watchOf("ResourceClaim")).toBeDefined();
    expect(watchParams(watchOf("ResourceClaim")!)).toMatchObject({ namespaces: ["gpu-test1"], maxObjects: 1000 });
    watchOf("ResourceClaim")!.emit({ type: "capped", total: 1500 } as never);
    watchOf("ResourceClaim")!.emit(snapshot([f.claimPending!]));
    await expect.poll(() => statusOf("Pending")).toBeDefined();
    expect(statusOf("Does not exist")).toBeUndefined();
    expect(text()).toContain("Cannot tell");
    root.querySelector<HTMLButtonElement>(".sx-block__toggle")!.click();
    await expect.poll(() => watchOf("ResourceClaim")).toBeUndefined();
  });
});

describe("the Devices page's caps", () => {
  it("reads at most 500 slices and 5000 claims, and says when either is cut", async () => {
    await start({ context: { view: "page", contribution: "devices" } }, (h) => startPage(h.sextant, root));
    await expect.poll(() => watchOf("ResourceSlice")).toBeDefined();
    expect(watchParams(watchOf("ResourceSlice")!).maxObjects).toBe(500);
    expect(watchParams(watchOf("ResourceClaim")!).maxObjects).toBe(5000);
    watchOf("ResourceSlice")!.emit({ type: "capped", total: 700 } as never);
    watchOf("ResourceSlice")!.emit(snapshot([f.sliceV1!]));
    watchOf("ResourceClaim")!.emit({ type: "capped", total: 7000 } as never);
    watchOf("ResourceClaim")!.emit(snapshot([f.claimAllocated!]));
    await expect.poll(() => text()).toContain("Only the first 500 ResourceSlices are read.");
    expect(root.querySelector("[role=status]")?.textContent).toBe("2 devices");
    expect(text()).toContain("could not be read in full");
  });
});
