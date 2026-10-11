// Deployment, StatefulSet, DaemonSet, ReplicaSet, Job and CronJob: replicas, selector, strategy, schedule and the
// pod template's containers. Conditions come from the shared conditions section.
import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../../api";
import { Age } from "../../../components";
import { status } from "../../../resources";
import {
  chips,
  Fields,
  inline,
  KINDS,
  labelSelector,
  link,
  mapChips,
  nsOf,
  strings,
  text,
  tolerations,
  type FieldRow,
} from "../ui";
import { ContainerList } from "./pods";

const { arr, get, num, str } = status;

const n = (value: unknown) => num(value) ?? 0;

function Template({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const spec = get(obj, "spec", "template", "spec");
  const ns = nsOf(obj);
  const rows: FieldRow[] = [
    ["nodeSelector", mapChips(get(spec, "nodeSelector"))],
    ["tolerations", chips(tolerations(get(spec, "tolerations")))],
    ["serviceAccount", link(KINDS.serviceAccount, str(get(spec, "serviceAccountName")), ns)],
  ];
  const containers = [...arr(get(spec, "initContainers")), ...arr(get(spec, "containers"))];
  const title = t("details:workload.templateContainers");
  return (
    <>
      <Fields rows={rows} />
      <ContainerList title={title} containers={containers} namespace={ns} />
    </>
  );
}

/** "RollingUpdate (max surge 25%, max unavailable 25%)", "Recreate", "OnDelete". */
function strategy(obj: KubeObject, field: string, t: TFunction): ReactNode {
  const value = get(obj, "spec", field);
  const type = str(get(value, "type"));
  if (!type) return null;
  const rolling = get(value, "rollingUpdate");
  if (!rolling) return type;
  return t("details:workload.rollingUpdate", {
    type,
    maxSurge: text(get(rolling, "maxSurge")) ?? "-",
    maxUnavailable: text(get(rolling, "maxUnavailable")) ?? "-",
  });
}

/** Deployment, StatefulSet and ReplicaSet. */
export function ReplicatedDetails({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const s = get(obj, "status");
  const replicaSet = obj.kind === "ReplicaSet";
  const statefulSet = obj.kind === "StatefulSet";
  const rows: FieldRow[] = [
    [
      "replicas",
      t("details:workload.replicas", {
        desired: n(get(obj, "spec", "replicas")),
        updated: n(get(s, "updatedReplicas") ?? (replicaSet ? get(s, "replicas") : 0)),
        current: n(get(s, "replicas")),
        ready: n(get(s, "readyReplicas")),
        available: n(get(s, "availableReplicas")),
      }),
    ],
    ["selector", labelSelector(get(obj, "spec", "selector"))],
    ["strategy", strategy(obj, statefulSet ? "updateStrategy" : "strategy", t)],
    ["serviceName", link(KINDS.service, str(get(obj, "spec", "serviceName")), nsOf(obj))],
    ["podManagementPolicy", str(get(obj, "spec", "podManagementPolicy"))],
    [
      "volumeClaimTemplates",
      chips(arr(get(obj, "spec", "volumeClaimTemplates")).map((v) => str(get(v, "metadata", "name")) ?? "")),
    ],
  ];
  return (
    <>
      <Fields rows={rows} />
      <Template obj={obj} />
    </>
  );
}

export function DaemonSetDetails({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const s = get(obj, "status");
  const rows: FieldRow[] = [
    [
      "pods",
      t("details:workload.daemonPods", {
        desired: n(get(s, "desiredNumberScheduled")),
        current: n(get(s, "currentNumberScheduled")),
        updated: n(get(s, "updatedNumberScheduled")),
        ready: n(get(s, "numberReady")),
        available: n(get(s, "numberAvailable")),
      }),
    ],
    ["selector", labelSelector(get(obj, "spec", "selector"))],
    ["strategy", strategy(obj, "updateStrategy", t)],
  ];
  return (
    <>
      <Fields rows={rows} />
      <Template obj={obj} />
    </>
  );
}

export function JobDetails({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const s = get(obj, "status");
  const spec = get(obj, "spec");
  const rows: FieldRow[] = [
    ["completions", `${n(get(s, "succeeded"))}/${text(get(spec, "completions")) ?? "1"}`],
    ["parallelism", text(get(spec, "parallelism"))],
    ["backoffLimit", text(get(spec, "backoffLimit"))],
    [
      "pods",
      t("details:workload.jobPods", { active: n(get(s, "active")), succeeded: n(get(s, "succeeded")), failed: n(get(s, "failed")) }),
    ],
    ["started", str(get(s, "startTime"))],
    ["completed", str(get(s, "completionTime"))],
    ["selector", labelSelector(get(spec, "selector"))],
  ];
  return (
    <>
      <Fields rows={rows} />
      <Template obj={obj} />
    </>
  );
}

function age(timestamp: string | undefined): ReactNode {
  return timestamp ? <Age timestamp={timestamp} /> : null;
}

export function CronJobDetails({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const spec = get(obj, "spec");
  const s = get(obj, "status");
  const ns = nsOf(obj);
  const jobs = arr(get(s, "active")).map((j) => link(KINDS.job, str(get(j, "name")), str(get(j, "namespace")) ?? ns));
  const images = strings(arr(get(spec, "jobTemplate", "spec", "template", "spec", "containers")).map((c) => get(c, "image")));
  const rows: FieldRow[] = [
    ["schedule", str(get(spec, "schedule"))],
    ["timeZone", str(get(spec, "timeZone"))],
    ["suspend", get(spec, "suspend") === true ? t("details:yes") : t("details:no")],
    ["concurrencyPolicy", str(get(spec, "concurrencyPolicy"))],
    ["lastSchedule", age(str(get(s, "lastScheduleTime")))],
    ["lastSuccessful", age(str(get(s, "lastSuccessfulTime")))],
    ["activeJobs", inline(jobs)],
    ["images", chips(images)],
  ];
  return <Fields rows={rows} />;
}
