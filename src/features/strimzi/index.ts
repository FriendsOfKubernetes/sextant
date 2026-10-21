// Strimzi (#213): the discovered sidebar section "Strimzi" — Kafkas, KafkaNodePools, KafkaTopics, KafkaUsers,
// KafkaConnects, KafkaMirrorMaker2s and KafkaConnectors (#235) with their readiness from the Ready / NotReady / Warning
// conditions and the reasons, a Kafka's listeners with their addresses and node pools, topics' partitions and replicas,
// users' Secret by name (never its data), connectors' and tasks' states with their traces. Objects not ready past a
// grace feed the problems screen (category `strimzi`) and the section counter, and so do failed connectors and tasks
// (#235, connectors.ts). Read-only (ADR-0100).
import { registerSectionBadge } from "../../layout/sectionBadges";
import { useStrimziProblemCount } from "./problems";
import "./register";
import "./strimzi.css";

registerSectionBadge("strimzi", useStrimziProblemCount, {
  tone: "danger",
  labelKey: "strimzi:badge",
});

export * from "./model";
