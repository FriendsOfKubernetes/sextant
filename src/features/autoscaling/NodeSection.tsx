// Node autoscaling in the details panel:
//  - Node: which Karpenter NodePool and NodeClaim it belongs to and why Karpenter disrupts it (or may not), or the
//    marks Cluster Autoscaler put on it, with the events of both about it;
//  - NodeClaim: launch, registration and initialization in plain words, its node and NodePool, disruption;
//  - NodePool: its limits against what it launched, its disruption settings and budgets, and the recent disruptions
//    of its NodeClaims — the reasons for nodes that are already gone;
//  - Cluster Autoscaler's status ConfigMap (`kube-system/cluster-autoscaler-status`) read into health and node groups.
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import { formatDateTime, formatList } from "../../i18n";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { status, StatusText } from "../../resources";
import { Block, Fields, KINDS, link, table, type ColumnWrap, type FieldRow } from "../details";
import { caNodeMarks, isCaEvent, isCaStatusMap, parseCaStatus } from "./clusterAutoscaler";
import { useKindEvents, useObjectEvents, useSharedList } from "./hooks";
import {
  CAPACITY_TYPE_LABEL,
  causeOf,
  disruptionOf,
  disruptionSettings,
  INSTANCE_TYPE_LABEL,
  isDisruptionEvent,
  isKarpenterNode,
  launchProblem,
  limitRows,
  nodeClaimOf,
  nodePoolOf,
  ZONE_LABEL,
} from "./karpenter";
import { NODE_CLAIM, NODE_POOL, phrase, type EventRow, type Phrase } from "./model";
import { CaStatusFields } from "./SchedulingSection";
import { EventsTable, Note, PhraseLine, Phrases } from "./ui";

const { get, record, str } = status;
const FIELDS = "autoscaling:fields";
const NODE_POOL_TYPE = { apiVersion: "karpenter.sh/v1", kind: "NodePool" };
const NODE_CLAIM_TYPE = { apiVersion: "karpenter.sh/v1", kind: "NodeClaim" };
const CLAIM_READY = phrase("karpenter.ready", undefined, "success");
const LIMIT_WRAP: readonly ColumnWrap[] = ["nowrap", "nowrap", "nowrap"];
const GROUP_WRAP: readonly ColumnWrap[] = ["nowrap", "nowrap", "nowrap", "nowrap", "nowrap", "nowrap"];

/** "expiresAt" carries an ISO time: shown in the UI language. */
function phrasesWithTimes(phrases: Phrase[]): Phrase[] {
  return phrases.map((p) => (p.params?.time ? { ...p, params: { ...p.params, time: formatDateTime(String(p.params.time)) } } : p));
}

function useCauseColumn(): { header: string; cell: (e: EventRow) => string } {
  const { t } = useTranslation();
  return { header: t("autoscaling:karpenter.cause"), cell: (e) => t(`autoscaling:karpenter.causes.${causeOf(`${e.reason} ${e.message}`)}`) };
}

// ---------- Node ----------

export function NodeAutoscalingSection({ clusterId, obj }: DetailsSectionProps) {
  if (!obj) return null;
  return <NodeAutoscaling clusterId={clusterId} node={obj} />;
}

