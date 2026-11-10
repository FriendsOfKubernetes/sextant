// Details of the other KServe kinds:
//   ServingRuntime / ClusterServingRuntime — the model formats it serves (version, auto-select, priority), protocols,
//                    whether disabled, multi-model or multi-node, and its containers' images;
//   InferenceGraph — its readiness, URL and nodes with their router type and steps (the root node first);
//   TrainedModel   — its InferenceService, framework, storage URI (never with credentials or a query) and memory.
import { ui, type KubeObject, type Sextant, type UiContent } from "@sextant/extension-sdk";
import { block, fieldsOf, link, OPEN_BLOCKS, tableOf, uri, type BlockMemory } from "./dom";
import { t } from "./i18n";
import { arr, conditionOf, deploymentModeOf, get, INFERENCE_SERVICE, num, record, SERVICE_TONE, str } from "./model";
import { formatsOf, isDisabled, isMultiModel, isMultiNode, protocolsOf } from "./runtimes";

const present = (nodes: (Node | null | false | undefined)[]): Node[] => nodes.filter((n): n is Node => Boolean(n));

/** Ready / Not ready / Progressing from a `Ready` condition (InferenceGraph, TrainedModel), why on hover when not ready. */
export function readyText(obj: KubeObject): HTMLElement {
  const ready = conditionOf(obj, "Ready");
  const value = ready?.status === "True" ? "ready" : ready?.status === "False" ? "notReady" : "progressing";
  const node = ui.status(t(`state.${value}`), SERVICE_TONE[value]);
  const why = ready?.status === "False" ? ready.message || ready.reason : undefined;
  if (why) node.title = why;
  return node;
}

export function runtimeView(sextant: Sextant, obj: KubeObject, memory: BlockMemory = OPEN_BLOCKS): Node[] {
  const yesNo = (v: boolean) => (v ? t("yes") : t("no"));
  const formats = formatsOf(obj).map((f) => [f.name, f.version ?? "", yesNo(f.autoSelect), f.priority === undefined ? "" : String(f.priority)]);
  const headers = ["name", "version", "autoSelect", "priority"].map((h) => t(`formats.${h}`));
  return present([
    fieldsOf([
      ["protocols", ui.chips(protocolsOf(obj))],
      ["disabled", yesNo(isDisabled(obj))],
      ["multiModel", yesNo(isMultiModel(obj))],
      ["multiNode", yesNo(isMultiNode(obj))],
      ["images", ui.chips(arr(get(obj, "spec", "containers")).map((c) => str(get(c, "image"))))],
    ]),
    block(memory, "formats", t("formats.title"), () => tableOf(sextant, "formats", headers, formats, t("formats.title"), [true, true, true, true])),
  ]);
}

/** The rows of a graph node's steps: name, target (a node, an InferenceService or a URL), weight, condition, dependency. */
function stepRows(sextant: Sextant, node: unknown, ns: string | null): UiContent[][] {
  return arr(get(node, "steps")).map((s, i) => {
    const nodeName = str(get(s, "nodeName"));
    const service = str(get(s, "serviceName"));
    const target = nodeName ? t("graph.toNode", { name: nodeName }) : service ? link(sextant, INFERENCE_SERVICE, service, ns) : uri(str(get(s, "serviceUrl")));
    const weight = num(get(s, "weight"));
    return [
      str(get(s, "name")) ?? String(i + 1),
      target ?? "",
      weight === undefined ? "" : String(weight),
      str(get(s, "condition")) ?? "",
      str(get(s, "dependency")) ?? "",
    ];
  });
}

export function graphView(sextant: Sextant, obj: KubeObject, memory: BlockMemory = OPEN_BLOCKS): Node[] {
  const ns = obj.metadata.namespace ?? null;
  const mode = deploymentModeOf(obj);
  const nodes = Object.entries(record(get(obj, "spec", "nodes"))).sort(([a], [b]) => (a === "root" ? -1 : b === "root" ? 1 : a.localeCompare(b)));
  const headers = ["step", "target", "weight", "condition", "dependency"].map((h) => t(`graph.${h}`));
  return present([
    fieldsOf([
      ["status", readyText(obj)],
      ["url", uri(str(get(obj, "status", "url")))],
      ["deploymentMode", mode ? t(`mode.${mode.mode}`, { value: mode.raw }) : null],
    ]),
    ...nodes.map(([name, node]) => {
      const title = t("graph.node", { name, type: str(get(node, "routerType")) ?? "" });
      // One id for every node, as the built-in blocks had: they open and close together.
      return block(memory, "graphNode", title, () => tableOf(sextant, "graphSteps", headers, stepRows(sextant, node, ns), title, [true, false, true, false, true]));
    }),
  ]);
}

export function trainedModelView(sextant: Sextant, obj: KubeObject): Node[] {
  const ns = obj.metadata.namespace ?? null;
  return present([
    fieldsOf([
      ["status", readyText(obj)],
      ["inferenceService", link(sextant, INFERENCE_SERVICE, str(get(obj, "spec", "inferenceService")), ns)],
      ["framework", str(get(obj, "spec", "model", "framework"))],
      ["storageUri", uri(str(get(obj, "spec", "model", "storageUri")))],
      ["memory", str(get(obj, "spec", "model", "memory"))],
      ["url", uri(str(get(obj, "status", "url")))],
    ]),
  ]);
}
