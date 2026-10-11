// Workloads: Pods, Deployments, DaemonSets, StatefulSets, ReplicaSets, Jobs, CronJobs — columns as in Lens.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { ageParts } from "../../components";
import { column, ObjectLink, standardColumns, StatusList, StatusText, statusColumn } from "../columns";
import { registerResource, type ColumnDef } from "../registry";
import {
  arr,
  containerStates,
  controllerOf,
  get,
  num,
  podRestarts,
  podStatus,
  readyOfDesired,
  selectorText,
  str,
  trueConditions,
  type ContainerState,
} from "../status";

function ContainerSquares({ pod }: { pod: KubeObject }) {
  const { t } = useTranslation();
  return (
    <span className="rt-containers">
      {containerStates(pod).map((c) => (
        <span
          key={`${c.init ? "init:" : ""}${c.name}`}
          className={`rt-container rt-container--${squareTone(c)}${c.init ? " rt-container--init" : ""}`}
          role="img"
          aria-label={t("resources:table.containerState", {
            name: c.name,
            state: c.reason ? `${c.state} (${c.reason})` : c.state,
          })}
          title={t("resources:table.containerState", {
            name: c.name,
            state: c.reason ? `${c.state} (${c.reason})` : c.state,
          })}
        />
      ))}
    </span>
  );
}

function squareTone(c: ContainerState): string {
  if (c.state === "running") return c.ready ? "ready" : "running";
  if (c.state === "terminated") return c.reason === "Completed" ? "done" : "failed";
  if (c.state === "waiting") return c.reason && /Err|BackOff|Crash/.test(c.reason) ? "failed" : "waiting";
  return "unknown";
}

const controlledByColumn: ColumnDef = column(
  "controlledBy",
  (o) => {
    const owner = controllerOf(o);
    return owner ? `${owner.kind}/${owner.name}` : undefined;
  },
  {
    width: "minmax(100px, 1fr)",
    render: (o) => {
      const owner = controllerOf(o);
      return owner ? <ObjectLink target={owner} namespace={o.metadata?.namespace ?? null} /> : null;
    },
  },
);

const pods: ColumnDef[] = standardColumns(
  true,
  column("containers", (o) => containerStates(o).length, {
    width: "minmax(90px, 1fr)",
    render: (o) => <ContainerSquares pod={o} />,
  }),
  column("restarts", podRestarts, { width: "80px" }),
  controlledByColumn,
  column("node", (o) => str(get(o, "spec", "nodeName")), {
    width: "minmax(120px, 1.5fr)",
    render: (o) => {
      const node = str(get(o, "spec", "nodeName"));
      return node ? <ObjectLink target={{ apiVersion: "v1", kind: "Node", name: node }} namespace={null}>{node}</ObjectLink> : null;
    },
  }),
  column("qos", (o) => str(get(o, "status", "qosClass")), { width: "100px" }),
);
// Lens shows Status last, after Age.
pods.push(statusColumn("status", podStatus, "130px"));

const conditionsColumn = column("conditions", (o) => trueConditions(o).join(" "), {
  width: "minmax(140px, 1.5fr)",
  render: (o) => <StatusList values={trueConditions(o)} />,
});

registerResource({
  kind: { group: "", version: "v1", kind: "Pod" },
  sidebar: { section: "workloads", order: 10, labelKey: "resources:kinds.pods" },
  columns: pods,
  actions: ["logs", "exec", "portForward", "edit", "delete"],
});

registerResource({
  kind: { group: "apps", version: "v1", kind: "Deployment" },
  sidebar: { section: "workloads", order: 20, labelKey: "resources:kinds.deployments" },
  columns: [
    ...standardColumns(
      true,
      column("pods", readyOfDesired, { width: "80px" }),
      column("replicas", (o) => num(get(o, "spec", "replicas")), { width: "80px" }),
    ),
    conditionsColumn,
  ],
  actions: ["scale", "restart", "logs", "edit", "delete"],
});

