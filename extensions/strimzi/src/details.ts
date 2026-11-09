// The details section of Strimzi objects (the manifest's `strimzi`, on every kind of the section), drawn with the
// SDK's UI kit as the former built-in section drew it:
//   Kafka             — readiness with the reason, warnings, version and metadata state, the listeners with their
//                       bootstrap servers and addresses, the node pools;
//   KafkaNodePool     — its Kafka, roles, replicas and node ids, storage;
//   KafkaTopic        — its Kafka, the topic name, partitions, replicas and config;
//   KafkaUser         — its Kafka, authentication, authorization, the user name and the Secret's name (a link; its
//                       data is never read);
//   KafkaConnect / KafkaMirrorMaker2 — replicas, URL, plugins, mirrors, connectors' states, automatic restarts and
//                       failed connectors and tasks with their traces;
//   KafkaConnector    — the Connect cluster, class, the connector's and tasks' states, automatic restarts, failures.
// The frame reads the shown object again whenever its resourceVersion changes. Conditions and YAML are Sextant's own
// sections. Read-only.
import { ui, type KubeObject, type ObjectRef, type Sextant, type UiContent } from "@sextant/extension-sdk";
import { dateTimeText, element, errorText, formatList, formatParts } from "./dom";
import { t } from "./i18n";
import {
  arr,
  autoRestartSpecOf,
  autoRestartsOf,
  clusterLabelOf,
  connectorStatusOf,
  desiredStateOf,
  FAILED,
  failedTasks,
  firstLine,
  get,
  isKind,
  KAFKA,
  KAFKA_CONNECT,
  KAFKA_CONNECTOR,
  KAFKA_MIRROR_MAKER_2,
  KAFKA_NODE_POOL,
  KAFKA_TOPIC,
  KAFKA_USER,
  kafkaVersionOf,
  kindOf,
  listenersOf,
  MAX_TRACE_CHARS,
  mirrorConnectorsOf,
  nodePoolsOf,
  num,
  readinessOf,
  record,
  replicasOf,
  STATE_TONE,
  stateTone,
  str,
  topicNameOf,
  userSecretOf,
  versionOf,
  warningsOf,
  type ConnectorStatus,
  type KindName,
} from "./model";

type Row = readonly [key: string, value: UiContent];

/** The fields of the details, labelled by their `fields.<key>` texts; a row without a value is left out. */
function fieldsOf(rows: readonly Row[]): HTMLElement | null {
  const list = ui.fields(rows.map(([key, value]) => [t(`fields.${key}`), value] as const));
  return list.childElementCount > 0 ? list : null;
}

const present = (nodes: (Node | null | undefined | false)[]): Node[] => nodes.filter((n): n is Node => !!n);

/** A link to the details of an object of `kind` in Sextant's panel; nothing without a name. */
function link(sextant: Sextant, kind: KindName, version: string, name: string | undefined, namespace: string | null): HTMLElement | null {
  if (!name) return null;
  const ref: ObjectRef = { kind: { ...kind, version }, namespace, name };
  return ui.objectLink(sextant, ref);
}

/** Strimzi's readiness as the tables show it: the state in its tone, Strimzi's message on hover. */
export function readyCell(obj: KubeObject): HTMLElement {
  const r = readinessOf(obj);
  const cell = element("span", {}, ui.status(t(`state.${r.state}`), STATE_TONE[r.state]));
  if (r.message !== undefined) cell.title = r.message;
  return cell;
}

const readyRows = (obj: KubeObject): Row[] => [
  ["status", readyCell(obj)],
  ["reason", readinessOf(obj).reason],
];

const note = (text: string, danger: boolean) => element("p", { className: danger ? "strimzi-note strimzi-note--danger" : "strimzi-note", textContent: text });
const mutedText = (text: string) => element("span", { className: "strimzi-muted", textContent: text });

function warningsBlock(obj: KubeObject): HTMLElement | null {
  const warnings = warningsOf(obj);
  if (warnings.length === 0) return null;
  const rows = warnings.map((w) => [w.reason ?? "", w.message ?? ""]);
  return ui.block(t("warnings"), ui.table([t("warningReason"), t("warningMessage")], rows));
}

