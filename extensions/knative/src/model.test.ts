// The model and the manifest's declarative parts. The manifest's problem rules, the kinds' "Only problems" and the
// columns are judged here by Sextant's own window engine (src/extensions/problemRules.ts and columns.tsx, loaded at run
// time so the type check stays inside the extension) and compared with the model they replace — the reading of
// Sextant's former built-in view (ADR-0101, ADR-0106), ported unchanged — on its fixtures and variants of them.
import type { KubeObject } from "@sextant/extension-sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import eventingJson from "../fixtures/eventing.json";
import revisionsJson from "../fixtures/revisions.json";
import serviceJson from "../fixtures/service.json";
import en from "./locales/en.json";
import {
  addressOf,
  brokerClassOf,
  brokerOf,
  channelOf,
  destinationText,
  EVENTING_KINDS,
  eventingProblems,
  explainEventing,
  filterText,
  IN_MEMORY_CHANNEL,
  KAFKA_SOURCE,
  kafkaTopics,
  replyOf,
  selectorText,
  sinkOf,
  subscriberOf,
  TRIGGER,
  triggerFilter,
} from "./eventing";
import {
  CONFIGURATION,
  DOMAIN_MAPPING,
  explain,
  failingCondition,
  get,
  HEALTH_TONE,
  healthOf,
  isProblem,
  KNATIVE_GRACE_MS,
  KNATIVE_KINDS,
  KSERVICE,
  mappingRef,
  REVISION,
  revisionFields,
  ROUTE,
  sameKind,
  serviceFields,
  servingProblems,
  str,
  trafficSplit,
  trafficSummary,
  type KindOf,
} from "./model";

const copy = <T>(value: T): T => structuredClone(value);
const service = serviceJson as unknown as KubeObject;
const [oldRevision, failedRevision] = revisionsJson as unknown as KubeObject[];
const eventing = eventingJson as unknown as KubeObject[];
const find = (kind: string, name: string): KubeObject => copy(eventing.find((o) => o.kind === kind && o.metadata.name === name)!);
const st = (o: KubeObject) => o.status as Record<string, unknown>;
type Cond = { type: string; status: string; reason?: string; message?: string; lastTransitionTime?: string };
/** Sets a condition, keeping the list sorted by type as Knative writes it (knative.dev/pkg's ConditionSet). */
const setCond = (o: KubeObject, c: Cond) => {
  const list = ((st(o).conditions as Cond[] | undefined) ?? []).filter((x) => x.type !== c.type);
  st(o).conditions = [...list, c].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
};
const owners = (o: KubeObject) => (o.metadata.ownerReferences ?? []) as { kind?: string }[];
const withKind = (o: KubeObject, apiVersion: string, kind: string): KubeObject => ({ ...copy(o), apiVersion, kind });

// ---------- Sextant's window engine ----------

interface Verdict {
  holds: boolean;
}
interface Detected {
  reason: string;
  group: string;
  message?: string;
  since?: string;
  graceMs?: number;
  notify: boolean;
  ownerUid?: string;
}
interface Engine {
  evaluate(condition: unknown, obj: KubeObject): Verdict;
  detectRule(rule: unknown, obj: KubeObject): Detected[];
}
interface WindowColumn {
  width?: string;
  filter?: { value(obj: KubeObject, ctx: { now: number; t: (key: string, values?: { count?: number }) => string }): unknown };
  value(obj: KubeObject): unknown;
  render(obj: KubeObject, ctx: { now: number }): unknown;
  searchText(obj: KubeObject, ctx: { now: number; t: (key: string, values?: { count?: number }) => string }): string | null | undefined;
}
interface Columns {
  computedColumn(id: string, column: unknown): WindowColumn;
}
let engine: Engine;
let columns: Columns;
const here = dirname(fileURLToPath(import.meta.url));
beforeAll(async () => {
  engine = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/problemRules.ts"))) as Engine;
  columns = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/columns.tsx"))) as Columns;
});

const rulesOf = (kind: KindOf) => manifest.contributes.problems.filter((r) => sameKind(r.kind, kind));
/** The problems the manifest's rules find in `obj`, as the window finds them object by object. */
const windowProblems = (kind: KindOf, obj: KubeObject): Detected[] => rulesOf(kind).flatMap((rule) => engine.detectRule(rule, obj));
const reference = (kind: KindOf, obj: KubeObject) => [...servingProblems(kind, obj), ...eventingProblems(kind, obj)];

function expectSameProblems(kind: KindOf, obj: KubeObject): void {
  // An empty reason: the built-in detector gave "", the rules give "NotReady" as for none.
  const expected = reference(kind, obj).map((d) => ({ reason: d.reason || "NotReady", message: d.message ?? "", since: d.since, graceMs: d.graceMs }));
  const found = windowProblems(kind, obj).map((d) => ({ reason: d.reason, message: d.message, since: d.since, graceMs: d.graceMs }));
  expect(found, `${kind.kind} ${obj.metadata.name}`).toEqual(expected);
}

const ALL_KINDS: KindOf[] = [...KNATIVE_KINDS.map((d) => d.kind), ...EVENTING_KINDS.map((d) => d.kind)];
const kindOf = (o: KubeObject): KindOf => ALL_KINDS.find((k) => k.kind === o.kind && (o.apiVersion ?? "").startsWith(`${k.group}/`))!;

// ---------- Variants of the fixtures ----------

