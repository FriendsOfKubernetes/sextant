// A RayCluster's details: its state in words and why (the failing condition or `status.reason`), the head pod with
// its logs, IP and Service, the workers ready of desired, each worker group's replicas, bounds and ready pods, and the
// cluster's pods (selected by `ray.io/cluster`) with the merged logs of the workers.
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import { status, StatusText } from "../../resources";
import { Block, chips, Fields, KINDS, link, table, type ColumnWrap, type FieldRow } from "../details";
import { ClusterStateText } from "./columns";
import { useRayPods } from "./hooks";
import { clusterReason, clusterState, endpointsOf, GROUP_LABEL, headOf, NODE_TYPE_LABEL, CLUSTER_LABEL, workerGroups, workersOf } from "./model";
import { LABELS, Muted, Note, PodLogsButton, SelectorLogsButton } from "./parts";

const { arr, get, podStatus, record, str, statusTone } = status;

/** Pods listed in one view; the rest are counted. */
export const MAX_LISTED_PODS = 50;

const POD_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap", "nowrap"];
const GROUP_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap", "nowrap", "nowrap"];

const labelOf = (pod: KubeObject, key: string): string | undefined => str(record(pod.metadata?.labels)[key]);
const isReady = (pod: KubeObject) => arr(get(pod, "status", "conditions")).some((c) => get(c, "type") === "Ready" && get(c, "status") === "True");

export function ClusterView({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const name = obj.metadata?.name;
  const state = clusterState(obj);
  const head = headOf(obj);
  const workers = workersOf(obj);
  const { pods, loading, error, truncated } = useRayPods(clusterId, ns, name);
  const headPod = pods.find((p) => p.metadata?.name === head.podName) ?? pods.find((p) => labelOf(p, NODE_TYPE_LABEL) === "head");
  const reason = clusterReason(obj);
  const workerSelector = `${CLUSTER_LABEL}=${name ?? ""},${NODE_TYPE_LABEL}=worker`;
  const logsTitle = `raycluster/${name ?? ""}`;
  const desired = (["CPU", "Memory", "GPU", "TPU"] as const).map((r) => {
    const v = get(obj, "status", `desired${r}`);
    return v === undefined || v === null || v === "0" || v === 0 ? undefined : t(`kuberay:desiredResource.${r}`, { value: String(v) });
  });
  const rows: FieldRow[] = [
    ["status", <ClusterStateText key="s" obj={obj} />],
    ["rayVersion", str(get(obj, "spec", "rayVersion"))],
    ["workers", t("kuberay:workersReady", { ready: workers.ready, desired: workers.desired })],
    ["workerBounds", workers.min !== undefined && workers.max !== undefined ? t("kuberay:bounds", { min: workers.min, max: workers.max }) : null],
    ["headPod", link(KINDS.pod, head.podName ?? headPod?.metadata?.name, ns)],
    ["headPodIP", head.podIP],
    ["headService", link(KINDS.service, head.serviceName, ns)],
    ["headServiceIP", head.serviceIP],
    ["endpoints", chips(endpointsOf(obj))],
    ["desired", chips(desired)],
  ];
  const ready = new Map<string, number>();
  for (const p of pods) {
    const g = labelOf(p, GROUP_LABEL);
    if (g && labelOf(p, NODE_TYPE_LABEL) === "worker" && isReady(p)) ready.set(g, (ready.get(g) ?? 0) + 1);
  }
  const groups = workerGroups(obj).map((g) => [
    g.name,
    g.replicas === undefined ? "" : String(g.replicas * g.hosts),
    t("kuberay:bounds", { min: g.min ?? 0, max: g.max ?? 0 }),
    loading || error ? "" : String(ready.get(g.name) ?? 0),
    g.suspended ? t("kuberay:yes") : t("kuberay:no"),
  ]);
  const listed = pods.slice(0, MAX_LISTED_PODS).map((p) => {
    const phase = podStatus(p);
    return [
      link(KINDS.pod, p.metadata?.name, ns),
      labelOf(p, NODE_TYPE_LABEL) ?? "",
      labelOf(p, GROUP_LABEL) ?? "",
      <StatusText key="p" value={phase} tone={statusTone(phase)} />,
    ];
  });
  const groupsTable = table(
    "rayWorkerGroups",
    [t("kuberay:groups.name"), t("kuberay:groups.desired"), t("kuberay:groups.bounds"), t("kuberay:groups.ready"), t("kuberay:groups.suspended")],
    groups,
    GROUP_WRAP,
  );
  const podsTable = table("rayPods", [t("kuberay:pods.name"), t("kuberay:pods.type"), t("kuberay:pods.group"), t("kuberay:pods.status")], listed, POD_WRAP);
  return (
    <>
      {(state === "failed" || state === "headNotReady") && reason && <Note text={reason} tone="danger" />}
      {state === "provisioning" && reason && <Note text={reason} tone="warning" />}
      {(state === "suspended" || state === "suspending") && <Muted text={t(`kuberay:suspendedNote.${state}`)} />}
      <Fields rows={rows} labelPrefix={LABELS} />
      <Block title={t("kuberay:groups.title")}>
        {groupsTable}
        {groups.length === 0 && <Muted text={t("kuberay:groups.none")} />}
      </Block>
      <Block
        title={t("kuberay:pods.title")}
        actions={
          ns && name ? (
            <span className="kr-actions">
              {headPod && <PodLogsButton clusterId={clusterId} pod={headPod} label={t("kuberay:pods.headLogs")} />}
              <SelectorLogsButton
                clusterId={clusterId}
                namespace={ns}
                selector={workerSelector}
                title={logsTitle}
                text={t("kuberay:pods.workerLogs")}
              />
            </span>
          ) : undefined
        }
      >
        {loading && <Muted text={t("kuberay:pods.loading")} />}
        {error && <Muted text={t("kuberay:pods.error")} />}
        {podsTable}
        {!loading && !error && pods.length === 0 && <Muted text={t("kuberay:pods.none")} />}
        {pods.length > MAX_LISTED_PODS && <Muted text={t("kuberay:pods.more", { count: pods.length - MAX_LISTED_PODS })} />}
        {truncated && <Muted text={t("kuberay:pods.truncated")} />}
      </Block>
    </>
  );
}
