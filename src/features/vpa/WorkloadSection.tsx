// The "Vertical Pod Autoscaler" block of a Deployment's, StatefulSet's, DaemonSet's, ReplicaSet's, Job's or CronJob's
// details, next to right-sizing: the VPAs of its namespace that target it, each with its state, mode, an HPA that
// fights it, and its recommendation against this workload's template with what a pod created now would get. Draws
// nothing where the cluster serves no VPAs or none targets the workload. The VPAs and HPAs come from the shared
// namespace lists, only while the details are open.
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject, ObjectRef } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { Block, Fields, link, type FieldRow } from "../details";
import { StateCell } from "./columns";
import { useNamespaceHpas, useNamespaceVpas } from "./hooks";
import { isTargetKind, targetOf, targets, updateModeOf } from "./model";
import { ChangesTable, ConflictLines, ModeText } from "./ui";

const VPA_TYPE = { apiVersion: "autoscaling.k8s.io/v1", kind: "VerticalPodAutoscaler" };

const LABELS = "vpa:fields";
const TABLE_ID = "vpaWorkload";

export const workloadApplies = isTargetKind;

function rowsOf(vpa: KubeObject, namespace: string | null): FieldRow[] {
  return [
    ["vpa", link(VPA_TYPE, vpa.metadata?.name, namespace)],
    ["status", <StateCell key="s" obj={vpa} />],
    ["mode", updateModeOf(vpa)],
    ["modeExplained", <ModeText key="m" vpa={vpa} />],
  ];
}

export function VpaWorkloadSection({ clusterId, obj, objectRef }: DetailsSectionProps) {
  if (!obj || !objectRef.namespace || !isTargetKind(objectRef.kind)) return null;
  return <WorkloadVpas clusterId={clusterId} obj={obj} objectRef={objectRef} />;
}

function WorkloadVpas({ clusterId, obj, objectRef }: { clusterId: ClusterId; obj: KubeObject; objectRef: ObjectRef }) {
  const { t } = useTranslation();
  const namespace = objectRef.namespace;
  const vpaList = useNamespaceVpas(clusterId, namespace);
  const served = vpaList.served === true;
  const vpas = useMemo(
    () => vpaList.items.filter((v) => targets(targetOf(v), objectRef.kind, objectRef.name)).sort((a, b) => (a.metadata?.name ?? "").localeCompare(b.metadata?.name ?? "")),
    [vpaList.items, objectRef.kind, objectRef.name],
  );
  // The namespace's HPAs only while a VPA targets this workload (the autoscaling block shares the same list).
  const hpas = useNamespaceHpas(clusterId, namespace, served && vpas.length > 0);
  if (!served || vpas.length === 0) return null;
  return (
    <section className="vpa-section" aria-label={t("vpa:workload.title")}>
      <h3 className="vpa-section__title">{t("vpa:workload.title")}</h3>
      {vpas.length > 1 && <p className="vpa-note">{t("vpa:workload.several", { count: vpas.length })}</p>}
      {vpas.map((vpa) => (
        <Block key={vpa.metadata?.uid ?? vpa.metadata?.name}>
          <Fields rows={rowsOf(vpa, namespace)} labelPrefix={LABELS} />
          <ConflictLines vpa={vpa} hpas={hpas.items} target={obj} />
          <ChangesTable vpa={vpa} target={obj} id={TABLE_ID} />
        </Block>
      ))}
    </section>
  );
}