function services(): KubeObject[] {
  const failed = copy(service);
  const ready = copy(service);
  st(ready).conditions = [
    { type: "ConfigurationsReady", status: "True" },
    { type: "Ready", status: "True" },
    { type: "RoutesReady", status: "True" },
  ];
  const rolling = copy(service);
  for (const c of st(rolling).conditions as Cond[]) c.status = "Unknown";
  const routeDown = copy(ready);
  setCond(routeDown, { type: "Ready", status: "False", reason: "IngressNotConfigured", message: "Ingress has not yet been reconciled.", lastTransitionTime: "2026-10-12T09:00:00Z" });
  setCond(routeDown, { type: "RoutesReady", status: "False", reason: "IngressNotConfigured", message: "Ingress has not yet been reconciled.", lastTransitionTime: "2026-10-12T09:00:00Z" });
  const unnamed = copy(failed);
  for (const c of st(unnamed).conditions as Cond[]) delete c.reason;
  const empty = copy(failed);
  for (const c of st(empty).conditions as Cond[]) c.reason = "";
  const readyOnly = copy(failed);
  st(readyOnly).conditions = [{ type: "Ready", status: "False", reason: "Bad", message: "bad", lastTransitionTime: "2026-10-12T00:00:00Z" }];
  const bare = copy(service);
  delete (bare as { status?: unknown }).status;
  // Several conditions fail: the first False one other than Ready tells the reason, message and time, Ready itself
  // only when no other one fails.
  const twoDown = copy(routeDown);
  setCond(twoDown, { type: "Ready", status: "False", reason: "Summary", message: "summary", lastTransitionTime: "2026-10-12T08:00:00Z" });
  setCond(twoDown, { type: "ConfigurationsReady", status: "False", reason: "RevisionFailed", message: "first", lastTransitionTime: "2026-10-12T07:00:00Z" });
  const readyOnlyUnnamed = copy(readyOnly);
  delete (st(readyOnlyUnnamed).conditions as Cond[])[0]!.reason;
  // A False condition beside a ready one (a warning) is no reason.
  const readyWarning = copy(ready);
  setCond(readyWarning, { type: "RoutesReady", status: "False", reason: "Warn" });
  return [failed, ready, rolling, routeDown, unnamed, empty, readyOnly, bare, twoDown, readyOnlyUnnamed, readyWarning];
}

function configurations(): KubeObject[] {
  const own = services().map((s) => withKind(s, "serving.knative.dev/v1", "Configuration"));
  const owned = own.map((c) => {
    const o = copy(c);
    o.metadata.ownerReferences = [{ apiVersion: "serving.knative.dev/v1", kind: "Service", name: "hello", uid: "u1", controller: true }];
    return o;
  });
  // A Service of any version owns it, its reference wherever it is; a core Service does not.
  const ownedOlder = owned.map((c) => {
    const o = copy(c);
    o.metadata.ownerReferences = [
      { apiVersion: "v1", kind: "Service", name: "core", uid: "u0" },
      { apiVersion: "serving.knative.dev/v1beta1", kind: "Service", name: "hello", uid: "u1", controller: true },
    ];
    return o;
  });
  const coreOwner = own.map((c) => {
    const o = copy(c);
    o.metadata.ownerReferences = [{ apiVersion: "v1", kind: "Service", name: "core", uid: "u0" }];
    return o;
  });
  return [...own, ...owned, ...ownedOlder, ...coreOwner];
}

function revisions(): KubeObject[] {
  const starting = copy(failedRevision!);
  setCond(starting, { type: "ContainerHealthy", status: "Unknown" });
  setCond(starting, { type: "Ready", status: "Unknown" });
  const noResources = copy(failedRevision!);
  setCond(noResources, { type: "ContainerHealthy", status: "True" });
  setCond(noResources, { type: "ResourcesAvailable", status: "False", reason: "ProgressDeadlineExceeded", message: "timed out" });
  setCond(noResources, { type: "Ready", status: "False", reason: "ProgressDeadlineExceeded", message: "timed out" });
  const unknownHealth = copy(starting);
  setCond(unknownHealth, { type: "ContainerHealthy", status: "False", reason: "ImagePullBackOff" });
  const noDesired = copy(oldRevision!);
  delete st(noDesired).desiredReplicas;
  const noReplicas = copy(oldRevision!);
  delete st(noReplicas).actualReplicas;
  return [copy(oldRevision!), copy(failedRevision!), starting, noResources, unknownHealth, noDesired, noReplicas];
}

function routes(): KubeObject[] {
  const base = withKind(service, "serving.knative.dev/v1", "Route");
  const traffic = (list: unknown[] | undefined, spec?: unknown[]) => {
    const o = copy(base);
    if (list === undefined) delete st(o).traffic;
    else st(o).traffic = list;
    if (spec !== undefined) (o.spec as Record<string, unknown>).traffic = spec;
    return o;
  };
  const t = (revisionName: string, percent: number, extra: Record<string, unknown> = {}) => ({ revisionName, percent, ...extra });
  return [
    copy(base),
    traffic([t("a", 100)]),
    traffic([t("a", 0, { tag: "old" }), t("b", 100)]),
    traffic([t("a", 0, { tag: "old" }), t("b", 0, { tag: "candidate" }), t("c", 100)]),
    traffic([t("a", 50), t("b", 0), t("c", 50)]),
    traffic([t("a", 0), t("b", 40), t("c", 60)]),
    traffic([t("a", 10), t("b", 10), t("c", 80)]),
    traffic(undefined, [{ latestRevision: true, percent: 100 }]),
    traffic(undefined, [{ revisionName: "hello-00001", percent: 100 }]),
    traffic(undefined, []),
  ];
}

