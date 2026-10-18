// The "Scheduling" details of a Pending pod the scheduler has not placed: what the scheduler said (parsed into
// reasons with node counts), a local check against the watched nodes saying per node why the pod does not fit, and
// what the node autoscaler decided — Karpenter (the NodeClaims it nominated, their launch, NodePools at their limit,
// its events) or Cluster Autoscaler (TriggeredScaleUp / NotTriggerScaleUp and its status ConfigMap). Draws nothing for
// a pod that is scheduled.
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type ClusterId, type KubeObject } from "../../api";
import { Age } from "../../components";
import { formatList, formatParts } from "../../i18n";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { status, StatusText } from "../../resources";
import { Block, Fields, KINDS, link, table, type ColumnWrap, type FieldRow } from "../details";
import {
  isCaEvent,
  notTriggeredReasons,
  parseCaStatus,
  STATUS_NAME,
  STATUS_NAMESPACE,
  triggeredGroups,
  type CaStatus,
} from "./clusterAutoscaler";
import { useBoundPods, useNodeRows, useObject, useObjectEvents, useServed, useSharedList } from "./hooks";
import { isKarpenterEvent, launchProblem, nominationsOf, reachedLimits } from "./karpenter";
import { CONFIG_MAP, formatAmount, NODE_CLAIM, NODE_POOL, phrase, POD, PV, PVC, type EventRow, type Phrase } from "./model";
import {
  checkNodes,
  claimNames,
  isUnscheduled,
  needsPeers,
  parseSchedulerMessage,
  peerPod,
  schedulingCondition,
  usedByNode,
  type PeerPod,
  type VolumeAffinity,
} from "./scheduling";
import { EventsTable, Note, PhraseLine, Phrases, ReasonsTable } from "./ui";

const { get, str } = status;
const FIELDS = "autoscaling:fields";
const NODE_CLAIM_TYPE = { apiVersion: "karpenter.sh/v1", kind: "NodeClaim" };
const TWO_WRAP: readonly ColumnWrap[] = ["nowrap", undefined];
const NOT_TRIGGERED = phrase("ca.notTriggered", undefined, "danger");

/** Node rows the local check lists at most (the fitting ones first). */
export const MAX_SHOWN_NODES = 30;

export function SchedulingSection({ clusterId, obj }: DetailsSectionProps) {
  if (!obj || !isUnscheduled(obj)) return null;
  return <Scheduling clusterId={clusterId} pod={obj} />;
}

function Scheduling({ clusterId, pod }: { clusterId: ClusterId; pod: KubeObject }) {
  const { t } = useTranslation();
  const events = useObjectEvents(clusterId, pod, "Pod");
  const condition = schedulingCondition(pod);
  const message = useMemo(() => {
    if (condition.message) return condition.message;
    return events.filter((e) => e.reason === "FailedScheduling" && !isKarpenterEvent(e)).sort((a, b) => (b.time ?? "").localeCompare(a.time ?? ""))[0]?.message;
  }, [condition.message, events]);
  const parsed = useMemo(() => parseSchedulerMessage(message), [message]);

  const fields: FieldRow[] = [
    ["reason", condition.reason ? <StatusText value={condition.reason} tone="warning" /> : null],
    ["pendingFor", condition.since ? <Age timestamp={condition.since} /> : null],
    ["message", message ? <span className="as-muted">{message}</span> : null],
    ["preemption", parsed?.preemption ? <span className="as-muted">{parsed.preemption}</span> : null],
  ];

  return (
    <Block title={t("autoscaling:sched.title")}>
      <Fields labelPrefix={FIELDS} rows={fields} />
      {!message && <Note>{t("autoscaling:sched.noMessage")}</Note>}
      {parsed && parsed.reasons.length > 0 && (
        <>
          <h4 className="as-subtitle">{t("autoscaling:sched.schedulerSays")}</h4>
          <ReasonsTable reasons={parsed.reasons} countHeader={t("autoscaling:sched.nodes")} />
        </>
      )}
      <LocalCheck clusterId={clusterId} pod={pod} schedulerTotal={parsed?.total} />
      <Karpenter clusterId={clusterId} events={events} />
      <ClusterAutoscaler clusterId={clusterId} events={events} />
    </Block>
  );
}