/** Why it is not ready, and the warnings Strimzi reports. */
function messages(obj: KubeObject): Node[] {
  const r = readinessOf(obj);
  return present([r.state === "notReady" && r.message ? note(r.message, true) : null, warningsBlock(obj)]);
}

const kafkaLink = (sextant: Sextant, obj: KubeObject) =>
  link(sextant, KAFKA, versionOf(obj), clusterLabelOf(obj), obj.metadata.namespace ?? null);

export function kafkaView(sextant: Sextant, obj: KubeObject): Node[] {
  const ns = obj.metadata.namespace ?? null;
  const listeners = listenersOf(obj);
  const pools = nodePoolsOf(obj);
  const rows: Row[] = [
    ...readyRows(obj),
    ["version", kafkaVersionOf(obj)],
    ["metadataState", str(get(obj, "status", "kafkaMetadataState"))],
    ["clusterId", str(get(obj, "status", "clusterId"))],
    ["nodePools", pools.length > 0 ? ui.inline(pools.map((p) => link(sextant, KAFKA_NODE_POOL, versionOf(obj), p, ns))) : null],
  ];
  const listenersTable = ui.table(
    [t("listeners.name"), t("listeners.type"), t("listeners.port"), t("listeners.bootstrap"), t("listeners.addresses")],
    listeners.map((l) => [
      l.name,
      formatParts([l.type, l.tls ? t("listeners.tls") : undefined].filter((x): x is string => !!x)),
      l.port === undefined ? "" : String(l.port),
      l.bootstrapServers ?? "",
      l.addresses.length > 0 ? ui.chips(l.addresses) : mutedText(t("listeners.noAddress")),
    ]),
  );
  return present([...messages(obj), fieldsOf(rows), listeners.length > 0 ? ui.block(t("listeners.title"), listenersTable) : null]);
}

export function nodePoolView(sextant: Sextant, obj: KubeObject): Node[] {
  // Strimzi sets no Ready condition on a node pool (only warnings): its state is the Kafka's.
  const rows: Row[] = [
    ...(readinessOf(obj).state === "pending" ? [] : readyRows(obj)),
    ["cluster", kafkaLink(sextant, obj)],
    ["roles", ui.chips(arr(get(obj, "spec", "roles")).map(String))],
    ["replicas", replicasOf(obj)?.toString()],
    ["nodeIds", ui.chips(arr(get(obj, "status", "nodeIds")).map(String))],
    ["storage", str(get(obj, "spec", "storage", "type"))],
  ];
  return present([...messages(obj), fieldsOf(rows)]);
}

export function topicView(sextant: Sextant, obj: KubeObject): Node[] {
  const rows: Row[] = [
    ...readyRows(obj),
    ["cluster", kafkaLink(sextant, obj)],
    ["topicName", topicNameOf(obj)],
    ["partitions", num(get(obj, "spec", "partitions"))?.toString()],
    ["topicReplicas", num(get(obj, "spec", "replicas"))?.toString()],
    ["config", ui.chips(Object.entries(record(get(obj, "spec", "config"))).map(([key, value]) => `${key}=${String(value)}`))],
  ];
  return present([...messages(obj), fieldsOf(rows)]);
}

export function userView(sextant: Sextant, obj: KubeObject): Node[] {
  const ns = obj.metadata.namespace ?? null;
  const acls = arr(get(obj, "spec", "authorization", "acls")).length;
  const rows: Row[] = [
    ...readyRows(obj),
    ["cluster", kafkaLink(sextant, obj)],
    ["authentication", str(get(obj, "spec", "authentication", "type"))],
    ["authorization", str(get(obj, "spec", "authorization", "type"))],
    ["acls", acls > 0 ? String(acls) : undefined],
    ["username", str(get(obj, "status", "username"))],
    // The Secret's name only: a link to Sextant's own details of it; the extension never reads it.
    ["secret", link(sextant, { group: "", kind: "Secret" }, "v1", userSecretOf(obj), ns)],
  ];
  return present([...messages(obj), fieldsOf(rows)]);
}

