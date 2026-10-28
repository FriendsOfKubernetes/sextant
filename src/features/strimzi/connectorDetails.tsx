// Details of Kafka Connect connectors (#235): a KafkaConnector's own view, and the failures block a KafkaMirrorMaker2
// shows under its connectors. Everything comes from the status Strimzi copies from the Kafka Connect REST API
// (connectors.ts); nothing is asked of Kafka Connect itself. Read-only.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { formatDateTime } from "../../i18n";
import { status, StatusText } from "../../resources";
import { Block, chips, Fields, link, table, type ColumnWrap, type FieldRow } from "../details";
import { ReadyCell } from "./columns";
import {
  autoRestartSpecOf,
  autoRestartsOf,
  connectorStatusOf,
  desiredStateOf,
  FAILED,
  failedTasks,
  firstLine,
  MAX_TRACE_CHARS,
  stateTone,
  type ConnectorStatus,
} from "./connectors";
import { clusterLabelOf, readinessOf, STRIMZI_GROUP, warningsOf } from "./model";

const { arr, get, num, str } = status;
const CONNECT_REF = {
  apiVersion: `${STRIMZI_GROUP}/v1beta2`,
  kind: "KafkaConnect",
};
const LABELS = "strimzi:fields";
const WARNINGS_WRAP: ColumnWrap[] = ["nowrap", undefined];
const TASKS_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap", undefined];

/** One failure: what failed, the first line of its trace, and the whole trace folded. */
function Failure({ title, trace }: { title: string; trace?: string }) {
  const { t } = useTranslation();
  const line = firstLine(trace);
  const cut = trace !== undefined && trace.length > MAX_TRACE_CHARS;
  return (
    <div className="strimzi-failure">
      <p className="strimzi-note strimzi-note--danger">
        <strong>{title}</strong>
        {line ? (
          <span className="strimzi-failure__line">{line}</span>
        ) : (
          <span className="strimzi-muted strimzi-failure__line">{t("strimzi:connector.noTrace")}</span>
        )}
      </p>
      {trace && (
        <details className="strimzi-trace">
          <summary>{t("strimzi:connector.trace")}</summary>
          <pre className="dt-pre strimzi-trace__text" tabIndex={0}>
            {cut ? trace.slice(0, MAX_TRACE_CHARS) : trace}
          </pre>
          {cut && <p className="strimzi-muted">{t("strimzi:connector.traceCut")}</p>}
        </details>
      )}
    </div>
  );
}

/** The failed connectors and tasks of a list of connectors (a MirrorMaker 2 runs several, named in the titles). */
export function ConnectorFailures({ connectors }: { connectors: ConnectorStatus[] }) {
  const { t } = useTranslation();
  const many = connectors.length > 1;
  const items = connectors.flatMap((c) => {
    const name = c.name ?? "";
    const own =
      c.state === FAILED
        ? [
            {
              key: `${name}/connector`,
              title: name ? t("strimzi:connector.connectorFailed", { name }) : t("strimzi:connector.failed"),
              trace: c.trace,
            },
          ]
        : [];
    const tasks = failedTasks(c).map((task) => ({
      key: `${name}/${task.id}`,
      title:
        many && name
          ? t("strimzi:connector.mirrorTaskFailed", { id: task.id, name })
          : t("strimzi:connector.taskFailed", { id: task.id }),
      trace: task.trace,
    }));
    return [...own, ...tasks];
  });
  if (items.length === 0) return null;
  return (
    <Block id="strimzi:connector.failuresTitle" title={t("strimzi:connector.failuresTitle")}>
      {items.map((i) => (
        <Failure key={i.key} title={i.title} trace={i.trace} />
      ))}
    </Block>
  );
}

function autoRestartText(obj: KubeObject, t: ReturnType<typeof useTranslation>["t"]): string {
  const spec = autoRestartSpecOf(obj);
  if (!spec.enabled) return t("strimzi:connector.autoRestartOff");
  return spec.maxRestarts === undefined
    ? t("strimzi:connector.autoRestartOn")
    : t("strimzi:connector.autoRestartMax", { count: spec.maxRestarts });
}

/** A KafkaConnector: its readiness, the Connect cluster it runs in, the connector's state, its tasks and failures. */
export function KafkaConnectorView({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const r = readinessOf(obj);
  const connector = connectorStatusOf(obj);
  const restart = autoRestartsOf(obj)[0];
  const spec = autoRestartSpecOf(obj);
  const exhausted =
    connector !== undefined &&
    spec.enabled &&
    spec.maxRestarts !== undefined &&
    restart !== undefined &&
    restart.count >= spec.maxRestarts;
  const failing = connector !== undefined && (connector.state === FAILED || failedTasks(connector).length > 0);
  const rows: FieldRow[] = [
    ["status", <ReadyCell key="s" obj={obj} />],
    ["reason", r.reason],
    ["connectCluster", link(CONNECT_REF, clusterLabelOf(obj), ns)],
    ["class", str(get(obj, "spec", "class"))],
    ["tasksMax", (num(get(obj, "status", "tasksMax")) ?? num(get(obj, "spec", "tasksMax")))?.toString()],
    ["desiredState", desiredStateOf(obj)],
    [
      "connectorState",
      connector?.state ? <StatusText key="c" value={connector.state} tone={stateTone(connector.state)} /> : null,
    ],
    ["connectorType", connector?.type],
    ["worker", connector?.workerId],
    ["autoRestart", autoRestartText(obj, t)],
    ["restarts", restart ? String(restart.count) : undefined],
    ["lastRestart", restart?.lastRestart ? formatDateTime(restart.lastRestart) : undefined],
    ["topics", chips(arr(get(obj, "status", "topics")).map(String))],
  ];
  const warnings = warningsOf(obj);
  const warningsTable = table(
    "strimziWarnings",
    [t("strimzi:warningReason"), t("strimzi:warningMessage")],
    warnings.map((w) => [w.reason ?? "", w.message ?? ""]),
    WARNINGS_WRAP,
  );
  const tasksTable = table(
    "strimziTasks",
    [
      t("strimzi:connector.task"),
      t("strimzi:connector.state"),
      t("strimzi:connector.worker"),
      t("strimzi:connector.error"),
    ],
    (connector?.tasks ?? []).map((task) => [
      task.id,
      task.state ? <StatusText key="s" value={task.state} tone={stateTone(task.state)} /> : "",
      task.workerId ?? "",
      firstLine(task.trace) ?? "",
    ]),
    TASKS_WRAP,
  );
  return (
    <>
      {/* With failures below, Strimzi's own NotReady text ("see connectorStatus") adds nothing. */}
      {r.state === "notReady" && r.message && !failing && (
        <p className="strimzi-note strimzi-note--danger">{r.message}</p>
      )}
      {exhausted && failing && (
        <p className="strimzi-note">{t("strimzi:connector.restartsExhausted", { count: restart.count })}</p>
      )}
      {warnings.length > 0 && <Block id="strimzi:warnings" title={t("strimzi:warnings")}>{warningsTable}</Block>}
      <Fields rows={rows} labelPrefix={LABELS} />
      {connector && <ConnectorFailures connectors={[connector]} />}
      {connector && connector.tasks.length > 0 && <Block id="strimzi:connector.tasksTitle" title={t("strimzi:connector.tasksTitle")}>{tasksTable}</Block>}
    </>
  );
}
