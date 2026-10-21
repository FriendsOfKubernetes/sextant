import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings, type KindRef, type KubeObject, type ObjectRef, type ResourceKind } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { Sidebar } from "../../layout/sidebar/Sidebar";
import { getResourceDef, resetClusterKinds } from "../../resources";
import { axeViolations } from "../../test/axe";
import "../details";
import { copy, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore } from "../namespaces";
import { categoryOf, resolve } from "../problems/model";
import { CATEGORY_SOURCES } from "../problems/sources";
import { resetProblemSources } from "../problems/store";
import eventingJson from "./fixtures/eventing.json";
import "./index";
import {
  API_SERVER_SOURCE,
  BROKER,
  CHANNEL,
  EVENTING_KINDS,
  explainEventing,
  filterText,
  IN_MEMORY_CHANNEL,
  KAFKA_SOURCE,
  PARALLEL,
  PING_SOURCE,
  SEQUENCE,
  SINK_BINDING,
  SUBSCRIPTION,
  TRIGGER,
  triggerFilter,
} from "./eventing";
import { eventPath, pathNeeds, type PathNode } from "./eventingPath";
import { knativeProblems } from "./problemRules";

const all = eventingJson as KubeObject[];
const byName = (kind: string, name: string) => all.find((o) => o.kind === kind && o.metadata?.name === name)!;
const broker = byName("Broker", "default");
const trigger = byName("Trigger", "my-service-trigger");
const badTrigger = byName("Trigger", "orders-trigger");
const ping = byName("PingSource", "test-ping-source");
const apiSource = byName("ApiServerSource", "testevents");
const channel = byName("Channel", "my-channel");
const subscription = byName("Subscription", "my-subscription");
const imc = byName("InMemoryChannel", "my-channel");
const sequence = byName("Sequence", "sequence");
const parallel = byName("Parallel", "odd-even-parallel");
const binding = byName("SinkBinding", "bind-heartbeat");
const kafka = byName("KafkaSource", "kafka-source");

/** The tree as `role:Kind/name` lines, indented by depth. */
function lines(node: PathNode, depth = 0): string[] {
  const label = `${"  ".repeat(depth)}${node.role}${node.index ? node.index : ""}:${node.kind ?? "uri"}/${node.name ?? node.uri ?? ""}${node.current ? " *" : ""}`;
  return [label, ...node.children.flatMap((c) => lines(c, depth + 1))];
}

const SOURCES = (items: KubeObject[]) => [{ kind: PING_SOURCE, items: items.filter((o) => o.kind === "PingSource") }, { kind: API_SERVER_SOURCE, items: items.filter((o) => o.kind === "ApiServerSource") }];

describe("the Eventing model", () => {
  it("reads a Trigger's filter: spec.filters overrides spec.filter, the dialects nest", () => {
    expect(filterText(triggerFilter(trigger).terms)).toBe("type=dev.knative.sources.ping");
    const f = triggerFilter(badTrigger);
    expect(f.legacyIgnored).toBe(true);
    expect(filterText(f.terms)).toBe("type=com.example.order, (source=/orders/* | subject=*.json)");
    const legacyAny = copy(trigger);
    (legacyAny.spec as { filter: { attributes: Record<string, string> } }).filter.attributes = { source: "" };
    expect(triggerFilter(legacyAny).terms).toEqual([{ op: "anyValue", attribute: "source" }]);
    const none = copy(trigger);
    delete (none.spec as { filter?: unknown }).filter;
    expect(triggerFilter(none).terms).toEqual([]);
  });

  it("explains each failure from the object's own conditions", () => {
    expect(explainEventing(BROKER, broker)).toEqual({ key: "brokerReady", params: { url: "http://broker-ingress.knative-eventing.svc.cluster.local/default/default" } });
    expect(explainEventing(TRIGGER, badTrigger)).toEqual({
      key: "subscriberUnresolved",
      params: { reason: "Unable to get the Subscriber's URI", subscriber: "Service/orders /events" },
    });
    expect(explainEventing(API_SERVER_SOURCE, apiSource)?.key).toBe("permissions");
    expect(explainEventing(KAFKA_SOURCE, kafka)?.key).toBe("kafkaConnection");
    expect(explainEventing(IN_MEMORY_CHANNEL, imc)?.key).toBe("imcDispatcher");
    expect(explainEventing(SEQUENCE, sequence)).toEqual({ key: "progressing" });
    expect(explainEventing(PING_SOURCE, ping)).toEqual({ key: "sourceReady", params: { uri: "http://broker-ingress.knative-eventing.svc.cluster.local/default/default" } });
    expect(explainEventing(SINK_BINDING, binding)?.key).toBe("bindingReady");
  });
});

