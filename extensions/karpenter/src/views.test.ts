// The details sections, driven through the SDK's stand-in for Sextant's window, as the built-in view's tests drove them.
import type { KubeObject, WatchUpdate } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestWatch } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import fixtures from "../fixtures/objects.json";
import { BLOCKS, startDetails } from "./details";
import { dateTimeText } from "./dom";
import { setLanguage } from "./i18n";

const objects = fixtures as unknown as KubeObject[];
const obj = (kind: string, name: string): KubeObject => structuredClone(objects.find((o) => o.kind === kind && o.metadata.name === name)!);
const ofKind = (kind: string) => objects.filter((o) => o.kind === kind).map((o) => structuredClone(o));

const refOf = (o: KubeObject) => {
  const api = o.apiVersion ?? "";
  const [group, version] = api.includes("/") ? api.split("/") : ["", api];
  return { kind: { group: group!, version: version!, kind: o.kind ?? "" }, namespace: o.metadata.namespace ?? null, name: o.metadata.name };
};
const served = (group: string, version: string, kind: string) => ({ kindRef: { group, version, kind }, plural: `${kind.toLowerCase()}s`, namespaced: false, verbs: ["list", "watch"], printerColumns: [] });
const KINDS = [served("karpenter.sh", "v1", "NodePool"), served("karpenter.sh", "v1", "NodeClaim")];

let host: TestHost;
let root: HTMLElement;
let stop: () => void = () => undefined;
let remembered: Record<string, boolean> = {};
let opened: { kind: { group: string; kind: string }; namespace: string | null; name: string }[] = [];

interface Options {
  contribution?: "node-pool" | "node-claim";
  language?: string;
  blocks?: Record<string, boolean>;
  kinds?: unknown[];
}

async function open(o: KubeObject, options: Options = {}): Promise<void> {
  const { contribution = "node-pool", language = "en", blocks = {}, kinds = KINDS } = options;
  remembered = { ...blocks };
  opened = [];
  host = await startTestHost({
    context: { view: "details", contribution, selection: [refOf(o)], resourceVersion: "1", language, blocks: remembered },
    handlers: {
      "resources.get": () => structuredClone(o),
      kinds: () => kinds,
      "ui.openDetails": (ref: (typeof opened)[number]) => void opened.push(ref),
      "ui.setBlockOpen": ({ id, open: isOpen }: { id: string; open: boolean }) => {
        remembered = { ...remembered, [id]: isOpen };
        host.setContext({ blocks: remembered });
      },
    },
  });
  setLanguage(language);
  root = document.createElement("main");
  document.body.append(root);
  stop = startDetails(host.sextant, root, contribution);
  await expect.poll(() => root.querySelector("[data-block]")).not.toBeNull();
}

function close(): void {
  stop();
  root.remove();
  host.close();
}

afterEach(() => {
  setLanguage("en");
  close();
});

type Params = { kind: { group: string; kind: string }; namespaces?: string[]; fieldSelector?: string };
/** What a watch asks for, besides the cluster (the context's). */
const params = (w: TestWatch): Params => {
  const rest = { ...(w.params as Params & { clusterId?: string }) };
  delete rest.clusterId;
  return rest;
};
const live = () => host.watches.filter((w) => !w.stopped);
const watchOf = (kind: string) => live().find((w) => params(w).kind.kind === kind);
const snapshot = (items: KubeObject[]): WatchUpdate => ({ type: "snapshot", items: items as never });
const text = () => root.textContent ?? "";
const phrases = () => [...root.querySelectorAll(".as-phrase")].map((p) => [p.className.replace("as-phrase as-phrase--", ""), p.textContent]);
const toggle = (id: string) => root.querySelector<HTMLButtonElement>(`[data-block="${id}"] .sx-block__toggle`);
const fields = () => {
  const out: Record<string, string> = {};
  for (const dt of root.querySelectorAll(".sx-fields__label")) out[dt.textContent ?? ""] = dt.nextElementSibling?.textContent ?? "";
  return out;
};
const rows = (scope: string) => [...root.querySelectorAll(`${scope} tbody tr`)].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent ?? ""));

