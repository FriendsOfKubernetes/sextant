// The details sections, driven through the SDK's stand-in for Sextant's window, as the built-in view's tests drove it.
import type { KubeObject, WatchUpdate } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestHostOptions, type TestWatch } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import objectsJson from "../fixtures/objects.json";
import { MAX_RUNTIMES, MAX_UNDERLYING, startDetails } from "./details";
import { setLanguage } from "./i18n";

const objects = objectsJson as unknown as KubeObject[];
const find = (kind: string, name: string): KubeObject => structuredClone(objects.find((o) => o.kind === kind && o.metadata.name === name)!);
const ofKind = (kind: string) => objects.filter((o) => o.kind === kind).map((o) => structuredClone(o));

const SECTION: Record<string, string> = {
  InferenceService: "inference-service",
  ServingRuntime: "serving-runtime",
  ClusterServingRuntime: "cluster-serving-runtime",
  InferenceGraph: "inference-graph",
  TrainedModel: "trained-model",
};

const ref = (o: KubeObject) => ({
  kind: { group: o.apiVersion!.split("/")[0]!, version: o.apiVersion!.split("/")[1]!, kind: o.kind! },
  namespace: o.metadata.namespace ?? null,
  name: o.metadata.name,
});

const SERVED = [
  ["serving.kserve.io", "v1beta1", "InferenceService"],
  ["serving.kserve.io", "v1alpha1", "ServingRuntime"],
  ["serving.kserve.io", "v1alpha1", "ClusterServingRuntime"],
  ["serving.knative.dev", "v1", "Service"],
  ["apps", "v1", "Deployment"],
  ["", "v1", "Service"],
] as const;
const kinds = (served: readonly (readonly [string, string, string])[]) =>
  served.map(([group, version, kind]) => ({ kindRef: { group, version, kind }, plural: `${kind.toLowerCase()}s`, namespaced: kind !== "ClusterServingRuntime", verbs: ["list", "watch"], printerColumns: [] }));

let host: TestHost;
let root: HTMLElement;
let stop: () => void = () => undefined;

async function open(obj: KubeObject, served: readonly (readonly [string, string, string])[] = SERVED, options: TestHostOptions = {}): Promise<void> {
  host = await startTestHost({
    context: { view: "details", contribution: SECTION[obj.kind!], selection: [ref(obj)], resourceVersion: "1", ...options.context },
    handlers: { "resources.get": () => structuredClone(obj), kinds: () => kinds(served), ...options.handlers },
  });
  root = document.createElement("main");
  document.body.append(root);
  stop = startDetails(host.sextant, root, SECTION[obj.kind!]!);
  await expect.poll(() => root.querySelector(".sx-loading")).toBeNull();
}

afterEach(() => {
  setLanguage("en");
  stop();
  root?.remove();
  host?.close();
});

