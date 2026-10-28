// Details of the other KServe kinds:
//   ServingRuntime / ClusterServingRuntime — the model formats it serves (version, auto-select, priority), protocols,
//                    whether disabled, multi-model or multi-node, and its containers' images;
//   InferenceGraph — its readiness, URL and nodes with their router type and steps (the root node first);
//   TrainedModel   — its InferenceService, framework, storage URI (never with credentials or a query) and memory.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { KubeObject } from "../../api";
import { status } from "../../resources";
import { Block, chips, Fields, link, table, type ColumnWrap, type FieldRow } from "../details";
import { ReadyText } from "./columns";
import { deploymentModeOf } from "./model";
import { ISVC_TYPE, LABELS, uri } from "./parts";
import { formatsOf, isDisabled, isMultiModel, isMultiNode, protocolsOf } from "./runtimes";

const { arr, get, num, record, str } = status;

const FORMAT_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap", "nowrap"];
const STEP_WRAP: ColumnWrap[] = ["nowrap", undefined, "nowrap", undefined, "nowrap"];

export function RuntimeView({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const yesNo = (v: boolean) => (v ? t("kserve:yes") : t("kserve:no"));
  const rows: FieldRow[] = [
    ["protocols", chips(protocolsOf(obj))],
    ["disabled", yesNo(isDisabled(obj))],
    ["multiModel", yesNo(isMultiModel(obj))],
    ["multiNode", yesNo(isMultiNode(obj))],
    ["images", chips(arr(get(obj, "spec", "containers")).map((c) => str(get(c, "image"))))],
  ];
  const formats = formatsOf(obj).map((f) => [f.name, f.version ?? "", yesNo(f.autoSelect), f.priority === undefined ? "" : String(f.priority)]);
  const formatsTable = table(
    "kserveFormats",
    [t("kserve:formats.name"), t("kserve:formats.version"), t("kserve:formats.autoSelect"), t("kserve:formats.priority")],
    formats,
    FORMAT_WRAP,
  );
  return (
    <>
      <Fields rows={rows} labelPrefix={LABELS} />
      <Block id="kserve:formats.title" title={t("kserve:formats.title")}>{formatsTable}</Block>
    </>
  );
}

/** The rows of a graph node's steps: name, target (a node, an InferenceService or a URL), weight, condition, dependency. */
function stepRows(node: unknown, ns: string | null, t: TFunction): ReactNode[][] {
  return arr(get(node, "steps")).map((s, i) => {
    const nodeName = str(get(s, "nodeName"));
    const service = str(get(s, "serviceName"));
    const target = nodeName ? t("kserve:graph.toNode", { name: nodeName }) : service ? link(ISVC_TYPE, service, ns) : uri(str(get(s, "serviceUrl")));
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

export function GraphView({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const mode = deploymentModeOf(obj);
  const rows: FieldRow[] = [
    ["status", <ReadyText key="s" obj={obj} />],
    ["url", uri(str(get(obj, "status", "url")))],
    ["deploymentMode", mode ? t(`kserve:mode.${mode.mode}`, { value: mode.raw }) : null],
  ];
  const nodes = Object.entries(record(get(obj, "spec", "nodes"))).sort(([a], [b]) => (a === "root" ? -1 : b === "root" ? 1 : a.localeCompare(b)));
  const blocks = nodes.map(([name, node]) => ({
    name,
    title: t("kserve:graph.node", { name, type: str(get(node, "routerType")) ?? "" }),
    steps: table(
      "kserveGraphSteps",
      [t("kserve:graph.step"), t("kserve:graph.target"), t("kserve:graph.weight"), t("kserve:graph.condition"), t("kserve:graph.dependency")],
      stepRows(node, ns, t),
      STEP_WRAP,
    ),
  }));
  return (
    <>
      <Fields rows={rows} labelPrefix={LABELS} />
      {blocks.map((b) => (
        <Block key={b.name} id="graphNode" title={b.title}>
          {b.steps}
        </Block>
      ))}
    </>
  );
}

export function TrainedModelView({ obj }: { obj: KubeObject }) {
  const ns = obj.metadata?.namespace ?? null;
  const rows: FieldRow[] = [
    ["status", <ReadyText key="s" obj={obj} />],
    ["inferenceService", link(ISVC_TYPE, str(get(obj, "spec", "inferenceService")), ns)],
    ["framework", str(get(obj, "spec", "model", "framework"))],
    ["storageUri", uri(str(get(obj, "spec", "model", "storageUri")))],
    ["memory", str(get(obj, "spec", "model", "memory"))],
    ["url", uri(str(get(obj, "status", "url")))],
  ];
  return <Fields rows={rows} labelPrefix={LABELS} />;
}
