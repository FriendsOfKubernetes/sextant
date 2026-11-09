// The model and the manifest's declarative parts. The manifest's problem rules, the InferenceService's "Only problems"
// and the columns are judged here by Sextant's own window engine (src/extensions/problemRules.ts and columns.tsx,
// loaded at run time so the type check stays inside the extension) and compared with the model they replace — the
// reading of Sextant's former built-in view (ADR-0115), ported unchanged — on its fixtures and variants of them.
import type { KubeObject } from "@sextant/extension-sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import objectsJson from "../fixtures/objects.json";
import en from "./locales/en.json";
import {
  canaryPercent,
  cleanText,
  CLUSTER_SERVING_RUNTIME,
  componentsOf,
  conditionOf,
  deploymentModeOf,
  failingCondition,
  INFERENCE_GRAPH,
  INFERENCE_SERVICE,
  INVALID_SPEC_GRACE_MS,
  isProblem,
  KSERVE_GRACE_MS,
  kserveProblems,
  recordedRuntimeOf,
  safeUri,
  SERVICE_TONE,
  serviceReason,
  serviceState,
  SERVING_RUNTIME,
  TRAINED_MODEL,
  type Detected,
  type KindRef,
} from "./model";
import { chooseRuntime, formatsOf, isDisabled, protocolsOf } from "./runtimes";

