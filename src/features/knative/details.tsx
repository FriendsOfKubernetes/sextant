// Details of Knative Serving objects (#213), one section for every kind of the section:
//   Service / Configuration — the state in plain words, URL, latest created and latest ready revision (links), and for
//                             a Service the traffic split;
//   Route                   — the state, URL and the traffic split;
//   Revision                — the state (scaled to zero, the failing condition), its Configuration and Service,
//                             actual / desired replicas, image, concurrency and timeout;
//   DomainMapping           — the state, URL and the Service it points at.
// The traffic split lists each target's revision (a link), tag, percent, whether it follows the latest ready revision,
// and its URL. Conditions and YAML are the panel's own sections. Read-only.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { StatusText } from "../../resources";
import { Block, chips, Fields, link, table, type ColumnWrap, type FieldRow } from "../details";
import {
  apiVersionOf,
  CONFIGURATION,
  DOMAIN_MAPPING,
  explain,
  failingCondition,
  HEALTH_TONE,
  healthOf,
  KSERVICE,
  knativeKind,
  mappingRef,
  REVISION,
  revisionFields,
  ROUTE,
  sameKind,
  serviceFields,
  trafficSplit,
} from "./model";

const LABELS = "knative:fields";
const TRAFFIC_TABLE = "knativeTraffic";
const TRAFFIC_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap", undefined, undefined];
const typeOf = (kind: typeof KSERVICE) => ({ apiVersion: apiVersionOf(kind), kind: kind.kind });

function Explanation({ obj, kind }: { obj: KubeObject; kind: typeof KSERVICE }) {
  const { t } = useTranslation();
  const phrase = explain(kind, obj);
  if (!phrase) return null;
  const danger = healthOf(obj) === "failed";
  return <p className={danger ? "cm-explain cm-explain--danger" : "cm-explain"}>{t(`knative:explain.${phrase.key}`, phrase.params ?? {})}</p>;
}

function FailingMessage({ obj }: { obj: KubeObject }) {
  const failing = failingCondition(obj);
  if (!failing?.message) return null;
  return <p className="cm-message">{failing.message}</p>;
}

function Health({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const health = healthOf(obj);
  return <StatusText value={t(`knative:health.${health}`)} tone={HEALTH_TONE[health]} />;
}

/** The traffic split of a Service or Route, with links to the revisions. */
export function TrafficTable({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const { targets, asked } = trafficSplit(obj);
  const ns = obj.metadata?.namespace ?? null;
  if (targets.length === 0) return null;
  const latestReady = serviceFields(obj).latestReady;
  const rows = targets.map((target) => [
    target.revisionName
      ? link(typeOf(REVISION), target.revisionName, ns)
      : target.latestRevision
        ? t("knative:traffic.latestReady", { revision: latestReady ?? "" })
        : (target.configurationName ?? ""),
    target.tag ?? "",
    target.percent === undefined ? "" : t("knative:traffic.percent", { percent: target.percent }),
    target.latestRevision ? t("knative:traffic.followsLatest") : "",
    target.url ?? "",
  ]);
  const headers = [t("knative:traffic.revision"), t("knative:traffic.tag"), t("knative:traffic.share"), t("knative:traffic.latest"), t("knative:traffic.url")];
  const body = table(TRAFFIC_TABLE, headers, rows, TRAFFIC_WRAP);
  return <Block title={asked ? t("knative:traffic.askedTitle") : t("knative:traffic.title")}>{body}</Block>;
}

function ServiceView({ obj, kind }: { obj: KubeObject; kind: typeof KSERVICE }) {
  const f = serviceFields(obj);
  const ns = obj.metadata?.namespace ?? null;
  const rows: FieldRow[] = [
    ["status", <Health key="h" obj={obj} />],
    ["url", f.url],
    ["address", f.address],
    ["latestCreated", link(typeOf(REVISION), f.latestCreated, ns)],
    ["latestReady", link(typeOf(REVISION), f.latestReady, ns)],
  ];
  return (
    <>
      <Explanation obj={obj} kind={kind} />
      <FailingMessage obj={obj} />
      <Fields rows={rows} labelPrefix={LABELS} />
      {(sameKind(kind, KSERVICE) || sameKind(kind, ROUTE)) && <TrafficTable obj={obj} />}
    </>
  );
}

function RevisionView({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const f = revisionFields(obj);
  const ns = obj.metadata?.namespace ?? null;
  const rows: FieldRow[] = [
    ["status", <Health key="h" obj={obj} />],
    ["configuration", link(typeOf(CONFIGURATION), f.configuration, ns)],
    ["service", link(typeOf(KSERVICE), f.service, ns)],
    ["generation", f.generation],
    ["replicas", f.actualReplicas === undefined ? undefined : t("knative:replicas", { actual: f.actualReplicas, desired: f.desiredReplicas ?? "?" })],
    ["routingState", f.routingState],
    ["images", chips(f.images)],
    ["concurrency", f.concurrency === undefined ? undefined : f.concurrency === 0 ? t("knative:unlimited") : String(f.concurrency)],
    ["timeout", f.timeoutSeconds === undefined ? undefined : t("knative:timeoutSeconds", { seconds: f.timeoutSeconds })],
  ];
  return (
    <>
      <Explanation obj={obj} kind={REVISION} />
      <FailingMessage obj={obj} />
      <Fields rows={rows} labelPrefix={LABELS} />
    </>
  );
}

function DomainMappingView({ obj }: { obj: KubeObject }) {
  const ref = mappingRef(obj);
  const ns = ref.namespace ?? obj.metadata?.namespace ?? null;
  const target = ref.kind === "Service" && ref.apiVersion?.startsWith("serving.knative.dev/") ? link(typeOf(KSERVICE), ref.name, ns) : ref.name;
  const rows: FieldRow[] = [
    ["status", <Health key="h" obj={obj} />],
    ["url", serviceFields(obj).url],
    ["target", target],
  ];
  return (
    <>
      <Explanation obj={obj} kind={DOMAIN_MAPPING} />
      <FailingMessage obj={obj} />
      <Fields rows={rows} labelPrefix={LABELS} />
    </>
  );
}

export function KnativeSection({ objectRef, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const def = knativeKind(objectRef.kind);
  if (!obj || !def) return null;
  const kind = def.kind;
  const view = sameKind(kind, REVISION) ? (
    <RevisionView obj={obj} />
  ) : sameKind(kind, DOMAIN_MAPPING) ? (
    <DomainMappingView obj={obj} />
  ) : (
    <ServiceView obj={obj} kind={kind} />
  );
  return <Block title={t("details:sections.fields", { kind: kind.kind })}>{view}</Block>;
}
