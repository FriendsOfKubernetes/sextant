// Details of the GPU Operator kinds (section `gpuOperator`, #245) and the "GPU" block of Nodes:
//   ClusterPolicy — the state with the operator's message, where the operands run, the MIG strategy, and each
//                   component: enabled or not (the spec, else the operator's default), its DaemonSet in the operand
//                   namespace and how many of its pods are ready and updated;
//   NVIDIADriver  — the state with the message, the driver type and version, the nodes it selects, and the
//                   DaemonSets it owns;
//   Node ("GPU")  — the GPU labels (product, count, memory), the MIG configuration and its state, and the GPU and MIG
//                   resources' capacity and allocatable, read from the node itself (no watch).
// Read-only.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { StatusText } from "../../resources";
import { Block, Fields, link, mapChips, table, type ColumnWrap, type FieldRow } from "../details";
import { StateCell } from "./columns";
import { useOperandDaemonSets, type Listed } from "./hooks";
import {
  CLUSTER_POLICY,
  COMPONENT_TONE,
  componentsOf,
  driverByCrd,
  driverNodeSelectorOf,
  driverTypeOf,
  driverVersionOf,
  failureOf,
  gpuNodeOf,
  hasGpu,
  isKind,
  isRolledOut,
  migStateTone,
  migStrategyOf,
  NODE,
  NVIDIA_DRIVER,
  operandNamespaceOf,
  ownedDaemonSets,
  shownComponent,
  stateOf,
  type Rollout,
} from "./model";

const LABELS = "gpuoperator:fields";
const DS_TYPE = { apiVersion: "apps/v1", kind: "DaemonSet" };
const COMPONENT_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap", undefined];
const TWO_WRAP: ColumnWrap[] = ["nowrap", "nowrap"];
const THREE_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap"];
const COMPONENTS_TABLE = "gpuComponents";
const DRIVER_TABLE = "gpuDriverDaemonSets";
const AMOUNTS_TABLE = "gpuNodeAmounts";

function RolloutText({ rollout }: { rollout: Rollout }) {
  const { t } = useTranslation();
  const text = t("gpuoperator:components.rollout", { ready: rollout.ready, updated: rollout.updated, desired: rollout.desired });
  return <StatusText value={text} tone={isRolledOut(rollout) ? "success" : "warning"} />;
}

