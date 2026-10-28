import { useDetailsDisclosure } from "../../layout/details/disclosure";
// Details of a Machine (its bootstrap and infrastructure objects read by name, the Node in the workload cluster), of
// MachineDeployments, MachineSets and KubeadmControlPlanes (replica counts, templates, their Machines by the
// selector their controller uses) and of MachineHealthChecks (what is checked, healthy of expected, remediations
// allowed and why they are blocked).
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import { status } from "../../resources";
import { controllerOf } from "../../resources/status";
import { Block, chips, Fields, KINDS, link, table, type ColumnWrap, type FieldRow } from "../details";
import { labelSelector } from "../details/ui";
import { StateText } from "./columns";
import { MAX_CHAIN_OBJECTS, MAX_LISTED, useListed, useRefObjects, type Fetched } from "./hooks";
import {
  addressesOf,
  availableOf,
  bootstrapRefOf,
  CAPI_CLUSTER,
  CAPI_GROUP,
  clusterNameOf,
  endpointOf,
  failureOf,
  firstFailing,
  healthCheckSpecOf,
  healthCheckState,
  healthCountsOf,
  conditionsOf,
  infrastructureRefOf,
  isLegacy,
  isPaused,
  kcpInitialized,
  kcpTemplateRefOf,
  MACHINE,
  machineSelectorOf,
  machineState,
  nodeNameOf,
  phaseOf,
  providerFields,
  refFrom,
  remediationBlocked,
  replicasOf,
  scalableState,
  type UnhealthyCondition,
} from "./model";
import { date, Explain, fetchedOf, LABELS, Message, RefValue, useRefLink, WorkloadClusters } from "./parts";

const { arr, get, num, str } = status;
const CLUSTER_TYPE = { apiVersion: `${CAPI_GROUP}/v1beta2`, kind: CAPI_CLUSTER.kind };
const nsOf = (obj: KubeObject) => obj.metadata?.namespace ?? null;
const count = (n: number | undefined) => (n === undefined ? undefined : String(n));

function OwnerLink({ obj }: { obj: KubeObject }) {
  const owner = controllerOf(obj);
  return owner ? <>{link({ apiVersion: owner.apiVersion, kind: owner.kind }, owner.name, nsOf(obj), `${owner.kind}/${owner.name}`)}</> : null;
}

/**
 * Whether the object's Cluster is paused (read by name): its controllers then change nothing in the object, which
 * may not say so itself (an old-only status has no Paused condition). `unread`: the Cluster could not be read and the
 * object has no new conditions, so whether it is paused is not known (#243, ADR-0113 amendment).
 */
function clusterPause(obj: KubeObject, fetched: Fetched | undefined): { paused: boolean; unread: boolean } {
  if (fetched && "obj" in fetched) return { paused: isPaused(fetched.obj), unread: false };
  return { paused: false, unread: fetched !== undefined && conditionsOf(obj).length === 0 };
}

/** What the details say of the Cluster's pause, if anything. */
function ClusterPauseNote({ name, pause }: { name: string | undefined; pause: { paused: boolean; unread: boolean } }) {
  const { t } = useTranslation();
  if (!name || (!pause.paused && !pause.unread)) return null;
  return <p className="cm-muted">{t(pause.paused ? "clusterapi:explain.clusterPaused" : "clusterapi:explain.clusterUnread", { name })}</p>;
}

const clusterRefOf = (obj: KubeObject) => {
  const name = clusterNameOf(obj);
  return name ? { group: CAPI_GROUP, kind: CAPI_CLUSTER.kind, name, namespace: nsOf(obj) } : undefined;
};