const objects = objectsJson as unknown as KubeObject[];
const copy = <T>(value: T): T => structuredClone(value);
const byName = (kind: string, name: string): KubeObject => copy(objects.find((o) => o.kind === kind && o.metadata.name === name)!);
const isvc = (name: string) => byName("InferenceService", name);
const clusterRuntimes = () => objects.filter((o) => o.kind === "ClusterServingRuntime").map(copy);
const nsRuntimes = () => objects.filter((o) => o.kind === "ServingRuntime").map(copy);
type Cond = { type: string; status: string; reason?: string; message?: string; lastTransitionTime?: string };
const st = (o: KubeObject) => o.status as Record<string, unknown> & { conditions: Cond[] };
const failure = (o: KubeObject) => (st(o).modelStatus as { lastFailureInfo: Record<string, unknown> }).lastFailureInfo;

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

  it("cleans every URI shape: whitespace, a `/` in the password, a single slash, cloud schemes", () => {
    const shown = (v: string) => safeUri(v)?.text;
    expect(safeUri("https://u:tok@models.example.com/m\n")).toEqual({ text: "https://models.example.com/m", hidden: true });
    expect(shown("  https://u:tok@models.example.com/m")).toBe("https://models.example.com/m");
    expect(shown("https://user:pa/ss@models.example.com/m.tar.gz")).toBe("https://models.example.com/m.tar.gz");
    expect(shown("https://user:p@ss@models.example.com/m")).toBe("https://models.example.com/m");
    expect(shown("https:/u:tok@h/model")).toBe("https:/h/model");
    expect(shown("s3://AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI%2FK7MDENG@bucket/p")).toBe("s3://bucket/p");
    expect(shown("gs://key:secret@bucket/p?x=1#y")).toBe("gs://bucket/p");
    expect(shown("u:tok@host/model")).toBe("host/model");
    expect(shown("https://user:pass\nword@h/p")).toBe("https://h/p");
    for (const clean of ["gs://kfserving-examples/models/sklearn/1.0/model", "s3://bucket/model", "pvc://claim/model", "hf://org/model", "https://h/p"])
      expect(safeUri(clean)).toEqual({ text: clean, hidden: false });
    expect(safeUri("   ")).toBeUndefined();
  });

  it("cleans the URIs inside free text from the cluster", () => {
    expect(cleanText("Failed to download s3://AKIA:wJalr@bucket/m?X-Amz-Signature=abc: 403")).toBe("Failed to download s3://bucket/m 403");
    expect(cleanText('fetch "https://u:hf_tok@huggingface.co/m?token=1" failed; from u:pw@registry/x')).toBe('fetch "https://huggingface.co/m" failed; from registry/x');
    expect(cleanText("0/3 nodes are available: 3 Insufficient cpu.")).toBe("0/3 nodes are available: 3 Insufficient cpu.");
    const leaky = isvc("torch-mnist");
    st(leaky).conditions.find((c) => c.type === "IngressReady")!.message = "cannot reach https://admin:s3cr3t@ingress.example.com/?sig=xyz";
    expect(kserveProblems(INFERENCE_SERVICE, leaky).map((d) => d.message ?? "").join()).not.toMatch(/s3cr3t|sig=xyz/);
    expect(serviceReason(leaky)).not.toContain("s3cr3t");
  });

  it("an invalid spec is a failure with KServe's reason, counted after a short grace", () => {
    const invalid = isvc("llm-invalid");
    expect(serviceState(invalid)).toBe("failed");
    expect(serviceReason(invalid)).toBe("Specified runtime does not support specified framework/version");
    expect(kserveProblems(INFERENCE_SERVICE, invalid)).toEqual([
      expect.objectContaining({ reason: "NoSupportingRuntime", group: "invalidSpec", graceMs: INVALID_SPEC_GRACE_MS, since: undefined, notify: true }),
    ]);
  });

  it("checks a named runtime's protocol only when the predictor sets one", () => {
    const [predictor] = componentsOf(isvc("sklearn-iris"));
    const named = { ...predictor!, runtime: "kserve-mlserver", protocolVersion: undefined };
    expect(chooseRuntime(named, nsRuntimes(), clusterRuntimes())).toMatchObject({ kind: "chosen", runtime: { name: "kserve-mlserver", cluster: true }, named: true });
    expect(chooseRuntime({ ...named, protocolVersion: "v1" }, nsRuntimes(), clusterRuntimes())).toMatchObject({ kind: "namedProtocol" });
    const auto = chooseRuntime({ ...predictor!, protocolVersion: undefined }, nsRuntimes(), clusterRuntimes());
    expect(auto.kind === "chosen" && auto.candidates.map((c) => c.name)).toEqual(["kserve-sklearnserver"]);
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
    stopped.metadata.annotations = { "serving.kserve.io/stop": "true" };
    expect(serviceState(stopped)).toBe("stopped");
    expect(kserveProblems(INFERENCE_SERVICE, stopped)).toEqual([]);
  });

  it("chooses the runtime as KServe does: protocol, auto-select, disabled, priority, namespace before cluster", () => {
    const [predictor] = componentsOf(isvc("sklearn-iris"));
    const v1 = chooseRuntime(predictor!, nsRuntimes(), clusterRuntimes());
    expect(v1).toMatchObject({ kind: "chosen", runtime: { name: "kserve-sklearnserver", cluster: true }, named: false });
    const v2 = chooseRuntime({ ...predictor!, protocolVersion: "v2" }, nsRuntimes(), clusterRuntimes());
    expect(v2).toMatchObject({ kind: "chosen", runtime: { name: "kserve-mlserver" }, candidates: [{ name: "kserve-mlserver" }, { name: "kserve-sklearnserver" }] });
    const team = nsRuntimes().map((r) => ({ ...r, spec: { ...(r.spec as object), disabled: false } }));
    expect(chooseRuntime(predictor!, team, clusterRuntimes())).toMatchObject({ runtime: { name: "team-sklearn-old", cluster: false } });
    expect(chooseRuntime({ ...predictor!, format: { name: "sklearn", version: "0" } }, [], clusterRuntimes())).toMatchObject({ kind: "none" });
    expect(chooseRuntime({ ...predictor!, format: { name: "sklearn", version: "0" }, protocolVersion: "v2" }, [], clusterRuntimes())).toMatchObject({
      runtime: { name: "kserve-mlserver" },
    });
    expect(chooseRuntime({ ...predictor!, runtime: "nope" }, nsRuntimes(), clusterRuntimes()).kind).toBe("namedMissing");
    expect(chooseRuntime({ ...predictor!, runtime: "team-sklearn-old" }, nsRuntimes(), clusterRuntimes()).kind).toBe("namedDisabled");
    const manual = clusterRuntimes().map((r) => (r.metadata.name === "kserve-sklearnserver" ? { ...r, spec: { ...(r.spec as object), supportedModelFormats: [{ name: "sklearn" }] } } : r));
    expect(chooseRuntime(predictor!, [], manual)).toMatchObject({ kind: "none" });
    expect(chooseRuntime({ ...predictor!, runtime: "kserve-sklearnserver" }, [], manual)).toMatchObject({ kind: "chosen", named: true });
    expect(chooseRuntime({ ...predictor!, workers: true }, [], clusterRuntimes()).kind).toBe("none");
  });
});

