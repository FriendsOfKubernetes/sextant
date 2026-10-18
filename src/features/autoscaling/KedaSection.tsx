// KEDA details: a ScaledObject's state in plain words (Ready, Active, Paused, Fallback, failing triggers), its target
// and the HPA KEDA manages for it with that HPA's verdict and metrics; a ScaledJob's state and triggers; and where a
// (Cluster)TriggerAuthentication takes its parameters from (names only). The events are the panel's own section.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { status } from "../../resources";
import { Block, chips, Fields, KINDS, link, table, type ColumnWrap, type FieldRow } from "../details";
import { HpaSummary } from "./HpaSection";
import { useObject, useServed } from "./hooks";
import { authSources, kedaState, managedHpaName, scaleTargetOf, triggersOf } from "./keda";
import { HPA, phrase } from "./model";
import { Note, PhraseLine, Phrases } from "./ui";

const { get, num, str } = status;
const FIELDS = "autoscaling:fields";
const KEDA_API = "keda.sh/v1alpha1";
const TRIGGER_WRAP: readonly ColumnWrap[] = ["nowrap", undefined, "nowrap", "nowrap"];
const SOURCE_WRAP: readonly ColumnWrap[] = ["nowrap", "nowrap", undefined, "nowrap"];
/** KEDA's defaults of the fields shown. */
const DEFAULTS = { minReplicaCount: 0, maxReplicaCount: 100, pollingInterval: 30, cooldownPeriod: 300 };

function TriggersTable({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const namespace = obj.metadata?.namespace ?? null;
  const triggers = triggersOf(obj);
  if (triggers.length === 0) return <Note>{t("autoscaling:keda.noTriggers")}</Note>;
  const rows: ReactNode[][] = triggers.map((tr) => [
    tr.name ? `${tr.type} (${tr.name})` : tr.type,
    chips(tr.metadata),
    tr.auth ? link({ apiVersion: KEDA_API, kind: tr.auth.kind }, tr.auth.name, tr.auth.kind === "TriggerAuthentication" ? namespace : null) : "",
    tr.health ? (tr.failures ? `${tr.health} (${tr.failures})` : tr.health) : "",
  ]);
  const headers = [t("autoscaling:keda.trigger"), t("autoscaling:keda.metadata"), t("autoscaling:keda.auth"), t("autoscaling:keda.health")];
  return <>{table(headers, rows, TRIGGER_WRAP)}</>;
}

export function ScaledObjectSection({ clusterId, obj }: DetailsSectionProps) {
  if (!obj) return null;
  return <ScaledObject clusterId={clusterId} obj={obj} />;
}

function specNumber(obj: KubeObject, field: keyof typeof DEFAULTS | "idleReplicaCount"): number | undefined {
  return num(get(obj, "spec", field)) ?? (field === "idleReplicaCount" ? undefined : DEFAULTS[field]);
}

function ScaledObject({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const namespace = obj.metadata?.namespace ?? null;
  const target = scaleTargetOf(obj);
  const hpaName = managedHpaName(obj);
  const hpaKind = useServed(clusterId, HPA);
  const hpa = useObject(clusterId, hpaKind, namespace, hpaName);
  const state = kedaState(obj);
  const fallback = get(obj, "spec", "fallback");
  const fields: FieldRow[] = [
    ["target", target ? link({ apiVersion: target.apiVersion, kind: target.kind }, target.name, namespace, `${target.kind}/${target.name}`) : null],
    ["range", `${specNumber(obj, "minReplicaCount")}–${specNumber(obj, "maxReplicaCount")}`],
    ["idleReplicas", specNumber(obj, "idleReplicaCount") ?? null],
    ["pollingInterval", t("autoscaling:keda.seconds", { count: specNumber(obj, "pollingInterval") })],
    ["cooldownPeriod", t("autoscaling:keda.seconds", { count: specNumber(obj, "cooldownPeriod") })],
    [
      "fallback",
      fallback
        ? t("autoscaling:keda.fallbackSpec", {
            failures: num(get(fallback, "failureThreshold")) ?? "?",
            replicas: num(get(fallback, "replicas")) ?? "?",
          })
        : null,
    ],
  ];
  const missing = phrase("keda.hpaMissing", { name: hpaName }, "warning");
  return (
    <Block title={t("autoscaling:keda.title")}>
      <Phrases phrases={state.phrases} />
      <Fields labelPrefix={FIELDS} rows={fields} />
      <h4 className="as-subtitle">{t("autoscaling:keda.triggers")}</h4>
      <TriggersTable obj={obj} />
      <h4 className="as-subtitle">{t("autoscaling:keda.managedHpa")}</h4>
      {hpa ? <HpaSummary hpa={hpa} metrics /> : <PhraseLine phrase={missing} />}
    </Block>
  );
}

export function ScaledJobSection({ obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  if (!obj) return null;
  const state = kedaState(obj, true);
  const fields: FieldRow[] = [
    ["maxReplicas", specNumber(obj, "maxReplicaCount")],
    ["strategy", str(get(obj, "spec", "scalingStrategy", "strategy")) ?? null],
    ["pollingInterval", t("autoscaling:keda.seconds", { count: specNumber(obj, "pollingInterval") })],
    ["image", str(get(obj, "spec", "jobTargetRef", "template", "spec", "containers", 0, "image")) ?? null],
  ];
  return (
    <Block title={t("autoscaling:keda.title")}>
      <Phrases phrases={state.phrases} />
      <Fields labelPrefix={FIELDS} rows={fields} />
      <h4 className="as-subtitle">{t("autoscaling:keda.triggers")}</h4>
      <TriggersTable obj={obj} />
    </Block>
  );
}

export function TriggerAuthenticationSection({ obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  if (!obj) return null;
  const namespace = obj.metadata?.namespace ?? null;
  const { sources, podIdentity } = authSources(obj);
  const target = (from: string, name: string | undefined): ReactNode => {
    if (!name) return "";
    if (from === "Secret" && namespace) return link(KINDS.secret, name, namespace);
    if (from === "ConfigMap" && namespace) return link(KINDS.configMap, name, namespace);
    return name;
  };
  const fields: FieldRow[] = [["podIdentity", podIdentity ?? null]];
  const headers = [t("autoscaling:keda.parameter"), t("autoscaling:keda.from"), t("autoscaling:keda.name"), t("autoscaling:keda.key")];
  const rows: ReactNode[][] = sources.map((s) => [s.parameter, s.from, target(s.from, s.name), s.key ?? ""]);
  return (
    <Block title={t("autoscaling:keda.authTitle")}>
      <Fields labelPrefix={FIELDS} rows={fields} />
      {sources.length === 0 && !podIdentity && <Note>{t("autoscaling:keda.noSources")}</Note>}
      {table(headers, rows, SOURCE_WRAP)}
    </Block>
  );
}