/** One failure: what failed, the first line of its trace, and the whole trace folded. */
function failure(title: string, trace: string | undefined): HTMLElement {
  const line = firstLine(trace);
  const cut = trace !== undefined && trace.length > MAX_TRACE_CHARS;
  const head = element(
    "p",
    { className: "strimzi-note strimzi-note--danger" },
    element("strong", { textContent: title }),
    line
      ? element("span", { className: "strimzi-failure__line", textContent: line })
      : element("span", { className: "strimzi-muted strimzi-failure__line", textContent: t("connector.noTrace") }),
  );
  let folded: HTMLElement | null = null;
  if (trace) {
    const text = element("pre", { className: "sx-pre strimzi-trace__text", textContent: cut ? trace.slice(0, MAX_TRACE_CHARS) : trace, tabIndex: 0 });
    folded = element(
      "details",
      { className: "strimzi-trace" },
      element("summary", { textContent: t("connector.trace") }),
      text,
      cut ? element("p", { className: "strimzi-muted", textContent: t("connector.traceCut") }) : null,
    );
  }
  return element("div", { className: "strimzi-failure" }, head, folded);
}

/** The failed connectors and tasks of a list of connectors (a MirrorMaker 2 runs several, named in the titles). */
export function connectorFailures(connectors: readonly ConnectorStatus[]): HTMLElement | null {
  const many = connectors.length > 1;
  const items = connectors.flatMap((c) => {
    const name = c.name ?? "";
    const own =
      c.state === FAILED
        ? [failure(name ? t("connector.connectorFailed", { name }) : t("connector.failed"), c.trace)]
        : [];
    const tasks = failedTasks(c).map((task) =>
      failure(
        many && name ? t("connector.mirrorTaskFailed", { id: task.id, name }) : t("connector.taskFailed", { id: task.id }),
        task.trace,
      ),
    );
    return [...own, ...tasks];
  });
  return items.length > 0 ? ui.block(t("connector.failuresTitle"), items) : null;
}

export function connectView(obj: KubeObject, mirror: boolean): Node[] {
  const plugins = arr(get(obj, "status", "connectorPlugins")).length;
  const rows: Row[] = [
    ...readyRows(obj),
    ["replicas", replicasOf(obj)?.toString()],
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
    return [c.name ?? "", ui.status(state, stateTone(state)), formatList(c.tasks.map((task) => task.state ?? "")), count === undefined ? "" : String(count)];
  });
  return present([
    ...messages(obj),
    fieldsOf(rows),
    mirror && mirrors.length > 0
      ? ui.block(t("mirrors.title"), ui.table([t("mirrors.source"), t("mirrors.target"), t("mirrors.topics")], mirrors))
      : null,
    connectors.length > 0
      ? ui.block(
          t("connectors.title"),
          ui.table([t("connectors.name"), t("connectors.state"), t("connectors.tasks"), t("connectors.restarts")], connectors),
        )
      : null,
    connectorFailures(reported),
  ]);
}

function autoRestartText(obj: KubeObject): string {
  const spec = autoRestartSpecOf(obj);
  if (!spec.enabled) return t("connector.autoRestartOff");
  return spec.maxRestarts === undefined ? t("connector.autoRestartOn") : t("connector.autoRestartMax", { count: spec.maxRestarts });
}