// ---------- Sextant's window engine ----------

interface Verdict {
  holds: boolean;
  activeFrom?: number;
  until?: number;
}
interface WindowDetected {
  reason: string;
  group: string;
  message?: string;
  since?: string;
  graceMs?: number;
  notify?: boolean;
}
interface Engine {
  evaluate(condition: unknown, obj: KubeObject): Verdict;
  detectRule(rule: unknown, obj: KubeObject): WindowDetected[];
}
interface WindowColumn {
  value(obj: KubeObject): unknown;
  render(obj: KubeObject, ctx: { now: number }): unknown;
  searchText(obj: KubeObject, ctx: { now: number; t: (key: string, values?: { count?: number }) => string }): string | null | undefined;
}
interface Columns {
  computedColumn(id: string, column: unknown): WindowColumn;
}
let engine: Engine;
let columns: Columns;
const here = dirname(fileURLToPath(import.meta.url));
beforeAll(async () => {
  engine = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/problemRules.ts"))) as Engine;
  columns = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/columns.tsx"))) as Columns;
});

const holdsNow = (condition: unknown, obj: KubeObject) => {
  const v = engine.evaluate(condition, obj);
  return v.holds && v.activeFrom === undefined && v.until === undefined;
};

const sameKind = (a: { group: string; kind: string }, b: { group: string; kind: string }) => a.group === b.group && a.kind === b.kind;

/** The problems the manifest's rules find in `obj`, as the window finds them. */
const windowProblems = (kind: KindRef, obj: KubeObject): WindowDetected[] =>
  manifest.contributes.problems.filter((r) => sameKind(r.kind, kind)).flatMap((rule) => engine.detectRule(rule, obj));

/** The built-in notification groups, as the rules' groups. */
const BUILT_IN_GROUPS: Record<string, string> = { invalidSpec: "invalid-spec", modelLoad: "model-load", notReady: "not-ready" };

const shape = (d: Detected | WindowDetected) => ({
  reason: d.reason,
  message: d.message ?? "",
  since: d.since,
  graceMs: d.graceMs,
  group: d.group && BUILT_IN_GROUPS[d.group] ? BUILT_IN_GROUPS[d.group] : d.group,
});

function expectSameProblems(obj: KubeObject, label: string): void {
  const expected = kserveProblems(INFERENCE_SERVICE, obj).map(shape);
  expect(windowProblems(INFERENCE_SERVICE, obj).map(shape), label).toEqual(expected);
}

/** The conditions KServe writes, in the order their failure explains the others. */
const CAUSES = [
  "PredictorReady",
  "TransformerReady",
  "ExplainerReady",
  "PredictorConfigurationReady",
  "TransformerConfigurationReady",
  "ExplainerConfigurationReady",
  "LatestDeploymentReady",
  "CanaryPredictorReady",
  "PredictorRouteReady",
  "TransformerRouteReady",
  "ExplainerRoutesReady",
  "RoutesReady",
  "IngressReady",
];

