import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultAppSettings,
  type AppSettings,
  type KindRef,
  type KubeObject,
  type ObjectRef,
  type ResourceKind,
} from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { Sidebar } from "../../layout/sidebar/Sidebar";
import { getResourceDef, resetClusterKinds } from "../../resources";
import { axeViolations } from "../../test/axe";
import "../details";
import { copy, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore } from "../namespaces";
import { detect, resolve } from "../problems/model";
import { resetProblemSources } from "../problems/store";
import { resetSharedWatches } from "../resource-map/watches";
import { connectorStatusOf, firstLine, MAX_LINE_CHARS, mirrorConnectorsOf, taskCounts } from "./connectors";
import connectorJson from "./fixtures/kafkaconnector.json";
import mirrorJson from "./fixtures/kafkamirrormaker2.json";
import "./index";
import { isProblem, KAFKA_CONNECTOR, KAFKA_MIRROR_MAKER_2, STRIMZI_KINDS } from "./model";

const connector = connectorJson as KubeObject;
const mirror = mirrorJson as KubeObject;
type Mutable = Record<string, Record<string, unknown>>;

describe("connectors in the model", () => {
  it("reads the Kafka Connect REST status Strimzi copies, task ids as text", () => {
    const c = connectorStatusOf(connector)!;
    expect(c).toMatchObject({
      name: "my-source-connector",
      type: "source",
      state: "RUNNING",
      workerId: "10.244.0.21:8083",
    });
    expect(c.tasks.map((t) => [t.id, t.state])).toEqual([
      ["0", "RUNNING"],
      ["1", "FAILED"],
    ]);
    expect(taskCounts(c)).toEqual({ running: 1, failed: 1, total: 2 });
    expect(mirrorConnectorsOf(mirror).map((m) => m.name)).toEqual([
      "cluster-a->cluster-b.MirrorCheckpointConnector",
      "cluster-a->cluster-b.MirrorSourceConnector",
    ]);
  });

  it("takes the first line of a trace, clipped", () => {
    expect(firstLine("\n  java.lang.Error: boom\n\tat x")).toBe("java.lang.Error: boom");
    expect(firstLine("x".repeat(MAX_LINE_CHARS + 10))).toHaveLength(MAX_LINE_CHARS + 1);
    expect(firstLine(undefined)).toBeUndefined();
  });

  it("a failed task is a problem at once, said by its trace instead of Strimzi's NotReady", () => {
    expect(detect(KAFKA_CONNECTOR, connector)).toEqual([
      {
        reason: "TaskFailed",
        group: "taskFailed",
        message:
          "org.apache.kafka.connect.errors.ConnectException: java.nio.file.NoSuchFileException: /opt/kafka/LICENSE",
        since: "2026-10-10T08:00:00Z",
        notify: true,
      },
    ]);
    const [problem] = resolve(KAFKA_CONNECTOR, connector, Date.parse("2026-10-10T08:00:01Z"));
    expect(problem).toMatchObject({
      category: "strimzi",
      activeAt: Date.parse("2026-10-10T08:00:00Z"),
    });
  });

  it("a failed connector is a problem; a healthy one is not", () => {
    const failed = copy(connector);
    const st = (failed as unknown as Mutable).status!;
    st.connectorStatus = {
      name: "my-source-connector",
      connector: {
        state: "FAILED",
        worker_id: "w",
        trace: 'org.apache.kafka.common.config.ConfigException: Missing required configuration "file"\n\tat x',
      },
      tasks: [],
    };
    expect(detect(KAFKA_CONNECTOR, failed)).toEqual([
      expect.objectContaining({
        reason: "ConnectorFailed",
        message: 'org.apache.kafka.common.config.ConfigException: Missing required configuration "file"',
      }),
    ]);
    const healthy = copy(connector);
    const hs = (healthy as unknown as Mutable).status!;
    hs.connectorStatus = {
      name: "c",
      connector: { state: "RUNNING" },
      tasks: [{ id: 0, state: "RUNNING" }],
    };
    hs.conditions = [{ type: "Ready", status: "True" }];
    expect(detect(KAFKA_CONNECTOR, healthy)).toEqual([]);
    expect(isProblem(healthy)).toBe(false);
  });

  it("a MirrorMaker 2 stays Ready with a failed task, which is still a problem, named by its connector", () => {
    expect(detect(KAFKA_MIRROR_MAKER_2, mirror)).toEqual([
      expect.objectContaining({
        reason: "TaskFailed",
        message:
          "cluster-a->cluster-b.MirrorSourceConnector: org.apache.kafka.common.errors.TopicAuthorizationException: Not authorized to access topics: [orders]",
      }),
    ]);
    expect(isProblem(mirror)).toBe(true);
  });

  it("the connectors table shows the Connect cluster, the state, running tasks, the class and restarts", () => {
    const def = getResourceDef(KAFKA_CONNECTOR);
    const col = (id: string) => def.columns.find((c) => c.id === id)!;
    expect(col("connectCluster").value(connector)).toBe("my-connect-cluster");
    expect(col("connectorState").value(connector)).toBe("RUNNING");
    expect(col("tasks").value(connector)).toBe(1);
    expect(col("class").value(connector)).toBe("FileStreamSourceConnector");
    expect(col("restarts").value(connector)).toBe(3);
    expect(def.problem?.(connector)).toBe(true);
  });
});

