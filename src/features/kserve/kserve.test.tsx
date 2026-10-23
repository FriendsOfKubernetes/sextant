import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings, type AppSettings, type KindRef, type KubeObject, type ObjectRef, type ResourceKind } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { Sidebar } from "../../layout/sidebar/Sidebar";
import { getResourceDef, resetClusterKinds } from "../../resources";
import { axeViolations } from "../../test/axe";
import "../details";
import { copy, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore } from "../namespaces";
import { categoryOf, detect, OPT_IN_CATEGORIES, PROBLEM_CATEGORIES, resolve } from "../problems/model";
import { CATEGORY_SOURCES } from "../problems/sources";
import { resetProblemSources } from "../problems/store";
import { resetSharedWatches } from "../resource-map/watches";
import objectsJson from "./fixtures/objects.json";
import "./index";
import {
  canaryPercent,
  CLUSTER_SERVING_RUNTIME,
  componentsOf,
  deploymentModeOf,
  INFERENCE_GRAPH,
  INFERENCE_SERVICE,
  KSERVE_GRACE_MS,
  safeUri,
  SERVING_RUNTIME,
  serviceState,
  TRAINED_MODEL,
} from "./model";
import { chooseRuntime } from "./runtimes";

const objects = objectsJson as KubeObject[];
const byName = (kind: string, name: string): KubeObject => copy(objects.find((o) => o.kind === kind && o.metadata?.name === name)!);
const isvc = (name: string) => byName("InferenceService", name);
const clusterRuntimes = () => objects.filter((o) => o.kind === "ClusterServingRuntime").map(copy);
const nsRuntimes = () => objects.filter((o) => o.kind === "ServingRuntime").map(copy);