/** The operator's message when it is not ready, and what its state means. */
function StateNote({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const state = stateOf(obj);
  const failure = failureOf(obj);
  return (
    <>
      {state !== "ready" && failure?.message && <p className="gpu-message">{failure.message}</p>}
      {state !== "ready" && <p className="gpu-note">{t(`gpuoperator:hint.${state}`)}</p>}
    </>
  );
}

function ListNote({ list, namespace }: { list: Listed; namespace: string | undefined }) {
  const { t } = useTranslation();
  if (!namespace) return <p className="gpu-muted">{t("gpuoperator:components.noNamespace")}</p>;
  if (list.loading) return <p className="gpu-muted">{t("gpuoperator:loading")}</p>;
  if (list.unavailable) return <p className="gpu-muted">{t("gpuoperator:components.unavailable", { namespace })}</p>;
  if (list.truncated) return <p className="gpu-muted">{t("gpuoperator:components.truncated")}</p>;
  return null;
}

function PolicyView({ clusterId, policy }: { clusterId: ClusterId; policy: KubeObject }) {
  const { t } = useTranslation();
  const namespace = operandNamespaceOf(policy);
  const daemonSets = useOperandDaemonSets(clusterId, namespace);
  const strategy = migStrategyOf(policy);
  const rows: FieldRow[] = [
    ["state", <StateCell key="s" obj={policy} />],
    ["namespace", namespace ?? null],
    ["migStrategy", strategy ?? t("gpuoperator:fields.migStrategyUnset")],
    ["driver", driverByCrd(policy) ? t("gpuoperator:fields.driverByCrd") : null],
  ];
  const known = !daemonSets.loading && !daemonSets.unavailable;
  const components = componentsOf(policy, daemonSets.items).filter(shownComponent);
  const tableRows: ReactNode[][] = components.flatMap((row) => {
    const name = t(`gpuoperator:component.${row.def.id}`);
    const enabled = t(row.enabled ? "gpuoperator:components.on" : "gpuoperator:components.off");
    if (row.daemonSets.length === 0) {
      const state = known || row.state === "off" || row.state === "managedByDriver" ? t(`gpuoperator:components.state.${row.state}`) : t("gpuoperator:components.state.unknown");
      return [[name, enabled, <StatusText key="s" value={state} tone={known ? COMPONENT_TONE[row.state] : "muted"} />, row.def.daemonSet]];
    }
    return row.daemonSets.map((r) => [name, enabled, <RolloutText key="r" rollout={r} />, link(DS_TYPE, r.name, r.namespace)]);
  });
  const view = table(
    COMPONENTS_TABLE,
    [t("gpuoperator:components.component"), t("gpuoperator:components.enabled"), t("gpuoperator:components.status"), t("gpuoperator:components.daemonSet")],
    tableRows,
    COMPONENT_WRAP,
  );
  return (
    <>
      <Fields rows={rows} labelPrefix={LABELS} />
      <StateNote obj={policy} />
      <Block title={t("gpuoperator:components.title")}>
        {view}
        <ListNote list={daemonSets} namespace={namespace} />
      </Block>
    </>
  );
}

function DriverView({ clusterId, driver }: { clusterId: ClusterId; driver: KubeObject }) {
  const { t } = useTranslation();
  const namespace = operandNamespaceOf(driver);
  const daemonSets = useOperandDaemonSets(clusterId, namespace);
  const owned = ownedDaemonSets(driver, daemonSets.items);
  const rows: FieldRow[] = [
    ["state", <StateCell key="s" obj={driver} />],
    ["driverType", driverTypeOf(driver)],
    ["version", driverVersionOf(driver) ?? null],
    ["nodeSelector", mapChips(driverNodeSelectorOf(driver))],
    ["namespace", namespace ?? null],
  ];
  const view = table(
    DRIVER_TABLE,
    [t("gpuoperator:components.daemonSet"), t("gpuoperator:components.status")],
    owned.map((r) => [link(DS_TYPE, r.name, r.namespace), <RolloutText key="r" rollout={r} />]),
    TWO_WRAP,
  );
  return (
    <>
      <Fields rows={rows} labelPrefix={LABELS} />
      <StateNote obj={driver} />
      <Block title={t("gpuoperator:driver.daemonSets")}>
        {owned.length > 0 ? view : !daemonSets.loading && namespace && <p className="gpu-muted">{t("gpuoperator:driver.none")}</p>}
        <ListNote list={daemonSets} namespace={namespace} />
      </Block>
    </>
  );
}

export function GpuOperatorSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  if (!obj) return null;
  if (isKind(objectRef.kind, CLUSTER_POLICY)) return <PolicyView clusterId={clusterId} policy={obj} />;
  if (isKind(objectRef.kind, NVIDIA_DRIVER)) return <DriverView clusterId={clusterId} driver={obj} />;
  return null;
}

export const appliesTo = (kind: Parameters<typeof isKind>[0]): boolean => isKind(kind, CLUSTER_POLICY) || isKind(kind, NVIDIA_DRIVER);

/** The GPU and MIG resources of a node: resource, capacity, allocatable. */
export function AmountsTable({ node, id }: { node: KubeObject; id: string }) {
  const { t } = useTranslation();
  const rows = gpuNodeOf(node).amounts.map((a) => [a.resource, a.capacity ?? "", a.allocatable ?? ""]);
  if (rows.length === 0) return <p className="gpu-muted">{t("gpuoperator:node.noResources")}</p>;
  const view = table(id, [t("gpuoperator:node.resource"), t("gpuoperator:node.capacity"), t("gpuoperator:node.allocatable")], rows, THREE_WRAP);
  return <>{view}</>;
}

export function GpuNodeSection({ obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  if (!obj) return null;
  const gpu = gpuNodeOf(obj);
  if (!hasGpu(gpu)) return null;
  const rows: FieldRow[] = [
    ["product", gpu.product ?? null],
    ["count", gpu.count ?? null],
    ["memory", gpu.memory ? t("gpuoperator:node.memoryMiB", { value: gpu.memory }) : null],
    ["migConfig", gpu.migConfig ?? null],
    ["migState", gpu.migState ? <StatusText key="m" value={gpu.migState} tone={migStateTone(gpu.migState)} /> : null],
  ];
  return (
    <Block title={t("gpuoperator:node.title")}>
      <Fields rows={rows} labelPrefix={LABELS} />
      {gpu.migState === "failed" && <p className="gpu-message">{t("gpuoperator:node.migFailed", { config: gpu.migConfig ?? "" })}</p>}
      <AmountsTable node={obj} id={AMOUNTS_TABLE} />
    </Block>
  );
}

export const nodeApplies = (kind: Parameters<typeof isKind>[0]): boolean => isKind(kind, NODE);
