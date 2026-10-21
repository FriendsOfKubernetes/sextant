// Columns of the Strimzi tables: every kind shows its readiness (ready / not ready / pending, the condition's reason as
// a column and the message as the tooltip); Kafkas their version and listeners, node pools their roles and replicas,
// topics their partitions and replicas, users their authentication, Connect and MirrorMaker 2 their replicas.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { formatList } from "../../i18n";
import { ageColumn, nameColumn, namespaceColumn, status, StatusText, type ColumnDef } from "../../resources";
import { autoRestartsOf, connectorStatusOf, stateTone, taskCounts } from "./connectors";
import { clusterLabelOf, listenersOf, readinessOf, STATE_TONE } from "./model";

const { arr, get, num, str } = status;

const col = (id: string, value: ColumnDef["value"], options: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  titleKey: `strimzi:columns.${id}`,
  value,
  ...options,
});

export function ReadyCell({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const r = readinessOf(obj);
  return (
    <span title={r.message}>
      <StatusText value={t(`strimzi:state.${r.state}`)} tone={STATE_TONE[r.state]} />
    </span>
  );
}

const statusColumn = col("status", (o) => readinessOf(o).state, {
  width: "100px",
  render: (o) => <ReadyCell obj={o} />,
});
const reasonColumn = col("reason", (o) => readinessOf(o).reason, {
  width: "minmax(120px, 1fr)",
});
const clusterColumn = col("cluster", clusterLabelOf, {
  width: "minmax(110px, 1fr)",
});
const replicasColumn = col("replicas", (o) => num(get(o, "status", "replicas")) ?? num(get(o, "spec", "replicas")), {
  width: "80px",
});

export const kafkaColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  statusColumn,
  col("version", (o) => str(get(o, "status", "kafkaVersion")) ?? str(get(o, "spec", "kafka", "version")), { width: "80px" }),
  col("listeners", (o) => formatList(listenersOf(o).map((l) => l.name)), {
    width: "minmax(120px, 1.5fr)",
  }),
  reasonColumn,
  ageColumn,
];

export const nodePoolColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  clusterColumn,
  col("roles", (o) => formatList(arr(get(o, "spec", "roles")).map(String)), {
    width: "minmax(110px, 1fr)",
  }),
  replicasColumn,
  ageColumn,
];

export const topicColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  clusterColumn,
  statusColumn,
  col("partitions", (o) => num(get(o, "spec", "partitions")), {
    width: "90px",
  }),
  col("topicReplicas", (o) => num(get(o, "spec", "replicas")), {
    width: "80px",
  }),
  reasonColumn,
  ageColumn,
];

export const userColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  clusterColumn,
  statusColumn,
  col("authentication", (o) => str(get(o, "spec", "authentication", "type")), {
    width: "130px",
  }),
  col("authorization", (o) => str(get(o, "spec", "authorization", "type")), {
    width: "110px",
  }),
  ageColumn,
];

export const connectColumns: ColumnDef[] = [nameColumn, namespaceColumn, statusColumn, replicasColumn, reasonColumn, ageColumn];

// KafkaConnector (#235): the Connect cluster it runs in, the connector's own state as Kafka Connect reports it (an API
// term, shown as is), running tasks of all, the class without its package, Strimzi's automatic restarts.
function TasksCell({ obj }: { obj: KubeObject }) {
  const c = taskCounts(connectorStatusOf(obj));
  if (c.total === 0) return null;
  const tone = c.failed > 0 ? "danger" : c.running === c.total ? "success" : "warning";
  return <StatusText value={`${c.running}/${c.total}`} tone={tone} />;
}

const classOf = (o: KubeObject) => str(get(o, "spec", "class"));
const simpleClass = (o: KubeObject) => classOf(o)?.split(".").pop();

export const connectorColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("connectCluster", clusterLabelOf, { width: "minmax(110px, 1fr)" }),
  statusColumn,
  col("connectorState", (o) => connectorStatusOf(o)?.state, {
    width: "110px",
    render: (o) => {
      const state = connectorStatusOf(o)?.state;
      return state ? <StatusText value={state} tone={stateTone(state)} /> : null;
    },
  }),
  col("tasks", (o) => taskCounts(connectorStatusOf(o)).running, { width: "80px", render: (o) => <TasksCell obj={o} /> }),
  col("class", simpleClass, {
    width: "minmax(120px, 1fr)",
    render: (o) => <span title={classOf(o)}>{simpleClass(o)}</span>,
  }),
  col("restarts", (o) => autoRestartsOf(o)[0]?.count, { width: "90px" }),
  reasonColumn,
  ageColumn,
];