describe("the model", () => {
  it("never shows credentials, a query or a fragment of a URI", () => {
    expect(safeUri("https://reader:s3cr3t@models.example.com/flowers.tar.gz?X-Amz-Signature=abc123")).toEqual({
      text: "https://models.example.com/flowers.tar.gz",
      hidden: true,
    });
    expect(safeUri("gs://kfserving-examples/models/sklearn/1.0/model")).toEqual({ text: "gs://kfserving-examples/models/sklearn/1.0/model", hidden: false });
    expect(safeUri("s3://bucket/model#frag")).toEqual({ text: "s3://bucket/model", hidden: true });
    expect(safeUri("hf://org/model?revision=main")?.text).toBe("hf://org/model");
    expect(safeUri("not a uri?token=1")).toEqual({ text: "not a uri", hidden: true });
    expect(safeUri(undefined)).toBeUndefined();
  });

  it("reads the components, deployment mode, canary share and state", () => {
    const iris = isvc("sklearn-iris");
    expect(serviceState(iris)).toBe("ready");
    expect(componentsOf(iris).map((c) => [c.name, c.format?.name, c.canaryTrafficPercent])).toEqual([["predictor", "sklearn", 10]]);
    expect(deploymentModeOf(iris)).toEqual({ mode: "knative", raw: "Serverless" });
    expect(canaryPercent(iris)).toBe(10);
    expect(deploymentModeOf(isvc("flowers"))?.mode).toBe("standard");
    expect(deploymentModeOf(isvc("torch-mnist"))).toBeUndefined();
    expect(serviceState(isvc("flowers"))).toBe("failed");
    expect(serviceState(isvc("torch-mnist"))).toBe("notReady");
    expect(componentsOf(isvc("torch-mnist")).map((c) => c.name)).toEqual(["predictor", "transformer"]);
    const legacy = copy(iris);
    legacy.spec = { predictor: { sklearn: { storageUri: "gs://x/model" } } };
    expect(componentsOf(legacy)[0]).toMatchObject({ format: { name: "sklearn" }, storageUri: "gs://x/model" });
    const stopped = copy(iris);
    stopped.metadata!.annotations = { "serving.kserve.io/stop": "true" };
    expect(serviceState(stopped)).toBe("stopped");
    expect(detect(INFERENCE_SERVICE, stopped)).toEqual([]);
  });

  it("chooses the runtime as KServe does: protocol, auto-select, disabled, priority, namespace before cluster", () => {
    const [predictor] = componentsOf(isvc("sklearn-iris"));
    // v1: the MLServer speaks v2 only; the namespace's runtime is disabled.
    const v1 = chooseRuntime(predictor!, nsRuntimes(), clusterRuntimes());
    expect(v1).toMatchObject({ kind: "chosen", runtime: { name: "kserve-sklearnserver", cluster: true }, named: false });
    // v2: both fit; MLServer's sklearn priority (2) is higher.
    const v2 = chooseRuntime({ ...predictor!, protocolVersion: "v2" }, nsRuntimes(), clusterRuntimes());
    expect(v2).toMatchObject({ kind: "chosen", runtime: { name: "kserve-mlserver" }, candidates: [{ name: "kserve-mlserver" }, { name: "kserve-sklearnserver" }] });
    // A namespace runtime that fits comes before every cluster runtime, whatever the priorities.
    const team = nsRuntimes().map((r) => ({ ...r, spec: { ...(r.spec as object), disabled: false } }));
    expect(chooseRuntime(predictor!, team, clusterRuntimes())).toMatchObject({ runtime: { name: "team-sklearn-old", cluster: false } });
    // A format version only a runtime lists.
    expect(chooseRuntime({ ...predictor!, format: { name: "sklearn", version: "0" } }, [], clusterRuntimes())).toMatchObject({ kind: "none" });
    expect(chooseRuntime({ ...predictor!, format: { name: "sklearn", version: "0" }, protocolVersion: "v2" }, [], clusterRuntimes())).toMatchObject({
      runtime: { name: "kserve-mlserver" },
    });
    // Named runtimes: missing, disabled, and auto-select does not matter then.
    expect(chooseRuntime({ ...predictor!, runtime: "nope" }, nsRuntimes(), clusterRuntimes()).kind).toBe("namedMissing");
    expect(chooseRuntime({ ...predictor!, runtime: "team-sklearn-old" }, nsRuntimes(), clusterRuntimes()).kind).toBe("namedDisabled");
    const manual = clusterRuntimes().map((r) => (r.metadata?.name === "kserve-sklearnserver" ? { ...r, spec: { ...(r.spec as object), supportedModelFormats: [{ name: "sklearn" }] } } : r));
    expect(chooseRuntime(predictor!, [], manual)).toMatchObject({ kind: "none" });
    expect(chooseRuntime({ ...predictor!, runtime: "kserve-sklearnserver" }, [], manual)).toMatchObject({ kind: "chosen", named: true });
    // A multi-node predictor needs a runtime with workers.
    expect(chooseRuntime({ ...predictor!, workers: true }, [], clusterRuntimes()).kind).toBe("none");
  });

  it("problems: a model that failed to load at once, not ready after a grace with the failing condition", () => {
    const flowers = detect(INFERENCE_SERVICE, isvc("flowers"));
    expect(flowers.map((d) => [d.reason, d.graceMs])).toEqual([
      ["ModelLoadFailed", undefined],
      ["ContainerNotReady", KSERVE_GRACE_MS],
    ]);
    expect(flowers[0]?.message).toBe("Failed to download model: 403 Forbidden");
    expect(flowers[1]?.message).toBe("storage-initializer: CrashLoopBackOff");
    const [ingress] = resolve(INFERENCE_SERVICE, isvc("torch-mnist"), Date.parse("2026-10-22T12:01:00Z"));
    expect(ingress).toMatchObject({ reason: "IngressNotConfigured", activeAt: Date.parse("2026-10-22T12:00:10Z") + KSERVE_GRACE_MS });
    expect(detect(INFERENCE_SERVICE, isvc("sklearn-iris"))).toEqual([]);
  });

  it("the category: on by default, InferenceServices only; the tables and the filter", () => {
    expect(PROBLEM_CATEGORIES).toContain("kserve");
    expect(OPT_IN_CATEGORIES).not.toContain("kserve");
    expect(categoryOf(INFERENCE_SERVICE)).toBe("kserve");
    expect(categoryOf(SERVING_RUNTIME)).toBeUndefined();
    expect(CATEGORY_SOURCES.kserve.map((s) => s.kind.kind)).toEqual(["InferenceService"]);
    const def = getResourceDef(INFERENCE_SERVICE);
    expect(def.columns.map((c) => c.id)).toEqual(["name", "namespace", "status", "url", "modelFormat", "runtime", "mode", "canary", "age"]);
    expect(def.columns.find((c) => c.id === "runtime")!.value(isvc("sklearn-iris"))).toBe("kserve-sklearnserver");
    expect(def.problem?.(isvc("flowers"))).toBe(true);
    expect(def.problem?.(isvc("sklearn-iris"))).toBe(false);
    expect(getResourceDef(CLUSTER_SERVING_RUNTIME).columns.map((c) => c.id)).not.toContain("namespace");
  });
});

// ---------- In the app ----------

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const KSVC: KindRef = { group: "serving.knative.dev", version: "v1", kind: "Service" };
const served = (kind: KindRef, namespaced = true): ResourceKind => ({ kindRef: kind, plural: `${kind.kind.toLowerCase()}s`, namespaced, verbs: ["list", "watch"], printerColumns: [] });

let wb: WatchBackend;
let discovery: KindRef[];
let stored: AppSettings;

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetProblemSources();
  resetSharedWatches();
  resetSettingsCache();
  resetNamespaceRestore();
  discovery = [POD, INFERENCE_SERVICE, SERVING_RUNTIME, CLUSTER_SERVING_RUNTIME, INFERENCE_GRAPH, TRAINED_MODEL, KSVC];
  stored = defaultAppSettings();
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => discovery.map((k) => served(k, k !== CLUSTER_SERVING_RUNTIME)));
  wb.backend.on("settings_get", () => structuredClone(stored));
  wb.backend.on("settings_update", (args) => {
    stored = structuredClone(args.settings as AppSettings);
    return structuredClone(stored);
  });
});

