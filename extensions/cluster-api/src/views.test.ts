// The details section, driven through the SDK's stand-in for Sextant's window, as the built-in view's tests drove it
// (`src/features/cluster-api/clusterapi.test.tsx` before the move).
import type { KubeObject, WatchUpdate } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestWatch } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import objectsJson from "../fixtures/objects.json";
import { MAX_CHAIN_OBJECTS, startDetails } from "./details";
import { setLanguage } from "./i18n";

const objects = objectsJson as unknown as KubeObject[];
const copy = <T>(value: T): T => structuredClone(value);
const find = (kind: string, name: string): KubeObject => copy(objects.find((o) => o.kind === kind && o.metadata.name === name)!);
const cluster = () => find("Cluster", "capi-quickstart");
const deployment = () => find("MachineDeployment", "capi-quickstart-md-0-6xq7b");
const machineSet = () => find("MachineSet", "capi-quickstart-md-0-6xq7b-k9dpl");
const cpMachine = () => find("Machine", "capi-quickstart-n5w87-hz4sv");
const runningWorker = () => find("Machine", "capi-quickstart-md-0-6xq7b-k9dpl-2vbjm");
const stuckWorker = () => find("Machine", "capi-quickstart-md-0-6xq7b-k9dpl-5tq8w");
const healthCheck = () => find("MachineHealthCheck", "capi-quickstart-node-unhealthy-5m");
const legacyMachine = () => find("Machine", "legacy-md-0-abcde-fghij");
const kcp = () => find("KubeadmControlPlane", "capi-quickstart-n5w87");

const refOf = (o: KubeObject) => {
  const [group, version] = (o.apiVersion ?? "").split("/");
  return { kind: { group: group!, version: version!, kind: o.kind ?? "" }, namespace: o.metadata.namespace ?? null, name: o.metadata.name };
};
const served = (group: string, kind: string) => ({ kindRef: { group, version: "v1beta2", kind }, plural: `${kind.toLowerCase()}s`, namespaced: true, verbs: ["list", "watch"], printerColumns: [] });
const KINDS = [
  served("cluster.x-k8s.io", "Cluster"),
  served("cluster.x-k8s.io", "ClusterClass"),
  served("controlplane.cluster.x-k8s.io", "KubeadmControlPlane"),
  served("cluster.x-k8s.io", "MachineDeployment"),
  served("cluster.x-k8s.io", "MachineSet"),
  served("cluster.x-k8s.io", "Machine"),
  served("cluster.x-k8s.io", "MachineHealthCheck"),
  served("infrastructure.cluster.x-k8s.io", "DockerMachine"),
  served("infrastructure.cluster.x-k8s.io", "DockerCluster"),
  served("bootstrap.cluster.x-k8s.io", "KubeadmConfig"),
];

let host: TestHost;
let root: HTMLElement;
let stop: () => void = () => undefined;
/** Sextant's memory of the section's blocks (`context.blocks`, `ui.setBlockOpen`). */
let remembered: Record<string, boolean> = {};
/** The objects `resources.getMany` was asked for, by kind. */
let reads: string[] = [];
/** What `ui.openCluster` was asked. */
let opened: unknown[] = [];

interface Options {
  blocks?: Record<string, boolean>;
  /** A Cluster `resources.getMany` gives instead of the fixture's. */
  clusterObject?: KubeObject | null;
  kinds?: unknown[];
  clusters?: { id: string; name: string; context: string; server: string; state: unknown }[];
}