function domainMappings(): KubeObject[] {
  const dm = withKind(service, "serving.knative.dev/v1beta1", "DomainMapping");
  dm.spec = { ref: { apiVersion: "serving.knative.dev/v1", kind: "Service", name: "hello" } };
  st(dm).conditions = [
    { type: "CertificateProvisioned", status: "False", reason: "CertificateNotReady", message: "not yet" },
    { type: "DomainClaimed", status: "True" },
    { type: "Ready", status: "False", reason: "CertificateNotReady", message: "not yet" },
  ];
  const ready = copy(dm);
  st(ready).conditions = [{ type: "Ready", status: "True" }];
  return [dm, ready];
}

/** The fixtures' Eventing objects and variants: failures, owned objects, Broker-caused Trigger failures. */
function eventingObjects(): KubeObject[] {
  const out: KubeObject[] = eventing.map(copy);
  const imcOwn = find("InMemoryChannel", "my-channel");
  delete imcOwn.metadata.ownerReferences;
  const imcByBroker = copy(imcOwn);
  imcByBroker.metadata.ownerReferences = [{ apiVersion: "eventing.knative.dev/v1", kind: "Broker", name: "default", uid: "b1", controller: true }];
  const imcOtherOwner = copy(imcOwn);
  imcOtherOwner.metadata.ownerReferences = [{ apiVersion: "messaging.knative.dev/v1beta1", kind: "KafkaChannel", name: "k", uid: "k1", controller: true }];
  const brokerDown = find("Trigger", "my-service-trigger");
  st(brokerDown).conditions = [
    { type: "BrokerReady", status: "False", reason: "IngressNotReady", message: "ingress", lastTransitionTime: "2026-10-20T00:00:00Z" },
    { type: "Ready", status: "False", reason: "IngressNotReady", message: "ingress", lastTransitionTime: "2026-10-20T00:00:00Z" },
  ];
  const brokerMissing = copy(brokerDown);
  for (const c of st(brokerMissing).conditions as Cond[]) c.reason = "BrokerDoesNotExist";
  const brokerUnnamed = copy(brokerDown);
  for (const c of st(brokerUnnamed).conditions as Cond[]) delete c.reason;
  const subOwned = find("Subscription", "my-subscription");
  subOwned.metadata.ownerReferences = [{ apiVersion: "eventing.knative.dev/v1", kind: "Trigger", name: "t", uid: "t1", controller: true }];
  setCond(subOwned, { type: "Ready", status: "False", reason: "SubscriberResolveFailed", message: "x" });
  const subOwn = copy(subOwned);
  delete subOwn.metadata.ownerReferences;
  const brokerFailed = find("Broker", "default");
  setCond(brokerFailed, { type: "IngressReady", status: "False", reason: "EndpointsUnavailable", message: "no endpoints", lastTransitionTime: "2026-10-20T00:00:00Z" });
  setCond(brokerFailed, { type: "Ready", status: "False", reason: "EndpointsUnavailable", message: "no endpoints", lastTransitionTime: "2026-10-20T00:00:00Z" });
  const ping = find("PingSource", "test-ping-source");
  setCond(ping, { type: "SinkProvided", status: "False", reason: "NotFound", message: "sink missing" });
  setCond(ping, { type: "Ready", status: "False", reason: "NotFound", message: "sink missing" });
  const binding = find("SinkBinding", "bind-heartbeat");
  binding.metadata.ownerReferences = [{ apiVersion: "sources.knative.dev/v1", kind: "ContainerSource", name: "c", uid: "c1", controller: true }];
  setCond(binding, { type: "Ready", status: "False", reason: "SinkNotFound", message: "x" });
  const bindingOwn = copy(binding);
  delete bindingOwn.metadata.ownerReferences;
  const container = withKind(ping, "sources.knative.dev/v1", "ContainerSource");
  const sequenceDown = find("Sequence", "sequence");
  st(sequenceDown).conditions = [
    { type: "ChannelsReady", status: "False", reason: "ChannelsNotReady", message: "x" },
    { type: "Ready", status: "False", reason: "ChannelsNotReady", message: "x" },
  ];
  const parallelDown = withKind(sequenceDown, "flows.knative.dev/v1", "Parallel");
  const channelDown = find("Channel", "my-channel");
  setCond(channelDown, { type: "BackingChannelReady", status: "False", reason: "BackingChannelNotReady", message: "x" });
  setCond(channelDown, { type: "Ready", status: "False", reason: "BackingChannelNotReady", message: "x" });
  const channelOfBroker = copy(channelDown);
  channelOfBroker.metadata.ownerReferences = [{ apiVersion: "eventing.knative.dev/v1", kind: "Broker", name: "default", uid: "b1", controller: true }];
  // An owner that is not the controller tells nothing; a controller of another group neither.
  const channelNotController = copy(channelDown);
  channelNotController.metadata.ownerReferences = [{ apiVersion: "eventing.knative.dev/v1", kind: "Broker", name: "default", uid: "b1" }];
  const channelOfOther = copy(channelDown);
  channelOfOther.metadata.ownerReferences = [{ apiVersion: "apps/v1", kind: "Deployment", name: "d", uid: "d1", controller: true }];
  // BrokerReady False, but another condition fails first: the Trigger's own problem.
  const brokerSecond = copy(brokerDown);
  st(brokerSecond).conditions = [
    { type: "Addressable", status: "False", reason: "NoAddress", message: "no address", lastTransitionTime: "2026-10-20T00:00:00Z" },
    ...(st(brokerDown).conditions as Cond[]),
  ];
  const subFailing = copy(subOwn);
  setCond(subFailing, { type: "ChannelReady", status: "False", reason: "ChannelNotReady", message: "channel" });
  const bindingFailing = copy(bindingOwn);
  setCond(bindingFailing, { type: "SinkProvided", status: "False", reason: "NotFound", message: "sink" });
  const brokerRefEmpty = copy(brokerDown);
  brokerRefEmpty.spec = { ...(brokerRefEmpty.spec as Record<string, unknown>), broker: "", brokerRef: { name: "" } };
  // Ready alone False, with and without a reason, of every kind.
  const readyOnly = EVENTING_KINDS.flatMap(({ kind }) => {
    const o = withKind(find("Broker", "default"), `${kind.group}/v1`, kind.kind);
    o.metadata.name = `ready-only-${kind.kind.toLowerCase()}`;
    st(o).conditions = [{ type: "Ready", status: "False", reason: "Own", message: "own", lastTransitionTime: "2026-10-21T00:00:00Z" }];
    const unnamed = copy(o);
    delete (st(unnamed).conditions as Cond[])[0]!.reason;
    return [o, unnamed];
  });
  return [
    ...readyOnly,
    channelNotController,
    channelOfOther,
    brokerSecond,
    brokerRefEmpty,
    subFailing,
    bindingFailing,
    ...out,
    imcOwn,
    imcByBroker,
    imcOtherOwner,
    brokerDown,
    brokerMissing,
    brokerUnnamed,
    subOwned,
    subOwn,
    brokerFailed,
    ping,
    binding,
    bindingOwn,
    container,
    sequenceDown,
    parallelDown,
    channelDown,
    channelOfBroker,
  ];
}

