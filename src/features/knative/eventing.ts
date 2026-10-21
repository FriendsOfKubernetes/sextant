// What the Knative Eventing section reads from its objects (#234): the kinds it knows (eventing.knative.dev,
// messaging.knative.dev, flows.knative.dev, sources.knative.dev), where each one sends events (a Destination: `ref`
// to an object or a `uri`), a Trigger's filter, and why an object is not ready, in plain words. Shapes checked against
// the CRDs and `*_lifecycle.go` of knative/eventing v1.23 and knative-extensions/eventing-kafka-broker v1.23 (KafkaSource).
// Pure functions, no React; texts are i18n keys under `knative:eventing` with their values.
import type { IconName } from "../../components";
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import { conditionOf, failingCondition, healthOf, sameKind, type Phrase } from "./model";

const { arr, get, record, str } = status;

export const EVENTING_GROUP = "eventing.knative.dev";
export const MESSAGING_GROUP = "messaging.knative.dev";
export const FLOWS_GROUP = "flows.knative.dev";
export const SOURCES_GROUP = "sources.knative.dev";
export const EVENTING_GROUPS: ReadonlySet<string> = new Set([EVENTING_GROUP, MESSAGING_GROUP, FLOWS_GROUP, SOURCES_GROUP]);

const k = (group: string, version: string, kind: string): KindRef => ({ group, version, kind });

export const BROKER = k(EVENTING_GROUP, "v1", "Broker");
export const TRIGGER = k(EVENTING_GROUP, "v1", "Trigger");
export const CHANNEL = k(MESSAGING_GROUP, "v1", "Channel");
export const IN_MEMORY_CHANNEL = k(MESSAGING_GROUP, "v1", "InMemoryChannel");
export const SUBSCRIPTION = k(MESSAGING_GROUP, "v1", "Subscription");
export const SEQUENCE = k(FLOWS_GROUP, "v1", "Sequence");
export const PARALLEL = k(FLOWS_GROUP, "v1", "Parallel");
export const API_SERVER_SOURCE = k(SOURCES_GROUP, "v1", "ApiServerSource");
export const PING_SOURCE = k(SOURCES_GROUP, "v1", "PingSource");
export const CONTAINER_SOURCE = k(SOURCES_GROUP, "v1", "ContainerSource");
export const SINK_BINDING = k(SOURCES_GROUP, "v1", "SinkBinding");
/** Served as v1beta1 (the stored version) and, since 1.17, v1: discovery picks the version to watch. */
export const KAFKA_SOURCE = k(SOURCES_GROUP, "v1beta1", "KafkaSource");

export interface EventingKind {
  kind: KindRef;
  order: number;
  /** Key under `knative:eventing.sidebar`. */
  label: string;
  icon: IconName;
}

export const EVENTING_KINDS: readonly EventingKind[] = [
  { kind: BROKER, order: 10, label: "brokers", icon: "knativeBroker" },
  { kind: TRIGGER, order: 20, label: "triggers", icon: "knativeTrigger" },
  { kind: CHANNEL, order: 30, label: "channels", icon: "knativeChannel" },
  { kind: IN_MEMORY_CHANNEL, order: 40, label: "inMemoryChannels", icon: "knativeChannel" },
  { kind: SUBSCRIPTION, order: 50, label: "subscriptions", icon: "knativeSubscription" },
  { kind: SEQUENCE, order: 60, label: "sequences", icon: "knativeSequence" },
  { kind: PARALLEL, order: 70, label: "parallels", icon: "knativeParallel" },
  { kind: API_SERVER_SOURCE, order: 80, label: "apiServerSources", icon: "knativeSource" },
  { kind: PING_SOURCE, order: 90, label: "pingSources", icon: "knativePingSource" },
  { kind: CONTAINER_SOURCE, order: 100, label: "containerSources", icon: "knativeSource" },
  { kind: SINK_BINDING, order: 110, label: "sinkBindings", icon: "knativeSinkBinding" },
  { kind: KAFKA_SOURCE, order: 120, label: "kafkaSources", icon: "knativeSource" },
];

/** The sources whose `spec.sink` sends events on (all but SinkBinding are sources; a SinkBinding binds one). */
export const SOURCE_KINDS: readonly KindRef[] = [API_SERVER_SOURCE, PING_SOURCE, CONTAINER_SOURCE, SINK_BINDING, KAFKA_SOURCE];
export const CHANNEL_KINDS: readonly KindRef[] = [CHANNEL, IN_MEMORY_CHANNEL];

export function eventingKind(kind: Pick<KindRef, "group" | "kind">): EventingKind | undefined {
  return EVENTING_KINDS.find((d) => sameKind(d.kind, kind));
}