async function open(obj: KubeObject, options: Options = {}): Promise<void> {
  const { blocks = {}, kinds = KINDS, clusters = [] } = options;
  remembered = { ...blocks };
  reads = [];
  opened = [];
  host = await startTestHost({
    context: { view: "details", contribution: "cluster-api", selection: [refOf(obj)], resourceVersion: "1", language: "en", blocks: remembered, clusterId: "c1" },
    handlers: {
      "resources.get": () => copy(obj),
      "resources.getMany": ({ refs }: { refs: { kind: { kind: string }; name: string }[] }) => ({
        items: refs.map((ref) => {
          reads.push(ref.kind.kind);
          if (ref.kind.kind === "Cluster" && options.clusterObject !== undefined) {
            return options.clusterObject ? { object: copy(options.clusterObject) } : { error: { code: "forbidden", message: "no" } };
          }
          const found = objects.find((o) => o.kind === ref.kind.kind && o.metadata.name === ref.name);
          return found ? { object: copy(found) } : { error: { code: "notFound", message: "not found" } };
        }),
      }),
      kinds: () => kinds,
      "clusters.list": () => clusters,
      "ui.openCluster": (params: unknown) => {
        opened.push(params);
        return { opened: true };
      },
      "ui.setBlockOpen": ({ id, open: isOpen }: { id: string; open: boolean }) => {
        remembered = { ...remembered, [id]: isOpen };
        host.setContext({ blocks: remembered });
      },
    },
  });
  setLanguage("en");
  root = document.createElement("main");
  document.body.append(root);
  stop = startDetails(host.sextant, root);
  await expect.poll(() => root.querySelector(".sx-loading") === null).toBe(true);
}

afterEach(() => {
  stop();
  root?.remove();
  host?.close();
});