const text = () => root.textContent ?? "";
const byLabel = (label: string) => [...root.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label") === label);
type Params = { kind: { group?: string; kind: string }; namespaces?: string[]; labelSelector?: string; metadataOnly?: boolean; maxObjects?: number };
const watchParams = (w: TestWatch) => w.params as Params;
const watchOf = (kind: string, group?: string) =>
  host.watches.find((w) => watchParams(w).kind.kind === kind && (group === undefined || watchParams(w).kind.group === group) && !w.stopped);
const snapshot = (items: KubeObject[]): WatchUpdate => ({ type: "snapshot", items: items as never });
const rows = () => [...root.querySelectorAll("tbody tr")].map((r) => r.textContent);

describe("details", () => {
  it("of an InferenceService: the canary split, the Knative Service KServe made and the runtime it chooses", async () => {
    await open(find("InferenceService", "sklearn-iris"));
    await expect.poll(() => watchOf("ClusterServingRuntime")).toBeDefined();
    expect(text()).toContain("Reading the serving runtimes…");
    expect(watchParams(watchOf("ServingRuntime")!)).toMatchObject({ namespaces: ["default"] });
    expect(watchParams(watchOf("ClusterServingRuntime")!).namespaces).toBeUndefined();
    const made = { namespaces: ["default"], labelSelector: "serving.kserve.io/inferenceservice=sklearn-iris", metadataOnly: true };
    expect(watchParams(watchOf("Service", "serving.knative.dev")!)).toMatchObject(made);
    expect(watchParams(watchOf("Deployment")!)).toMatchObject(made);
    expect(watchParams(watchOf("Service", "")!)).toMatchObject(made);
    watchOf("ServingRuntime")!.emit(snapshot(ofKind("ServingRuntime")));
    watchOf("ClusterServingRuntime")!.emit(snapshot(ofKind("ClusterServingRuntime")));
    watchOf("Service", "serving.knative.dev")!.emit(snapshot([find("Service", "sklearn-iris-predictor")]));
    await expect.poll(text).toContain("KServe chooses");
    expect(byLabel("Open ClusterServingRuntime kserve-sklearnserver")).toHaveLength(2);
    expect(byLabel("Open Service sklearn-iris-predictor")).toHaveLength(1);
    expect(text()).toContain("Knative (Serverless)");
    expect(rows()).toContain("sklearn-iris-predictor-0000210%latestYes");
    expect(rows()).toContain("sklearn-iris-predictor-0000190%prevNo");
    expect(root.querySelector(".sx-status--success")?.textContent).toBe("Ready");
    byLabel("Open Service sklearn-iris-predictor")[0]!.click();
    await expect.poll(() => host.calls.find((c) => c.method === "ui.openDetails")?.params).toEqual({
      kind: { group: "serving.knative.dev", version: "v1", kind: "Service" },
      namespace: "default",
      name: "sklearn-iris-predictor",
    });
  });

  it("of a failing InferenceService: the model's failure and a storage URI without its credentials", async () => {
    await open(find("InferenceService", "flowers"));
    expect(root.querySelectorAll(".ks-note--danger")[0]?.textContent).toBe("Failed to download model: 403 Forbidden");
    expect(text()).toContain("https://models.example.com/flowers.tar.gz");
    expect(text()).toContain("credentials and query hidden");
    expect(text()).not.toContain("s3cr3t");
    expect(text()).not.toContain("X-Amz-Signature");
    await expect.poll(() => watchOf("ClusterServingRuntime")).toBeDefined();
    watchOf("ClusterServingRuntime")!.emit(snapshot(ofKind("ClusterServingRuntime")));
    watchOf("ServingRuntime")!.emit(snapshot(ofKind("ServingRuntime")));
    await expect.poll(text).toMatch(/kserve-tensorflow-serving named in the spec does not exist/);
    expect(root.querySelector(".sx-status--danger")?.textContent).toBe("Failed");
  });

  it("tells when the runtimes cannot be read, are cut or are not served", async () => {
    await open(find("InferenceService", "sklearn-iris"));
    await expect.poll(() => watchOf("ClusterServingRuntime")).toBeDefined();
    watchOf("ServingRuntime")!.emit({ type: "forbidden", namespaces: ["default"] } as never);
    watchOf("ClusterServingRuntime")!.emit(snapshot(ofKind("ClusterServingRuntime")));
    await expect.poll(text).toContain("The serving runtimes cannot all be read, so the choice cannot be told.");
    stop();
    host.close();
    root.remove();

    const many = Array.from({ length: MAX_RUNTIMES + 1 }, (_, i) => ({ ...find("ClusterServingRuntime", "kserve-mlserver"), metadata: { name: `rt-${i}` } }));
    await open(find("InferenceService", "sklearn-iris"));
    await expect.poll(() => watchOf("ClusterServingRuntime")).toBeDefined();
    watchOf("ServingRuntime")!.emit(snapshot([]));
    watchOf("ClusterServingRuntime")!.emit(snapshot(many as KubeObject[]));
    await expect.poll(text).toContain("cannot be told");
    stop();
    host.close();
    root.remove();

    // Kept to MAX_RUNTIMES by Sextant, as the built-in watch was: more is "cannot be told".
    await open(find("InferenceService", "sklearn-iris"));
    await expect.poll(() => watchOf("ClusterServingRuntime")).toBeDefined();
    expect(watchParams(watchOf("ClusterServingRuntime")!).maxObjects).toBe(MAX_RUNTIMES);
    expect(watchParams(watchOf("ServingRuntime")!).maxObjects).toBe(MAX_RUNTIMES);
    for (const kind of ["Deployment", "Service"]) expect(watchParams(watchOf(kind)!).maxObjects).toBe(MAX_UNDERLYING);
    watchOf("ServingRuntime")!.emit(snapshot([]));
    watchOf("ClusterServingRuntime")!.emit(snapshot(ofKind("ClusterServingRuntime")));
    await expect.poll(text).toContain("KServe chooses");
    watchOf("ClusterServingRuntime")!.emit({ type: "capped", total: MAX_RUNTIMES + 20 } as never);
    await expect.poll(text).toContain("cannot be told");
    stop();
    host.close();
    root.remove();

    await open(find("InferenceService", "sklearn-iris"), [["serving.kserve.io", "v1beta1", "InferenceService"]]);
    await expect.poll(text).toContain("The cluster serves no ServingRuntime kinds.");
    expect(host.watches).toHaveLength(0);
  });

  it("of a stopped and a not-ready InferenceService", async () => {
    const stopped = find("InferenceService", "sklearn-iris");
    stopped.metadata.annotations = { "serving.kserve.io/stop": "true" };
    await open(stopped);
    expect(text()).toContain("The InferenceService is stopped on purpose: KServe removed what serves it.");
    expect(root.querySelector(".sx-status--muted")?.textContent).toBe("Stopped");
    stop();
    host.close();
    root.remove();
    await open(find("InferenceService", "torch-mnist"));
    expect(root.querySelector(".ks-note--warning")?.textContent).toBe("Ingress has not been configured yet");
    expect(text()).toContain("Not set: the cluster's default applies");
    expect(text()).toContain("Transformer");
  });

  it("of an InferenceGraph and a runtime", async () => {
    await open(find("InferenceGraph", "model-chainer"));
    expect(text()).toContain("Node root (Sequence)");
    expect(byLabel("Open InferenceService sklearn-iris")).toHaveLength(1);
    expect(text()).toContain("http://other.example.com/v1/models/x:predict");
    expect(text()).not.toContain("user:pw");
  });

  it("of a ClusterServingRuntime: its model formats", async () => {
    await open(find("ClusterServingRuntime", "kserve-mlserver"));
    expect(rows()).toContain("sklearn0Yes2");
    expect(host.watches).toHaveLength(0);
  });

  it("of a TrainedModel: its InferenceService and storage", async () => {
    await open(find("TrainedModel", "iris-v2"));
    expect(byLabel("Open InferenceService sklearn-iris")).toHaveLength(1);
    expect(root.querySelector(".sx-status--success")?.textContent).toBe("Ready");
  });

  it("in another language", async () => {
    setLanguage("ru");
    await open(find("InferenceService", "flowers"));
    expect(root.querySelector(".sx-status--danger")?.textContent).toBe("Сбой");
  });
});

describe("the blocks", () => {
  const toggles = () => [...root.querySelectorAll<HTMLButtonElement>(".sx-block__toggle")];
  const expanded = () => toggles().map((b) => [b.textContent, b.getAttribute("aria-expanded")]);
  const toggle = (title: string) => toggles().find((b) => b.textContent === title)!;
  /** Sextant's memory: `ui.setBlockOpen` writes it, the context tells it back, as the window does. */
  const remembering = (blocks: Record<string, boolean> = {}): TestHostOptions => ({
    context: { blocks },
    handlers: {
      "ui.setBlockOpen": ({ id, open }: { id: string; open: boolean }) => {
        blocks = { ...blocks, [id]: open };
        setTimeout(() => host.setContext({ blocks }));
        return null;
      },
    },
  });
  const setBlockOpen = () => host.calls.filter((c) => c.method === "ui.setBlockOpen").map((c) => c.params);
  const live = (kind: string, group?: string) => watchOf(kind, group) !== undefined;

  it("open and close with their titles in Sextant's own memory, the runtimes watched only while Serving runtime is open", async () => {
    await open(find("InferenceService", "sklearn-iris"), SERVED, remembering());
    await expect.poll(() => live("ClusterServingRuntime")).toBe(true);
    expect(expanded()).toEqual([
      ["Predictor", "true"],
      ["Model status", "true"],
      ["Serving runtime", "true"],
    ]);
    toggle("Serving runtime").focus();
    toggle("Serving runtime").click();
    await expect.poll(() => live("ClusterServingRuntime")).toBe(false);
    expect(live("ServingRuntime")).toBe(false);
    expect(expanded()).toEqual([
      ["Predictor", "true"],
      ["Model status", "true"],
      ["Serving runtime", "false"],
    ]);
    expect(text()).not.toContain("Reading the serving runtimes…");
    // Drawn again for the watches, the focus kept on the toggle.
    expect(document.activeElement).toBe(toggle("Serving runtime"));
    await expect.poll(setBlockOpen).toEqual([{ id: "choice", open: false }]);
    // Read again on a change: still closed.
    host.setContext({ resourceVersion: "2" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(expanded()[2]).toEqual(["Serving runtime", "false"]);
    expect(live("ClusterServingRuntime")).toBe(false);
    toggle("Serving runtime").click();
    await expect.poll(() => live("ClusterServingRuntime")).toBe(true);
    expect(text()).toContain("Reading the serving runtimes…");
  });

  it("watch what KServe made only while a component's block is open", async () => {
    await open(find("InferenceService", "torch-mnist"), SERVED, remembering({ "component.predictor": false }));
    await expect.poll(() => live("Deployment")).toBe(true);
    expect(expanded().slice(0, 2)).toEqual([
      ["Predictor", "false"],
      ["Transformer", "true"],
    ]);
    toggle("Transformer").click();
    await expect.poll(() => live("Deployment")).toBe(false);
    expect(live("Service", "")).toBe(false);
    expect(live("Service", "serving.knative.dev")).toBe(false);
    toggle("Predictor").click();
    await expect.poll(() => live("Deployment")).toBe(true);
    expect(setBlockOpen()).toEqual([
      { id: "component.transformer", open: false },
      { id: "component.predictor", open: true },
    ]);
  });

  it("start as Sextant remembers them, and follow the panel's Expand all and Collapse all", async () => {
    await open(find("InferenceService", "flowers"), SERVED, remembering({ modelStatus: false }));
    expect(expanded()).toEqual([
      ["Predictor", "true"],
      ["Model status", "false"],
      ["Serving runtime", "true"],
    ]);
    host.setContext({ blocks: { "*": false } });
    await expect.poll(expanded).toEqual([
      ["Predictor", "false"],
      ["Model status", "false"],
      ["Serving runtime", "false"],
    ]);
    await expect.poll(() => live("ClusterServingRuntime")).toBe(false);
    host.setContext({ blocks: { "*": false, choice: true } });
    await expect.poll(expanded).toEqual([
      ["Predictor", "false"],
      ["Model status", "false"],
      ["Serving runtime", "true"],
    ]);
    host.setContext({ blocks: { "*": true } });
    await expect.poll(expanded).toEqual([
      ["Predictor", "true"],
      ["Model status", "true"],
      ["Serving runtime", "true"],
    ]);
    expect(setBlockOpen()).toEqual([]);
  });

  it("of a runtime and a graph: the formats, and every node's block together, as the built-in ones", async () => {
    await open(find("ClusterServingRuntime", "kserve-mlserver"), SERVED, remembering({ formats: false }));
    expect(expanded()).toEqual([["Model formats", "false"]]);
    expect(rows()).toEqual([]);
    toggle("Model formats").click();
    await expect.poll(rows).toContain("sklearn0Yes2");
    stop();
    host.close();
    root.remove();
    await open(find("InferenceGraph", "model-chainer"), SERVED, remembering());
    expect(expanded()).toEqual([
      ["Node root (Sequence)", "true"],
      ["Node split (Splitter)", "true"],
    ]);
    toggle("Node split (Splitter)").click();
    await expect.poll(expanded).toEqual([
      ["Node root (Sequence)", "false"],
      ["Node split (Splitter)", "false"],
    ]);
    await expect.poll(setBlockOpen).toEqual([{ id: "graphNode", open: false }]);
  });
});
