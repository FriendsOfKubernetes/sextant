import { useDetailsDisclosure } from "../../layout/details/disclosure";
// Details of a VerticalPodAutoscaler (section `vpa`): its state from the conditions with the recommender's message and
// what it means, the update mode explained, a link to the target, an HPA that fights it, the recommendation per
// container against the target template's requests and limits with what a pod created now would get (admission.ts),
// and the VPA components found in the cluster with what a missing one means for this VPA. Conditions, events and YAML
// are the panel's own sections. Read-only.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { formatDateTime } from "../../i18n";
import { StatusText } from "../../resources";
import { Block, Fields, link, table, type ColumnWrap, type FieldRow } from "../details";
import { StateCell } from "./columns";
import { COMPONENTS, missingMeaning } from "./components";
import { useComponents, useNamespaceHpas, useTarget } from "./hooks";
import { isVpa, minReplicasOf, modeIsDefault, recommendationsOf, recommenderOf, statusOf, targetOf, updateModeOf, type TargetRef } from "./model";
import { ChangesTable, ConflictLines, ModeText } from "./ui";

const LABELS = "vpa:fields";
const DEPLOYMENT_TYPE = { apiVersion: "apps/v1", kind: "Deployment" };

const date = (value: string | undefined): ReactNode => (value ? <time dateTime={value}>{formatDateTime(value)}</time> : null);

/** The deciding condition's message and what it means. */
function StateNote({ vpa }: { vpa: KubeObject }) {
  const { t } = useTranslation();
  const s = statusOf(vpa);
  const hint = s.reason === "provided" ? null : t(`vpa:hint.${s.reason}`);
  return (
    <>
      {s.message && <p className={s.state === "failed" ? "vpa-message" : "vpa-note"}>{s.message}</p>}
      {hint && <p className="vpa-note">{hint}</p>}
      {s.noPodsNow && <p className="vpa-note">{t("vpa:hint.noPodsNow")}</p>}
      {s.deprecated && <p className="vpa-note">{t("vpa:hint.deprecated")}</p>}
    </>
  );
}

const targetType = (ref: TargetRef) => ({ apiVersion: ref.apiVersion, kind: ref.kind });

/** The recommendation against the target's template, once the target is read. */
function Recommendation({ clusterId, vpa, ref }: { clusterId: ClusterId; vpa: KubeObject; ref: TargetRef }) {
  const { t } = useTranslation();
  const namespace = vpa.metadata?.namespace ?? null;
  const target = useTarget(clusterId, namespace, ref);
  const hpas = useNamespaceHpas(clusterId, namespace);
  let body: ReactNode;
  if (target.notServed) body = <p className="vpa-note">{t("vpa:target.notServed", { kind: ref.kind })}</p>;
  else if (!target.obj) body = <p className="vpa-muted">{t("vpa:target.notRead")}</p>;
  else body = <ChangesTable vpa={vpa} target={target.obj} id={RECOMMENDATION_TABLE} />;
  return (
    <>
      <ConflictLines vpa={vpa} hpas={hpas.items} target={target.obj} />
      <Block id="vpa:recommendation.title" title={t("vpa:recommendation.title")}>{body}</Block>
    </>
  );
}

const RECOMMENDATION_TABLE = "vpaRecommendation";
const COMPONENTS_TABLE = "vpaComponents";
const COMPONENT_WRAP: ColumnWrap[] = ["nowrap", "nowrap", undefined];

/** The recommender, updater and admission controller found in the cluster, and what a missing one means. */
function Components({ clusterId, vpa }: { clusterId: ClusterId; vpa: KubeObject }) {
  const { t } = useTranslation();
  const open = useDetailsDisclosure("vpa:components.title")?.open ?? true;
  const { found, error } = useComponents(clusterId, open);
  const mode = updateModeOf(vpa);
  // A recommendation in the status shows a recommender works, whatever the conditions say now.
  const provided = recommendationsOf(vpa).length > 0 || statusOf(vpa).state === "ready";
  if (!found)
    return (
      <Block id="vpa:components.title" title={t("vpa:components.title")}>
        <p className="vpa-muted">{t("vpa:loading")}</p>
      </Block>
    );
  const rows: ReactNode[][] = [];
  const notes: string[] = [];
  for (const c of COMPONENTS) {
    const list = found[c];
    if (list.length === 0) {
      rows.push([t(`vpa:components.name.${c}`), <StatusText key="s" value={t(error ? "vpa:components.unknown" : "vpa:components.notFound")} tone="warning" />, ""]);
      const meaning = missingMeaning(c, mode);
      // A recommendation in the status shows a recommender works, even where it runs outside the cluster (GKE).
      if (meaning && !(c === "recommender" && provided)) notes.push(t(`vpa:components.missing.${meaning}`));
      continue;
    }
    for (const d of list) {
      const tone = d.ready >= d.desired && d.desired > 0 ? "success" : "danger";
      rows.push([
        t(`vpa:components.name.${c}`),
        <StatusText key="s" value={t("vpa:components.ready", { ready: d.ready, desired: d.desired })} tone={tone} />,
        link(DEPLOYMENT_TYPE, d.name, d.namespace),
      ]);
    }
  }
  const missing = COMPONENTS.some((c) => found[c].length === 0);
  const view = table(COMPONENTS_TABLE, [t("vpa:components.component"), t("vpa:components.state"), t("vpa:components.deployment")], rows, COMPONENT_WRAP);
  return (
    <Block id="vpa:components.title" title={t("vpa:components.title")}>
      {view}
      {notes.map((n) => (
        <p key={n} className="vpa-note">
          {n}
        </p>
      ))}
      {missing && <p className="vpa-muted">{t("vpa:components.managed")}</p>}
    </Block>
  );
}

function VpaView({ clusterId, vpa }: { clusterId: ClusterId; vpa: KubeObject }) {
  const { t } = useTranslation();
  const ns = vpa.metadata?.namespace ?? null;
  const ref = targetOf(vpa);
  const s = statusOf(vpa);
  const minReplicas = minReplicasOf(vpa);
  const rows: FieldRow[] = [
    ["status", <StateCell key="s" obj={vpa} />],
    ["since", date(s.since)],
    ["target", ref ? link(targetType(ref), ref.name, ns, `${ref.kind}/${ref.name}`) : t("vpa:target.missing")],
    ["mode", modeIsDefault(vpa) ? t("vpa:fields.modeDefault", { mode: updateModeOf(vpa) }) : updateModeOf(vpa)],
    ["modeExplained", <ModeText key="m" vpa={vpa} />],
    ["minReplicas", minReplicas === undefined ? null : String(minReplicas)],
    ["recommender", recommenderOf(vpa)],
  ];
  return (
    <>
      <Fields rows={rows} labelPrefix={LABELS} />
      <StateNote vpa={vpa} />
      {ref && <Recommendation clusterId={clusterId} vpa={vpa} ref={ref} />}
      <Components clusterId={clusterId} vpa={vpa} />
    </>
  );
}

export function VpaSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  if (!obj || !isVpa(objectRef.kind)) return null;
  return <VpaView clusterId={clusterId} vpa={obj} />;
}

export const appliesTo = isVpa;
