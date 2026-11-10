# Changes of Strimzi

## 1.0.0 — 2026-11-09

Needs Sextant 0.30 (`sextantApi` 4) with ADR-0167's additions. The first release: Sextant's former built-in Strimzi
view (ADR-0100) as an extension.

- **A sidebar section "Strimzi"** with Kafkas, Kafka Node Pools, Kafka Topics, Kafka Users, Kafka Connects, Kafka
  MirrorMaker 2 and Kafka Connectors in Sextant's tables, and the built-in columns in their widths: readiness (sorted
  by the state in every language), reason, version, every listener, the Kafka an object belongs to, roles, replicas,
  partitions, authentication, a connector's state (PAUSED and STOPPED muted), running tasks of all (red with a failed
  task, green with all running, blank without tasks, sorted by the running ones), the class's last part (the whole on hover) and automatic
  restarts.
- **Details** without a heading of their own: readiness and Strimzi's warnings; a Kafka's listeners with their
  addresses and node pools; a topic's name, partitions, replication and config; a user's authentication and its
  Secret by name; a Connect cluster's or MirrorMaker 2's mirrors and connectors; a connector's states, tasks and
  automatic restarts; failed connectors and tasks with their stack traces. Blocks open and close by their titles in
  Sextant's own memory of details sections, with "Expand all" and "Collapse all".
- **Problems:** objects not ready for 5 minutes (Strimzi's reason, else `NotReady`), failed connectors and tasks with
  their trace's first line (cut at 300 characters) (after Strimzi's automatic restart had its chance), counting from `NotReady` or `Ready`
  False; a MirrorMaker 2's failed connectors and tasks, the connector named wherever it is;
  "Only problems" with every failed connector and task; counted on the section. Topics and users are watched for
  problems up to 5000 each, the other kinds up to 20 000.
- Installing asks for consent to read the seven kinds and to judge them in problem rules.