const servingObjects = () => [...services(), ...configurations(), ...revisions(), ...routes(), ...domainMappings()];

// ---------- The model ----------

describe("the model", () => {
  it("reads the state, the failing condition and the traffic split", () => {
    expect(healthOf(service)).toBe("failed");
    expect(failingCondition(service)?.type).toBe("ConfigurationsReady");
    expect(explain(KSERVICE, service)).toEqual({
      key: "revisionFailedTrafficStays",
      params: { revision: "hello-00003", ready: "hello-00002", reason: "RevisionFailed" },
    });
    const { targets, asked } = trafficSplit(service);
    expect(asked).toBe(false);
    expect(targets.map((t) => [t.revisionName, t.percent, t.tag, t.latestRevision])).toEqual([
      ["hello-00001", 20, "v1", false],
      ["hello-00002", 80, undefined, true],
    ]);
  });

  it("a revision scaled to zero is ready; a failing container is said so", () => {
    expect(explain(REVISION, oldRevision!)).toEqual({ key: "revisionScaledToZero" });
    expect(failingCondition(oldRevision!)).toBeUndefined();
    expect(explain(REVISION, failedRevision!)).toEqual({ key: "revisionContainerUnhealthy", params: { reason: "ExitCode1" } });
  });

  it("reads a Trigger's filter and explains each Eventing failure from the object's own conditions", () => {
    expect(filterText(triggerFilter(find("Trigger", "my-service-trigger")).terms)).toBe("type=dev.knative.sources.ping");
    const f = triggerFilter(find("Trigger", "orders-trigger"));
    expect(f.legacyIgnored).toBe(true);
    expect(filterText(f.terms)).toBe("type=com.example.order, (source=/orders/* | subject=*.json)");
    expect(explainEventing(TRIGGER, find("Trigger", "orders-trigger"))).toEqual({
      key: "subscriberUnresolved",
      params: { reason: "Unable to get the Subscriber's URI", subscriber: "Service/orders /events" },
    });
    expect(explainEventing(KAFKA_SOURCE, find("KafkaSource", "kafka-source"))?.key).toBe("kafkaConnection");
    expect(explainEventing(IN_MEMORY_CHANNEL, find("InMemoryChannel", "my-channel"))?.key).toBe("imcDispatcher");
  });

  it("writes a SinkBinding's subject selector as its labels and expressions", () => {
    expect(selectorText({ matchLabels: { app: "heartbeat-cron" } })).toBe("app=heartbeat-cron");
    expect(selectorText({ matchExpressions: [{ key: "tier", operator: "In", values: ["a", "b"] }, { key: "x", operator: "Exists" }] })).toBe("tier In (a, b), x Exists");
  });
});

// ---------- The problem rules ----------