export const isSourceKind = (kind: Pick<KindRef, "group" | "kind">) => SOURCE_KINDS.some((s) => sameKind(s, kind));
export const isChannelKind = (kind: Pick<KindRef, "group" | "kind">) => CHANNEL_KINDS.some((s) => sameKind(s, kind));

// ---------- Destinations ----------

/** A Destination (`duckv1.Destination`): an object reference, a URI, or both (the URI then is relative to the ref). */
export interface Destination {
  ref?: { apiVersion?: string; kind?: string; name?: string; namespace?: string };
  uri?: string;
}

export function destinationOf(value: unknown): Destination | undefined {
  const ref = get(value, "ref");
  const uri = str(get(value, "uri"));
  const name = str(get(ref, "name"));
  if (!name && !uri) return undefined;
  return {
    ...(name
      ? { ref: { apiVersion: str(get(ref, "apiVersion")), kind: str(get(ref, "kind")), name, namespace: str(get(ref, "namespace")) } }
      : {}),
    ...(uri ? { uri } : {}),
  };
}

/** The API group of an `apiVersion` ("" for the core group's "v1"). */
export const groupOf = (apiVersion: string | undefined) => (apiVersion?.includes("/") ? apiVersion.split("/")[0]! : "");

export interface Target {
  kind: Pick<KindRef, "group" | "kind">;
  name: string;
  namespace: string;
  /** Its address (`status.address.url`): a destination may name it by URI. */
  url?: string;
}

/** Whether `dest`, written in an object of `fromNamespace` (a ref's default namespace), names `target`. */
export function pointsAt(dest: Destination | undefined, fromNamespace: string, target: Target): boolean {
  if (!dest) return false;
  const ref = dest.ref;
  if (ref) {
    return (
      ref.kind === target.kind.kind &&
      groupOf(ref.apiVersion) === target.kind.group &&
      ref.name === target.name &&
      (ref.namespace ?? fromNamespace) === target.namespace
    );
  }
  const url = target.url;
  return Boolean(url && dest.uri === url);
}

/** "Kind/name", or the URI, for a table cell. */
export function destinationText(dest: Destination | undefined): string | undefined {
  if (!dest) return undefined;
  if (dest.ref) return `${dest.ref.kind ?? "?"}/${dest.ref.name}${dest.uri ? ` ${dest.uri}` : ""}`;
  return dest.uri;
}

// ---------- Fields ----------

export const addressOf = (obj: KubeObject) => str(get(obj, "status", "address", "url"));
export const sinkOf = (obj: KubeObject) => destinationOf(get(obj, "spec", "sink"));
/** Where a source's sink resolved to (`status.sinkUri`). */
export const sinkUriOf = (obj: KubeObject) => str(get(obj, "status", "sinkUri"));
export const deadLetterUriOf = (obj: KubeObject) => str(get(obj, "status", "deadLetterSinkUri"));
export const brokerClassOf = (obj: KubeObject) => status.record(obj.metadata?.annotations)["eventing.knative.dev/broker.class"] as string | undefined;

/** The Broker a Trigger takes events from: `spec.broker`, or `spec.brokerRef` (cross-namespace). */
export function brokerOf(trigger: KubeObject): { name: string; namespace: string } | undefined {
  const ns = trigger.metadata?.namespace ?? "";
  const ref = get(trigger, "spec", "brokerRef");
  const refName = str(get(ref, "name"));
  if (refName) return { name: refName, namespace: str(get(ref, "namespace")) ?? ns };
  const name = str(get(trigger, "spec", "broker"));
  return name ? { name, namespace: ns } : undefined;
}

export const subscriberOf = (obj: KubeObject) => destinationOf(get(obj, "spec", "subscriber"));
export const replyOf = (obj: KubeObject) => destinationOf(get(obj, "spec", "reply"));
/** Where a Trigger's subscriber resolved to (`status.subscriberUri`; a Subscription's `status.physicalSubscription`). */
export const subscriberUriOf = (obj: KubeObject) =>
  str(get(obj, "status", "subscriberUri")) ?? str(get(obj, "status", "physicalSubscription", "subscriberUri"));
export const replyUriOf = (obj: KubeObject) => str(get(obj, "status", "physicalSubscription", "replyUri"));

/** The Channel a Subscription subscribes to (`spec.channel`: a Channel or a channel implementation). */
export function channelOf(sub: KubeObject): { kind: Pick<KindRef, "group" | "kind">; apiVersion?: string; name: string; namespace: string } | undefined {
  const ref = get(sub, "spec", "channel");
  const name = str(get(ref, "name"));
  if (!name) return undefined;
  const apiVersion = str(get(ref, "apiVersion"));
  return {
    kind: { group: groupOf(apiVersion), kind: str(get(ref, "kind")) ?? "" },
    apiVersion,
    name,
    namespace: str(get(ref, "namespace")) ?? sub.metadata?.namespace ?? "",
  };
}