describe("the event path", () => {
  it("of a Broker: the sources that send to it, its Triggers and their subscribers", () => {
    const needs = pathNeeds(BROKER, broker);
    expect(needs).toMatchObject({ namespace: "default", triggers: true, sources: true, subscriptions: false });
    const path = eventPath(BROKER, broker, { triggers: all.filter((o) => o.kind === "Trigger"), sources: SOURCES(all) })!;
    expect(path.from?.map((n) => `${n.kind}/${n.name}`)).toEqual(["PingSource/test-ping-source", "ApiServerSource/testevents"]);
    expect(lines(path.root)).toEqual([
      "hub:Broker/default *",
      "  trigger:Trigger/my-service-trigger",
      "    subscriber:Service/event-display",
      "  trigger:Trigger/orders-trigger",
      "    subscriber:Service/orders",
    ]);
    // The subscriber resolved to its address.
    expect(path.root.children[0]!.children[0]!.uri).toBe("http://event-display.default.svc.cluster.local");
  });

  it("of a Trigger: its Broker's sources, the Broker, the Trigger and its subscriber", () => {
    expect(pathNeeds(TRIGGER, trigger)).toMatchObject({ brokers: true, sources: true, triggers: false });
    const path = eventPath(TRIGGER, trigger, { brokers: [broker], sources: SOURCES(all) })!;
    expect(path.from).toHaveLength(2);
    expect(lines(path.root)).toEqual(["hub:Broker/default", "  trigger:Trigger/my-service-trigger *", "    subscriber:Service/event-display"]);
    expect(path.root.obj).toBe(broker);
  });

  it("of a source: its sink, followed through the Broker to the Triggers", () => {
    expect(pathNeeds(PING_SOURCE, ping)).toMatchObject({ brokers: true, triggers: true, sources: false });
    const path = eventPath(PING_SOURCE, ping, { brokers: [broker], triggers: [trigger] })!;
    expect(lines(path.root)).toEqual([
      "source:PingSource/test-ping-source *",
      "  sink:Broker/default",
      "    trigger:Trigger/my-service-trigger",
      "      subscriber:Service/event-display",
    ]);
    // A sink to a Service ends there, with the address it resolved to.
    expect(pathNeeds(SINK_BINDING, binding)).toBeUndefined();
    expect(lines(eventPath(SINK_BINDING, binding, {})!.root)).toEqual(["source:SinkBinding/bind-heartbeat *", "  sink:Service/event-display"]);
  });

  it("of a Channel and a Subscription; a Sequence's steps in order; a Parallel's branches", () => {
    const path = eventPath(CHANNEL, channel, { subscriptions: [subscription], sources: [] })!;
    expect(path.from).toEqual([]);
    expect(lines(path.root)).toEqual([
      "hub:Channel/my-channel *",
      "  subscription:Subscription/my-subscription",
      "    subscriber:Service/event-display",
      "    reply:Broker/default",
    ]);
    expect(lines(eventPath(SUBSCRIPTION, subscription, {})!.root)[0]).toBe("hub:Channel/my-channel");
    expect(lines(eventPath(SEQUENCE, sequence, {})!.root)).toEqual([
      "hub:Sequence/sequence *",
      "  step1:Service/first",
      "    step2:Service/second",
      "      step3:uri/http://third.default.svc.cluster.local",
      "        reply:Service/event-display",
    ]);
    expect(lines(eventPath(PARALLEL, parallel, {})!.root)).toEqual([
      "hub:Parallel/odd-even-parallel *",
      "  branch1:uri/",
      "    filter:Service/even-filter",
      "      subscriber:Service/even-transformer",
      "        reply:Service/event-display",
      "  branch2:uri/",
      "    filter:Service/odd-filter",
      "      subscriber:Service/odd-transformer",
      "        reply:Service/event-display",
    ]);
  });
});

