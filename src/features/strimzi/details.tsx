// Details of Strimzi objects (one section, `strimzi`):
//   Kafka             — readiness with the reason, warnings, version and metadata state, the listeners with their
//                       bootstrap servers and addresses, the node pools;
//   KafkaNodePool     — its Kafka, roles, replicas and node ids, storage;
//   KafkaTopic        — its Kafka, the topic name, partitions, replicas and config;
//   KafkaUser         — its Kafka, authentication, authorization, the user name and the Secret's name (a link; its
//                       data is never read);
//   KafkaConnect / KafkaMirrorMaker2 — replicas, URL, plugins, mirrors, connectors' states, automatic restarts and
//                       failed connectors and tasks with their traces;
//   KafkaConnector    — connectorDetails.tsx (#235).
// Conditions and YAML are the panel's own sections. Read-only.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { formatList, formatParts } from "../../i18n";
import { status, StatusText } from "../../resources";
import { Block, chips, Fields, KINDS, link, mapChips, table, type ColumnWrap, type FieldRow } from "../details";
import { ReadyCell } from "./columns";
import { ConnectorFailures, KafkaConnectorView } from "./connectorDetails";
import { autoRestartsOf, mirrorConnectorsOf, stateTone } from "./connectors";
import {
  clusterLabelOf,
  isKind,
  KAFKA,
  KAFKA_CONNECT,
  KAFKA_CONNECTOR,
  KAFKA_MIRROR_MAKER_2,
  KAFKA_NODE_POOL,
  KAFKA_TOPIC,
  KAFKA_USER,
  listenersOf,
  nodePoolsOf,
  readinessOf,
  STRIMZI_GROUP,
  strimziKind,
  topicNameOf,
  userSecretOf,
  warningsOf,
} from "./model";

const { arr, get, num, str } = status;
const LABELS = "strimzi:fields";
const API = `${STRIMZI_GROUP}/v1beta2`;
const ref = (kind: string) => ({ apiVersion: API, kind });
const KAFKA_REF = ref("Kafka");
const NODE_POOL_REF = ref("KafkaNodePool");
const WARNINGS_WRAP: ColumnWrap[] = ["nowrap", undefined];
const LISTENERS_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap", undefined, undefined];
const THREE_WRAP: ColumnWrap[] = ["nowrap", "nowrap", undefined];
const CONNECTORS_WRAP: ColumnWrap[] = ["nowrap", "nowrap", undefined, "nowrap"];