afterEach(() => {
  wb.backend.restore();
  resetClusterKinds();
  resetProblemSources();
  resetSharedWatches();
  resetSettingsCache();
});

const sections = () =>
  screen
    .getAllByRole("button")
    .filter((b) => b.hasAttribute("aria-expanded"))
    .map((b) => b.textContent);

describe("the KServe section", () => {
  it("is there for a cluster that serves the kinds and counts the failing InferenceServices", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("KServe"));
    emitSnapshot(wb, await watchOf(wb, "InferenceService"), [isvc("sklearn-iris"), isvc("flowers"), isvc("torch-mnist")]);
    // flowers' model failed to load, torch-mnist has not been ready for longer than the grace: one count each.
    await waitFor(() => expect(screen.getByTitle("2 InferenceServices need attention")).toHaveTextContent("2"));
  });

  it("is not there without the CRDs", async () => {
    discovery = [POD];
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Workloads"));
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(true));
    expect(sections()).not.toContain("KServe");
  });
});

function refTo(obj: KubeObject): ObjectRef {
  const version = obj.apiVersion?.split("/")[1] ?? "v1";
  return { kind: { group: "serving.kserve.io", version, kind: obj.kind ?? "" }, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
}

async function openDetails(obj: KubeObject): Promise<HTMLElement> {
  const ref = refTo(obj);
  useAppStore.getState().openDetails(ref);
  const { container } = render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  emitSnapshot(wb, await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`), [obj]);
  await waitFor(() => expect(document.querySelector("[data-section='kserve']")).not.toBeNull());
  return container;
}

const view = () => within(document.querySelector<HTMLElement>("[data-section='kserve']")!);

describe("details", () => {
  it("of an InferenceService: the canary split, the Knative Service KServe made and the runtime it chooses", async () => {
    const container = await openDetails(isvc("sklearn-iris"));
    emitSnapshot(wb, await watchOf(wb, "ServingRuntime"), nsRuntimes());
    emitSnapshot(wb, await watchOf(wb, "ClusterServingRuntime"), clusterRuntimes());
    emitSnapshot(wb, await watchOf(wb, "Service", (s) => s.kind.group === "serving.knative.dev" && s.labelSelector === "serving.kserve.io/inferenceservice=sklearn-iris"), [
      byName("Service", "sklearn-iris-predictor"),
    ]);
    const v = view();
    await waitFor(() => expect(v.getByText("KServe chooses")).toBeInTheDocument());
    expect(v.getAllByRole("button", { name: "Open ClusterServingRuntime kserve-sklearnserver" }).length).toBe(2);
    expect(v.getByRole("button", { name: "Open Service sklearn-iris-predictor" })).toBeInTheDocument();
    expect(v.getByText("Knative (Serverless)")).toBeInTheDocument();
    const rows = v.getAllByRole("row").map((r) => r.textContent);
    expect(rows).toContain("sklearn-iris-predictor-0000210%latestYes");
    expect(rows).toContain("sklearn-iris-predictor-0000190%prevNo");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("of a failing InferenceService: the model's failure and a storage URI without its credentials", async () => {
    const container = await openDetails(isvc("flowers"));
    const v = view();
    expect(v.getAllByText("Failed to download model: 403 Forbidden").length).toBeGreaterThan(0);
    expect(v.getByText("https://models.example.com/flowers.tar.gz")).toBeInTheDocument();
    expect(v.getByText("credentials and query hidden")).toBeInTheDocument();
    expect(container.textContent).not.toContain("s3cr3t");
    expect(container.textContent).not.toContain("X-Amz-Signature");
    emitSnapshot(wb, await watchOf(wb, "ClusterServingRuntime"), clusterRuntimes());
    emitSnapshot(wb, await watchOf(wb, "ServingRuntime"), nsRuntimes());
    await waitFor(() => expect(v.getByText(/kserve-tensorflow-serving named in the spec does not exist/)).toBeInTheDocument());
    expect(await axeViolations(container)).toEqual([]);
  });

  it("of an InferenceGraph and a runtime", async () => {
    const container = await openDetails(byName("InferenceGraph", "model-chainer"));
    const v = view();
    expect(v.getByText("Node root (Sequence)")).toBeInTheDocument();
    expect(v.getByRole("button", { name: "Open InferenceService sklearn-iris" })).toBeInTheDocument();
    expect(v.getByText("http://other.example.com/v1/models/x:predict")).toBeInTheDocument();
    expect(container.textContent).not.toContain("user:pw");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("of a ClusterServingRuntime: its model formats", async () => {
    const container = await openDetails(byName("ClusterServingRuntime", "kserve-mlserver"));
    const rows = view().getAllByRole("row").map((r) => r.textContent);
    expect(rows).toContain("sklearn0Yes2");
    expect(await axeViolations(container)).toEqual([]);
  });
});