/** The bound PersistentVolumes of the pod's claims, read once each (their node affinity limits the nodes). */
function useVolumeAffinities(clusterId: ClusterId, pod: KubeObject): { volumes: VolumeAffinity[]; notes: Phrase[] } {
  const namespace = pod.metadata?.namespace ?? null;
  const claims = useMemo(() => claimNames(pod), [pod]);
  const pvcs = useSharedList(clusterId, PVC, namespace, claims.length > 0);
  const pvKind = useServed(clusterId, PV);
  const byName = useMemo(() => new Map(pvcs.items.map((c) => [c.metadata?.name ?? "", c])), [pvcs.items]);
  const volumeNames = useMemo(
    () => claims.map((c) => str(get(byName.get(c), "spec", "volumeName"))).filter((n): n is string => Boolean(n)),
    [claims, byName],
  );
  const key = volumeNames.join(",");
  const [pvs, setPvs] = useState<Map<string, KubeObject>>(new Map());
  useEffect(() => {
    if (!pvKind || volumeNames.length === 0) return;
    let cancelled = false;
    Promise.all(
      volumeNames.map((name) =>
        api.resources.get(clusterId, { kind: pvKind, namespace: null, name }).then(
          (pv) => [name, pv] as const,
          () => undefined,
        ),
      ),
    ).then((found) => {
      if (!cancelled) setPvs(new Map(found.filter((f): f is readonly [string, KubeObject] => f !== undefined)));
    });
    return () => {
      cancelled = true;
    };
    // `key` stands for `volumeNames`.
  }, [clusterId, pvKind, key]);

  return useMemo(() => {
    const notes: Phrase[] = [];
    if (claims.length > 0 && pvcs.state?.status === "ready") {
      for (const claim of claims) {
        const pvc = byName.get(claim);
        if (!pvc) notes.push(phrase("sched.claimMissing", { name: claim }, "danger"));
        else if (str(get(pvc, "status", "phase")) !== "Bound") notes.push(phrase("sched.claimUnbound", { name: claim }, "warning"));
      }
    }
    const volumes = [...pvs.entries()].flatMap(([name, pv]) => {
      const required = get(pv, "spec", "nodeAffinity", "required");
      return required ? [{ pv: name, required }] : [];
    });
    return { volumes, notes };
  }, [claims, pvcs.state?.status, byName, pvs]);
}

function LocalCheck({ clusterId, pod, schedulerTotal }: { clusterId: ClusterId; pod: KubeObject; schedulerTotal: number | undefined }) {
  const { t } = useTranslation();
  const nodes = useNodeRows(clusterId, true);
  const bound = useBoundPods(clusterId, true);
  const peersWanted = needsPeers(pod);
  const peerList = useSharedList(clusterId, POD, pod.metadata?.namespace ?? null, peersWanted);
  const { volumes, notes } = useVolumeAffinities(clusterId, pod);
  const peers = useMemo<PeerPod[] | undefined>(
    () => (peersWanted && peerList.state?.status === "ready" ? peerList.items.map(peerPod).filter((p): p is PeerPod => p !== null) : undefined),
    [peersWanted, peerList.state?.status, peerList.items],
  );
  const ready = nodes.status !== "loading" && bound.status !== "loading";
  const result = useMemo(() => {
    if (!ready) return undefined;
    const input = { pod, nodes: [...nodes.rows.values()], used: usedByNode(bound.rows.values()), volumes };
    return checkNodes(peers ? { ...input, peers } : input);
  }, [ready, pod, nodes.rows, bound.rows, volumes, peers]);

  const requests = result
    ? formatParts(
        Object.entries(result.requests)
          .filter(([resource, value]) => resource !== "pods" && value > 0)
          .map(([resource, value]) => `${resource} ${formatAmount(resource, value)}`),
      )
    : "";

  const requestRows: FieldRow[] = [["requests", requests]];
  let body;
  if (nodes.status === "error" || bound.status === "error") body = <Note>{t("autoscaling:check.failed")}</Note>;
  else if (!result) body = <Note>{t("autoscaling:check.loading")}</Note>;
  else {
    const fitting = result.verdicts.filter((v) => v.fits);
    const shown = [...fitting, ...result.verdicts.filter((v) => !v.fits)].slice(0, MAX_SHOWN_NODES);
    const summary: Phrase =
      result.total === 0
        ? phrase("check.noNodes", undefined, "danger")
        : fitting.length === 0
          ? phrase("check.none", undefined, "danger")
          : phrase("check.fits", { count: fitting.length, total: result.verdicts.length }, "warning");
    body = (
      <>
        <PhraseLine phrase={summary} />
        {fitting.length > 0 && <Note>{t("autoscaling:check.fitsButPending")}</Note>}
        {result.total > result.verdicts.length && <Note>{t("autoscaling:check.bounded", { count: result.verdicts.length, total: result.total })}</Note>}
        {(nodes.truncated || bound.truncated) && <Note>{t("autoscaling:check.truncated")}</Note>}
        {schedulerTotal !== undefined && schedulerTotal !== result.total && (
          <Note>{t("autoscaling:check.otherTotal", { scheduler: schedulerTotal, total: result.total })}</Note>
        )}
        {table(
          [t("autoscaling:check.node"), t("autoscaling:check.why")],
          shown.map((v) => [
            link(KINDS.node, v.node),
            v.fits ? (
              <StatusText value={t("autoscaling:check.fitsNode")} tone="success" />
            ) : (
              <span className="as-lines">
                {v.reasons.map((r, i) => (
                  <span key={i}>{t(`autoscaling:${r.key}`, r.params ?? {})}</span>
                ))}
              </span>
            ),
          ]),
          TWO_WRAP,
        )}
        {result.verdicts.length > shown.length && <Note>{t("autoscaling:check.more", { count: result.verdicts.length - shown.length })}</Note>}
        {result.unchecked.map((p) => (
          <Note key={p.key}>{t(`autoscaling:${p.key}`)}</Note>
        ))}
      </>
    );
  }

  return (
    <>
      <h4 className="as-subtitle">{t("autoscaling:check.title")}</h4>
      <Fields labelPrefix={FIELDS} rows={requestRows} />
      <Phrases phrases={notes} />
      {body}
    </>
  );
}

