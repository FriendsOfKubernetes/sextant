import { useDetailsDisclosure } from "../../layout/details/disclosure";
// A Cluster's details: its state in words, class, version and endpoint, the control plane and infrastructure objects
// (read by name), the Machine counts its status keeps, the workload cluster when Sextant has it, and the chain of its
// Machines: the control plane's, then each MachineDeployment → MachineSet → Machines, then any other Machines.
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import { status } from "../../resources";
import { Block, Fields, link, type FieldRow } from "../details";
import { planChain, type SetPlan } from "./chain";
import { StateText } from "./columns";
import { MAX_CHAIN_OBJECTS, MAX_LISTED, useListed, useRefObjects } from "./hooks";
import {
  availableOf,
  CLUSTER_CLASS,
  CLUSTER_NAME_LABEL,
  classOf,
  clusterReplicasOf,
  clusterState,
  controlPlaneRefOf,
  endpointOf,
  failureOf,
  infrastructureRefOf,
  MACHINE,
  MACHINE_DEPLOYMENT,
  MACHINE_SET,
  machineState,
  nodeNameOf,
  phaseOf,
  readyText,
  replicasOf,
  scalableState,
  type Replicas,
} from "./model";
import { Explain, fetchedOf, LABELS, Message, RefValue, useRefLink, WorkloadClusters } from "./parts";

const { get, str } = status;
const typeOf = (kind: { group: string; version: string; kind: string }) => ({ apiVersion: `${kind.group}/${kind.version}`, kind: kind.kind });

function useCountText(): (r: Replicas | undefined) => string | undefined {
  const { t } = useTranslation();
  return (r) => (r && (r.ready !== undefined || r.desired !== undefined) ? t("clusterapi:readyOf", { ready: r.ready ?? 0, desired: r.desired ?? r.current ?? 0 }) : undefined);
}

