// The details section, driven through the SDK's stand-in for Sextant's window: what the built-in section showed of
// each kind, on the built-in view's fixtures.
import { SextantError, type KubeObject } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestHostOptions } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import kafkaJson from "../fixtures/kafka.json";
import connectorJson from "../fixtures/kafkaconnector.json";
import mirrorJson from "../fixtures/kafkamirrormaker2.json";
import topicJson from "../fixtures/kafkatopic.json";
import userJson from "../fixtures/kafkauser.json";
import { startDetails } from "./details";
import { setLanguage, t } from "./i18n";
import { MAX_TRACE_CHARS } from "./model";

const kafka = kafkaJson as unknown as KubeObject;
const topic = topicJson as unknown as KubeObject;
const user = userJson as unknown as KubeObject;
const connector = connectorJson as unknown as KubeObject;
const mirror = mirrorJson as unknown as KubeObject;
const nodePool: KubeObject = {
  apiVersion: "kafka.strimzi.io/v1beta2",
  kind: "KafkaNodePool",
  metadata: { name: "broker", namespace: "kafka", labels: { "strimzi.io/cluster": "my-cluster" } },
  spec: { replicas: 3, roles: ["broker"], storage: { type: "jbod" } },
  status: { replicas: 3, nodeIds: [0, 1, 2] },
};
const connect: KubeObject = {
  apiVersion: "kafka.strimzi.io/v1beta2",
  kind: "KafkaConnect",
  metadata: { name: "my-connect-cluster", namespace: "kafka" },
  spec: { replicas: 1, version: "4.0.0", bootstrapServers: "my-cluster-kafka-bootstrap:9093" },
  status: {
    replicas: 1,
    url: "http://my-connect-cluster-connect-api.kafka.svc:8083",
    connectorPlugins: [{ class: "a" }, { class: "b" }],
    conditions: [{ type: "NotReady", status: "True", reason: "TimeoutException", message: "Exceeded timeout of 300000ms" }],
  },
};
const ALL = [kafka, topic, user, connector, mirror, nodePool, connect];

const copy = <T>(value: T): T => structuredClone(value);
const ref = (o: KubeObject) => ({
  kind: { group: o.apiVersion!.split("/")[0]!, version: o.apiVersion!.split("/")[1]!, kind: o.kind! },
  namespace: o.metadata.namespace ?? null,
  name: o.metadata.name,
});

let host: TestHost;
let root: HTMLElement;
let stop: () => void = () => undefined;

async function show(obj: KubeObject, options: TestHostOptions & { objects?: KubeObject[] } = {}) {
  const objects = options.objects ?? [obj, ...ALL];
  host = await startTestHost({
    context: { view: "details", contribution: "strimzi", selection: [ref(obj)], resourceVersion: "1", ...options.context },
    handlers: {
      "resources.get": ({ ref: r }) =>
        structuredClone(objects.find((o) => o.kind === r.kind.kind && o.metadata.name === r.name && (o.metadata.namespace ?? null) === r.namespace)),
      "ui.setHidden": () => null,
      ...options.handlers,
    },
  });
  root = document.createElement("main");
  document.body.append(root);
  stop = startDetails(host.sextant, root);
  await expect.poll(() => root.querySelector(".sx-fields, .sx-error") !== null).toBe(true);
}