/** Why it is not ready, and the warnings Strimzi reports. */
function Messages({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const r = readinessOf(obj);
  const warnings = warningsOf(obj);
  const warningsTable = table(
    "strimziWarnings",
    [t("strimzi:warningReason"), t("strimzi:warningMessage")],
    warnings.map((w) => [w.reason ?? "", w.message ?? ""]),
    WARNINGS_WRAP,
  );
  return (
    <>
      {r.state === "notReady" && r.message && <p className="strimzi-note strimzi-note--danger">{r.message}</p>}
      {warnings.length > 0 && <Block id="strimzi:warnings" title={t("strimzi:warnings")}>{warningsTable}</Block>}
    </>
  );
}

function readyRows(obj: KubeObject): FieldRow[] {
  const r = readinessOf(obj);
  return [
    ["status", <ReadyCell key="s" obj={obj} />],
    ["reason", r.reason],
  ];
}

const kafkaLink = (obj: KubeObject) => link(KAFKA_REF, clusterLabelOf(obj), obj.metadata?.namespace ?? null);

function KafkaView({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const listeners = listenersOf(obj);
  const pools = nodePoolsOf(obj);
  const rows: FieldRow[] = [
    ...readyRows(obj),
    ["version", str(get(obj, "status", "kafkaVersion")) ?? str(get(obj, "spec", "kafka", "version"))],
    ["metadataState", str(get(obj, "status", "kafkaMetadataState"))],
    ["clusterId", str(get(obj, "status", "clusterId"))],
    ["nodePools", pools.length > 0 ? <span className="dt-links">{pools.map((p) => link(NODE_POOL_REF, p, ns))}</span> : null],
  ];
  const listenersTable = table(
    "strimziListeners",
    [
      t("strimzi:listeners.name"),
      t("strimzi:listeners.type"),
      t("strimzi:listeners.port"),
      t("strimzi:listeners.bootstrap"),
      t("strimzi:listeners.addresses"),
    ],
    listeners.map((l) => [
      l.name,
      formatParts([l.type, l.tls ? t("strimzi:listeners.tls") : undefined].filter((x): x is string => !!x)),
      l.port === undefined ? "" : String(l.port),
      l.bootstrapServers ?? "",
      l.addresses.length > 0 ? chips(l.addresses) : <span className="strimzi-muted">{t("strimzi:listeners.noAddress")}</span>,
    ]),
    LISTENERS_WRAP,
  );
  return (
    <>
      <Messages obj={obj} />
      <Fields rows={rows} labelPrefix={LABELS} />
      {listeners.length > 0 && <Block id="strimzi:listeners.title" title={t("strimzi:listeners.title")}>{listenersTable}</Block>}
    </>
  );
}

function NodePoolView({ obj }: { obj: KubeObject }) {
  // Strimzi sets no Ready condition on a node pool (only warnings): its state is the Kafka's.
  const rows: FieldRow[] = [
    ...(readinessOf(obj).state === "pending" ? [] : readyRows(obj)),
    ["cluster", kafkaLink(obj)],
    ["roles", chips(arr(get(obj, "spec", "roles")).map(String))],
    ["replicas", (num(get(obj, "status", "replicas")) ?? num(get(obj, "spec", "replicas")))?.toString()],
    ["nodeIds", chips(arr(get(obj, "status", "nodeIds")).map(String))],
    ["storage", str(get(obj, "spec", "storage", "type"))],
  ];
  return (
    <>
      <Messages obj={obj} />
      <Fields rows={rows} labelPrefix={LABELS} />
    </>
  );
}

function TopicView({ obj }: { obj: KubeObject }) {
  const rows: FieldRow[] = [
    ...readyRows(obj),
    ["cluster", kafkaLink(obj)],
    ["topicName", topicNameOf(obj)],
    ["partitions", num(get(obj, "spec", "partitions"))?.toString()],
    ["topicReplicas", num(get(obj, "spec", "replicas"))?.toString()],
    ["config", mapChips(get(obj, "spec", "config"))],
  ];
  return (
    <>
      <Messages obj={obj} />
      <Fields rows={rows} labelPrefix={LABELS} />
    </>
  );
}

function UserView({ obj }: { obj: KubeObject }) {
  const ns = obj.metadata?.namespace ?? null;
  const acls = arr(get(obj, "spec", "authorization", "acls")).length;
  const rows: FieldRow[] = [
    ...readyRows(obj),
    ["cluster", kafkaLink(obj)],
    ["authentication", str(get(obj, "spec", "authentication", "type"))],
    ["authorization", str(get(obj, "spec", "authorization", "type"))],
    ["acls", acls > 0 ? String(acls) : undefined],
    ["username", str(get(obj, "status", "username"))],
    ["secret", link(KINDS.secret, userSecretOf(obj), ns)],
  ];
  return (
    <>
      <Messages obj={obj} />
      <Fields rows={rows} labelPrefix={LABELS} />
    </>
  );
}

function ConnectView({ obj, mirror }: { obj: KubeObject; mirror: boolean }) {
  const { t } = useTranslation();
  const plugins = arr(get(obj, "status", "connectorPlugins")).length;
  const rows: FieldRow[] = [
    ...readyRows(obj),
    ["replicas", (num(get(obj, "status", "replicas")) ?? num(get(obj, "spec", "replicas")))?.toString()],
    ["version", str(get(obj, "spec", "version"))],
    ["bootstrapServers", str(get(obj, "spec", "bootstrapServers"))],
    ["connectCluster", str(get(obj, "spec", "connectCluster")) ?? str(get(obj, "spec", "target", "alias"))],
    ["url", str(get(obj, "status", "url"))],
    ["plugins", plugins > 0 ? String(plugins) : undefined],
  ];
  const mirrors = arr(get(obj, "spec", "mirrors")).map((m) => [
    str(get(m, "sourceCluster")) ?? str(get(m, "source", "alias")) ?? "",
    str(get(m, "targetCluster")) ?? str(get(obj, "spec", "target", "alias")) ?? "",
    str(get(m, "topicsPattern")) ?? "",
  ]);
  const reported = mirrorConnectorsOf(obj);
  const restarts = autoRestartsOf(obj);
  const connectors = reported.map((c) => {
    const state = c.state ?? "";
    const count = restarts.find((r) => r.connectorName === c.name)?.count;
    return [
      c.name ?? "",
      <StatusText key="s" value={state} tone={stateTone(state)} />,
      formatList(c.tasks.map((task) => task.state ?? "")),
      count === undefined ? "" : String(count),
    ];
  });
  const mirrorsTable = table(
    "strimziMirrors",
    [t("strimzi:mirrors.source"), t("strimzi:mirrors.target"), t("strimzi:mirrors.topics")],
    mirrors,
    THREE_WRAP,
  );
  const connectorsTable = table(
    "strimziConnectors",
    [t("strimzi:connectors.name"), t("strimzi:connectors.state"), t("strimzi:connectors.tasks"), t("strimzi:connectors.restarts")],
    connectors,
    CONNECTORS_WRAP,
  );
  return (
    <>
      <Messages obj={obj} />
      <Fields rows={rows} labelPrefix={LABELS} />
      {mirror && mirrors.length > 0 && <Block id="strimzi:mirrors.title" title={t("strimzi:mirrors.title")}>{mirrorsTable}</Block>}
      {connectors.length > 0 && <Block id="strimzi:connectors.title" title={t("strimzi:connectors.title")}>{connectorsTable}</Block>}
      <ConnectorFailures connectors={reported} />
    </>
  );
}

export function StrimziSection({ objectRef, obj }: DetailsSectionProps) {
  if (!obj) return null;
  const kind = objectRef.kind;
  if (isKind(kind, KAFKA)) return <KafkaView obj={obj} />;
  if (isKind(kind, KAFKA_NODE_POOL)) return <NodePoolView obj={obj} />;
  if (isKind(kind, KAFKA_TOPIC)) return <TopicView obj={obj} />;
  if (isKind(kind, KAFKA_USER)) return <UserView obj={obj} />;
  if (isKind(kind, KAFKA_CONNECT)) return <ConnectView obj={obj} mirror={false} />;
  if (isKind(kind, KAFKA_MIRROR_MAKER_2)) return <ConnectView obj={obj} mirror />;
  if (isKind(kind, KAFKA_CONNECTOR)) return <KafkaConnectorView obj={obj} />;
  return null;
}

export const appliesTo = (kind: Parameters<typeof strimziKind>[0]): boolean => strimziKind(kind) !== undefined;
