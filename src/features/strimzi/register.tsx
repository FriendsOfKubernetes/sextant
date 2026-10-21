// Registers the Strimzi kinds in the sidebar section `strimzi` (shown only for kinds the cluster serves) and their
// details. Read-only: the kinds offer the generic Edit and Delete only.
import type { IconName } from "../../components";
import { registerDetailsSection } from "../../layout/details/registry";
import { registerResource, type ColumnDef } from "../../resources";
import { connectColumns, connectorColumns, kafkaColumns, nodePoolColumns, topicColumns, userColumns } from "./columns";
import { appliesTo, StrimziSection } from "./details";
import { isKind, isProblem, KAFKA, KAFKA_CONNECTOR, KAFKA_NODE_POOL, KAFKA_TOPIC, KAFKA_USER, STRIMZI_KINDS, type StrimziKind } from "./model";

const ICONS: Record<string, IconName> = {
  kafkas: "kafka",
  nodePools: "kafkaNodePool",
  topics: "kafkaTopic",
  users: "kafkaUser",
  connects: "kafkaConnect",
  mirrorMakers: "kafkaMirror",
  connectors: "kafkaConnector",
};

function columnsOf({ kind }: StrimziKind): ColumnDef[] {
  if (isKind(kind, KAFKA)) return kafkaColumns;
  if (isKind(kind, KAFKA_NODE_POOL)) return nodePoolColumns;
  if (isKind(kind, KAFKA_TOPIC)) return topicColumns;
  if (isKind(kind, KAFKA_USER)) return userColumns;
  if (isKind(kind, KAFKA_CONNECTOR)) return connectorColumns;
  return connectColumns;
}

for (const def of STRIMZI_KINDS) {
  registerResource({
    kind: def.kind,
    sidebar: {
      section: "strimzi",
      order: def.order,
      labelKey: `strimzi:sidebar.${def.label}`,
      icon: ICONS[def.label],
    },
    columns: columnsOf(def),
    actions: ["edit", "delete"],
    namespaced: true,
    problem: isProblem,
  });
}

registerDetailsSection({
  id: "strimzi",
  order: 20,
  appliesTo,
  Component: StrimziSection,
});