registerResource({
  kind: { group: "apps", version: "v1", kind: "DaemonSet" },
  sidebar: { section: "workloads", order: 30, labelKey: "resources:kinds.daemonsets" },
  columns: standardColumns(
    true,
    column(
      "pods",
      (o) => `${num(get(o, "status", "numberReady")) ?? 0}/${num(get(o, "status", "desiredNumberScheduled")) ?? 0}`,
      { width: "80px" },
    ),
    column("nodeSelector", (o) => selectorText(get(o, "spec", "template", "spec", "nodeSelector")), {
      width: "minmax(140px, 2fr)",
    }),
  ),
  actions: ["restart", "logs", "edit", "delete"],
});

registerResource({
  kind: { group: "apps", version: "v1", kind: "StatefulSet" },
  sidebar: { section: "workloads", order: 40, labelKey: "resources:kinds.statefulsets" },
  columns: standardColumns(
    true,
    column("pods", readyOfDesired, { width: "80px" }),
    column("replicas", (o) => num(get(o, "spec", "replicas")), { width: "80px" }),
  ),
  actions: ["scale", "restart", "logs", "edit", "delete"],
});

registerResource({
  kind: { group: "apps", version: "v1", kind: "ReplicaSet" },
  sidebar: { section: "workloads", order: 50, labelKey: "resources:kinds.replicasets" },
  columns: standardColumns(
    true,
    column("desired", (o) => num(get(o, "spec", "replicas")) ?? 0, { width: "80px" }),
    column("current", (o) => num(get(o, "status", "replicas")) ?? 0, { width: "80px" }),
    column("ready", (o) => num(get(o, "status", "readyReplicas")) ?? 0, { width: "80px" }),
  ),
  actions: ["scale", "edit", "delete"],
});

/** "Complete", "Failed", "Suspended" or "Running" — like Lens' job conditions. */
function jobConditions(job: KubeObject): string[] {
  const conditions = trueConditions(job).filter((c) => c !== "SuccessCriteriaMet" && c !== "FailureTarget");
  if (conditions.length > 0) return conditions;
  return (num(get(job, "status", "active")) ?? 0) > 0 ? ["Running"] : [];
}

registerResource({
  kind: { group: "batch", version: "v1", kind: "Job" },
  sidebar: { section: "workloads", order: 60, labelKey: "resources:kinds.jobs" },
  columns: [
    ...standardColumns(
      true,
      column(
        "completions",
        (o) => `${num(get(o, "status", "succeeded")) ?? 0}/${num(get(o, "spec", "completions")) ?? 1}`,
        { width: "100px" },
      ),
    ),
    column("conditions", (o) => jobConditions(o).join(" "), {
      width: "minmax(120px, 1fr)",
      render: (o) => <StatusList values={jobConditions(o)} />,
    }),
  ],
  actions: ["logs", "edit", "delete"],
});

registerResource({
  kind: { group: "batch", version: "v1", kind: "CronJob" },
  sidebar: { section: "workloads", order: 70, labelKey: "resources:kinds.cronjobs" },
  columns: standardColumns(
    true,
    column("schedule", (o) => str(get(o, "spec", "schedule")), { width: "minmax(110px, 1fr)" }),
    column("suspend", (o) => String(get(o, "spec", "suspend") === true), {
      width: "80px",
      render: (o) => {
        const suspended = get(o, "spec", "suspend") === true;
        return <StatusText value={String(suspended)} tone={suspended ? "warning" : "neutral"} />;
      },
    }),
    column("active", (o) => arr(get(o, "status", "active")).length, { width: "70px" }),
    column(
      "lastSchedule",
      (o) => {
        const t = str(get(o, "status", "lastScheduleTime"));
        return t ? -Date.parse(t) : undefined;
      },
      {
        width: "110px",
        render: (o, ctx) => {
          const time = str(get(o, "status", "lastScheduleTime"));
          return <LastSchedule time={time} now={ctx.now} />;
        },
      },
    ),
  ),
  actions: ["trigger", "suspend", "edit", "delete"],
});

function LastSchedule({ time, now }: { time: string | undefined; now: number }) {
  const { t } = useTranslation();
  const ms = time ? Date.parse(time) : NaN;
  if (Number.isNaN(ms)) return null;
  const { unit, count } = ageParts(now - ms);
  return <time dateTime={time}>{t("resources:table.ago", { age: t(`common:age.${unit}`, { count }) })}</time>;
}