describe("details of a NodePool", () => {
  it("tells its node class, disruption settings, limits and the recent disruptions of its NodeClaims", async () => {
    await open(obj("NodePool", "default"));
    expect(toggle(BLOCKS.pool)!.textContent).toBe("Limits and disruption");
    expect(phrases()).toEqual([]);
    expect(fields()).toEqual({
      "Node class": "default",
      "Consolidation policy": "WhenEmptyOrUnderutilized",
      "Consolidate after": "1m",
      "Expire after": "720h",
      "Disruption budgets": "10%0, Drifted/Underutilized, 0 9 * * mon-fri (8h)",
    });
    expect([...root.querySelectorAll(".as-lines > span")].map((s) => s.textContent)).toEqual(["10%", "0, Drifted/Underutilized, 0 9 * * mon-fri (8h)"]);
    expect(rows(`[data-block="${BLOCKS.pool}"] > .sx-block__body > .sx-table-wrap`)).toEqual([
      ["cpu", "12", "1000"],
      ["memory", "45.9GiB", "1000GiB"],
    ]);
    root.querySelector<HTMLButtonElement>('button[aria-label="Open EC2NodeClass default"]')!.click();
    await expect.poll(() => opened).toEqual([{ kind: { group: "karpenter.k8s.aws", version: "v1", kind: "EC2NodeClass" }, namespace: null, name: "default" }]);
    // Every NodeClaim's events, while the block is open; those of this pool's claims about disruption, newest first.
    await expect.poll(() => watchOf("Event")).toBeDefined();
    expect(params(watchOf("Event")!)).toEqual({ kind: { group: "", kind: "Event" }, fieldSelector: "involvedObject.kind=NodeClaim" });
    expect(text()).toContain("No recent disruption events.");
    watchOf("Event")!.emit(snapshot(ofKind("Event")));
    await expect.poll(() => rows(`[data-block="${BLOCKS.poolDisruptions}"]`).length).toBe(2);
    expect(rows(`[data-block="${BLOCKS.poolDisruptions}"]`).map((r) => r.slice(0, 3))).toEqual([
      ["default-abc12 · Other", "DisruptionBlocked", "Cannot disrupt NodeClaim: pdb default/web prevents pod evictions"],
      ["default-old42 · Drift", "DisruptionTerminating", "Disrupting NodeClaim: Drifted/Delete"],
    ]);
    expect(root.querySelector(`[data-block="${BLOCKS.poolDisruptions}"] tbody tr:nth-child(2) .as-warning`)?.textContent).toBe("DisruptionTerminating");
    toggle(BLOCKS.poolDisruptions)!.click();
    await expect.poll(() => watchOf("Event")).toBeUndefined();
    expect(remembered[BLOCKS.poolDisruptions]).toBe(false);
  });

  it("says when it is at a limit, and when it has none", async () => {
    await open(obj("NodePool", "gpu"));
    expect(phrases()).toEqual([["danger", "NodePool gpu is at its limit for cpu, nvidia.com/gpu: it launches no more nodes."]]);
    expect([...root.querySelectorAll(`[data-block="${BLOCKS.pool}"] td .sx-status--danger`)].map((s) => s.textContent)).toEqual(["64", "8"]);
    close();
    await open(obj("NodePool", "unbounded"), { blocks: { [BLOCKS.poolDisruptions]: false } });
    expect(text()).toContain("No limits: the NodePool may launch nodes without bound.");
    expect(fields()).toEqual({ "Node class": "default" });
    expect(watchOf("Event")).toBeUndefined();
  });

  it("watches nothing while its block is closed", async () => {
    await open(obj("NodePool", "default"), { blocks: { [BLOCKS.pool]: false } });
    await new Promise((r) => setTimeout(r, 20));
    expect(host.watches).toEqual([]);
    expect(root.querySelector(".sx-fields")).toBeNull();
  });
});