/** A not-ready InferenceService whose False conditions are `falses` (Ready False besides), each with a reason. */
function notReadyBy(falses: string[], withReason = true): KubeObject {
  const o = isvc("torch-mnist");
  st(o).conditions = [
    ...CAUSES.map((type) =>
      falses.includes(type)
        ? { type, status: "False", lastTransitionTime: "2026-10-22T12:00:00Z", message: `${type} is down`, ...(withReason ? { reason: `${type}Reason` } : {}) }
        : { type, status: "True", lastTransitionTime: "2026-10-22T10:00:00Z" },
    ),
    { type: "Ready", status: "False", lastTransitionTime: "2026-10-22T12:00:10Z", reason: "ReadyReason", message: "not ready" },
  ];
  return o;
}

/** Variants of the fixtures the rules, filter and columns are compared on (none hits a known difference). */
function services(): [string, KubeObject][] {
  const list: [string, KubeObject][] = ["sklearn-iris", "flowers", "torch-mnist", "llm-invalid"].map((n) => [n, isvc(n)]);
  const add = (label: string, o: KubeObject) => list.push([label, o]);
  const timedInvalid = isvc("llm-invalid");
  failure(timedInvalid).time = "2026-10-22T13:00:02Z";
  add("invalid with a time", timedInvalid);
  const invalidUnnamed = isvc("llm-invalid");
  delete failure(invalidUnnamed).reason;
  add("invalid without a reason", invalidUnnamed);
  const invalidEmpty = isvc("llm-invalid");
  failure(invalidEmpty).reason = "";
  add("invalid with an empty reason", invalidEmpty);
  const loadUnnamed = isvc("flowers");
  delete failure(loadUnnamed).reason;
  add("load failed without a reason", loadUnnamed);
  for (const [field, value] of [
    ["activeModelState", "FailedToLoad"],
    ["targetModelState", "FailedToLoad"],
    ["transitionStatus", "BlockedByFailedLoad"],
  ]) {
    const o = isvc("torch-mnist");
    const states = { activeModelState: "Loaded", targetModelState: "" };
    st(o).modelStatus = { transitionStatus: "UpToDate", states, lastFailureInfo: { reason: "ModelLoadFailed", message: "OOM", time: "2026-10-22T12:00:00Z" } };
    if (field === "transitionStatus") (st(o).modelStatus as Record<string, unknown>).transitionStatus = value;
    else (states as Record<string, string>)[field!] = value!;
    add(`load failed by ${field}`, o);
  }
  const stoppedByAnnotation = isvc("flowers");
  stoppedByAnnotation.metadata.annotations = { ...stoppedByAnnotation.metadata.annotations, "serving.kserve.io/stop": "true" };
  add("stopped by annotation", stoppedByAnnotation);
  const notStopped = isvc("flowers");
  notStopped.metadata.annotations = { ...notStopped.metadata.annotations, "serving.kserve.io/stop": "false" };
  add("stop annotation false", notStopped);
  const stoppedByCondition = isvc("torch-mnist");
  st(stoppedByCondition).conditions.push({ type: "Stopped", status: "True", lastTransitionTime: "2026-10-22T12:00:00Z" });
  add("stopped by condition", stoppedByCondition);
  const deleting = isvc("flowers");
  deleting.metadata.deletionTimestamp = "2026-10-22T12:30:00Z";
  add("deleting", deleting);
  for (const [i, cause] of CAUSES.entries()) {
    add(`not ready by ${cause}`, notReadyBy([cause]));
    // A later cause False too: the earlier one explains it.
    if (i + 1 < CAUSES.length) add(`not ready by ${cause} and ${CAUSES[CAUSES.length - 1]}`, notReadyBy([cause, CAUSES[CAUSES.length - 1]!]));
  }
  add("not ready by Explainer and Predictor", notReadyBy(["ExplainerReady", "PredictorReady"]));
  add("not ready, nothing else False", notReadyBy([]));
  const unnamedReady = notReadyBy([]);
  delete st(unnamedReady).conditions.find((c) => c.type === "Ready")!.reason;
  add("not ready, Ready without a reason", unnamedReady);
  const noMessage = notReadyBy(["IngressReady"]);
  delete st(noMessage).conditions.find((c) => c.type === "IngressReady")!.message;
  add("not ready, no message", noMessage);
  const fresh = isvc("torch-mnist");
  delete (fresh as { status?: unknown }).status;
  add("no status", fresh);
  const readyUnknown = isvc("torch-mnist");
  st(readyUnknown).conditions = [{ type: "Ready", status: "Unknown" }];
  add("Ready unknown", readyUnknown);
  return list;
}