function Karpenter({ clusterId, events }: { clusterId: ClusterId; events: readonly EventRow[] }) {
  const { t } = useTranslation();
  const pools = useSharedList(clusterId, NODE_POOL, null);
  const nominations = useMemo(() => nominationsOf(events), [events]);
  const claims = useSharedList(clusterId, NODE_CLAIM, null, pools.served === true);
  const own = useMemo(() => events.filter(isKarpenterEvent), [events]);
  if (pools.served !== true) return null;
  const nominated = nominations.claims.map((name) => {
    const claim = claims.items.find((c) => c.metadata?.name === name);
    return { name, claim, problem: claim ? launchProblem(claim) : undefined };
  });
  const atLimit = pools.items
    .map((p) => ({ name: p.metadata?.name ?? "", reached: reachedLimits(p) }))
    .filter((p) => p.reached.length > 0)
    .map((p) => phrase("karpenter.poolLimit", { name: p.name, resources: formatList(p.reached) }, "danger"));

  return (
    <>
      <h4 className="as-subtitle">{t("autoscaling:karpenter.title")}</h4>
      {nominated.length === 0 && own.length === 0 && <Note>{t("autoscaling:karpenter.noDecision")}</Note>}
      {nominated.length > 0 &&
        table(
          [t("autoscaling:karpenter.nodeClaim"), t("autoscaling:karpenter.state")],
          nominated.map((n) => [
            link(NODE_CLAIM_TYPE, n.name),
            n.problem ? (
              <span className={`as-tone--${n.problem.tone ?? "neutral"}`}>{t(`autoscaling:${n.problem.key}`, n.problem.params ?? {})}</span>
            ) : n.claim ? (
              <StatusText value={t("autoscaling:karpenter.launched")} tone="success" />
            ) : (
              <span className="as-muted">{t("autoscaling:karpenter.claimGone")}</span>
            ),
          ]),
          TWO_WRAP,
        )}
      <Phrases phrases={atLimit} />
      <EventsTable events={own} />
    </>
  );
}

function caRows(ca: CaStatus): FieldRow[] {
  return [
    ["caHealth", ca.health ? <StatusText value={ca.health} tone={ca.health === "Healthy" ? "success" : "danger"} /> : null],
    ["caScaleUp", ca.scaleUp ?? null],
    ["caScaleDown", ca.scaleDown ?? null],
    ["caNodes", ca.registered !== undefined ? `${ca.ready ?? "?"}/${ca.registered}` : null],
    ["caTime", ca.time ? <Age timestamp={ca.time} /> : null],
  ];
}

export function CaStatusFields({ ca }: { ca: CaStatus }) {
  return (
    <Fields labelPrefix={FIELDS} rows={caRows(ca)} />
  );
}

function ClusterAutoscaler({ clusterId, events }: { clusterId: ClusterId; events: readonly EventRow[] }) {
  const { t } = useTranslation();
  const own = useMemo(() => events.filter(isCaEvent), [events]);
  // The status ConfigMap is read only once Cluster Autoscaler has said something about this pod.
  const configMap = useObject(clusterId, own.length > 0 ? CONFIG_MAP : null, STATUS_NAMESPACE, STATUS_NAME);
  const ca = useMemo(() => parseCaStatus(configMap), [configMap]);
  if (own.length === 0) return null;
  const latest = [...own].sort((a, b) => (b.time ?? "").localeCompare(a.time ?? ""))[0]!;
  const groups = latest.reason === "TriggeredScaleUp" ? triggeredGroups(latest.message) : [];
  const reasons = latest.reason === "NotTriggerScaleUp" ? notTriggeredReasons(latest.message) : [];
  const triggered =
    groups.length > 0
      ? phrase(
          "ca.triggered",
          { groups: formatList(groups.map((g) => `${g.group} ${g.from}→${g.to}${g.max !== undefined ? ` (max ${g.max})` : ""}`)) },
          "success",
        )
      : null;
  return (
    <>
      <h4 className="as-subtitle">{t("autoscaling:ca.title")}</h4>
      {triggered && <PhraseLine phrase={triggered} />}
      {reasons.length > 0 && (
        <>
          <PhraseLine phrase={NOT_TRIGGERED} />
          <ReasonsTable reasons={reasons} countHeader={t("autoscaling:ca.groups")} />
        </>
      )}
      {ca && <CaStatusFields ca={ca} />}
      <EventsTable events={own} />
    </>
  );
}