function NodeAutoscaling({ clusterId, node }: { clusterId: ClusterId; node: KubeObject }) {
  const { t } = useTranslation();
  const karpenter = isKarpenterNode(node);
  const pools = useSharedList(clusterId, NODE_POOL, null, karpenter);
  const claims = useSharedList(clusterId, NODE_CLAIM, null, karpenter);
  const claim = useMemo(() => (karpenter ? nodeClaimOf(node, claims.items) : undefined), [karpenter, node, claims.items]);
  const poolName = nodePoolOf(node);
  const pool = pools.items.find((p) => p.metadata?.name === poolName);
  const nodeEvents = useObjectEvents(clusterId, node, "Node");
  const claimEvents = useObjectEvents(clusterId, claim, "NodeClaim", claim !== undefined);
  const cause = useCauseColumn();
  const caMarks = caNodeMarks(node);
  const caEvents = nodeEvents.filter(isCaEvent);
  const disruptionEvents = [...nodeEvents, ...claimEvents].filter(isDisruptionEvent);
  if (!karpenter && caMarks.length === 0 && caEvents.length === 0) return null;
  const labels = record(node.metadata?.labels);
  const fields: FieldRow[] = [
    ["nodePool", link(NODE_POOL_TYPE, poolName)],
    ["nodeClaim", claim ? link(NODE_CLAIM_TYPE, claim.metadata?.name) : null],
    ["capacityType", str(labels[CAPACITY_TYPE_LABEL]) ?? null],
    ["instanceType", str(labels[INSTANCE_TYPE_LABEL]) ?? null],
  ];

  return (
    <Block title={t("autoscaling:title")}>
      {karpenter && (
        <>
          <Fields labelPrefix={FIELDS} rows={fields} />
          <Phrases phrases={phrasesWithTimes(disruptionOf(node, claim, pool))} />
          {disruptionEvents.length > 0 && (
            <>
              <h4 className="as-subtitle">{t("autoscaling:karpenter.disruptions")}</h4>
              <EventsTable events={disruptionEvents} first={cause} />
            </>
          )}
        </>
      )}
      {(caMarks.length > 0 || caEvents.length > 0) && (
        <>
          <h4 className="as-subtitle">{t("autoscaling:ca.title")}</h4>
          <Phrases phrases={caMarks} />
          <EventsTable events={caEvents} />
        </>
      )}
    </Block>
  );
}

// ---------- NodeClaim ----------

export function NodeClaimSection({ clusterId, obj }: DetailsSectionProps) {
  if (!obj) return null;
  return <NodeClaimDetails clusterId={clusterId} claim={obj} />;
}

function NodeClaimDetails({ clusterId, claim }: { clusterId: ClusterId; claim: KubeObject }) {
  const { t } = useTranslation();
  const pools = useSharedList(clusterId, NODE_POOL, null);
  const poolName = nodePoolOf(claim);
  const pool = pools.items.find((p) => p.metadata?.name === poolName);
  const nodeName = str(get(claim, "status", "nodeName"));
  const labels = record(claim.metadata?.labels);
  const problem = launchProblem(claim);
  const events = useObjectEvents(clusterId, claim, "NodeClaim");
  const disruptions = events.filter(isDisruptionEvent);
  const cause = useCauseColumn();
  const fields: FieldRow[] = [
    ["node", link(KINDS.node, nodeName)],
    ["nodePool", link(NODE_POOL_TYPE, poolName)],
    ["capacityType", str(labels[CAPACITY_TYPE_LABEL]) ?? null],
    ["instanceType", str(labels[INSTANCE_TYPE_LABEL]) ?? null],
    ["zone", str(labels[ZONE_LABEL]) ?? null],
  ];
  return (
    <Block title={t("autoscaling:karpenter.claimTitle")}>
      <PhraseLine phrase={problem ?? CLAIM_READY} />
      <Fields labelPrefix={FIELDS} rows={fields} />
      <Phrases phrases={phrasesWithTimes(disruptionOf(undefined, claim, pool))} />
      {disruptions.length > 0 && (
        <>
          <h4 className="as-subtitle">{t("autoscaling:karpenter.disruptions")}</h4>
          <EventsTable events={disruptions} first={cause} />
        </>
      )}
    </Block>
  );
}

// ---------- NodePool ----------

export function NodePoolSection({ clusterId, obj }: DetailsSectionProps) {
  if (!obj) return null;
  return <NodePoolDetails clusterId={clusterId} pool={obj} />;
}

