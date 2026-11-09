# Changes of Strimzi

## 1.0.0 — 2026-11-09

Needs Sextant 0.30 (`sextantApi` 4) with ADR-0167's additions. The first release: Sextant's former built-in Strimzi
view (ADR-0100) as an extension.

- **A sidebar section "Strimzi"** with Kafkas, Kafka Node Pools, Kafka Topics, Kafka Users, Kafka Connects, Kafka
  MirrorMaker 2 and Kafka Connectors in Sextant's tables, and the built-in columns: readiness, reason, version,
  listeners, the Kafka an object belongs to, roles, replicas, partitions, authentication, a connector's state, running
  tasks, class and automatic restarts.
- **Details:** readiness and Strimzi's warnings; a Kafka's listeners with their addresses and node pools; a topic's
  name, partitions, replication and config; a user's authentication and its Secret by name; a Connect cluster's or
  MirrorMaker 2's mirrors and connectors; a connector's states, tasks and automatic restarts; failed connectors and
  tasks with their stack traces.
- **Problems:** objects not ready for 5 minutes, failed connectors and tasks (after Strimzi's automatic restart had
  its chance), counted on the section.
- Installing asks for consent to read the seven kinds and to judge them in problem rules.