describe("the problem rules, against the built-in category kserve", () => {
  it("find what the built-in detector found, with its reason, message, start and grace", () => {
    for (const [label, o] of services()) expectSameProblems(o, label);
    // Every rule may notify, as every built-in one did; only InferenceServices are judged.
    for (const rule of manifest.contributes.problems) {
      expect((rule as { notify?: boolean }).notify).toBeUndefined();
      expect(rule.kind).toEqual({ group: "serving.kserve.io", kind: "InferenceService" });
    }
  });

  it("a model that failed to load at once, not ready after a grace with the failing condition", () => {
    const flowers = windowProblems(INFERENCE_SERVICE, isvc("flowers"));
    expect(flowers.map((d) => [d.reason, d.graceMs])).toEqual([
      ["ModelLoadFailed", undefined],
      ["ContainerNotReady", KSERVE_GRACE_MS],
    ]);
    expect(flowers[0]?.message).toBe("Failed to download model: 403 Forbidden");
    expect(flowers[1]?.message).toBe("storage-initializer: CrashLoopBackOff");
    expect(windowProblems(INFERENCE_SERVICE, isvc("torch-mnist"))).toMatchObject([{ reason: "IngressNotConfigured", since: "2026-10-22T12:00:10Z", graceMs: KSERVE_GRACE_MS }]);
    expect(windowProblems(INFERENCE_SERVICE, isvc("sklearn-iris"))).toEqual([]);
    expect(windowProblems(INFERENCE_SERVICE, isvc("llm-invalid"))).toMatchObject([{ reason: "NoSupportingRuntime", graceMs: INVALID_SPEC_GRACE_MS }]);
  });

  it("never shows a URI's credentials in a message", () => {
    const leaky = isvc("torch-mnist");
    st(leaky).conditions.find((c) => c.type === "IngressReady")!.message = "cannot reach https://admin:s3cr3t@ingress.example.com/?sig=xyz";
    const [problem] = windowProblems(INFERENCE_SERVICE, leaky);
    expect(problem!.message).toBe("cannot reach https://ingress.example.com/");
  });

  it("differs where a False condition gives no reason: the rule's title stands for the built-in `<type>False`", () => {
    for (const cause of CAUSES) {
      const o = notReadyBy([cause], false);
      expect(kserveProblems(INFERENCE_SERVICE, o)[0]!.reason).toBe(`${cause}False`);
      const [found] = windowProblems(INFERENCE_SERVICE, o);
      expect(found!.reason).toBe(`InferenceService not ready: ${cause} is False`);
      expect(shape({ ...found!, reason: `${cause}False` })).toEqual(shape(kserveProblems(INFERENCE_SERVICE, o)[0]!));
    }
    // A False condition of a type KServe's list does not name: the built-in told it, the rules tell Ready.
    const odd = notReadyBy([]);
    st(odd).conditions.push({ type: "LocalModelReady", status: "False", reason: "Downloading" });
    expect(kserveProblems(INFERENCE_SERVICE, odd)[0]!.reason).toBe("Downloading");
    expect(windowProblems(INFERENCE_SERVICE, odd)[0]!.reason).toBe("ReadyReason");
  });
});

// ---------- "Only problems" ----------

