// The details sections, driven through the SDK's stand-in for Sextant's window, as the built-in view's tests drove them.
import type { KubeObject, WatchUpdate } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestWatch } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import fixtures from "../fixtures/objects.json";
import { BLOCKS, startDetails } from "./details";
import { setLanguage } from "./i18n";

const objects = fixtures as unknown as KubeObject[];
const obj = (kind: string, name: string): KubeObject => structuredClone(objects.find((o) => o.kind === kind && o.metadata.name === name)!);

const refOf = (o: KubeObject) => {
  const api = o.apiVersion ?? "";
  const [group, version] = api.includes("/") ? api.split("/") : ["", api];
  return { kind: { group: group!, version: version!, kind: o.kind ?? "" }, namespace: o.metadata.namespace ?? null, name: o.metadata.name };
};
const served = (group: string, version: string, kind: string) => ({ kindRef: { group, version, kind }, plural: `${kind.toLowerCase()}s`, namespaced: true, verbs: ["list", "watch"], printerColumns: [] });
const KINDS = [served("keda.sh", "v1alpha1", "ScaledObject"), served("autoscaling", "v2", "HorizontalPodAutoscaler")];

let host: TestHost;
let root: HTMLElement;
let stop: () => void = () => undefined;
let remembered: Record<string, boolean> = {};
let opened: { kind: { kind: string }; namespace: string | null; name: string }[] = [];

interface Options {
  contribution?: "scaled-object" | "scaled-job" | "trigger-authentication";
  language?: string;
  blocks?: Record<string, boolean>;
  kinds?: unknown[] | Error;
}

