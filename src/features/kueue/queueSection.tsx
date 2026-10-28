import { useClusterKinds } from "../../resources";
import { useDisclosureProbe, useDisclosureProbeResult } from "../details/disclosureProbe";
// The "Queue" section of a job Kueue can queue (a Job, a JobSet, a RayJob, a Kubeflow job, …): its LocalQueue (the
// `kueue.x-k8s.io/queue-name` label) and its Workload — found by the label Kueue puts on it (the job's uid) and its
// owner reference, or the prebuilt Workload the job names — with the Workload's state and why it waits. Shown only
// where the cluster serves Workloads, and for a job without the queue label only when Kueue made a Workload for it
// (`manageJobsWithoutQueueName`). Read-only.
import { useTranslation } from "react-i18next";
import type { KindRef } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { status } from "../../resources";
import { Block, Fields, link, type FieldRow } from "../details";
import { useJobWorkloads } from "./hooks";
import { QUEUE_LABEL } from "./model";
import { Muted, TYPES } from "./ui";
import { WorkloadSummary } from "./workloadView";

/** Kinds Kueue's integrations queue (pkg/controller/jobs), by group and kind. */
export const QUEUED_KINDS: readonly Pick<KindRef, "group" | "kind">[] = [
  { group: "batch", kind: "Job" },
  { group: "jobset.x-k8s.io", kind: "JobSet" },
  { group: "ray.io", kind: "RayJob" },
  { group: "ray.io", kind: "RayCluster" },
  { group: "kubeflow.org", kind: "PyTorchJob" },
  { group: "kubeflow.org", kind: "TFJob" },
  { group: "kubeflow.org", kind: "XGBoostJob" },
  { group: "kubeflow.org", kind: "PaddleJob" },
  { group: "kubeflow.org", kind: "JAXJob" },
  { group: "kubeflow.org", kind: "MPIJob" },
  { group: "trainer.kubeflow.org", kind: "TrainJob" },
  { group: "leaderworkerset.x-k8s.io", kind: "LeaderWorkerSet" },
  { group: "workload.codeflare.dev", kind: "AppWrapper" },
];

const LABELS = "kueue:fields";

export const appliesToJob = (kind: Pick<KindRef, "group" | "kind">): boolean =>
  QUEUED_KINDS.some((k) => k.group === kind.group && k.kind === kind.kind);

export function QueueSection({ clusterId, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const probe = useDisclosureProbe("kueue:queue.title");
  const { enabled, result } = probe;
  const discovery = useClusterKinds(clusterId);
  const found = useJobWorkloads(clusterId, enabled ? obj : null);
  const queue = status.str(status.record(obj?.metadata?.labels)[QUEUE_LABEL]);
  const items = found.items;
  const answer = queue || (items?.length ?? 0) > 0 ? "present" : found.failed || discovery.error ? "unknown" : found.served === false || items ? "absent" : null;
  const view = useDisclosureProbeResult(probe, answer);
  if (!probe.open && result) return view.visible ? <Block id="kueue:queue.title" title={t("kueue:queue.title")}>{null}</Block> : null;
  if (!obj || (found.served === false && !discovery.error)) return null;
  if (!view.visible) return null;
  const ns = obj.metadata?.namespace ?? null;
  const queueRows: FieldRow[] = [["queue", link(TYPES.localQueue, queue, ns)]];
  return (
    <Block id="kueue:queue.title" title={t("kueue:queue.title")}>
      {queue && <Fields rows={queueRows} labelPrefix={LABELS} />}
      {answer === "unknown" ? <Muted text={t("kueue:listUnknown")} /> : items === undefined ? (
        <Muted text={t("kueue:loading")} />
      ) : items.length === 0 ? (
        <Muted text={found.failed ? t("kueue:listUnknown") : t("kueue:queue.noWorkload")} />
      ) : (
        items.map((w) => <WorkloadSummary key={w.metadata?.uid ?? w.metadata?.name} obj={w} />)
      )}
    </Block>
  );
}