describe("details of a NodeClaim", () => {
  it("tells its launch, node, pool, disruption and, when there are some, its disruption events", async () => {
    await open(obj("NodeClaim", "default-abc12"), { contribution: "node-claim" });
    expect(toggle(BLOCKS.claim)!.textContent).toBe("Launch and disruption");
    expect(fields()).toEqual({
      Node: "ip-10-0-1-23.eu-west-1.compute.internal",
      NodePool: "default",
      "Capacity type": "spot",
      "Instance type": "m6i.large",
      Zone: "eu-west-1a",
    });
    // The NodePools are read for the consolidation policy and the expiry.
    await expect.poll(() => watchOf("NodePool")).toBeDefined();
    expect(params(watchOf("NodePool")!)).toEqual({ kind: { group: "karpenter.sh", kind: "NodePool" } });
    watchOf("NodePool")!.emit(snapshot(ofKind("NodePool")));
    await expect.poll(() => phrases().length).toBe(5);
    expect(phrases()).toEqual([
      ["success", "Launched, registered and initialized."],
      ["neutral", "Can be consolidated (policy: WhenEmptyOrUnderutilized): Karpenter may remove or replace it with a cheaper node."],
      ["warning", "Drifted (NodeClassDrift): the node no longer matches its NodePool or node class, so Karpenter replaces it."],
      ["neutral", "The annotation karpenter.sh/do-not-disrupt keeps Karpenter from disrupting it voluntarily."],
      ["neutral", `Expires (expireAfter) at ${dateTimeText("2026-11-19T08:00:00.000Z")}.`],
    ]);
    // Its events: no block until some are about disruption.
    const events = watchOf("Event")!;
    expect(params(events)).toEqual({ kind: { group: "", kind: "Event" }, fieldSelector: "involvedObject.kind=NodeClaim,involvedObject.name=default-abc12" });
    expect(toggle(BLOCKS.claimDisruptions)).toBeNull();
    events.emit(snapshot(ofKind("Event").filter((e) => (e as unknown as { involvedObject: { name: string } }).involvedObject.name === "default-abc12")));
    await expect.poll(() => toggle(BLOCKS.claimDisruptions)).not.toBeNull();
    expect(toggle(BLOCKS.claimDisruptions)!.textContent).toBe("Disruption events");
    expect(rows(`[data-block="${BLOCKS.claimDisruptions}"]`).map((r) => r.slice(0, 2))).toEqual([["Other", "DisruptionBlocked"]]);
    root.querySelector<HTMLButtonElement>('button[aria-label="Open Node ip-10-0-1-23.eu-west-1.compute.internal"]')!.click();
    root.querySelector<HTMLButtonElement>('button[aria-label="Open NodePool default"]')!.click();
    await expect.poll(() => opened.map((r) => r.kind.kind)).toEqual(["Node", "NodePool"]);
    // Closed, it stays (closed) and its events are not watched; open again, they are.
    toggle(BLOCKS.claimDisruptions)!.click();
    await expect.poll(() => watchOf("Event")).toBeUndefined();
    expect(toggle(BLOCKS.claimDisruptions)!.getAttribute("aria-expanded")).toBe("false");
    toggle(BLOCKS.claimDisruptions)!.click();
    await expect.poll(() => watchOf("Event")).toBeDefined();
  });

  it("looks once whether a closed disruption block has anything, and leaves it out when it has nothing", async () => {
    await open(obj("NodeClaim", "gpu-failed"), { contribution: "node-claim", blocks: { [BLOCKS.claimDisruptions]: false } });
    expect(phrases()[0]).toEqual(["danger", "Not launched: InsufficientCapacity."]);
    await expect.poll(() => watchOf("Event")).toBeDefined();
    watchOf("Event")!.emit(snapshot([]));
    await expect.poll(() => watchOf("Event")).toBeUndefined();
    expect(toggle(BLOCKS.claimDisruptions)).toBeNull();
    close();
    await open(obj("NodeClaim", "default-abc12"), { contribution: "node-claim", blocks: { [BLOCKS.claimDisruptions]: false } });
    await expect.poll(() => watchOf("Event")).toBeDefined();
    watchOf("Event")!.emit(snapshot(ofKind("Event").slice(0, 1)));
    await expect.poll(() => toggle(BLOCKS.claimDisruptions)).not.toBeNull();
    expect(toggle(BLOCKS.claimDisruptions)!.getAttribute("aria-expanded")).toBe("false");
    await expect.poll(() => watchOf("Event")).toBeUndefined();
  });

  it("says so when its events cannot be read", async () => {
    await open(obj("NodeClaim", "spot-joining"), { contribution: "node-claim" });
    expect(phrases()[0]).toEqual(["warning", "Launched, but the node has not joined the cluster: AwaitingReconciliation."]);
    await expect.poll(() => watchOf("Event")).toBeDefined();
    watchOf("Event")!.emit({ type: "forbidden", namespaces: [] });
    await expect.poll(() => root.querySelector(`[data-block="${BLOCKS.claimDisruptions}"] .sx-error`)?.textContent).toBe("The list could not be read.");
    expect(phrases().map((p) => p[1])).toContain("The node is being terminated.");
  });

  it("reads no NodePools where the cluster does not serve them", async () => {
    await open(obj("NodeClaim", "default-launching"), { contribution: "node-claim", kinds: [] });
    expect(phrases()[0]).toEqual(["warning", "Launching: no instance yet."]);
    await expect.poll(() => watchOf("Event")).toBeDefined();
    expect(watchOf("NodePool")).toBeUndefined();
  });

  it("speaks the UI language", async () => {
    await open(obj("NodeClaim", "default-init"), { contribution: "node-claim", language: "de" });
    expect(toggle(BLOCKS.claim)!.textContent).toBe("Start und Unterbrechung");
  });
});