function NodePoolDetails({ clusterId, pool }: { clusterId: ClusterId; pool: KubeObject }) {
  const { t } = useTranslation();
  const name = pool.metadata?.name ?? "";
  const limits = limitRows(pool);
  const settings = disruptionSettings(pool);
  const classRef = get(pool, "spec", "template", "spec", "nodeClassRef");
  const classKind = str(get(classRef, "kind"));
  const classGroup = str(get(classRef, "group")) ?? "karpenter.k8s.aws";
  const events = useKindEvents(clusterId, "NodeClaim", true);
  // A NodePool names its NodeClaims `<nodepool>-<suffix>`.
  const disruptions = useMemo(() => events.filter((e) => e.involvedName.startsWith(`${name}-`) && isDisruptionEvent(e)), [events, name]);
  const cause = useCauseColumn();
  const reached = limits.filter((l) => l.reached).map((l) => l.resource);
  const budgets = settings.budgets.map((b) =>
    formatList([b.nodes, ...(b.reasons.length > 0 ? [b.reasons.join("/")] : []), ...(b.schedule ? [`${b.schedule}${b.duration ? ` (${b.duration})` : ""}`] : [])]),
  );

  const limitPhrase = reached.length > 0 ? phrase("karpenter.poolLimit", { name, resources: formatList(reached) }, "danger") : null;
  const fields: FieldRow[] = [
    ["nodeClass", classKind ? link({ apiVersion: `${classGroup}/v1`, kind: classKind }, str(get(classRef, "name"))) : null],
    ["consolidationPolicy", settings.consolidationPolicy ?? null],
    ["consolidateAfter", settings.consolidateAfter ?? null],
    ["expireAfter", settings.expireAfter ?? null],
    ["budgets", budgets.length > 0 ? <Lines lines={budgets} /> : null],
  ];
  const limitTable = table(
    [t("autoscaling:karpenter.resource"), t("autoscaling:karpenter.inUse"), t("autoscaling:karpenter.limit")],
    limits.map((l) => [l.resource, l.used ?? "", l.reached ? <StatusText value={l.limit} tone="danger" /> : l.limit]),
    LIMIT_WRAP,
  );
  const claimColumn = { header: t("autoscaling:karpenter.nodeClaim"), cell: (e: EventRow) => `${e.involvedName} · ${cause.cell(e)}` };

  return (
    <Block title={t("autoscaling:karpenter.poolTitle")}>
      {limitPhrase && <PhraseLine phrase={limitPhrase} />}
      <Fields labelPrefix={FIELDS} rows={fields} />
      {limits.length > 0 ? limitTable : <Note>{t("autoscaling:karpenter.noLimits")}</Note>}
      <h4 className="as-subtitle">{t("autoscaling:karpenter.recentDisruptions")}</h4>
      {disruptions.length === 0 ? <Note>{t("autoscaling:karpenter.noDisruptions")}</Note> : <EventsTable events={disruptions} first={claimColumn} />}
    </Block>
  );
}

function Lines({ lines }: { lines: readonly string[] }) {
  return (
    <span className="as-lines">
      {lines.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </span>
  );
}

// ---------- Cluster Autoscaler status ----------

export function CaStatusSection({ obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const ca = useMemo(() => (isCaStatusMap(obj) ? parseCaStatus(obj ?? undefined) : undefined), [obj]);
  if (!ca) return null;
  return (
    <Block title={t("autoscaling:ca.statusTitle")}>
      <CaStatusFields ca={ca} />
      {ca.groups.length > 0 &&
        table(
          [t("autoscaling:ca.group"), t("autoscaling:ca.health"), t("autoscaling:ca.nodes"), t("autoscaling:ca.size"), t("autoscaling:ca.scaleUp"), t("autoscaling:ca.scaleDown")],
          ca.groups.map((g) => [
            g.name,
            g.health ? <StatusText value={g.health} tone={g.health === "Healthy" ? "success" : "danger"} /> : "",
            g.registered !== undefined ? `${g.ready ?? "?"}/${g.registered}` : "",
            g.min !== undefined || g.max !== undefined ? `${g.target ?? "?"} (${g.min ?? "?"}–${g.max ?? "?"})` : "",
            g.scaleUp ?? "",
            g.scaleDown ?? "",
          ]),
          GROUP_WRAP,
        )}
    </Block>
  );
}