async function open(o: KubeObject, options: Options = {}): Promise<void> {
  const { contribution = "scaled-object", language = "en", blocks = {}, kinds = KINDS } = options;
  remembered = { ...blocks };
  opened = [];
  host = await startTestHost({
    context: { view: "details", contribution, selection: [refOf(o)], resourceVersion: "1", language, blocks: remembered },
    handlers: {
      "resources.get": () => structuredClone(o),
      kinds: () => {
        if (kinds instanceof Error) throw kinds;
        return kinds;
      },
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

afterEach(() => {
  setLanguage("en");
  stop();
  root?.remove();
  host?.close();
});

type Params = { kind: { group: string; kind: string }; namespaces?: string[]; fieldSelector?: string };
const params = (w: TestWatch) => w.params as Params;
const live = () => host.watches.filter((w) => !w.stopped);
const watchOf = (kind: string) => live().find((w) => params(w).kind.kind === kind);
const snapshot = (items: KubeObject[]): WatchUpdate => ({ type: "snapshot", items: items as never });
const text = () => root.textContent ?? "";
/** The phrases of the object's state: directly in its block, not in the managed HPA's. */
const phrases = () => [...root.querySelectorAll(":scope > [data-block] > .sx-block__body > .as-phrase")].map((p) => [p.className.replace("as-phrase as-phrase--", ""), p.textContent]);
const toggle = (id: string) => root.querySelector<HTMLButtonElement>(`[data-block="${id}"] .sx-block__toggle`)!;
const fieldsOf = (scope: ParentNode = root) => {
  const out: Record<string, string> = {};
  for (const dt of scope.querySelectorAll(".sx-fields__label")) out[dt.textContent ?? ""] = dt.nextElementSibling?.textContent ?? "";
  return out;
};
const rowsOf = (block: string) =>
  [...root.querySelectorAll(`[data-block="${block}"] tbody tr`)].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent ?? ""));

describe("details of a ScaledObject", () => {
  it("tells its state, fields and triggers, and the HPA KEDA manages by its name", async () => {
    await open(obj("ScaledObject", "orders"));
    expect(phrases()).toEqual([
      ["danger", "Trigger orders-queue failed 4 times in a row."],
      ["success", "Active: a trigger is above its activation threshold, so the HPA scales the target (replicas: 1–10)."],
    ]);
    expect(fieldsOf(root.querySelector(`[data-block="${BLOCKS.keda}"] .sx-block__body`)!)).toMatchObject({
      Target: "Deployment/orders",
      "Min–max": "1–10",
      "Polling interval": "15 seconds",
      "Cooldown period": "300 seconds",
      Fallback: "failure threshold: 3; fallback replicas: 6",
    });
    expect(rowsOf(BLOCKS.triggers)).toEqual([
      ["rabbitmq (orders-queue)", "queueName=ordersmode=QueueLengthvalue=20", "rabbit", "Failure (4)"],
      ["cron", "timezone=Europe/Berlinstart=0 8 * * *end=0 20 * * *desiredReplicas=3", "cluster-aws", "Happy"],
      ["rabbitmq", "queueName=returns", "", ""],
    ]);
    // The links open Sextant's details: the target, a TriggerAuthentication of the namespace, a cluster one.
    root.querySelector<HTMLButtonElement>('button[aria-label="Open Deployment orders"]')!.click();
    root.querySelector<HTMLButtonElement>('button[aria-label="Open TriggerAuthentication rabbit"]')!.click();
    root.querySelector<HTMLButtonElement>('button[aria-label="Open ClusterTriggerAuthentication cluster-aws"]')!.click();
    await expect.poll(() => opened.length).toBe(3);
    expect(opened.map((r) => [r.kind.kind, r.namespace, r.name])).toEqual([
      ["Deployment", "shop", "orders"],
      ["TriggerAuthentication", "shop", "rabbit"],
      ["ClusterTriggerAuthentication", null, "cluster-aws"],
    ]);
    // Until the HPA is there, it says so, as the built-in block did.
    expect(text()).toContain("The HPA keda-hpa-orders that KEDA manages for this ScaledObject is not there.");
    await expect.poll(() => watchOf("HorizontalPodAutoscaler")).toBeDefined();
    expect(params(watchOf("HorizontalPodAutoscaler")!)).toMatchObject({ kind: { group: "autoscaling", kind: "HorizontalPodAutoscaler" }, namespaces: ["shop"], fieldSelector: "metadata.name=keda-hpa-orders" });
    watchOf("HorizontalPodAutoscaler")!.emit(snapshot([obj("HorizontalPodAutoscaler", "keda-hpa-orders")]));
    await expect.poll(() => root.querySelector(".as-summary")).not.toBeNull();
    const summary = root.querySelector(".as-summary")!;
    expect(fieldsOf(summary)).toEqual({ HPA: "keda-hpa-orders", Replicas: "3 now, 3 desired", "Min–max": "1–10" });
    expect([...summary.querySelectorAll(".as-phrase")].map((p) => p.textContent)).toEqual([
      "Not scaling: the metrics cannot be read.",
      "The external metrics API (external.metrics.k8s.io) does not answer: no adapter (such as KEDA) serves it.",
    ]);
    expect([...summary.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent))).toEqual([
      ["External s0-rabbitmq-orders {scaledobject.keda.sh/name=orders}", "18", "20 (AverageValue)", "3 (within tolerance)"],
      ["External s1-cron-Europe-Berlin", "no value", "1 (AverageValue)", "no value"],
    ]);
  });

  it("watches the HPA only while its block is open, remembered in Sextant's memory", async () => {
    await open(obj("ScaledObject", "orders"));
    await expect.poll(() => watchOf("HorizontalPodAutoscaler")).toBeDefined();
    toggle(BLOCKS.managedHpa).focus();
    toggle(BLOCKS.managedHpa).click();
    await expect.poll(() => watchOf("HorizontalPodAutoscaler")).toBeUndefined();
    expect(remembered[BLOCKS.managedHpa]).toBe(false);
    // Drawn again, the focus stays on the toggle.
    expect(document.activeElement).toBe(toggle(BLOCKS.managedHpa));
    toggle(BLOCKS.managedHpa).click();
    await expect.poll(() => watchOf("HorizontalPodAutoscaler")).toBeDefined();
    // Closing the whole KEDA block stops it too, and "Collapse all" closes every block.
    host.setContext({ blocks: { "*": false } });
    await expect.poll(() => root.querySelector(`[data-block="${BLOCKS.triggers}"]`)).toBeNull();
    expect(watchOf("HorizontalPodAutoscaler")).toBeUndefined();
  });

  it("starts with the blocks Sextant remembers closed, and watches no HPA a cluster does not serve", async () => {
    await open(obj("ScaledObject", "orders"), { blocks: { [BLOCKS.managedHpa]: false }, kinds: [served("keda.sh", "v1alpha1", "ScaledObject")] });
    expect(toggle(BLOCKS.managedHpa).getAttribute("aria-expanded")).toBe("false");
    toggle(BLOCKS.managedHpa).click();
    await expect.poll(() => text()).toContain("is not there");
    await new Promise((r) => setTimeout(r, 20));
    expect(watchOf("HorizontalPodAutoscaler")).toBeUndefined();
  });

  it("watches the HPA at autoscaling/v2 when discovery cannot tell, as the built-in view did", async () => {
    await open(obj("ScaledObject", "orders"), { kinds: new Error("no discovery") });
    await expect.poll(() => watchOf("HorizontalPodAutoscaler")).toBeDefined();
  });

  it("explains a paused, a broken and an idle ScaledObject", async () => {
    await open(obj("ScaledObject", "held"));
    expect(phrases()).toEqual([["warning", "Paused by the annotation autoscaling.keda.sh/paused-replicas: the target is held at this replica count: 2."]]);
    expect(fieldsOf()).toMatchObject({ Target: "Deployment/web", "Min–max": "0–100", "Polling interval": "30 seconds" });
    stop();
    host.close();
    root.remove();
    await open(obj("ScaledObject", "broken"));
    expect(phrases()[0]).toEqual(["danger", "KEDA cannot scale this object (ScaledObjectCheckFailed): see the Ready condition and the events."]);
    expect(fieldsOf().Target).toBe("Rollout/checkout");
    stop();
    host.close();
    root.remove();
    await open(obj("ScaledObject", "idle"));
    expect(fieldsOf()).toMatchObject({ "Idle replicas": "0", "Min–max": "2–20", "Cooldown period": "120 seconds" });
    expect(text()).toContain("No triggers.");
  });

  it("speaks the UI language", async () => {
    await open(obj("ScaledObject", "orders"), { language: "de" });
    expect(root.querySelector(".sx-block__toggle")!.textContent).toBe("KEDA");
    expect(fieldsOf()["Abfrageintervall"]).toBeDefined();
  });
});

describe("details of a ScaledJob", () => {
  it("tells its state, maximum, strategy, image and triggers", async () => {
    await open(obj("ScaledJob", "importer"), { contribution: "scaled-job" });
    expect(phrases()).toEqual([["success", "Active: a trigger is above its activation threshold, so KEDA creates Jobs (maxReplicaCount: 5)."]]);
    expect(fieldsOf()).toMatchObject({ "Max replicas": "5", "Scaling strategy": "accurate", "Polling interval": "10 seconds", Image: "registry.example.com/importer:1.4" });
    expect(rowsOf(BLOCKS.triggers)).toEqual([["rabbitmq", "queueName=imports", "rabbit", ""]]);
    expect(host.watches).toEqual([]);
    stop();
    host.close();
    root.remove();
    await open(obj("ScaledJob", "nightly"), { contribution: "scaled-job" });
    expect(phrases()).toEqual([["neutral", "Inactive: no trigger is above its activation threshold, so no Jobs are created."]]);
    expect(fieldsOf()).toMatchObject({ "Max replicas": "100" });
    expect(fieldsOf().Image).toBeUndefined();
  });
});

describe("details of a TriggerAuthentication", () => {
  it("tells where its parameters come from, with links to the Secrets and ConfigMaps", async () => {
    await open(obj("TriggerAuthentication", "mixed"), { contribution: "trigger-authentication" });
    expect(root.querySelector(".sx-block__toggle")!.textContent).toBe("Where the parameters come from");
    expect(rowsOf(BLOCKS.auth)).toEqual([
      ["password", "Secret", "db", "password"],
      ["host", "ConfigMap", "db-settings", "host"],
      ["user", "env", "DB_USER", ""],
    ]);
    root.querySelector<HTMLButtonElement>('button[aria-label="Open Secret db"]')!.click();
    root.querySelector<HTMLButtonElement>('button[aria-label="Open ConfigMap db-settings"]')!.click();
    await expect.poll(() => opened.length).toBe(2);
    expect(opened.map((r) => [r.kind.kind, r.namespace, r.name])).toEqual([
      ["Secret", "shop", "db"],
      ["ConfigMap", "shop", "db-settings"],
    ]);
  });

  it("names a cluster one's Secrets without links, its pod identity, and an empty one", async () => {
    await open(obj("ClusterTriggerAuthentication", "cluster-aws"), { contribution: "trigger-authentication" });
    expect(fieldsOf()).toEqual({ "Pod identity": "aws" });
    expect(rowsOf(BLOCKS.auth)).toEqual([["awsRegion", "Secret", "aws-settings", "region"]]);
    expect(root.querySelector('button[aria-label="Open Secret aws-settings"]')).toBeNull();
    stop();
    host.close();
    root.remove();
    await open(obj("TriggerAuthentication", "empty"), { contribution: "trigger-authentication" });
    expect(text()).toContain("No parameter sources.");
    expect(root.querySelector("table")).toBeNull();
  });
});