// ---------- In the app ----------

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const served = (kind: KindRef): ResourceKind => ({
  kindRef: kind,
  plural: `${kind.kind.toLowerCase()}s`,
  namespaced: true,
  verbs: ["list", "watch"],
  printerColumns: [],
});

let wb: WatchBackend;
let stored: AppSettings;

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetProblemSources();
  resetSharedWatches();
  resetSettingsCache();
  resetNamespaceRestore();
  stored = defaultAppSettings();
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => [POD, ...STRIMZI_KINDS.map((d) => d.kind)].map(served));
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

async function openDetails(obj: KubeObject): Promise<HTMLElement> {
  const ref: ObjectRef = {
    kind: { group: "kafka.strimzi.io", version: "v1", kind: obj.kind ?? "" },
    namespace: "kafka",
    name: obj.metadata?.name ?? "",
  };
  useAppStore.getState().openDetails(ref);
  const { container } = render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  emitSnapshot(wb, await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`), [obj]);
  await waitFor(() => expect(document.querySelector("[data-section='strimzi']")).not.toBeNull());
  return container;
}

const view = () => within(document.querySelector<HTMLElement>("[data-section='strimzi']")!);

describe("KafkaConnectors in the app", () => {
  it("are an entry of the Strimzi section", async () => {
    render(<Sidebar clusterId="c1" />);
    const header = await screen.findByRole("button", { name: /^Strimzi/ });
    if (header.getAttribute("aria-expanded") === "false") fireEvent.click(header);
    await waitFor(() => expect(screen.getByText("Kafka Connectors")).toBeInTheDocument());
  });

  it("details: the Connect cluster, the failed task with its trace, auto-restarts used up", async () => {
    const container = await openDetails(connector);
    const v = view();
    expect(v.getByRole("button", { name: "Open KafkaConnect my-connect-cluster" })).toBeInTheDocument();
    expect(v.getByText("Task 1 failed")).toBeInTheDocument();
    expect(v.getAllByText(/NoSuchFileException: \/opt\/kafka\/LICENSE$/).length).toBeGreaterThan(0);
    expect(v.getByText("Stack trace")).toBeInTheDocument();
    expect(v.getByText("On, at most 3 restarts")).toBeInTheDocument();
    expect(v.getByText("Strimzi stopped restarting it automatically after 3 restarts.")).toBeInTheDocument();
    expect(v.getByText("FAILED")).toHaveClass("rt-status--danger");
    expect(v.getByText("my-topic")).toBeInTheDocument();
    // Strimzi's own "see connectorStatus" adds nothing next to the failure.
    expect(v.queryByText(/see connectorStatus/)).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("details of a MirrorMaker 2: auto-restarts per connector and the failed task named by its connector", async () => {
    const container = await openDetails(mirror);
    const v = view();
    expect(v.getByText("Task 0 of cluster-a->cluster-b.MirrorSourceConnector failed")).toBeInTheDocument();
    expect(v.getByRole("columnheader", { name: "Auto-restarts" })).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });
});
