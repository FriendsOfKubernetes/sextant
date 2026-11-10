// Node autoscaling in the details panel:
//  - Node: which Karpenter NodePool and NodeClaim it belongs to and why Karpenter disrupts it (or may not), or the
//    marks Cluster Autoscaler put on it, with the events of both about it;
//  - Cluster Autoscaler's status ConfigMap (`kube-system/cluster-autoscaler-status`) read into health and node groups.
// The details of NodeClaims and NodePools are Sextant's own extension `extensions/karpenter` (`sextant.karpenter`).
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject, WatchState } from "../../api";
import { formatDateTime } from "../../i18n";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { UNKNOWN_DETAILS_SOURCE, useDisclosureProbe, useDisclosureProbeResult, watchProbeResult } from "../details/disclosureProbe";
import { ErrorState } from "../../components";
import { status, StatusText, useClusterKinds } from "../../resources";
import { Block, Fields, link, table, type ColumnWrap, type FieldRow } from "../details";
import { caNodeMarks, isCaEvent, isCaStatusMap, parseCaStatus } from "./clusterAutoscaler";
import { useObjectEventsSource, useSharedList } from "./hooks";
import {
  CAPACITY_TYPE_LABEL,
  causeOf,
  disruptionOf,
  INSTANCE_TYPE_LABEL,
  isDisruptionEvent,
  isKarpenterNode,
  nodeClaimOf,
  nodePoolOf,
} from "./karpenter";
import { NODE_CLAIM, NODE_POOL, type EventRow, type Phrase } from "./model";
import { CaStatusFields } from "./SchedulingSection";
import { EventsTable, Phrases } from "./ui";

/** Where the column widths of this file's tables are saved (`table` of `details/ui`). */
const TABLE_IDS = {
  clusterAutoscalerGroups: "clusterAutoscaler.groups",
};

const { record, str } = status;
const FIELDS = "autoscaling:fields";
const NODE_POOL_TYPE = { apiVersion: "karpenter.sh/v1", kind: "NodePool" };
const NODE_CLAIM_TYPE = { apiVersion: "karpenter.sh/v1", kind: "NodeClaim" };
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
  const probe = useDisclosureProbe("autoscaling:title");
  const { enabled, result } = probe;
  const disruptionsProbe = useDisclosureProbe("autoscaling:title/autoscaling:karpenter.disruptions");
  const caProbe = useDisclosureProbe("autoscaling:title/autoscaling:ca.title");
  const discovery = useClusterKinds(clusterId);
  const karpenter = isKarpenterNode(node);
  const pools = useSharedList(clusterId, NODE_POOL, null, karpenter && enabled);
  const claims = useSharedList(clusterId, NODE_CLAIM, null, karpenter && enabled);
  const claim = useMemo(() => (karpenter ? nodeClaimOf(node, claims.items) : undefined), [karpenter, node, claims.items]);
  const poolName = nodePoolOf(node);
  const pool = pools.items.find((p) => p.metadata?.name === poolName);
  const nodeSource = useObjectEventsSource(clusterId, node, "Node", enabled && (result === null || disruptionsProbe.enabled || caProbe.enabled));
  const claimSource = useObjectEventsSource(clusterId, claim, "NodeClaim", claim !== undefined && enabled && disruptionsProbe.enabled);
  const nodeEvents = nodeSource.events;
  const claimEvents = claimSource.events;
  const cause = useCauseColumn();
  const caMarks = caNodeMarks(node);
  const caEvents = nodeEvents.filter(isCaEvent);
  const disruptionEvents = [...nodeEvents, ...claimEvents].filter(isDisruptionEvent);
  const caFound = caMarks.length > 0 || caEvents.length > 0;
  const hasSources = karpenter || caFound;
  const answer = watchProbeResult(hasSources, [nodeSource.state]);
  const view = useDisclosureProbeResult(probe, answer);
  const claimsReady = !karpenter || claims.served === false || (claims.state && claims.state.status !== "loading");
  const disruptionStates: (WatchState | undefined)[] = [nodeSource.state];
  if (karpenter && claims.served) disruptionStates.push(claims.state);
  if (claim) disruptionStates.push(claimSource.state);
  let disruptionsAnswer = watchProbeResult(disruptionEvents.length > 0, disruptionStates);
  if (!claimsReady) disruptionsAnswer = null;
  else if (karpenter && discovery.error && disruptionEvents.length === 0) disruptionsAnswer = "unknown";
  const caAnswer = watchProbeResult(caFound, [nodeSource.state]);
  const disruptionsView = useDisclosureProbeResult(disruptionsProbe, enabled ? disruptionsAnswer : null);
  const caView = useDisclosureProbeResult(caProbe, enabled ? caAnswer : null);
  if (!view.visible) return null;
  if (!probe.open) return <Block id="autoscaling:title" title={t("autoscaling:title")}>{null}</Block>;
  const labels = record(node.metadata?.labels);
  const fields: FieldRow[] = [
    ["nodePool", link(NODE_POOL_TYPE, poolName)],
    ["nodeClaim", claim ? link(NODE_CLAIM_TYPE, claim.metadata?.name) : null],
    ["capacityType", str(labels[CAPACITY_TYPE_LABEL]) ?? null],
    ["instanceType", str(labels[INSTANCE_TYPE_LABEL]) ?? null],
  ];

  return (
    <Block id="autoscaling:title" title={t("autoscaling:title")}>
      {!hasSources && nodeSource.state.status === "loading" && <p className="dt-muted">{t("common:details.loading")}</p>}
      {karpenter && (
        <>
          <Fields labelPrefix={FIELDS} rows={fields} />
          <Phrases phrases={phrasesWithTimes(disruptionOf(node, claim, pool))} />
          {(disruptionEvents.length > 0 || claimSource.state.error || disruptionsView.visible) && (
            <Block id="autoscaling:karpenter.disruptions" title={t("autoscaling:karpenter.disruptions")}>
              {disruptionsAnswer === "unknown" ? <ErrorState error={claimSource.state.error ?? claims.state?.error ?? nodeSource.state.error ?? discovery.error ?? UNKNOWN_DETAILS_SOURCE} /> : <EventsTable events={disruptionEvents} first={cause} />}
            </Block>
          )}
        </>
      )}
      {(caFound || caView.visible) && (
        <Block id="autoscaling:ca.title" title={t("autoscaling:ca.title")}>
          <Phrases phrases={caMarks} />
          {caAnswer === "unknown" ? <ErrorState error={nodeSource.state.error ?? UNKNOWN_DETAILS_SOURCE} /> : <EventsTable events={caEvents} />}
        </Block>
      )}
    </Block>
  );
}

// ---------- Cluster Autoscaler status ----------

export function CaStatusSection({ obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const ca = useMemo(() => (isCaStatusMap(obj) ? parseCaStatus(obj ?? undefined) : undefined), [obj]);
  if (!ca) return null;
  return (
    <Block id="autoscaling:ca.statusTitle" title={t("autoscaling:ca.statusTitle")}>
      <CaStatusFields ca={ca} />
      {ca.groups.length > 0 &&
        table(
          TABLE_IDS.clusterAutoscalerGroups,
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