describe("problems", () => {
  it("a not-ready Eventing object is one of the Knative category, after the grace", () => {
    const [p] = knativeProblems(TRIGGER, badTrigger);
    expect(p).toMatchObject({ reason: "Unable to get the Subscriber's URI", notify: true, graceMs: 2 * 60_000 });
    expect(p!.message).toMatch(/orders/);
    expect(categoryOf(TRIGGER)).toBe("knative");
    expect(categoryOf(KAFKA_SOURCE)).toBe("knative");
    expect(resolve(TRIGGER, badTrigger, Date.parse("2026-10-21T00:00:00Z"))[0]?.category).toBe("knative");
    expect(knativeProblems(API_SERVER_SOURCE, apiSource)).toHaveLength(1);
    expect(knativeProblems(KAFKA_SOURCE, kafka)).toHaveLength(1);
    expect(knativeProblems(BROKER, broker)).toEqual([]);
    // Progressing is no problem.
    expect(knativeProblems(SEQUENCE, sequence)).toEqual([]);
  });

  it("an object another Eventing object controls is told through its owner; a Broker's failure through the Broker", () => {
    expect(knativeProblems(IN_MEMORY_CHANNEL, imc)).toEqual([]);
    const own = copy(imc);
    delete own.metadata!.ownerReferences;
    expect(knativeProblems(IN_MEMORY_CHANNEL, own)).toHaveLength(1);
    const brokerDown = copy(trigger);
    (brokerDown.status as { conditions: { type: string; status: string; reason?: string }[] }).conditions = [
      { type: "BrokerReady", status: "False", reason: "IngressNotReady" },
      { type: "Ready", status: "False", reason: "IngressNotReady" },
    ];
    expect(knativeProblems(TRIGGER, brokerDown)).toEqual([]);
    (brokerDown.status as { conditions: { reason?: string }[] }).conditions.forEach((c) => (c.reason = "BrokerDoesNotExist"));
    expect(knativeProblems(TRIGGER, brokerDown)).toHaveLength(1);
  });

  it("watches every Eventing kind, capped, only where served; the tables offer the problem filter", () => {
    const watched = CATEGORY_SOURCES.knative.map((s) => s.kind.kind);
    for (const def of EVENTING_KINDS) expect(watched).toContain(def.kind.kind);
    expect(CATEGORY_SOURCES.knative.filter((s) => s.kind.group !== "serving.knative.dev").every((s) => s.discovered && s.maxObjects === 5000)).toBe(true);
    expect(getResourceDef(TRIGGER).problem?.(badTrigger)).toBe(true);
    expect(getResourceDef(BROKER).problem?.(broker)).toBe(false);
  });
});

// ---------- In the app ----------

const served = (kind: KindRef): ResourceKind => ({ kindRef: kind, plural: `${kind.kind.toLowerCase()}s`, namespaced: true, verbs: ["list", "watch"], printerColumns: [] });
const BUILT_IN: KindRef[] = [{ group: "", version: "v1", kind: "Pod" }];

let wb: WatchBackend;
let discovery: KindRef[];

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetProblemSources();
  resetSettingsCache();
  resetNamespaceRestore();
  discovery = [...BUILT_IN, BROKER, TRIGGER, PING_SOURCE, API_SERVER_SOURCE];
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => discovery.map(served));
  wb.backend.on("settings_get", () => defaultAppSettings());
});