const text = () => root.textContent ?? "";
const buttons = (label: string) => [...root.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label") === label || b.textContent === label);
const watchParams = (w: TestWatch) => w.params as { kind: { kind: string }; namespaces?: string[]; labelSelector?: string; maxObjects?: number };
const watchOf = (kind: string) => host.watches.find((w) => watchParams(w).kind.kind === kind && !w.stopped);
const snapshot = (items: KubeObject[]): WatchUpdate => ({ type: "snapshot", items: items as never });
const toggle = (id: string) => root.querySelector<HTMLButtonElement>(`[data-block="${id}"] .sx-block__toggle`);
const statusOf = (word: string) => [...root.querySelectorAll(".sx-status")].find((s) => s.textContent === word);

describe("the details of a Cluster", () => {
  it("say why it is not available, show its control plane and infrastructure, the workload cluster and the machine chain", async () => {
    await open(cluster(), { clusters: [{ id: "w1", name: "kind-capi-quickstart", context: "kind-capi-quickstart", server: "https://172.18.0.3:6443", state: { type: "connected" } }] });
    await expect.poll(text).toContain("The cluster is not available: one of the checks behind its Available condition fails.");
    expect(statusOf("Not available")?.className).toContain("sx-status--danger");
    expect(buttons("Open KubeadmControlPlane capi-quickstart-n5w87")).toHaveLength(1);
    expect(text()).toContain("1 of 2 ready");
    await expect.poll(() => buttons("Open cluster kind-capi-quickstart").length).toBe(1);
    // DockerCluster is not in the fixtures: missing.
    await expect.poll(() => statusOf("Missing")?.className).toContain("sx-status--danger");
    expect(statusOf("Ready")?.className).toContain("sx-status--success");
    expect(reads.sort()).toEqual(["DockerCluster", "KubeadmControlPlane"]);
    // The chain: three label-selected watches of the Cluster's namespace, each capped.
    await expect.poll(() => watchOf("Machine")).toBeDefined();
    const label = "cluster.x-k8s.io/cluster-name=capi-quickstart";
    for (const kind of ["MachineDeployment", "MachineSet", "Machine"]) {
      expect(watchParams(watchOf(kind)!), kind).toMatchObject({ namespaces: ["default"], labelSelector: label, maxObjects: MAX_CHAIN_OBJECTS });
    }
    expect(text()).toContain("Loading the machines…");
    watchOf("MachineDeployment")!.emit(snapshot([deployment()]));
    watchOf("MachineSet")!.emit(snapshot([machineSet()]));
    watchOf("Machine")!.emit(snapshot([cpMachine(), runningWorker(), stuckWorker()]));
    await expect.poll(() => buttons("Open Machine capi-quickstart-md-0-6xq7b-k9dpl-5tq8w").length).toBe(1);
    expect([...root.querySelectorAll(".capi-chain__row")].filter((r) => r.textContent === "Control plane")).toHaveLength(1);
    expect(buttons("Open MachineSet capi-quickstart-md-0-6xq7b-k9dpl")).toHaveLength(1);
    expect(text()).toContain("Node capi-quickstart-n5w87-hz4sv");
    expect(text()).toContain("Ready: 1/2");
  });

  it("opens the workload cluster only on a click, through Sextant's dialog", async () => {
    await open(cluster(), { clusters: [{ id: "w1", name: "w", context: "kind-capi-quickstart", server: "https://172.18.0.3:6443", state: { type: "disconnected" } }] });
    const button = await expect.poll(() => buttons("Open cluster kind-capi-quickstart")[0]).toBeDefined().then(() => buttons("Open cluster kind-capi-quickstart")[0]!);
    expect(opened).toEqual([]);
    button.click();
    await expect.poll(() => opened).toEqual([{ host: "172.18.0.3", port: 6443 }]);
  });

  it("say so when no cluster of Sextant's is at the endpoint", async () => {
    await open(cluster(), { clusters: [{ id: "x", name: "x", context: "other", server: "https://127.0.0.1:6443", state: { type: "connected" } }] });
    await expect.poll(text).toContain("No cluster in Sextant has the API server 172.18.0.3:6443.");
  });

  it("read nothing and watch nothing while its blocks are closed, and remember a toggle in Sextant's memory", async () => {
    await open(cluster(), { blocks: { fields: false, chain: false } });
    await expect.poll(() => toggle("chain")).not.toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(reads).toEqual([]);
    expect(host.watches).toEqual([]);
    expect(toggle("fields")!.getAttribute("aria-expanded")).toBe("false");
    toggle("chain")!.click();
    await expect.poll(() => remembered.chain).toBe(true);
    await expect.poll(() => watchOf("Machine")).toBeDefined();
    expect(reads).toEqual([]);
    // "Collapse all": every block closes and its watches stop.
    host.setContext({ blocks: { "*": false } });
    await expect.poll(() => toggle("chain")!.getAttribute("aria-expanded")).toBe("false");
    await expect.poll(() => host.watches.every((w) => w.stopped)).toBe(true);
  });

  it("say when a chain list was cut", async () => {
    await open(cluster());
    await expect.poll(() => watchOf("Machine")).toBeDefined();
    watchOf("MachineDeployment")!.emit(snapshot([]));
    watchOf("MachineSet")!.emit(snapshot([]));
    watchOf("Machine")!.emit(snapshot([cpMachine()]));
    watchOf("Machine")!.emit({ type: "capped", total: MAX_CHAIN_OBJECTS + 10 } as never);
    await expect.poll(text).toContain("Only the first 5000 objects of a kind are read here: the list is incomplete.");
  });

  it("say the machines could not be listed where the cluster serves no Machines", async () => {
    await open(cluster(), { kinds: KINDS.filter((k) => k.kindRef.kind !== "Machine") });
    await expect.poll(text).toContain("The machines could not be listed.");
  });
});

describe("the details of a Machine", () => {
  it("of a stuck one: its bootstrap and infrastructure objects, read by name", async () => {
    await open(stuckWorker());
    await expect.poll(text).toContain("The machine has not reached Running yet (phase Provisioning).");
    await expect.poll(text).toContain("kindest/node:v1.34.0");
    expect(statusOf("Not ready")?.className).toContain("sx-status--warning");
    expect(buttons("Open DockerMachine capi-quickstart-md-0-6xq7b-k9dpl-5tq8w")).toHaveLength(1);
    expect(reads.sort()).toEqual(["Cluster", "DockerMachine", "KubeadmConfig"]);
  });

  it("whose Cluster is paused: paused, and said why", async () => {
    const paused = cluster();
    (paused.spec as Record<string, unknown>).paused = true;
    await open(stuckWorker(), { clusterObject: paused });
    await expect.poll(text).toMatch(/Its Cluster capi-quickstart is paused/);
    expect(text()).toContain("The machine is paused: Cluster API changes nothing in it until it is resumed.");
  });

  it("with only old conditions and a Cluster that cannot be read: says it cannot tell whether it is paused", async () => {
    const old = legacyMachine();
    delete (old.status as Record<string, unknown>).v1beta2;
    await open(old);
    await expect.poll(text).toMatch(/Its Cluster legacy could not be read/);
  });

  it("running: the Node opens in the workload cluster only on a click", async () => {
    await open(cpMachine(), { clusters: [{ id: "w1", name: "w", context: "kind-capi-quickstart", server: "https://172.18.0.3:6443", state: { type: "connected" } }] });
    await expect.poll(() => buttons("Open Node capi-quickstart-n5w87-hz4sv in kind-capi-quickstart").length).toBe(1);
    expect(opened).toEqual([]);
    buttons("Open Node capi-quickstart-n5w87-hz4sv in kind-capi-quickstart")[0]!.click();
    await expect.poll(() => opened).toEqual([{ host: "172.18.0.3", port: 6443, node: "capi-quickstart-n5w87-hz4sv" }]);
  });

  it("shows a provider kind outside Cluster API's groups as not readable, without asking for it", async () => {
    const m = stuckWorker();
    (m.spec as { infrastructureRef: Record<string, unknown> }).infrastructureRef = { apiGroup: "infra.example.com", kind: "FancyMachine", name: "fm-1" };
    // Sextant lists only the kinds the extension may use: a provider kind it may not read is never among them.
    await open(m);
    await expect.poll(text).toContain("Could not be read");
    expect(reads.sort()).toEqual(["Cluster", "KubeadmConfig"]);
  });

  it("reads any provider kind of the groups under cluster.x-k8s.io, and says one the cluster does not serve is not served", async () => {
    const m = stuckWorker();
    (m.spec as { infrastructureRef: Record<string, unknown> }).infrastructureRef = { apiGroup: "infrastructure.cluster.x-k8s.io", kind: "FancyMachine", name: "fm-1" };
    await open(m);
    await expect.poll(text).toContain("Kind not served by this cluster");
    expect(text()).not.toContain("Could not be read");
  });

  it("says a kind the cluster does not serve is not served", async () => {
    await open(stuckWorker(), { kinds: KINDS.filter((k) => k.kindRef.kind !== "DockerMachine") });
    await expect.poll(text).toContain("Kind not served by this cluster");
  });
});

describe("the details of the other kinds", () => {
  it("of a MachineHealthCheck: what it checks and why remediation is blocked", async () => {
    await open(healthCheck());
    await expect.poll(text).toContain("Remediation is blocked: too many machines are unhealthy (2 of 5 healthy).");
    expect(text()).toMatch(/exceeds maxUnhealthy/);
    expect(text()).toContain("40%");
    expect([...root.querySelectorAll("td")].filter((td) => td.textContent === "300s")).toHaveLength(2);
    expect(buttons("Open Machine np0-a")).toHaveLength(1);
  });

  it("of a MachineDeployment: replica counts and its Machines by its selector", async () => {
    await open(deployment());
    await expect.poll(text).toContain("Not available: fewer machines are available than required.");
    await expect.poll(() => watchOf("Machine")).toBeDefined();
    expect(watchParams(watchOf("Machine")!).labelSelector).toBe("cluster.x-k8s.io/cluster-name=capi-quickstart,topology.cluster.x-k8s.io/deployment-name=md-0");
    watchOf("Machine")!.emit(snapshot([runningWorker(), stuckWorker()]));
    await expect.poll(() => root.querySelectorAll("tr").length).toBe(3);
  });

  it("of a KubeadmControlPlane: its counts, initialization and template", async () => {
    await open(kcp());
    await expect.poll(text).toContain("Initialized");
    expect(text()).toContain("Yes");
    expect(reads).toEqual(["Cluster"]);
  });
});