const text = () => root.textContent ?? "";
const fields = () => Object.fromEntries([...root.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]));
const blockTitles = () => [...root.querySelectorAll(".sx-block__title")].map((h) => h.textContent);
const tableRows = (title: string) => {
  const block = [...root.querySelectorAll(".sx-block")].find((b) => b.querySelector(".sx-block__title")?.textContent === title)!;
  return [...block.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
};
const button = (name: string) => [...root.querySelectorAll("button")].find((b) => b.textContent === name) as HTMLButtonElement | undefined;
const opened = () => host.calls.filter((c) => c.method === "ui.openDetails").map((c) => c.params);

afterEach(() => {
  setLanguage("en");
  stop();
  root?.remove();
  host?.close();
});

describe("the details", () => {
  it("of a Kafka: readiness, version, metadata, node pools, warnings and listeners", async () => {
    await show(kafka);
    expect(fields()).toEqual({
      Status: "Ready",
      "Kafka version": "4.0.0",
      Metadata: "KRaft",
      "Cluster ID": "Kb1C-1J5TAKC6zvSGSJbFg",
      "Node pools": "controllerbroker",
    });
    expect(root.querySelector(".sx-status--success")?.textContent).toBe("Ready");
    expect(blockTitles()).toEqual(["Warnings", "Listeners"]);
    expect(tableRows("Warnings")).toEqual([["UnusedKafkaConfig", "The option offsets.topic.replication.factor is ignored by the KRaft controller nodes."]]);
    expect(tableRows("Listeners")).toEqual([
      ["plain", "internal", "9092", "my-cluster-kafka-bootstrap.kafka.svc:9092", "my-cluster-kafka-bootstrap.kafka.svc:9092"],
      ["tls", "internal · TLS", "9093", "my-cluster-kafka-bootstrap.kafka.svc:9093", "my-cluster-kafka-bootstrap.kafka.svc:9093"],
      ["external", "loadbalancer · TLS", "9094", "", "No address yet"],
    ]);
    button("broker")!.click();
    await expect.poll(opened).toEqual([{ kind: { group: "kafka.strimzi.io", version: "v1beta2", kind: "KafkaNodePool" }, namespace: "kafka", name: "broker" }]);
  });

  it("of a Kafka not ready: why, in Strimzi's words", async () => {
    const o = copy(kafka);
    (o.status as Record<string, unknown>).conditions = [
      { type: "NotReady", status: "True", reason: "TimeoutException", message: "Exceeded timeout of 300000ms" },
    ];
    await show(o);
    expect(root.querySelector(".strimzi-note--danger")?.textContent).toBe("Exceeded timeout of 300000ms");
    expect(fields()).toMatchObject({ Status: "Not ready", Reason: "TimeoutException" });
    expect((root.querySelector(".sx-status--danger")?.parentElement as HTMLElement).title).toBe("Exceeded timeout of 300000ms");
  });

  it("of a node pool: its Kafka, roles, replicas, node ids and storage; no readiness Strimzi does not set", async () => {
    await show(nodePool);
    expect(fields()).toEqual({ Kafka: "my-cluster", Roles: "broker", Replicas: "3", "Node IDs": "012", Storage: "jbod" });
    button("my-cluster")!.click();
    await expect.poll(opened).toEqual([{ kind: { group: "kafka.strimzi.io", version: "v1beta2", kind: "Kafka" }, namespace: "kafka", name: "my-cluster" }]);
  });

  it("of a topic: its Kafka, name, partitions, replication and config", async () => {
    await show(topic);
    expect(fields()).toEqual({
      Status: "Not ready",
      Reason: "KafkaError",
      Kafka: "my-cluster",
      "Topic name": "my-topic",
      Partitions: "10",
      "Replication factor": "3",
      Config: "retention.ms=7200000segment.bytes=1073741824",
    });
    expect(root.querySelector(".strimzi-note--danger")?.textContent).toContain("InvalidReplicationFactorException");
  });

  it("of a user: the Secret by name only, a link to Sextant's own details", async () => {
    await show(user);
    expect(fields()).toEqual({
      Status: "Ready",
      Kafka: "my-cluster",
      Authentication: "tls",
      Authorization: "simple",
      "ACL rules": "2",
      "User name": "CN=my-user",
      Secret: "my-user",
    });
    button("my-user")!.click();
    await expect.poll(opened).toEqual([{ kind: { group: "", version: "v1", kind: "Secret" }, namespace: "kafka", name: "my-user" }]);
    // Never read: the extension asks for no Secret.
    expect(host.calls.filter((c) => c.method === "resources.get").map((c) => (c.params as { ref: { kind: { kind: string } } }).ref.kind.kind)).toEqual(["KafkaUser"]);
  });

  it("of a Kafka Connect: replicas, version, bootstrap servers, REST API and plugins", async () => {
    await show(connect);
    expect(fields()).toEqual({
      Status: "Not ready",
      Reason: "TimeoutException",
      Replicas: "1",
      "Kafka version": "4.0.0",
      "Bootstrap servers": "my-cluster-kafka-bootstrap:9093",
      "REST API": "http://my-connect-cluster-connect-api.kafka.svc:8083",
      "Connector plugins": "2",
    });
    expect(blockTitles()).toEqual([]);
  });

  it("of a MirrorMaker 2: mirrors, connectors with their tasks and restarts, and the failed task's trace", async () => {
    await show(mirror);
    expect(fields()).toMatchObject({ Status: "Ready", Replicas: "1", "Kafka version": "4.0.0", "Connect cluster": "cluster-b" });
    expect(blockTitles()).toEqual(["Mirrors", "Connectors", "Failures"]);
    expect(tableRows("Mirrors")).toEqual([["cluster-a", "cluster-b", ".*"]]);
    expect(tableRows("Connectors")).toEqual([
      ["cluster-a->cluster-b.MirrorCheckpointConnector", "RUNNING", "RUNNING", ""],
      ["cluster-a->cluster-b.MirrorSourceConnector", "RUNNING", "FAILED", "1"],
    ]);
    const failure = root.querySelector(".strimzi-failure")!;
    expect(failure.querySelector("strong")?.textContent).toBe("Task 0 of cluster-a->cluster-b.MirrorSourceConnector failed");
    expect(failure.querySelector(".strimzi-failure__line")?.textContent).toBe(
      "org.apache.kafka.common.errors.TopicAuthorizationException: Not authorized to access topics: [orders]",
    );
    expect(failure.querySelector("details summary")?.textContent).toBe("Stack trace");
  });

  it("of a KafkaConnector: its Connect cluster, states, restarts, the failed task and the tasks", async () => {
    await show(connector);
    // With a failure to show, Strimzi's own "see connectorStatus" is left out; restarts are spent.
    expect(text()).not.toContain("see connectorStatus");
    expect(root.querySelector(".strimzi-note:not(.strimzi-note--danger)")?.textContent).toBe(
      "Strimzi stopped restarting it automatically after 3 restarts.",
    );
    expect(fields()).toMatchObject({
      Status: "Not ready",
      Reason: "Throwable",
      "Connect cluster": "my-connect-cluster",
      "Connector class": "org.apache.kafka.connect.file.FileStreamSourceConnector",
      "Max tasks": "2",
      "Connector state": "RUNNING",
      Type: "source",
      Worker: "10.244.0.21:8083",
      "Automatic restart": "On, at most 3 restarts",
      "Automatic restarts": "3",
      Topics: "my-topic",
    });
    expect(fields()["Last automatic restart"]).toBeTruthy();
    expect(blockTitles()).toEqual(["Failures", "Tasks"]);
    expect(root.querySelector(".strimzi-failure strong")?.textContent).toBe("Task 1 failed");
    expect(tableRows("Tasks")).toEqual([
      ["0", "RUNNING", "10.244.0.21:8083", ""],
      ["1", "FAILED", "10.244.0.22:8083", "org.apache.kafka.connect.errors.ConnectException: java.nio.file.NoSuchFileException: /opt/kafka/LICENSE"],
    ]);
    button("my-connect-cluster")!.click();
    await expect.poll(opened).toEqual([{ kind: { group: "kafka.strimzi.io", version: "v1", kind: "KafkaConnect" }, namespace: "kafka", name: "my-connect-cluster" }]);
  });

  it("cut a long trace, and say when there is none", async () => {
    const o = copy(connector);
    (o.status as Record<string, unknown>).connectorStatus = {
      name: "c",
      connector: { state: "FAILED", trace: `E: long\n${"x".repeat(MAX_TRACE_CHARS + 10)}` },
      tasks: [{ id: 0, state: "FAILED" }],
    };
    await show(o);
    expect(root.querySelector(".strimzi-trace__text")?.textContent).toHaveLength(MAX_TRACE_CHARS);
    expect(text()).toContain("The stack trace is shortened.");
    expect(text()).toContain("Connector c failed");
    expect(text()).toContain("Kafka Connect reported no stack trace.");
  });

  it("in another language, and an error in Sextant's words", async () => {
    setLanguage("ru");
    await show(topic);
    expect(fields()).toMatchObject({ [t("fields.partitions")]: "10" });
    expect(t("state.notReady")).toBe("Не готов");
    stop();
    root.remove();
    host.close();
    setLanguage("en");
    await show(kafka, {
      handlers: {
        "resources.get": () => {
          throw new SextantError("denied", "no read of Kafka");
        },
      },
    });
    expect(root.querySelector(".sx-error")?.textContent).toBe("Sextant refused: no read of Kafka");
  });

  it("open and close its blocks in Sextant's own memory, as the built-in section's blocks", async () => {
    const toggles = () => [...root.querySelectorAll<HTMLButtonElement>(".sx-block__toggle")];
    const toggle = (title: string) => toggles().find((b) => b.textContent === title)!;
    const written: unknown[] = [];
    await show(kafka, { handlers: { "ui.setBlockOpen": (params) => void written.push(params) } });
    expect(toggles().map((b) => b.getAttribute("aria-expanded"))).toEqual(["true", "true"]);
    toggle("Listeners").click();
    expect(toggle("Listeners").getAttribute("aria-expanded")).toBe("false");
    await expect.poll(() => written).toEqual([{ id: "listeners", open: false }]);
    // What Sextant remembers comes back in the context, and a change of it draws the blocks again.
    host.setContext({ blocks: { listeners: false } });
    await expect.poll(() => toggle("Listeners").getAttribute("aria-expanded")).toBe("false");
    expect(toggle("Warnings").getAttribute("aria-expanded")).toBe("true");
    // "Collapse all" and "Expand all" of the panel; a block's own choice comes first.
    host.setContext({ blocks: { "*": false } });
    await expect.poll(() => toggles().map((b) => b.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
    host.setContext({ blocks: { "*": true, warnings: false } });
    await expect.poll(() => toggles().map((b) => b.getAttribute("aria-expanded"))).toEqual(["false", "true"]);
    // A new frame starts as remembered; never in the extension's storage.
    stop();
    root.remove();
    host.close();
    await show(kafka, { context: { blocks: { listeners: false } } });
    expect(toggle("Listeners").getAttribute("aria-expanded")).toBe("false");
    expect(host.storage.size).toBe(0);
  });

  it("read the object again when it changes", async () => {
    const objects = [copy(kafka)];
    await show(kafka, { objects });
    (objects[0]!.status as Record<string, unknown>).kafkaVersion = "4.1.0";
    host.setContext({ resourceVersion: "2" });
    await expect.poll(() => fields()["Kafka version"]).toBe("4.1.0");
  });
});