export const stepsOf = (sequence: KubeObject) => arr(get(sequence, "spec", "steps")).map(destinationOf);

export interface Branch {
  filter?: Destination;
  subscriber?: Destination;
  reply?: Destination;
}

export const branchesOf = (parallel: KubeObject): Branch[] =>
  arr(get(parallel, "spec", "branches")).map((b) => ({
    filter: destinationOf(get(b, "filter")),
    subscriber: destinationOf(get(b, "subscriber")),
    reply: destinationOf(get(b, "reply")),
  }));

/** What a SinkBinding injects the sink into: one object by name, or the objects of a kind its selector picks. */
export function subjectOf(binding: KubeObject): { apiVersion?: string; kind?: string; name?: string; namespace?: string; selector?: unknown } {
  const s = get(binding, "spec", "subject");
  return {
    apiVersion: str(get(s, "apiVersion")),
    kind: str(get(s, "kind")),
    name: str(get(s, "name")),
    namespace: str(get(s, "namespace")),
    selector: get(s, "selector"),
  };
}

/** An ApiServerSource's watched kinds as "Kind (apiVersion)" text. */
export const apiServerResources = (obj: KubeObject) =>
  arr(get(obj, "spec", "resources")).flatMap((r) => {
    const kind = str(get(r, "kind"));
    return kind ? [`${kind} (${str(get(r, "apiVersion")) ?? "?"})`] : [];
  });

export const kafkaTopics = (obj: KubeObject) => arr(get(obj, "spec", "topics")).map(str).filter((v): v is string => Boolean(v));
export const kafkaServers = (obj: KubeObject) => arr(get(obj, "spec", "bootstrapServers")).map(str).filter((v): v is string => Boolean(v));

/**
 * Owned (controller) by another Eventing object: a Broker's or Channel's backing InMemoryChannel, a Trigger's,
 * Sequence's or Parallel's Subscriptions and Channels, a ContainerSource's SinkBinding. Their state is told through the
 * owner (its conditions carry it), and they are not sources of their own on the event path.
 */
export function ownedByEventing(obj: KubeObject): boolean {
  return arr(obj.metadata?.ownerReferences).some(
    (o) => get(o, "controller") === true && EVENTING_GROUPS.has(groupOf(str(get(o, "apiVersion")))),
  );
}

// ---------- Trigger filters ----------

export type FilterTerm =
  | { op: "exact" | "prefix" | "suffix"; attribute: string; value: string }
  | { op: "anyValue"; attribute: string }
  | { op: "cesql"; expression: string }
  | { op: "all" | "any" | "not"; terms: FilterTerm[] };

const MAX_FILTER_DEPTH = 6;

/** One `SubscriptionsAPIFilter` (each dialect it sets), as terms that must all hold. */
function filterTerms(filter: unknown, depth: number): FilterTerm[] {
  if (depth > MAX_FILTER_DEPTH) return [];
  const terms: FilterTerm[] = [];
  for (const op of ["exact", "prefix", "suffix"] as const) {
    for (const [attribute, value] of Object.entries(record(get(filter, op)))) {
      terms.push({ op, attribute, value: str(value) ?? "" });
    }
  }
  for (const op of ["all", "any"] as const) {
    const list = arr(get(filter, op));
    if (list.length > 0) terms.push({ op, terms: list.flatMap((f) => filterTerms(f, depth + 1)) });
  }
  const not = get(filter, "not");
  if (not && typeof not === "object") terms.push({ op: "not", terms: filterTerms(not, depth + 1) });
  const cesql = str(get(filter, "cesql"));
  if (cesql) terms.push({ op: "cesql", expression: cesql });
  return terms;
}

export interface TriggerFilter {
  /** All must hold; empty passes every event. */
  terms: FilterTerm[];
  /** `spec.filter.attributes` is set but `spec.filters` overrides it. */
  legacyIgnored: boolean;
}

/**
 * A Trigger's filter: `spec.filters` (the CloudEvents Subscriptions API dialects) when set — it overrides the older
 * `spec.filter.attributes` (exact matches; an empty value matches any value, `TriggerAnyFilter`) — else the latter.
 */
export function triggerFilter(trigger: KubeObject): TriggerFilter {
  const legacy = Object.entries(record(get(trigger, "spec", "filter", "attributes"))).map(([attribute, value]): FilterTerm => {
    const v = str(value) ?? "";
    return v === "" ? { op: "anyValue", attribute } : { op: "exact", attribute, value: v };
  });
  const filters = arr(get(trigger, "spec", "filters"));
  if (filters.length > 0) return { terms: filters.flatMap((f) => filterTerms(f, 0)), legacyIgnored: legacy.length > 0 };
  return { terms: legacy, legacyIgnored: false };
}