describe("the problem rules, against the built-in detector", () => {
  it("find a Knative Service or Configuration not ready, with the failing condition's reason, message and time", () => {
    for (const o of services()) expectSameProblems(KSERVICE, o);
    for (const o of configurations()) expectSameProblems(CONFIGURATION, o);
    const [p] = windowProblems(KSERVICE, service);
    expect(p).toMatchObject({ reason: "RevisionFailed", graceMs: KNATIVE_GRACE_MS, since: "2026-10-10T09:00:00Z" });
    expect(p!.message).toMatch(/hello-00003/);
  });

  it("judge no Revision, Route or DomainMapping, as the built-in detector did not", () => {
    for (const kind of [REVISION, ROUTE, DOMAIN_MAPPING]) expect(rulesOf(kind)).toEqual([]);
  });

  it("find a not-ready Eventing object, leaving out what another Eventing object controls and a Broker-caused Trigger failure", () => {
    for (const o of eventingObjects()) expectSameProblems(kindOf(o), o);
    const brokerUnnamed = eventingObjects().find((o) => o.kind === "Trigger" && (st(o).conditions as Cond[]).some((c) => c.type === "BrokerReady" && c.status === "False" && !c.reason))!;
    expect(reference(TRIGGER, brokerUnnamed)).toEqual([]);
    expect(windowProblems(TRIGGER, brokerUnnamed)).toEqual([]);
    const reasonless = find("KafkaSource", "kafka-source");
    for (const c of st(reasonless).conditions as Cond[]) delete c.reason;
    expect(reference(KAFKA_SOURCE, reasonless)[0]?.reason).toBe("NotReady");
    expect(windowProblems(KAFKA_SOURCE, reasonless)[0]?.reason).toBe("NotReady");
  });

  it("leave out an object another Eventing object controls, of any version, on the object alone", () => {
    const other = eventingObjects().find((o) => o.kind === "InMemoryChannel" && owners(o)[0]?.kind === "KafkaChannel")!;
    expect(reference(IN_MEMORY_CHANNEL, other)).toEqual([]);
    expect(windowProblems(IN_MEMORY_CHANNEL, other)).toEqual([]);
    // Nothing is judged across objects: every rule's problems, in the built-in group, come from the object itself.
    for (const rule of manifest.contributes.problems) {
      expect((rule as { toldThroughOwner?: boolean }).toldThroughOwner, rule.id).toBeUndefined();
      expect(rule.group, rule.id).toBe("not-ready");
      expect((rule as { reasonOr?: string }).reasonOr, rule.id).toBe("NotReady");
    }
  });

  it("tell the reason, message and time of the first False condition other than Ready, else Ready's own", () => {
    const twoDown = services().find((o) => ((st(o)?.conditions as Cond[] | undefined) ?? []).some((c) => c.reason === "Summary"))!;
    expect(windowProblems(KSERVICE, twoDown)).toMatchObject([{ reason: "RevisionFailed", message: "first", since: "2026-10-12T07:00:00Z" }]);
    const readyOnly = services().find((o) => ((st(o)?.conditions as Cond[] | undefined) ?? []).length === 1 && (st(o).conditions as Cond[])[0]!.reason === "Bad")!;
    expect(windowProblems(KSERVICE, readyOnly)).toMatchObject([{ reason: "Bad", message: "bad", since: "2026-10-12T00:00:00Z" }]);
    const brokerSecond = eventingObjects().find((o) => (st(o)?.conditions as Cond[] | undefined)?.[0]?.reason === "NoAddress")!;
    expect(windowProblems(TRIGGER, brokerSecond)).toMatchObject([{ reason: "NoAddress", message: "no address" }]);
  });

  it("are each met by a variant", () => {
    const met = new Set<string>();
    const reasonless = [...services(), ...configurations()].filter((o) => (st(o)?.conditions as Cond[] | undefined)?.every((c) => !c.reason));
    for (const o of [...servingObjects(), ...reasonless, ...eventingObjects()]) {
      const kind = kindOf(o);
      for (const rule of rulesOf(kind)) if (engine.detectRule(rule, o).length > 0) met.add(rule.id);
    }
    expect([...met].sort()).toEqual(manifest.contributes.problems.map((r) => r.id).sort());
  });

  it("notify, as every built-in one did, and each section counts its own rules", () => {
    for (const rule of manifest.contributes.problems) expect((rule as { notify?: boolean }).notify).toBeUndefined();
    const [serving, eventingBadge] = manifest.contributes.sectionBadges;
    expect(serving).toMatchObject({ section: "knative", label: { one: "{{count}} Knative object needs attention", other: "{{count}} Knative objects need attention" } });
    expect(eventingBadge).toMatchObject({
      section: "knativeEventing",
      label: { one: "{{count}} Knative Eventing object needs attention", other: "{{count}} Knative Eventing objects need attention" },
    });
    const servingRules = manifest.contributes.problems.filter((r) => r.kind.group === "serving.knative.dev").map((r) => r.id);
    const eventingRules = manifest.contributes.problems.filter((r) => r.kind.group !== "serving.knative.dev").map((r) => r.id);
    expect(serving!.rules).toEqual(servingRules);
    expect(eventingBadge!.rules).toEqual(eventingRules);
    expect(new Set(manifest.contributes.problems.map((r) => `${r.kind.group}/${r.kind.kind}`)).size).toBe(14);
    // Two rules a kind: its failing condition's and Ready's own.
    expect(manifest.contributes.problems).toHaveLength(28);
  });
});

// ---------- "Only problems" ----------

const kindEntry = (kind: KindOf) => manifest.contributes.kinds.find((k) => sameKind(k, kind))!;

describe("the kinds", () => {
  it("offer Only problems as the built-in tables: Ready is False, without a grace or an owner", () => {
    for (const o of [...servingObjects(), ...eventingObjects()]) {
      const when = (kindEntry(kindOf(o)) as { problemWhen?: unknown }).problemWhen;
      expect(engine.evaluate(when, o).holds, `${o.kind} ${o.metadata.name}`).toBe(isProblem(o));
    }
  });

  it("are listed in the built-in sections, with their titles, icons and order, without the CRDs' own columns", () => {
    expect(manifest.contributes.sections).toEqual([
      { section: "knative", title: "Knative Serving", icon: "knative", after: "contour" },
      { section: "knativeEventing", title: "Knative Eventing", icon: "knativeEventing", after: "contour" },
    ]);
    expect(manifest.contributes.kinds.map((k) => [k.group, k.kind, k.section, k.title, k.icon, k.order, k.printerColumns])).toEqual([
      ["serving.knative.dev", "Service", "knative", "Services", "service", 10, false],
      ["serving.knative.dev", "Configuration", "knative", "Configurations", "config", 20, false],
      ["serving.knative.dev", "Revision", "knative", "Revisions", "knativeRevision", 30, false],
      ["serving.knative.dev", "Route", "knative", "Routes", "knativeRoute", 40, false],
      ["serving.knative.dev", "DomainMapping", "knative", "Domain Mappings", "knativeDomain", 50, false],
      ...EVENTING_KINDS.map((d) => [d.kind.group, d.kind.kind, "knativeEventing", expect.any(String), d.icon, d.order, false]),
    ]);
    // Without a heading: the frame draws the built-in block titled with the kind, which opens and closes.
    expect(manifest.contributes.detailsSections.map((d) => [d.kinds[0]!.kind, d.title, d.order, d.placement, d.heading])).toEqual(
      ALL_KINDS.map((k) => [k.kind, k.kind, 20, "section", false]),
    );
    expect(manifest.permissions.rules).toEqual([{ namespaces: { type: "all" }, kinds: { type: "only", kinds: ALL_KINDS.map((k) => ({ group: k.group, kind: k.kind })) }, actions: ["read"] }]);
  });
});

