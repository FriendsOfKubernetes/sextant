import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings, type AppSettings, type KindRef, type KubeObject, type ObjectRef, type ResourceKind } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { Sidebar } from "../../layout/sidebar/Sidebar";
import { getResourceDef, resetClusterKinds } from "../../resources";
import { axeViolations } from "../../test/axe";
import "../details";
import { copy, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore } from "../namespaces";
import { detect } from "../problems/model";
import { resetProblemSources } from "../problems/store";
import { resetSharedWatches } from "../resource-map/watches";
import kafkaJson from "./fixtures/kafka.json";
import topicJson from "./fixtures/kafkatopic.json";
import userJson from "./fixtures/kafkauser.json";
import "./index";
import { KAFKA, KAFKA_TOPIC, listenersOf, NOT_READY_GRACE_MS, readinessOf, STRIMZI_KINDS, warningsOf } from "./model";

const kafka = kafkaJson as KubeObject;
const topic = topicJson as KubeObject;
const user = userJson as KubeObject;

describe("the model", () => {
  it("reads readiness from Ready / NotReady, and the warnings apart", () => {
    expect(readinessOf(kafka).state).toBe("ready");
    expect(warningsOf(kafka)).toEqual([expect.objectContaining({ reason: "UnusedKafkaConfig" })]);
    expect(readinessOf(topic)).toMatchObject({ state: "notReady", reason: "KafkaError" });
    const notReady = copy(kafka);
    (notReady.status as Record<string, unknown>).conditions = [
      { type: "NotReady", status: "True", reason: "TimeoutException", message: "Exceeded timeout of 300000ms" },
    ];
    expect(readinessOf(notReady)).toMatchObject({ state: "notReady", reason: "TimeoutException" });
    expect(readinessOf({ apiVersion: "x", kind: "Kafka", metadata: { name: "new" } }).state).toBe("pending");
  });

  it("joins the declared listeners with the addresses Strimzi reports", () => {
    expect(listenersOf(kafka)).toEqual([
      { name: "plain", type: "internal", port: 9092, tls: false, bootstrapServers: "my-cluster-kafka-bootstrap.kafka.svc:9092", addresses: ["my-cluster-kafka-bootstrap.kafka.svc:9092"] },
      { name: "tls", type: "internal", port: 9093, tls: true, bootstrapServers: "my-cluster-kafka-bootstrap.kafka.svc:9093", addresses: ["my-cluster-kafka-bootstrap.kafka.svc:9093"] },
      { name: "external", type: "loadbalancer", port: 9094, tls: true, bootstrapServers: undefined, addresses: [] },
    ]);
  });

  it("not ready is a problem after a grace; warnings are not", () => {
    expect(detect(KAFKA, kafka)).toEqual([]);
    expect(detect(KAFKA_TOPIC, topic)).toEqual([expect.objectContaining({ reason: "KafkaError", graceMs: NOT_READY_GRACE_MS, notify: true })]);
  });

  it("the topics table shows the Kafka, partitions and replicas", () => {
    const def = getResourceDef(KAFKA_TOPIC);
    const col = (id: string) => def.columns.find((c) => c.id === id)!;
    expect(col("cluster").value(topic)).toBe("my-cluster");
    expect(col("partitions").value(topic)).toBe(10);
    expect(col("topicReplicas").value(topic)).toBe(3);
    expect(def.problem?.(topic)).toBe(true);
  });
});

// ---------- In the app ----------

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const served = (kind: KindRef): ResourceKind => ({ kindRef: kind, plural: `${kind.kind.toLowerCase()}s`, namespaced: true, verbs: ["list", "watch"], printerColumns: [] });

let wb: WatchBackend;
let discovery: KindRef[];
let stored: AppSettings;

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetProblemSources();
  resetSharedWatches();
  resetSettingsCache();
  resetNamespaceRestore();
  discovery = [POD, ...STRIMZI_KINDS.map((d) => d.kind)];
  stored = defaultAppSettings();
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => discovery.map(served));
  wb.backend.on("settings_get", () => structuredClone(stored));
  wb.backend.on("settings_update", (args) => {
    stored = structuredClone(args.settings as AppSettings);
    return structuredClone(stored);
  });
});

afterEach(() => {
  wb.backend.restore();
  resetClusterKinds();
  resetProblemSources();
  resetSharedWatches();
  resetSettingsCache();
});

const sections = () =>
  screen
    .getAllByRole("button")
    .filter((b) => b.hasAttribute("aria-expanded"))
    .map((b) => b.textContent);

describe("the Strimzi section", () => {
  it("is shown for a cluster that serves Kafka, and only then", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Strimzi"));
  });

  it("is not there without the CRDs", async () => {
    discovery = [POD];
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(true));
    await waitFor(() => expect(sections()).toContain("Workloads"));
    expect(sections()).not.toContain("Strimzi");
  });
});

function refTo(obj: KubeObject): ObjectRef {
  return { kind: { group: "kafka.strimzi.io", version: "v1beta2", kind: obj.kind ?? "" }, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
}

async function openDetails(obj: KubeObject): Promise<HTMLElement> {
  const ref = refTo(obj);
  useAppStore.getState().openDetails(ref);
  const { container } = render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  emitSnapshot(wb, await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`), [obj]);
  await waitFor(() => expect(document.querySelector("[data-section='strimzi']")).not.toBeNull());
  return container;
}

const view = () => within(document.querySelector<HTMLElement>("[data-section='strimzi']")!);

describe("details", () => {
  it("of a Kafka: ready, the warning, listeners with addresses and the node pools", async () => {
    const container = await openDetails(kafka);
    const v = view();
    expect(v.getByText("Ready")).toHaveClass("rt-status--success");
    expect(v.getByText("UnusedKafkaConfig")).toBeInTheDocument();
    expect(v.getByText("my-cluster-kafka-bootstrap.kafka.svc:9093", { selector: ".dt-chip" })).toBeInTheDocument();
    expect(v.getByText("No address yet")).toBeInTheDocument();
    expect(v.getByRole("button", { name: "Open KafkaNodePool broker" })).toBeInTheDocument();
    expect(v.getByText("KRaft")).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("of a KafkaTopic: why it is not ready, its Kafka, partitions and replicas", async () => {
    await openDetails(topic);
    const v = view();
    expect(v.getByText("Not ready")).toHaveClass("rt-status--danger");
    expect(v.getByText(/InvalidReplicationFactorException/)).toBeInTheDocument();
    expect(v.getByRole("button", { name: "Open Kafka my-cluster" })).toBeInTheDocument();
    expect(v.getByText("retention.ms=7200000")).toBeInTheDocument();
  });

  it("of a KafkaUser: its Secret by name, never its data", async () => {
    const container = await openDetails(user);
    const v = view();
    expect(v.getByRole("button", { name: "Open Secret my-user" })).toBeInTheDocument();
    expect(v.getByText("CN=my-user")).toBeInTheDocument();
    expect(v.getByText("2")).toBeInTheDocument();
    expect(wb.backend.calls.map((c) => c.cmd)).not.toContain("secret_value");
    expect([...wb.specs.values()].some((s) => s.kind.kind === "Secret")).toBe(false);
    expect(await axeViolations(container)).toEqual([]);
  });
});