afterEach(() => {
  wb.backend.restore();
  resetClusterKinds();
  resetProblemSources();
  resetSettingsCache();
});

const sections = () =>
  screen
    .getAllByRole("button")
    .filter((b) => b.hasAttribute("aria-expanded"))
    .map((b) => b.textContent);

describe("the Knative Eventing section", () => {
  it("lists the kinds the cluster serves and counts the objects that need attention", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Knative Eventing"));
    expect(sections()).not.toContain("Knative Serving");
    fireEvent.click(screen.getByRole("button", { name: /Knative Eventing/ }));
    const section = within(screen.getByRole("button", { name: /Knative Eventing/ }).closest("li")!);
    for (const label of ["Brokers", "Triggers", "Ping Sources", "API Server Sources"]) expect(section.getByRole("button", { name: label })).toBeInTheDocument();
    expect(section.queryByRole("button", { name: "Kafka Sources" })).toBeNull();
    emitSnapshot(wb, await watchOf(wb, "Trigger", (s) => s.fieldSelector === null), [badTrigger]);
    await waitFor(() => expect(screen.getByTitle("1 Knative Eventing object needs attention")).toHaveTextContent("1"));
    expect(await axeViolations(document.body)).toEqual([]);
  });
});

function refTo(obj: KubeObject): ObjectRef {
  const [group, version] = (obj.apiVersion ?? "").split("/");
  return { kind: { group: group!, version: version!, kind: obj.kind ?? "" }, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
}

async function openDetails(obj: KubeObject): Promise<void> {
  const ref = refTo(obj);
  useAppStore.getState().openDetails(ref);
  render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  const id = await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`);
  emitSnapshot(wb, id, [obj]);
}

const detailsSection = (id: string) => within(document.querySelector<HTMLElement>(`[data-section='${id}']`)!);

describe("details", () => {
  it("of a Broker: its address and the event path from the namespace's sources to the subscribers", async () => {
    await openDetails(broker);
    const kn = detailsSection("knativeEventing");
    await waitFor(() => expect(kn.getByText("Ready: receives events at http://broker-ingress.knative-eventing.svc.cluster.local/default/default.")).toBeInTheDocument());
    emitSnapshot(wb, await watchOf(wb, "Trigger", (s) => s.namespaces?.[0] === "default"), [trigger, badTrigger]);
    emitSnapshot(wb, await watchOf(wb, "PingSource", (s) => s.namespaces?.[0] === "default"), [ping]);
    emitSnapshot(wb, await watchOf(wb, "ApiServerSource", (s) => s.namespaces?.[0] === "default"), []);
    await waitFor(() => expect(kn.getByRole("button", { name: "Open Trigger orders-trigger" })).toBeInTheDocument());
    expect(kn.getByRole("button", { name: "Open PingSource test-ping-source" })).toBeInTheDocument();
    expect(kn.getByRole("button", { name: "Open Service event-display" })).toBeInTheDocument();
    expect(kn.getByText("Sent here by:")).toBeInTheDocument();
    // Kinds the cluster does not serve are never watched.
    expect(wb.backend.calls.some((c) => c.cmd === "watch_start" && JSON.stringify(c.args).includes("ContainerSource"))).toBe(false);
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it("of a Trigger: why it is not ready and its filter in words", async () => {
    await openDetails(badTrigger);
    const kn = detailsSection("knativeEventing");
    await waitFor(() => expect(kn.getByText(/Its subscriber Service\/orders \/events cannot be resolved to an address/)).toBeInTheDocument());
    expect(kn.getByText("type is com.example.order")).toBeInTheDocument();
    expect(kn.getByText("any of: source starts with /orders/, subject ends with .json")).toBeInTheDocument();
    expect(kn.getByText(/spec\.filter is ignored/)).toBeInTheDocument();
    expect(kn.getAllByRole("button", { name: "Open Broker default" }).length).toBeGreaterThan(0);
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