export function ClusterView({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const linkTo = useRefLink(clusterId);
  const countText = useCountText();
  const state = clusterState(obj);
  const controlPlane = controlPlaneRefOf(obj);
  const infrastructure = infrastructureRefOf(obj);
  const refs = [controlPlane, infrastructure].filter((r) => r !== undefined);
  const fieldsOpen = useDetailsDisclosure("details:sections.fields")?.open ?? true;
  const read = useRefObjects(clusterId, fieldsOpen ? refs : [], str(obj.metadata?.resourceVersion) ?? "");
  const endpoint = endpointOf(obj);
  const cls = classOf(obj);
  const counts = clusterReplicasOf(obj);
  const failure = failureOf(obj);
  const available = availableOf(obj);
  const rows: FieldRow[] = [
    ["state", <StateText key="s" obj={obj} state={state} />],
    ["phase", phaseOf(obj)],
    ["class", cls ? link(typeOf(CLUSTER_CLASS), cls.name, cls.namespace) : undefined],
    ["version", str(get(obj, "spec", "topology", "version"))],
    ["endpoint", endpoint ? `${endpoint.host}:${endpoint.port}` : undefined],
    ["controlPlane", controlPlane ? <RefValue key="cp" ref={controlPlane} fetched={fetchedOf(read.byKey, controlPlane)} linkTo={linkTo} /> : undefined],
    ["infrastructure", infrastructure ? <RefValue key="in" ref={infrastructure} fetched={fetchedOf(read.byKey, infrastructure)} linkTo={linkTo} /> : undefined],
    ["controlPlaneMachines", countText(counts.controlPlane)],
    ["workerMachines", countText(counts.workers)],
    ["workloadCluster", endpoint ? <WorkloadClusters key="w" endpoint={endpoint} /> : undefined],
  ];
  const note =
    state === "failed" || state === "notAvailable" || state === "provisioning" || state === "paused" || state === "deleting"
      ? t(`clusterapi:explain.cluster.${state}`)
      : undefined;
  return (
    <>
      <Block id="details:sections.fields" title={t("details:sections.fields", { kind: "Cluster" })}>
        <Explain text={note} danger={state === "failed" || state === "notAvailable"} />
        <Message text={failure?.message ?? (state === "notAvailable" || state === "provisioning" ? available?.message : undefined)} />
        <Fields rows={rows} labelPrefix={LABELS} />
      </Block>
      <MachineChain clusterId={clusterId} cluster={obj} />
    </>
  );
}

function GroupRow({ obj, kind }: { obj: KubeObject; kind: { group: string; version: string; kind: string } }) {
  const { t } = useTranslation();
  const r = readyText(replicasOf(obj));
  return (
    <span className="cm-chain__row">
      <span className="cm-chain__kind">{kind.kind}</span>
      {link({ apiVersion: obj.apiVersion ?? typeOf(kind).apiVersion, kind: kind.kind }, obj.metadata?.name, obj.metadata?.namespace ?? null)}
      <StateText obj={obj} state={scalableState(obj)} />
      {r && <span className="cm-chain__extra">{t("clusterapi:chain.ready", { ready: r })}</span>}
    </span>
  );
}

function MachineRow({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const node = nodeNameOf(obj);
  const infra = infrastructureRefOf(obj);
  return (
    <span className="cm-chain__row">
      <span className="cm-chain__kind">{MACHINE.kind}</span>
      {link({ apiVersion: obj.apiVersion ?? typeOf(MACHINE).apiVersion, kind: MACHINE.kind }, obj.metadata?.name, obj.metadata?.namespace ?? null)}
      <StateText obj={obj} state={machineState(obj)} />
      {node && <span className="cm-chain__extra">{t("clusterapi:chain.node", { node })}</span>}
      {infra && <span className="cm-chain__extra">{`${infra.kind}/${infra.name}`}</span>}
    </span>
  );
}

function MachineItems({ machines }: { machines: KubeObject[] }) {
  if (machines.length === 0) return null;
  return (
    <ul>
      {machines.map((m) => (
        <li key={m.metadata?.uid ?? m.metadata?.name} className="cm-chain__item">
          <MachineRow obj={m} />
        </li>
      ))}
    </ul>
  );
}

/** The Cluster's Machines and what owns them: label-selected watches of its namespace (served kinds only). */
function MachineChain({ clusterId, cluster }: { clusterId: ClusterId; cluster: KubeObject }) {
  const { t } = useTranslation();
  const ns = cluster.metadata?.namespace ?? null;
  const open = useDetailsDisclosure("clusterapi:chain.title")?.open ?? true;
  const selector = open && cluster.metadata?.name ? `${CLUSTER_NAME_LABEL}=${cluster.metadata.name}` : undefined;
  const deployments = useListed(clusterId, MACHINE_DEPLOYMENT, ns, selector);
  const sets = useListed(clusterId, MACHINE_SET, ns, selector);
  const machines = useListed(clusterId, MACHINE, ns, selector);
  const loading = deployments.loading || sets.loading || machines.loading;
  const plan = planChain(deployments.items, sets.items, machines.items, MAX_LISTED);
  const setItem = ({ set, machines: mine }: SetPlan) => (
    <li key={set.metadata?.uid ?? set.metadata?.name} className="cm-chain__item">
      <GroupRow obj={set} kind={MACHINE_SET} />
      <MachineItems machines={mine} />
    </li>
  );
  const empty = plan.controlPlane.length + plan.deployments.length + plan.sets.length + plan.others.length === 0;
  return (
    <Block id="clusterapi:chain.title" title={t("clusterapi:chain.title")}>
      {machines.unavailable && <p className="cm-muted">{t("clusterapi:chain.unavailable")}</p>}
      {empty && !machines.unavailable && <p className="cm-muted">{loading ? t("clusterapi:chain.loading") : t("clusterapi:chain.none")}</p>}
      <ul className="cm-chain">
        {plan.controlPlane.length > 0 && (
          <li className="cm-chain__item">
            <span className="cm-chain__row">{t("clusterapi:chain.controlPlane")}</span>
            <MachineItems machines={plan.controlPlane} />
          </li>
        )}
        {plan.deployments.map(({ deployment, sets: own }) => (
          <li key={deployment.metadata?.uid ?? deployment.metadata?.name} className="cm-chain__item">
            <GroupRow obj={deployment} kind={MACHINE_DEPLOYMENT} />
            {own.length > 0 && <ul>{own.map(setItem)}</ul>}
          </li>
        ))}
        {plan.sets.map(setItem)}
        {plan.others.length > 0 && (
          <li className="cm-chain__item">
            <span className="cm-chain__row">{t("clusterapi:chain.others")}</span>
            <MachineItems machines={plan.others} />
          </li>
        )}
      </ul>
      {plan.hidden > 0 && <p className="cm-muted">{t("clusterapi:chain.more", { count: plan.hidden })}</p>}
      {(deployments.truncated || sets.truncated || machines.truncated) && (
        <p className="cm-muted">{t("clusterapi:chain.truncated", { count: MAX_CHAIN_OBJECTS })}</p>
      )}
    </Block>
  );
}