describe("the InferenceServices' Only problems, against the built-in filter", () => {
  it("shows the same objects", () => {
    const when = manifest.contributes.kinds.find((k) => k.kind === "InferenceService")!.problemWhen;
    for (const [label, o] of services()) expect(holdsNow(when, o), label).toBe(isProblem(o, INFERENCE_SERVICE));
    for (const kind of manifest.contributes.kinds.filter((k) => k.kind !== "InferenceService")) expect((kind as { problemWhen?: unknown }).problemWhen).toBeUndefined();
  });
});

// ---------- The columns ----------

type Column = (typeof manifest.contributes.columns)[number];
const columnOf = (id: string) => manifest.contributes.columns.find((c) => c.id === id)! as Column;
const windowColumn = (id: string) => columns.computedColumn(`ext:sextant.kserve:${id}`, columnOf(id));
const T = (key: string, values?: { count?: number }) => `${key}:${values?.count ?? ""}`;
const NOW = Date.parse("2026-10-22T14:00:00Z");
/** A cell's text, as the window searches and copies it. */
const cell = (id: string, obj: KubeObject) => windowColumn(id).searchText(obj, { now: NOW, t: T }) ?? undefined;
interface Drawn {
  title?: string;
  tone?: string;
}
/** A cell as drawn: its hover and its status tone. */
function drawn(id: string, obj: KubeObject): Drawn {
  let node = windowColumn(id).render(obj, { now: NOW }) as { props?: { title?: string; tone?: string; children?: unknown } } | null;
  const title = node?.props?.title;
  if (title !== undefined) node = node!.props!.children as typeof node;
  return { title: title || undefined, tone: node?.props?.tone };
}
const toneOf = (tone: string) => (tone === "muted" ? "neutral" : tone);
const predictorOf = (o: KubeObject) => componentsOf(o).find((c) => c.name === "predictor");

function runtimes(): KubeObject[] {
  const many = byName("ClusterServingRuntime", "kserve-mlserver");
  (many.spec as Record<string, unknown>).supportedModelFormats = ["a", "b", "c", "d", "e", "f"].map((name) => ({ name }));
  const four = byName("ClusterServingRuntime", "kserve-mlserver");
  (four.spec as Record<string, unknown>).supportedModelFormats = ["a", "b", "c", "d"].map((name) => ({ name }));
  (four.spec as Record<string, unknown>).protocolVersions = ["v1", "v2", "grpc-v1", "grpc-v2"];
  const none = byName("ServingRuntime", "team-sklearn-old");
  delete (none.spec as Record<string, unknown>).supportedModelFormats;
  delete (none.spec as Record<string, unknown>).protocolVersions;
  return [...clusterRuntimes(), ...nsRuntimes(), four, none, many];
}