/** A KafkaConnector: its readiness, the Connect cluster it runs in, the connector's state, its tasks and failures. */
export function connectorView(sextant: Sextant, obj: KubeObject): Node[] {
  const ns = obj.metadata.namespace ?? null;
  const r = readinessOf(obj);
  const connector = connectorStatusOf(obj);
  const restart = autoRestartsOf(obj)[0];
  const spec = autoRestartSpecOf(obj);
  const exhausted =
    connector !== undefined && spec.enabled && spec.maxRestarts !== undefined && restart !== undefined && restart.count >= spec.maxRestarts;
  const failing = connector !== undefined && (connector.state === FAILED || failedTasks(connector).length > 0);
  const rows: Row[] = [
    ["status", readyCell(obj)],
    ["reason", r.reason],
    ["connectCluster", link(sextant, KAFKA_CONNECT, versionOf(obj), clusterLabelOf(obj), ns)],
    ["class", str(get(obj, "spec", "class"))],
    ["tasksMax", (num(get(obj, "status", "tasksMax")) ?? num(get(obj, "spec", "tasksMax")))?.toString()],
    ["desiredState", desiredStateOf(obj)],
    ["connectorState", connector?.state ? ui.status(connector.state, stateTone(connector.state)) : null],
    ["connectorType", connector?.type],
    ["worker", connector?.workerId],
    ["autoRestart", autoRestartText(obj)],
    ["restarts", restart ? String(restart.count) : undefined],
    ["lastRestart", restart?.lastRestart ? dateTimeText(restart.lastRestart) : undefined],
    ["topics", ui.chips(arr(get(obj, "status", "topics")).map(String))],
  ];
  const tasks = connector?.tasks ?? [];
  const tasksTable = ui.table(
    [t("connector.task"), t("connector.state"), t("connector.worker"), t("connector.error")],
    tasks.map((task) => [task.id, task.state ? ui.status(task.state, stateTone(task.state)) : "", task.workerId ?? "", firstLine(task.trace) ?? ""]),
  );
  return present([
    // With failures below, Strimzi's own NotReady text ("see connectorStatus") adds nothing.
    r.state === "notReady" && r.message && !failing ? note(r.message, true) : null,
    exhausted && failing ? note(t("connector.restartsExhausted", { count: restart.count }), false) : null,
    warningsBlock(obj),
    fieldsOf(rows),
    connector ? connectorFailures([connector]) : null,
    tasks.length > 0 ? ui.block(t("connector.tasksTitle"), tasksTable) : null,
  ]);
}

/** The view of an object, by its kind; nothing for a kind the section does not know. */
export function viewOf(sextant: Sextant, obj: KubeObject): Node[] {
  const kind = kindOf(obj);
  if (isKind(kind, KAFKA)) return kafkaView(sextant, obj);
  if (isKind(kind, KAFKA_NODE_POOL)) return nodePoolView(sextant, obj);
  if (isKind(kind, KAFKA_TOPIC)) return topicView(sextant, obj);
  if (isKind(kind, KAFKA_USER)) return userView(sextant, obj);
  if (isKind(kind, KAFKA_CONNECT)) return connectView(obj, false);
  if (isKind(kind, KAFKA_MIRROR_MAKER_2)) return connectView(obj, true);
  if (isKind(kind, KAFKA_CONNECTOR)) return connectorView(sextant, obj);
  return [];
}

/**
 * Starts the details section on the object in the context: read again whenever its resourceVersion changes. A
 * section with nothing to show hides itself, title included, until it has something (`ui.setHidden`).
 */
export function startDetails(sextant: Sextant, root: HTMLElement): () => void {
  let shownVersion: string | null | undefined;
  let shownRef: string | null = null;
  let reading = 0;
  let hidden = false;

  /** Shows `nodes`, hiding the section while there are none. */
  const show = (nodes: Node[]) => {
    root.replaceChildren(...nodes);
    const empty = nodes.length === 0;
    if (empty === hidden) return;
    hidden = empty;
    void sextant.ui.setHidden(empty).catch(() => undefined);
  };

  const read = async (ref: ObjectRef) => {
    const attempt = ++reading;
    try {
      const fresh = await sextant.resources.get({ ref });
      if (attempt !== reading) return;
      // The kind the context names, whatever the answer says (an object without apiVersion/kind).
      show(viewOf(sextant, { apiVersion: `${ref.kind.group}/${ref.kind.version}`, kind: ref.kind.kind, ...fresh }));
    } catch (err) {
      if (attempt === reading) show([ui.errorState(errorText(err))]);
    }
  };

  const follow = () => {
    const ref = sextant.context.selection[0];
    if (!ref) {
      show([ui.empty(t("common.nothingSelected"))]);
      return;
    }
    const key = JSON.stringify([ref.kind.group, ref.kind.kind, ref.namespace, ref.name]);
    if (key !== shownRef) {
      shownRef = key;
      shownVersion = undefined;
      show([ui.loading(t("loading"))]);
    }
    const version = sextant.context.resourceVersion;
    if (version === shownVersion) return;
    shownVersion = version;
    void read(ref);
  };
  follow();
  return sextant.onContextChange(follow);
}