// ---------- The columns ----------

type Column = (typeof manifest.contributes.columns)[number];
const columnOf = (id: string) => manifest.contributes.columns.find((c) => c.id === id)! as Column;
const windowColumn = (id: string) => columns.computedColumn(`ext:sextant.knative:${id}`, columnOf(id));
const T = (key: string, values?: { count?: number }) => `${key}:${values?.count ?? ""}`;
const NOW = Date.parse("2026-10-23T10:00:00Z");
/** A cell's text, as the window searches and copies it. */
const cell = (id: string, obj: KubeObject) => windowColumn(id).searchText(obj, { now: NOW, t: T }) || undefined;
/** A cell as drawn: its hover and its status tone. */
function drawn(id: string, obj: KubeObject): { title?: string; tone?: string } {
  let node = windowColumn(id).render(obj, { now: NOW }) as { props?: { title?: string; tone?: string; children?: unknown } } | null;
  const title = node?.props?.title;
  if (title !== undefined) node = node!.props!.children as typeof node;
  return { title: title || undefined, tone: node?.props?.tone };
}
const word = (key: string) => (en as Record<string, string>)[key];
const prefixOf = (o: KubeObject) =>
  ({ Service: "ksvc", InMemoryChannel: "in-memory-channel", ApiServerSource: "api-server-source", PingSource: "ping-source", ContainerSource: "container-source", SinkBinding: "sink-binding", KafkaSource: "kafka-source", DomainMapping: "domain-mapping" })[o.kind!] ??
  o.kind!.toLowerCase();