describe("the columns, against the built-in ones", () => {
  it("are placed after the name or namespace, in the built-in order, with the CRDs' own columns left out", () => {
    for (const kind of manifest.contributes.kinds) expect(kind.printerColumns).toBe(false);
    const ids = (k: string) => manifest.contributes.columns.filter((c) => c.kind.kind === k).map((c) => [c.afterColumn, c.id]);
    expect(ids("InferenceService")).toEqual([
      ["namespace", "isvc-status"],
      ["isvc-status", "isvc-url"],
      ["isvc-url", "isvc-model-format"],
      ["isvc-model-format", "isvc-runtime"],
      ["isvc-runtime", "isvc-mode"],
      ["isvc-mode", "isvc-canary"],
    ]);
    expect(ids("ClusterServingRuntime")[0]).toEqual(["name", "csr-formats"]);
    expect(ids("ServingRuntime")[0]).toEqual(["namespace", "sr-formats"]);
    expect(ids("InferenceGraph")).toEqual([
      ["namespace", "graph-status"],
      ["graph-status", "graph-url"],
    ]);
  });

  it("of InferenceServices: state, URL without credentials, model format, runtime, mode, canary share", () => {
    for (const [label, o] of services()) {
      const state = serviceState(o);
      expect(cell("isvc-status", o), label).toBe(en[`state.${state}` as keyof typeof en]);
      expect(drawn("isvc-status", o).tone, label).toBe(toneOf(SERVICE_TONE[state]));
      expect(cell("isvc-url", o), label).toBe(safeUri((st(o)?.url as string | undefined) ?? undefined)?.text);
      const f = predictorOf(o)?.format;
      expect(cell("isvc-model-format", o), label).toBe(f ? [f.name, f.version].filter(Boolean).join(":") : undefined);
      expect(cell("isvc-runtime", o), label).toBe(predictorOf(o)?.runtime ?? recordedRuntimeOf(o)?.name);
      expect(cell("isvc-mode", o), label).toBe(deploymentModeOf(o)?.raw);
      const canary = canaryPercent(o);
      expect(cell("isvc-canary", o), label).toBe(canary === undefined ? undefined : String(canary));
    }
    const leaky = isvc("sklearn-iris");
    st(leaky).url = "https://u:tok@sklearn-iris.default.example.com/?sig=1";
    expect(cell("isvc-url", leaky)).toBe("https://sklearn-iris.default.example.com/");
  });

  it("the state's hover is the built-in one where the failing condition is the predictor's, a component's, the ingress or Ready", () => {
    const told = ["flowers", "torch-mnist", "llm-invalid", "sklearn-iris"].map((n) => isvc(n));
    for (const cause of ["PredictorReady", "TransformerReady", "ExplainerReady", "LatestDeploymentReady", "IngressReady"]) told.push(notReadyBy([cause]));
    told.push(notReadyBy([]));
    for (const o of told) expect(drawn("isvc-status", o).title, o.metadata.name).toBe(serviceReason(o));
    // Elsewhere it is Ready's message (the built-in one named the first False condition in KServe's order).
    const config = notReadyBy(["PredictorConfigurationReady"]);
    expect(serviceReason(config)).toBe("PredictorConfigurationReady is down");
    expect(drawn("isvc-status", config).title).toBe("not ready");
    expect(failingCondition(config)?.type).toBe("PredictorConfigurationReady");
  });

  it("of the old framework fields: the framework's name", () => {
    for (const framework of ["sklearn", "xgboost", "tensorflow", "pytorch", "triton", "onnx", "huggingface", "pmml", "lightgbm"]) {
      const o = isvc("sklearn-iris");
      o.spec = { predictor: { [framework]: { storageUri: "gs://x/model" } } };
      expect(cell("isvc-model-format", o)).toBe(framework);
    }
    const versioned = isvc("sklearn-iris");
    (versioned.spec as { predictor: { model: { modelFormat: Record<string, string> } } }).predictor.model.modelFormat.version = "1";
    expect(cell("isvc-model-format", versioned)).toBe("sklearn:1");
  });

  it("of runtimes: formats, protocols, disabled and multi-model", () => {
    for (const o of runtimes()) {
      const prefix = o.kind === "ServingRuntime" ? "sr" : "csr";
      const names = formatsOf(o).map((f) => f.name).filter(Boolean);
      const shown = names.length > 4 ? `${names.slice(0, 4).join(", ")}, …` : names.join(", ");
      expect(cell(`${prefix}-formats`, o), o.metadata.name).toBe(shown || undefined);
      expect(cell(`${prefix}-protocols`, o), o.metadata.name).toBe(protocolsOf(o).join(", ") || undefined);
      expect(cell(`${prefix}-disabled`, o)).toBe(isDisabled(o) ? "True" : "False");
      expect(cell(`${prefix}-multi-model`, o)).toBe((o.spec as Record<string, unknown>).multiModel === true ? "True" : "False");
    }
  });

  it("of InferenceGraphs and TrainedModels: readiness with its reason, URL, InferenceService, framework", () => {
    const graph = byName("InferenceGraph", "model-chainer");
    const model = byName("TrainedModel", "iris-v2");
    const variants = (o: KubeObject): KubeObject[] => {
      const notReady = copy(o);
      st(notReady).conditions = [{ type: "Ready", status: "False", reason: "Waiting", message: "waiting for https://u:p@h/x" }];
      const noMessage = copy(o);
      st(noMessage).conditions = [{ type: "Ready", status: "False", reason: "Waiting", message: "" }];
      const unknown = copy(o);
      st(unknown).conditions = [];
      return [o, notReady, noMessage, unknown];
    };
    for (const [prefix, list] of [
      ["graph", variants(graph)],
      ["trained-model", variants(model)],
    ] as const) {
      for (const o of list) {
        const ready = conditionOf(o, "Ready");
        const value = ready?.status === "True" ? "ready" : ready?.status === "False" ? "notReady" : "progressing";
        expect(cell(`${prefix}-status`, o)).toBe(en[`state.${value}` as keyof typeof en]);
        expect(drawn(`${prefix}-status`, o)).toEqual({ title: ready?.status === "False" ? ready.message || ready.reason : undefined, tone: toneOf(SERVICE_TONE[value]) });
      }
    }
    expect(cell("graph-url", graph)).toBe(safeUri(st(graph).url as string)?.text);
    expect(cell("trained-model-inference-service", model)).toBe((model.spec as { inferenceService: string }).inferenceService);
    expect(cell("trained-model-framework", model)).toBe((model.spec as { model: { framework: string } }).model.framework);
  });
});