export function MachineView({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const linkTo = useRefLink(clusterId);
  const clusterName = clusterNameOf(obj);
  const clusterRef = clusterRefOf(obj);
  const bootstrap = bootstrapRefOf(obj);
  const infrastructure = infrastructureRefOf(obj);
  const refs = [clusterRef, bootstrap, infrastructure].filter((r) => r !== undefined);
  const fieldsOpen = useDetailsDisclosure("details:sections.fields")?.open ?? true;
  const read = useRefObjects(clusterId, fieldsOpen ? refs : [], str(obj.metadata?.resourceVersion) ?? "");
  const fetchedCluster = fetchedOf(read.byKey, clusterRef);
  const pause = clusterPause(obj, fetchedCluster);
  const own = machineState(obj);
  const state = pause.paused && own !== "deleting" && own !== "failed" ? "paused" : own;
  const infraFetched = fetchedOf(read.byKey, infrastructure);
  const infraObj = infraFetched && "obj" in infraFetched ? infraFetched.obj : undefined;
  const node = nodeNameOf(obj);
  const endpoint = fetchedCluster && "obj" in fetchedCluster ? endpointOf(fetchedCluster.obj) : undefined;
  const dataSecret = str(get(obj, "spec", "bootstrap", "dataSecretName"));
  const rows: FieldRow[] = [
    ["state", <StateText key="s" obj={obj} state={state} />],
    ["phase", phaseOf(obj)],
    ["cluster", link(CLUSTER_TYPE, clusterName, nsOf(obj))],
    ["owner", controllerOf(obj) ? <OwnerLink key="o" obj={obj} /> : undefined],
    ["version", str(get(obj, "spec", "version"))],
    ["providerID", str(get(obj, "spec", "providerID"))],
    ["failureDomain", str(get(obj, "spec", "failureDomain")) ?? str(get(obj, "status", "failureDomain"))],
    ["node", node],
    ["workloadCluster", node && endpoint ? <WorkloadClusters key="w" endpoint={endpoint} node={node} /> : undefined],
    ["addresses", chips(addressesOf(obj))],
    ["bootstrap", bootstrap ? <RefValue key="b" ref={bootstrap} fetched={fetchedOf(read.byKey, bootstrap)} linkTo={linkTo} /> : undefined],
    ["dataSecret", link(KINDS.secret, dataSecret, nsOf(obj))],
    ["infrastructure", infrastructure ? <RefValue key="i" ref={infrastructure} fetched={infraFetched} linkTo={linkTo} /> : undefined],
    ...(infraObj ? providerFields(infraObj).map(([key, value]): FieldRow => [`provider.${key}`, value]) : []),
    ["lastUpdated", date(str(get(obj, "status", "lastUpdated")))],
  ];
  const note = state === "failed" || state === "provisioning" || state === "notReady" || state === "paused" || state === "deleting" ? t(`clusterapi:explain.machine.${state}`, { phase: phaseOf(obj) ?? "" }) : undefined;
  const failing = firstFailing(obj);
  return (
    <Block id="details:sections.fields" title={t("details:sections.fields", { kind: MACHINE.kind })}>
      <Explain text={note} danger={state === "failed" || state === "notReady"} />
      <ClusterPauseNote name={clusterName} pause={pause} />
      <Message text={failureOf(obj)?.message ?? (state !== "running" ? failing?.message : undefined)} />
      <Fields rows={rows} labelPrefix={LABELS} />
    </Block>
  );
}

/** The Machines a selector picks in the object's namespace (≤ `MAX_LISTED`). */
function MachineList({ clusterId, namespace, selector }: { clusterId: ClusterId; namespace: string | null; selector: string | undefined }) {
  const { t } = useTranslation();
  const open = useDetailsDisclosure("clusterapi:machines.title")?.open ?? true;
  const listed = useListed(clusterId, MACHINE, namespace, open ? selector : undefined);
  if (!selector) return null;
  const shown = listed.items.slice(0, MAX_LISTED);
  const rows = shown.map((m) => [
    link({ apiVersion: m.apiVersion ?? `${CAPI_GROUP}/v1beta2`, kind: MACHINE.kind }, m.metadata?.name, namespace),
    <StateText key="s" obj={m} state={machineState(m)} />,
    nodeNameOf(m) ?? "",
  ]);
  return (
    <Block id="clusterapi:machines.title" title={t("clusterapi:machines.title")}>
      {listed.unavailable && <p className="cm-muted">{t("clusterapi:chain.unavailable")}</p>}
      {shown.length === 0 && !listed.unavailable && <p className="cm-muted">{listed.loading ? t("clusterapi:chain.loading") : t("clusterapi:machines.none")}</p>}
      {shown.length > 0 && table(MACHINES_TABLE, [t("clusterapi:machines.name"), t("clusterapi:machines.state"), t("clusterapi:machines.node")], rows, WRAP)}
      {listed.items.length > MAX_LISTED && <p className="cm-muted">{t("clusterapi:chain.more", { count: listed.items.length - MAX_LISTED })}</p>}
      {listed.truncated && <p className="cm-muted">{t("clusterapi:chain.truncated", { count: MAX_CHAIN_OBJECTS })}</p>}
    </Block>
  );
}
const WRAP: ColumnWrap[] = [undefined, "nowrap", undefined];
const MACHINES_TABLE = "capiMachines";

/** The terminal failure, or why the object is not available, as the cluster words it. */
const whyNot = (obj: KubeObject, state: string) =>
  failureOf(obj)?.message ?? (state === "notAvailable" ? availableOf(obj)?.message : undefined);

function replicaRows(obj: KubeObject): FieldRow[] {
  const r = replicasOf(obj);
  return [
    ["desired", count(r.desired)],
    ["current", count(r.current)],
    ["ready", count(r.ready)],
    ["available", count(r.available)],
    ["upToDate", count(r.upToDate)],
  ];
}

const groupNote = (state: string) => (state === "failed" || state === "notAvailable" || state === "rollingOut" || state === "scaling" || state === "paused" || state === "provisioning" ? state : undefined);

/** A MachineDeployment or MachineSet. */
export function MachineGroupView({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const linkTo = useRefLink(clusterId);
  const state = scalableState(obj);
  const template = get(obj, "spec", "template", "spec");
  const strategy = str(get(obj, "spec", "rollout", "strategy", "type")) ?? str(get(obj, "spec", "strategy", "type"));
  const rows: FieldRow[] = [
    ["state", <StateText key="s" obj={obj} state={state} />],
    ["phase", phaseOf(obj)],
    ["cluster", link(CLUSTER_TYPE, clusterNameOf(obj), nsOf(obj))],
    ["owner", controllerOf(obj) ? <OwnerLink key="o" obj={obj} /> : undefined],
    ...replicaRows(obj),
    ["version", str(get(template, "version"))],
    ["strategy", strategy],
    ["bootstrapTemplate", linkTo(refFrom(get(template, "bootstrap", "configRef"), nsOf(obj)))],
    ["infrastructureTemplate", linkTo(refFrom(get(template, "infrastructureRef"), nsOf(obj)))],
  ];
  const key = groupNote(state);
  return (
    <>
      <Block id="details:sections.fields" title={t("details:sections.fields", { kind: obj.kind ?? "" })}>
        <Explain text={key ? t(`clusterapi:explain.group.${key}`) : undefined} danger={state === "failed" || state === "notAvailable"} />
        <Message text={whyNot(obj, state)} />
        <Fields rows={rows} labelPrefix={LABELS} />
      </Block>
      <MachineList clusterId={clusterId} namespace={nsOf(obj)} selector={machineSelectorOf(obj)} />
    </>
  );
}

export function ControlPlaneView({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const linkTo = useRefLink(clusterId);
  const clusterRef = clusterRefOf(obj);
  const fieldsOpen = useDetailsDisclosure("details:sections.fields")?.open ?? true;
  const read = useRefObjects(clusterId, fieldsOpen && clusterRef ? [clusterRef] : [], str(obj.metadata?.resourceVersion) ?? "");
  const pause = clusterPause(obj, fetchedOf(read.byKey, clusterRef));
  const own = scalableState(obj);
  const state = pause.paused && own !== "deleting" && own !== "failed" ? "paused" : own;
  const initialized = kcpInitialized(obj);
  const last = get(obj, "status", "lastRemediation");
  const rows: FieldRow[] = [
    ["state", <StateText key="s" obj={obj} state={state} />],
    ["cluster", link(CLUSTER_TYPE, clusterNameOf(obj), nsOf(obj))],
    ["version", str(get(obj, "spec", "version"))],
    ["initialized", initialized === undefined ? undefined : initialized ? t("clusterapi:yes") : t("clusterapi:no")],
    ...replicaRows(obj),
    ["infrastructureTemplate", linkTo(kcpTemplateRefOf(obj))],
    ["lastRemediation", str(get(last, "machine"))],
    ["lastRemediationTime", date(str(get(last, "time")) ?? str(get(last, "timestamp")))],
    ["retryCount", count(num(get(last, "retryCount")))],
  ];
  const key = groupNote(state);
  return (
    <>
      <Block id="details:sections.fields" title={t("details:sections.fields", { kind: obj.kind ?? "" })}>
        <Explain text={key ? t(`clusterapi:explain.group.${key}`) : undefined} danger={state === "failed" || state === "notAvailable"} />
        <ClusterPauseNote name={clusterRef?.name} pause={pause} />
        <Message text={whyNot(obj, state)} />
        <Fields rows={rows} labelPrefix={LABELS} />
      </Block>
      <MachineList clusterId={clusterId} namespace={nsOf(obj)} selector={machineSelectorOf(obj)} />
    </>
  );
}

const CONDITION_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap"];

export function HealthCheckView({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const state = healthCheckState(obj);
  const spec = healthCheckSpecOf(obj);
  const counts = healthCountsOf(obj);
  const blocked = remediationBlocked(obj);
  const targets = arr(get(obj, "status", "targets")).map(String);
  const conditionTable = (id: string, list: UnhealthyCondition[]) =>
    list.length > 0
      ? table(id, [t("clusterapi:healthCheck.type"), t("clusterapi:healthCheck.status"), t("clusterapi:healthCheck.timeout")], list.map((c) => [c.type, c.status, c.timeout ?? ""]), CONDITION_WRAP)
      : null;
  const rows: FieldRow[] = [
    ["state", <StateText key="s" obj={obj} state={state} />],
    ["cluster", link(CLUSTER_TYPE, clusterNameOf(obj), nsOf(obj))],
    ["selector", labelSelector(get(obj, "spec", "selector"))],
    ["expected", count(counts.expected)],
    ["healthy", count(counts.healthy)],
    ["remediationsAllowed", count(counts.allowed)],
    ["maxUnhealthy", spec.maxUnhealthy],
    ["unhealthyRange", spec.unhealthyRange],
    ["nodeStartupTimeout", spec.nodeStartupTimeout],
    ["unhealthyNodeConditions", conditionTable("capiNodeConditions", spec.nodeConditions)],
    ["unhealthyMachineConditions", conditionTable("capiMachineConditions", spec.machineConditions)],
    ["targets", targets.length > 0 ? <TargetLinks key="t" obj={obj} names={targets} /> : undefined],
  ];
  const note = state === "blocked" || state === "remediating" ? t(`clusterapi:explain.healthCheck.${state}`, { healthy: counts.healthy ?? 0, expected: counts.expected ?? 0 }) : undefined;
  return (
    <Block id="details:sections.fields" title={t("details:sections.fields", { kind: obj.kind ?? "" })}>
      <Explain text={note} danger={state === "blocked"} />
      <Message text={blocked?.message} />
      <Fields rows={rows} labelPrefix={LABELS} />
    </Block>
  );
}

function TargetLinks({ obj, names }: { obj: KubeObject; names: string[] }) {
  const { t } = useTranslation();
  const apiVersion = isLegacy(obj) ? `${CAPI_GROUP}/v1beta1` : `${CAPI_GROUP}/v1beta2`;
  return (
    <span className="dt-links">
      {names.slice(0, MAX_LISTED).map((name) => link({ apiVersion, kind: MACHINE.kind }, name, nsOf(obj)))}
      {names.length > MAX_LISTED && <span className="cm-chain__extra">{t("clusterapi:chain.more", { count: names.length - MAX_LISTED })}</span>}
    </span>
  );
}