/** The filter as plain text for a table cell (not translated: attribute names and values only). */
export function filterText(terms: readonly FilterTerm[]): string {
  return terms
    .map((t): string => {
      switch (t.op) {
        case "exact":
          return `${t.attribute}=${t.value}`;
        case "prefix":
          return `${t.attribute}=${t.value}*`;
        case "suffix":
          return `${t.attribute}=*${t.value}`;
        case "anyValue":
          return `${t.attribute}=*`;
        case "cesql":
          return t.expression;
        case "all":
          return `(${filterText(t.terms)})`;
        case "any":
          return `(${t.terms.map((x) => filterText([x])).join(" | ")})`;
        case "not":
          return `!(${filterText(t.terms)})`;
      }
    })
    .join(", ");
}

// ---------- Plain words ----------

/** The phrase (key under `knative:eventing.explain`) of each failing condition type. */
const FAILURE_KEYS: Record<string, string> = {
  IngressReady: "brokerIngress",
  FilterReady: "brokerFilter",
  TriggerChannelReady: "brokerChannel",
  Addressable: "notAddressable",
  DeadLetterSinkResolved: "deadLetterUnresolved",
  EventPoliciesReady: "eventPolicies",
  OIDCIdentityCreated: "oidc",
  OIDCTokenSecretCreated: "oidc",
  BrokerReady: "triggerBroker",
  SubscriberResolved: "subscriberUnresolved",
  SubscriptionReady: "triggerSubscription",
  DependencyReady: "dependency",
  BackingChannelReady: "backingChannel",
  DispatcherReady: "imcDispatcher",
  ServiceReady: "imcDispatcher",
  EndpointsReady: "imcDispatcher",
  ChannelServiceReady: "imcDispatcher",
  ReferencesResolved: "subscriptionReferences",
  AddedToChannel: "notAddedToChannel",
  ChannelReady: "subscriptionChannel",
  ChannelsReady: "flowChannels",
  SubscriptionsReady: "flowSubscriptions",
  SinkProvided: "sinkUnresolved",
  Deployed: "adapterNotReady",
  ReceiveAdapterReady: "adapterNotReady",
  SufficientPermissions: "permissions",
  SinkBindingReady: "containerBinding",
  SinkBindingAvailable: "bindingUnavailable",
  TrustBundlePropagated: "trustBundle",
  ConnectionEstablished: "kafkaConnection",
  InitialOffsetsCommitted: "kafkaOffsets",
  KeyTypeCorrect: "kafkaKeyType",
};

/** Why an Eventing object is (not) ready, in plain words. */
export function explainEventing(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject): Phrase | undefined {
  const health = healthOf(obj);
  if (health === "unknown") return undefined;
  if (health === "progressing") return { key: "progressing" };
  if (health === "ready") {
    const url = addressOf(obj);
    if (sameKind(kind, BROKER)) return url ? { key: "brokerReady", params: { url } } : { key: "ready" };
    if (sameKind(kind, TRIGGER) || sameKind(kind, SUBSCRIPTION)) {
      const uri = subscriberUriOf(obj);
      return uri ? { key: "deliversTo", params: { uri } } : { key: "ready" };
    }
    if (sameKind(kind, SINK_BINDING)) {
      const uri = sinkUriOf(obj);
      return uri ? { key: "bindingReady", params: { uri } } : { key: "ready" };
    }
    if (isSourceKind(kind)) {
      const uri = sinkUriOf(obj);
      return uri ? { key: "sourceReady", params: { uri } } : { key: "ready" };
    }
    return url ? { key: "receivesAt", params: { url } } : { key: "ready" };
  }
  const failing = failingCondition(obj);
  const reason = failing?.reason ?? failing?.type ?? "";
  const key = (failing && failing.type !== "Ready" && FAILURE_KEYS[failing.type]) || "notReady";
  const params: Record<string, string> = { reason };
  if (key === "triggerBroker") params.broker = brokerOf(obj)?.name ?? "?";
  if (key === "subscriberUnresolved") params.subscriber = destinationText(subscriberOf(obj)) ?? "?";
  if (key === "sinkUnresolved") params.sink = destinationText(sinkOf(obj)) ?? "?";
  if (key === "subscriptionChannel") params.channel = channelOf(obj)?.name ?? "?";
  return { key, params };
}

/** Whether the Ready condition is False (the tables' "Only problems" filter). */
export const isEventingProblem = (obj: KubeObject) => conditionOf(obj, "Ready")?.status === "False";