// ---------- The manifest ----------

describe("the manifest", () => {
  it("lists the five kinds in the section kserve with the built-in icons, each with a details section of its own", () => {
    expect(manifest.contributes.kinds.map((k) => [k.kind, k.section, k.order, k.icon])).toEqual([
      ["InferenceService", "kserve", 10, "inferenceService"],
      ["ServingRuntime", "kserve", 20, "servingRuntime"],
      ["ClusterServingRuntime", "kserve", 21, "clusterServingRuntime"],
      ["InferenceGraph", "kserve", 30, "inferenceGraph"],
      ["TrainedModel", "kserve", 40, "trainedModel"],
    ]);
    expect(manifest.contributes.sections).toEqual([{ section: "kserve", title: "KServe", icon: "kserve", after: "kueue" }]);
    const kinds: Record<string, KindRef> = {
      "inference-service": INFERENCE_SERVICE,
      "serving-runtime": SERVING_RUNTIME,
      "cluster-serving-runtime": CLUSTER_SERVING_RUNTIME,
      "inference-graph": INFERENCE_GRAPH,
      "trained-model": TRAINED_MODEL,
    };
    for (const section of manifest.contributes.detailsSections) {
      expect(section.kinds).toEqual([{ group: kinds[section.id]!.group, kind: kinds[section.id]!.kind }]);
      expect(section.order).toBe(20);
    }
    expect(manifest.contributes.sectionBadges).toEqual([{ section: "kserve", label: { one: "{{count}} InferenceService needs attention", other: "{{count}} InferenceServices need attention" } }]);
  });

  it("asks to read only: KServe's kinds and what KServe makes", () => {
    expect(manifest.permissions.rules.map((r) => r.actions)).toEqual([["read"]]);
    expect("actions" in manifest.contributes).toBe(false);
    expect(manifest.permissions.rules[0]!.kinds.kinds).toEqual([
      { group: "serving.kserve.io", kind: "InferenceService" },
      { group: "serving.kserve.io", kind: "ServingRuntime" },
      { group: "serving.kserve.io", kind: "ClusterServingRuntime" },
      { group: "serving.kserve.io", kind: "InferenceGraph" },
      { group: "serving.kserve.io", kind: "TrainedModel" },
      { group: "serving.knative.dev", kind: "Service" },
      { group: "apps", kind: "Deployment" },
      { group: "", kind: "Service" },
    ]);
  });
});