describe("the columns, against the built-in ones", () => {
  it("are placed after the namespace, in the built-in order, each kind with its state first and its reason last", () => {
    for (const kind of ALL_KINDS) {
      const own = manifest.contributes.columns.filter((c) => sameKind(c.kind, kind));
      expect(own[0]!.afterColumn).toBe("namespace");
      for (let i = 1; i < own.length; i++) expect(own[i]!.afterColumn).toBe(own[i - 1]!.id);
      expect(own[0]!.title).toBe("Status");
      expect(own.at(-1)!.title).toBe("Reason");
    }
    const titles = (kind: KindOf) => manifest.contributes.columns.filter((c) => sameKind(c.kind, kind)).map((c) => c.title);
    expect(titles(KSERVICE)).toEqual(["Status", "URL", "Latest created", "Latest ready", "Reason"]);
    expect(titles(CONFIGURATION)).toEqual(["Status", "Latest created", "Latest ready", "Reason"]);
    expect(titles(REVISION)).toEqual(["Status", "Configuration", "Generation", "Replicas", "Reason"]);
    expect(titles(ROUTE)).toEqual(["Status", "URL", "Traffic", "Reason"]);
    expect(titles(DOMAIN_MAPPING)).toEqual(["Status", "URL", "Target", "Reason"]);
    const middle = (kind: string) => manifest.contributes.columns.filter((c) => c.kind.kind === kind && c.kind.group !== "serving.knative.dev").map((c) => c.title).slice(1, -1);
    expect(middle("Broker")).toEqual(["Class", "Address"]);
    expect(middle("Trigger")).toEqual(["Broker", "Filter", "Subscriber"]);
    expect(middle("Subscription")).toEqual(["Channel", "Subscriber", "Reply"]);
    expect(middle("Sequence")).toEqual(["Steps", "Address"]);
    expect(middle("Parallel")).toEqual(["Branches", "Address"]);
    expect(middle("PingSource")).toEqual(["Schedule", "Sink"]);
    expect(middle("KafkaSource")).toEqual(["Topics", "Sink"]);
    expect(middle("ApiServerSource")).toEqual(["Mode", "Sink"]);
    for (const k of ["ContainerSource", "SinkBinding"]) expect(middle(k)).toEqual(["Sink"]);
    for (const k of ["Channel", "InMemoryChannel"]) expect(middle(k)).toEqual(["Address"]);
  });

  it("say every object's state in its tone and the failing condition's reason", () => {
    for (const o of [...servingObjects(), ...eventingObjects()]) {
      const prefix = prefixOf(o);
      const state = healthOf(o);
      expect(cell(`${prefix}-status`, o), `${o.kind} ${o.metadata.name}`).toBe(word(`health.${state}`));
      expect(drawn(`${prefix}-status`, o).tone).toBe(HEALTH_TONE[state]);
      // Sorted by the state, as the built-in column's value.
      expect(windowColumn(`${prefix}-status`).value(o)).toBe(state);
      expect(windowColumn(`${prefix}-status`).filter?.value(o, { now: NOW, t: T })).toBe(state);
      expect(cell(`${prefix}-reason`, o) || undefined, `${o.kind} ${o.metadata.name}`).toBe(failingCondition(o)?.reason || undefined);
      expect(windowColumn(`${prefix}-reason`).value(o) || undefined).toBe(failingCondition(o)?.reason || undefined);
    }
  });

  it("have the built-in widths", () => {
    const W = { status: "110px", reason: "minmax(100px, 1fr)", url: "minmax(160px, 2fr)", latest: "minmax(120px, 1fr)", text: "minmax(140px, 2fr)", short: "minmax(100px, 1fr)" };
    const widths: Record<string, string> = {
      "ksvc-url": W.url,
      "ksvc-latest-created": W.latest,
      "ksvc-latest-ready": W.latest,
      "configuration-latest-created": W.latest,
      "configuration-latest-ready": W.latest,
      "revision-configuration": W.latest,
      "revision-generation": "90px",
      "revision-replicas": "90px",
      "route-url": W.url,
      "route-traffic": W.url,
      "domain-mapping-url": W.url,
      "domain-mapping-target": W.latest,
      "broker-class": W.short,
      "broker-address": W.text,
      "trigger-broker": W.short,
      "trigger-filter": W.text,
      "trigger-subscriber": W.text,
      "channel-address": W.text,
      "in-memory-channel-address": W.text,
      "subscription-channel": W.short,
      "subscription-subscriber": W.text,
      "subscription-reply": W.text,
      "sequence-steps": "80px",
      "sequence-address": W.text,
      "parallel-branches": "90px",
      "parallel-address": W.text,
      "api-server-source-mode": "100px",
      "api-server-source-sink": W.text,
      "ping-source-schedule": W.short,
      "ping-source-sink": W.text,
      "container-source-sink": W.text,
      "sink-binding-sink": W.text,
      "kafka-source-topics": "minmax(120px, 1fr)",
      "kafka-source-sink": W.text,
    };
    for (const c of manifest.contributes.columns) {
      const expected = c.id.endsWith("-status") ? W.status : c.id.endsWith("-reason") ? W.reason : widths[c.id];
      expect(windowColumn(c.id).width, c.id).toBe(expected);
    }
  });

  it("of Serving: URLs, revisions, labels, replicas and the target", () => {
    for (const o of services()) {
      const f = serviceFields(o);
      expect(cell("ksvc-url", o)).toBe(f.url);
      expect(drawn("ksvc-url", o).title).toBe(f.url);
      expect(cell("ksvc-latest-created", o)).toBe(f.latestCreated);
      expect(cell("ksvc-latest-ready", o)).toBe(f.latestReady);
    }
    for (const o of revisions()) {
      const f = revisionFields(o);
      expect(cell("revision-configuration", o)).toBe(f.configuration);
      expect(cell("revision-generation", o)).toBe(f.generation);
      expect(cell("revision-replicas", o)).toBe(f.actualReplicas === undefined ? undefined : `${f.actualReplicas}/${f.desiredReplicas ?? "?"}`);
    }
    for (const o of domainMappings()) expect(cell("domain-mapping-target", o)).toBe(mappingRef(o).name);
  });

  it("of Routes: the traffic split as the built-in summary, every target with a share", () => {
    const base = routes()[0]!;
    const route = (traffic: unknown[] | undefined, spec?: unknown[]) => {
      const o = copy(base);
      if (traffic === undefined) delete st(o).traffic;
      else st(o).traffic = traffic;
      if (spec !== undefined) (o.spec as Record<string, unknown>).traffic = spec;
      return o;
    };
    const t = (name: string, percent?: number) => ({ revisionName: name, ...(percent === undefined ? { tag: name } : { percent }) });
    const variants = [
      ...routes(),
      route([t("a"), t("b"), t("c"), t("d", 100)]),
      route([t("a", 100), t("b"), t("c")]),
      route([t("a"), t("b", 30), t("c"), t("d", 70)]),
      route([t("a", 0), t("b", 0), t("c", 25), t("d", 75)]),
      route([10, 20, 30, 40].map((p, i) => t(`r${i}`, p))),
      route([50, 0, 0, 0, 50].map((p, i) => t(`r${i}`, p))),
      route([t("a"), t("b")]),
      route(undefined, [{ configurationName: "hello", percent: 100 }]),
      route(undefined, [{ revisionName: "hello-00001", percent: 40 }, { latestRevision: true, percent: 60 }]),
      route(undefined, [{ percent: 100 }]),
      // One revision twice with the same share, under two tags: both are said.
      route([{ revisionName: "a", percent: 50, tag: "x" }, { revisionName: "a", percent: 50, tag: "y" }]),
    ];
    for (const o of variants) {
      const expected = trafficSummary(o, word("latest")!) || undefined;
      expect(cell("route-traffic", o), JSON.stringify(st(o).traffic ?? o.spec)).toBe(expected);
      expect(drawn("route-traffic", o).title).toBe(expected);
    }
  });

  it("of Eventing: class, address, Broker, filter, destinations, channel, steps, schedule, topics and mode", () => {
    for (const o of eventingObjects()) {
      const prefix = prefixOf(o);
      const has = (suffix: string) => manifest.contributes.columns.some((c) => c.id === `${prefix}-${suffix}`);
      if (has("address")) expect(cell(`${prefix}-address`, o)).toBe(addressOf(o));
      if (has("sink")) {
        expect(cell(`${prefix}-sink`, o), `${o.kind} ${o.metadata.name}`).toBe(destinationText(sinkOf(o)));
        expect(drawn(`${prefix}-sink`, o).title).toBe(destinationText(sinkOf(o)));
      }
      if (has("subscriber")) expect(cell(`${prefix}-subscriber`, o)).toBe(destinationText(subscriberOf(o)));
      if (has("reply")) expect(cell(`${prefix}-reply`, o)).toBe(destinationText(replyOf(o)));
      if (o.kind === "Broker") expect(cell("broker-class", o)).toBe(brokerClassOf(o));
      if (o.kind === "Trigger") expect(cell("trigger-broker", o)).toBe(brokerOf(o)?.name);
      if (o.kind === "Subscription") expect(cell("subscription-channel", o)).toBe(channelOf(o)?.name);
      // Counted, 0 without any, as the built-in columns.
      const count = (path: string) => ((get(o, "spec", path) as unknown[] | undefined) ?? []).length;
      if (o.kind === "Sequence") expect(cell("sequence-steps", o)).toBe(String(count("steps")));
      if (o.kind === "Parallel") expect(cell("parallel-branches", o)).toBe(String(count("branches")));
      if (o.kind === "PingSource") expect(cell("ping-source-schedule", o)).toBe(str(get(o, "spec", "schedule")));
      if (o.kind === "ApiServerSource") expect(cell("api-server-source-mode", o)).toBe(str(get(o, "spec", "mode")));
      if (o.kind === "KafkaSource") {
        expect(cell("kafka-source-topics", o)).toBe(kafkaTopics(o).join(", ") || undefined);
        expect(drawn("kafka-source-topics", o).title).toBe(kafkaTopics(o).join(", ") || undefined);
      }
    }
  });

  it("of Eventing: a destination without a kind, a Broker named only by spec.broker, no steps", () => {
    const ping = find("PingSource", "test-ping-source");
    ping.spec = { ...(ping.spec as Record<string, unknown>), sink: { ref: { name: "display" }, uri: "/x" } };
    expect(cell("ping-source-sink", ping)).toBe(destinationText(sinkOf(ping)));
    expect(cell("ping-source-sink", ping)).toBe("?/display /x");
    ping.spec = { ...(ping.spec as Record<string, unknown>), sink: { ref: { name: "" }, uri: "http://a" } };
    expect(cell("ping-source-sink", ping)).toBe("http://a");
    const trigger = find("Trigger", "my-service-trigger");
    trigger.spec = { ...(trigger.spec as Record<string, unknown>), brokerRef: { name: "" }, broker: "b" };
    expect(cell("trigger-broker", trigger)).toBe(brokerOf(trigger)?.name);
    const sequence = find("Sequence", "sequence");
    delete (sequence.spec as Record<string, unknown>).steps;
    expect(cell("sequence-steps", sequence)).toBe("0");
    expect(windowColumn("sequence-steps").value(sequence)).toBe(0);
  });

  it("of Triggers: the filter as the built-in text, each filter of one attribute or CESQL expression, else …", () => {
    const trigger = find("Trigger", "my-service-trigger");
    const withSpec = (spec: Record<string, unknown>) => {
      const o = copy(trigger);
      o.spec = { broker: "default", ...spec };
      return o;
    };
    const exact = [
      trigger,
      withSpec({ filter: { attributes: { source: "/a", type: "t" } } }),
      withSpec({ filter: { attributes: { source: "/a" } } }),
      withSpec({ filter: { attributes: { type: "" } } }),
      withSpec({ filter: { attributes: { source: "" } } }),
      withSpec({ filter: { attributes: { type: "t" } } }),
      withSpec({ filter: { attributes: { source: "", type: "t" } } }),
      withSpec({ filter: { attributes: { source: "/a", type: "" } } }),
      withSpec({ filter: { attributes: { source: "", type: "" } } }),
      withSpec({ filter: { attributes: {} } }),
      withSpec({ filters: [{ exact: { type: "t" } }] }),
      withSpec({ filters: [{ exact: { type: "" } }] }),
      withSpec({ filters: [{ exact: { source: "/s", type: "t" } }] }),
      withSpec({ filters: [{ prefix: { type: "com.example." } }] }),
      withSpec({ filters: [{ suffix: { type: ".created" } }] }),
      withSpec({ filters: [{ cesql: "source LIKE '%x%'" }] }),
      withSpec({ filters: [{ exact: { type: "t" } }], filter: { attributes: { type: "old" } } }),
      withSpec({ filters: [{}] }),
      withSpec({ filters: [] }),
      withSpec({}),
      withSpec({ filter: { attributes: { subject: "x" } } }),
      // An attribute of another name with an empty value: "subject=*", as the built-in wrote it (#417).
      withSpec({ filter: { attributes: { subject: "" } } }),
      withSpec({ filters: [{ exact: { subject: "s" } }, { prefix: { source: "/orders/" } }, { suffix: { subject: ".json" } }] }),
      withSpec({ filters: [{ exact: { type: "t" } }, {}, { cesql: "a = 'b'" }] }),
      withSpec({ filters: [{ exact: { type: "t" }, prefix: {}, all: [] }] }),
      withSpec({ filters: [{ exact: { type: "t" } }, { exact: { type: "t" } }] }),
    ];
    for (const o of exact) {
      const expected = filterText(triggerFilter(o).terms) || undefined;
      expect(cell("trigger-filter", o), JSON.stringify(o.spec)).toBe(expected);
      expect(drawn("trigger-filter", o).title).toBe(expected);
    }
    // Beyond what the cases say: nested terms, or several dialects in one filter, are "…".
    expect(cell("trigger-filter", find("Trigger", "orders-trigger"))).toBe("type=com.example.order, …");
    expect(cell("trigger-filter", withSpec({ filters: [{ any: [{ exact: { type: "a" } }] }] }))).toBe("…");
    expect(cell("trigger-filter", withSpec({ filters: [{ exact: { type: "a" }, cesql: "x" }] }))).toBe("…");
    expect(cell("trigger-filter", withSpec({ filter: { attributes: { source: "/a", subject: "x" } } }))).toBe("…");
  });
});

describe("the kinds' order and labels", () => {
  it("are the built-in ones", () => {
    expect(KNATIVE_KINDS.map((d) => d.kind.kind)).toEqual(["Service", "Configuration", "Revision", "Route", "DomainMapping"]);
    expect(manifest.contributes.kinds.filter((k) => k.section === "knativeEventing").map((k) => k.kind)).toEqual(EVENTING_KINDS.map((d) => d.kind.kind));
  });
});
