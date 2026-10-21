// Columns of the Knative Eventing tables (#234): every kind's state in words (ready / progressing / failed, colored)
// with the failing condition's reason, and where it sends events: a Broker's class and address, a Trigger's Broker,
// filter and subscriber, a Subscription's channel and subscriber, a source's sink (and a PingSource's schedule, a
// KafkaSource's topics).
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { ageColumn, nameColumn, namespaceColumn, StatusText, type ColumnDef } from "../../resources";
import { status } from "../../resources";
import {
  addressOf,
  API_SERVER_SOURCE,
  branchesOf,
  BROKER,
  brokerClassOf,
  brokerOf,
  channelOf,
  destinationText,
  filterText,
  IN_MEMORY_CHANNEL,
  isSourceKind,
  KAFKA_SOURCE,
  kafkaTopics,
  PARALLEL,
  PING_SOURCE,
  replyOf,
  SEQUENCE,
  sinkOf,
  stepsOf,
  subscriberOf,
  SUBSCRIPTION,
  TRIGGER,
  triggerFilter,
  type EventingKind,
} from "./eventing";
import { failingCondition, HEALTH_TONE, healthOf, sameKind } from "./model";

const col = (id: string, value: ColumnDef["value"], options: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  titleKey: `knative:eventing.columns.${id}`,
  value,
  ...options,
});

function Health({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const health = healthOf(obj);
  return <StatusText value={t(`knative:health.${health}`)} tone={HEALTH_TONE[health]} />;
}

/** A text cell that shows its whole value on hover. */
const titled = (text: (o: KubeObject) => string | undefined) => (o: KubeObject) => {
  const value = text(o);
  return value ? <span title={value}>{value}</span> : null;
};

const textColumn = (id: string, text: (o: KubeObject) => string | undefined, width = "minmax(140px, 2fr)") =>
  col(id, text, { width, render: titled(text) });

const statusColumn = col("status", healthOf, { width: "110px", render: (o) => <Health obj={o} /> });
const reasonColumn = col("reason", (o) => failingCondition(o)?.reason, { width: "minmax(100px, 1fr)" });
const addressColumn = textColumn("address", addressOf);
const sinkColumn = textColumn("sink", (o) => destinationText(sinkOf(o)));
const subscriberColumn = textColumn("subscriber", (o) => destinationText(subscriberOf(o)));

const brokerColumns: ColumnDef[] = [
  col("class", brokerClassOf, { width: "minmax(100px, 1fr)" }),
  addressColumn,
];
const triggerColumns: ColumnDef[] = [
  col("broker", (o) => brokerOf(o)?.name, { width: "minmax(100px, 1fr)" }),
  textColumn("filter", (o) => filterText(triggerFilter(o).terms) || undefined),
  subscriberColumn,
];
const subscriptionColumns: ColumnDef[] = [
  col("channel", (o) => channelOf(o)?.name, { width: "minmax(100px, 1fr)" }),
  subscriberColumn,
  textColumn("reply", (o) => destinationText(replyOf(o))),
];
const sequenceColumns: ColumnDef[] = [col("steps", (o) => stepsOf(o).length, { width: "80px" }), addressColumn];
const parallelColumns: ColumnDef[] = [col("branches", (o) => branchesOf(o).length, { width: "90px" }), addressColumn];
const pingColumns: ColumnDef[] = [col("schedule", (o) => status.str(status.get(o, "spec", "schedule")), { width: "minmax(100px, 1fr)" }), sinkColumn];
const kafkaColumns: ColumnDef[] = [textColumn("topics", (o) => kafkaTopics(o).join(", ") || undefined, "minmax(120px, 1fr)"), sinkColumn];
const apiServerColumns: ColumnDef[] = [col("mode", (o) => status.str(status.get(o, "spec", "mode")), { width: "100px" }), sinkColumn];

function middleColumns({ kind }: EventingKind): ColumnDef[] {
  if (sameKind(kind, BROKER)) return brokerColumns;
  if (sameKind(kind, TRIGGER)) return triggerColumns;
  if (sameKind(kind, SUBSCRIPTION)) return subscriptionColumns;
  if (sameKind(kind, SEQUENCE)) return sequenceColumns;
  if (sameKind(kind, PARALLEL)) return parallelColumns;
  if (sameKind(kind, PING_SOURCE)) return pingColumns;
  if (sameKind(kind, KAFKA_SOURCE)) return kafkaColumns;
  if (sameKind(kind, API_SERVER_SOURCE)) return apiServerColumns;
  if (isSourceKind(kind)) return [sinkColumn];
  // Channel, InMemoryChannel.
  if (sameKind(kind, IN_MEMORY_CHANNEL) || kind.group === "messaging.knative.dev") return [addressColumn];
  return [];
}

export function eventingColumns(def: EventingKind): ColumnDef[] {
  return [nameColumn, namespaceColumn, statusColumn, ...middleColumns(def), reasonColumn, ageColumn];
}
