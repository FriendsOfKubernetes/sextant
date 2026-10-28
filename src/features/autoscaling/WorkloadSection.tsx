// The "Autoscaling" details of a Deployment, StatefulSet or ReplicaSet scaled by an HPA or a KEDA ScaledObject: who
// sets its replicas, the HPA's verdict, the ScaledObject's state, and a warning when two HPAs fight over it. Draws
// nothing for a workload nothing scales. The HPAs (and ScaledObjects, where KEDA is installed) of the workload's
// namespace come from the shared namespace watches.
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject, ObjectRef } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { UNKNOWN_DETAILS_SOURCE, useDisclosureProbe, useDisclosureProbeResult, watchProbeResult } from "../details/disclosureProbe";
import { ErrorState } from "../../components";
import { useClusterKinds } from "../../resources";
import { status } from "../../resources";
import { Block, Fields, link, type FieldRow } from "../details";
import { HpaSummary } from "./HpaSection";
import { useSharedList } from "./hooks";
import { kedaState, scaleTargetOf } from "./keda";
import { HPA, phrase, SCALED_OBJECT } from "./model";
import { PhraseLine, Phrases } from "./ui";

const { get, str } = status;
const FIELDS = "autoscaling:fields";
const SCALED_OBJECT_TYPE = { apiVersion: "keda.sh/v1alpha1", kind: "ScaledObject" };
const MANUAL_SCALE = phrase("workload.manualScale", undefined, "muted");

export function WorkloadAutoscalingSection({ clusterId, obj, objectRef }: DetailsSectionProps) {
  if (!obj || !objectRef.namespace) return null;
  return <WorkloadAutoscaling clusterId={clusterId} obj={obj} objectRef={objectRef} />;
}

function WorkloadAutoscaling({ clusterId, obj, objectRef }: { clusterId: ClusterId; obj: KubeObject; objectRef: ObjectRef }) {
  const { t } = useTranslation();
  const probe = useDisclosureProbe("autoscaling:title");
  const { enabled, result } = probe;
  const discovery = useClusterKinds(clusterId);
  const namespace = objectRef.namespace;
  const name = obj.metadata?.name;
  const kind = objectRef.kind.kind;
  const hpaList = useSharedList(clusterId, HPA, namespace, enabled);
  const soList = useSharedList(clusterId, SCALED_OBJECT, namespace, enabled);
  const hpas = useMemo(
    () =>
      hpaList.items.filter(
        (h) => str(get(h, "spec", "scaleTargetRef", "kind")) === kind && str(get(h, "spec", "scaleTargetRef", "name")) === name,
      ),
    [hpaList.items, kind, name],
  );
  const scaledObjects = useMemo(
    () =>
      soList.items.filter((so) => {
        const target = scaleTargetOf(so);
        return target?.kind === kind && target.name === name;
      }),
    [soList.items, kind, name],
  );
  const hasSources = hpas.length > 0 || scaledObjects.length > 0;
  const sources = [hpaList, soList];
  const answer = sources.some(source => source.served === undefined) ? null : watchProbeResult(hasSources, sources.filter(source => source.served).map(source => source.state));
  const outcome = answer === "absent" && discovery.error ? "unknown" : answer;
  const view = useDisclosureProbeResult(probe, outcome);
  if (!probe.open && result) return view.visible ? <Block id="autoscaling:title" title={t("autoscaling:title")}>{null}</Block> : null;
  const error = hpaList.state?.error ?? soList.state?.error ?? discovery.error;
  if (!view.visible && !error) return null;
  const conflict = hpas.length > 1 ? phrase("workload.conflict", { count: hpas.length }, "danger") : null;
  const soRows = (so: KubeObject): FieldRow[] => [["scaledObject", link(SCALED_OBJECT_TYPE, so.metadata?.name, namespace)]];

  return (
    <Block id="autoscaling:title" title={t("autoscaling:title")}>
      {conflict && <PhraseLine phrase={conflict} />}
      {scaledObjects.map((so) => (
        <div key={so.metadata?.uid ?? so.metadata?.name} className="as-summary">
          <Fields labelPrefix={FIELDS} rows={soRows(so)} />
          <Phrases phrases={kedaState(so).phrases} />
        </div>
      ))}
      {hpas.map((hpa) => (
        <HpaSummary key={hpa.metadata?.uid ?? hpa.metadata?.name} hpa={hpa} />
      ))}
      {error || outcome === "unknown" ? <ErrorState error={error ?? UNKNOWN_DETAILS_SOURCE} /> : outcome === null ? <p className="dt-muted">{t("common:details.loading")}</p> : <PhraseLine phrase={MANUAL_SCALE} />}
    </Block>
  );
}
