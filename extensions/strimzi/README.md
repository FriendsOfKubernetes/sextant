# Strimzi

Views of [Strimzi](https://strimzi.io/) (Apache Kafka on Kubernetes), in every language Sextant has. It lists
Kafkas, Kafka node pools, topics, users, Kafka Connect clusters, MirrorMaker 2 instances and connectors in a sidebar
section of their own with Sextant's tables, reads each one's readiness from the conditions Strimzi writes, a Kafka's
listeners with their addresses and node pools, the connectors' and tasks' states with their stack traces and
Strimzi's automatic restarts, and tells objects that are not ready and connectors or tasks that failed as problems.
Read-only. It replaces Sextant's former built-in Strimzi view (ADR-0100) with the same behaviour. Its id is
`sextant.strimzi`. Why it is built this way: ADR-0100 (the readings and the problems), ADR-0139 (Sextant's own
extensions), ADR-0140 (translations), ADR-0143 (the section's counter), ADR-0152 (kinds in a section of its own),
ADR-0153 (computed columns), ADR-0160 (the section's icon and place, the UI kit), ADR-0161 (printer columns left out,
paths picking an item, notification groups), ADR-0163 (field values in texts, a problem's reason from the object),
ADR-0164 (case tooltips, deeper conditions), ADR-0165 (a kind's own "Only problems") and ADR-0167 (every match of a
path, nested match fields reaching through lists, placeholder filters and clipping, joined list paths, blank texts, case values, widths and the `muted` tone, `reasonOr`/`sinceOr`, 30
rules and 40 conditions, sections without a heading, blocks in Sextant's own memory, text sort keys, non-empty texts,
rule sources' caps, the counter's own label).

## At a glance

| | |
|---|---|
| Id | `sextant.strimzi` |
| Version | 1.0.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `strimzi-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → Strimzi |
| Checked against | Strimzi's objects of `kafka.strimzi.io` (`v1beta2` and `v1`) as the cluster operator writes them; the automatic restarts follow `AbstractConnectOperator` of strimzi-kafka-operator |

## What it adds

**A sidebar section "Strimzi"** (`strimzi`), shown while the cluster serves one of its kinds, with the built-in
section's icon: Kafkas, Kafka Node Pools, Kafka Topics, Kafka Users, Kafka Connects, Kafka MirrorMaker 2 and Kafka
Connectors, each with Sextant's own table, filters, selection bar and details. The section's counter shows how many
objects need attention (the problems below). "Only problems" on each table shows every object that is not ready, and
on Kafka Connectors and MirrorMaker 2 every one with a failed connector or task, at once, as the built-in tables did.

**Columns**, after Name and Namespace, in place of the CRDs' own printer columns (left out, as the built-in view did),
in the built-in columns' widths. Readiness (**Status**) is "Ready" (a `Ready` condition True), "Not ready" (`NotReady`
True, or `Ready` False) or "Pending" (neither yet), coloured, with Strimzi's message on hover, sorted by the state in
every language; **Reason** is that condition's reason.
- Kafkas: **Status** (`kafka-status`), **Version** (`kafka-version`: the running Kafka version, else the one asked
  for), **Listeners** (`kafka-listeners`: every declared listener's name, then those only reported in the status, each
  once) and **Reason**
  (`kafka-reason`).
- Kafka Node Pools: **Kafka** (`node-pool-cluster`: the `strimzi.io/cluster` label), **Roles** (`node-pool-roles`)
  and **Replicas** (`node-pool-replicas`). Strimzi sets no readiness on a node pool.
- Kafka Topics: **Kafka** (`topic-cluster`), **Status** (`topic-status`), **Partitions** (`topic-partitions`),
  **Replicas** (`topic-replicas`) and **Reason** (`topic-reason`).
- Kafka Users: **Kafka** (`user-cluster`), **Status** (`user-status`), **Authentication** (`user-authentication`)
  and **Authorization** (`user-authorization`).
- Kafka Connects: **Status** (`connect-status`), **Replicas** (`connect-replicas`) and **Reason**
  (`connect-reason`); Kafka MirrorMaker 2 the same (`mirror-maker-status`, `mirror-maker-replicas`,
  `mirror-maker-reason`).
- Kafka Connectors: **Connect cluster** (`connector-cluster`), **Status** (`connector-status`), **Connector**
  (`connector-state`: the connector's state as Kafka Connect reports it: RUNNING green, FAILED red, PAUSED and STOPPED
  muted, any other yellow), **Running tasks** (`connector-tasks`: running of all, red with a failed task, green with
  every task running, else yellow; blank without tasks; sorted by the running tasks, a connector without tasks with those running none), **Class** (`connector-class`: the class's last part, the whole
  on hover), **Auto-restarts** (`connector-restarts`: Strimzi's automatic restarts) and **Reason**
  (`connector-reason`).

**Details** (`strimzi`, on every kind of the section, without a heading of its own as the built-in section; "Strimzi"
stays its accessible name), drawn with the SDK's UI kit in the classes of Sextant's own details panel. Its blocks
(warnings, listeners, mirrors, connectors, failures, tasks) open and close by their titles in Sextant's own memory of
details sections, as the built-in blocks did: kept as Settings → Appearance says, and opened or closed by the panel's
"Expand all" and "Collapse all". Every kind but a node pool shows its readiness and reason, why it is
not ready in Strimzi's words, and Strimzi's warnings (deprecated fields, unused settings: shown, never a problem):
- **Kafka:** its version, metadata state (KRaft), cluster id and node pools (links), and its listeners with type,
  TLS, port, bootstrap servers and the addresses Strimzi reports ("No address yet" while there is none).
- **KafkaNodePool:** its Kafka (a link), roles, replicas, node ids and storage type.
- **KafkaTopic:** its Kafka, the topic's name in Kafka, partitions, replication factor and config.
- **KafkaUser:** its Kafka, authentication, authorization and the number of ACL rules, the user name, and the
  Secret Strimzi wrote for it, by name: a link to Sextant's own details of it. The extension never reads it.
- **KafkaConnect / KafkaMirrorMaker2:** replicas, version, bootstrap servers, the Connect cluster, the REST API's
  address and the number of connector plugins; a MirrorMaker 2's mirrors (source, target, topics pattern) and its
  connectors with their states, their tasks' states and Strimzi's automatic restarts.
- **KafkaConnector:** its Connect cluster (a link), class, maximum tasks, requested state, the connector's state,
  type and worker, whether Strimzi restarts it automatically and at most how many times, the restarts so far and the
  last one, its topics, and its tasks with their states, workers and errors; it says when Strimzi stopped restarting
  it because the limit is reached.
- **Failures** (connectors, MirrorMaker 2): each failed connector and task with the first line of its stack trace and
  the whole trace folded (at most 20 000 characters drawn).

No actions: Edit and Delete are Sextant's own actions on every kind of the section.

## Permissions

- **Read** Kafkas, KafkaNodePools, KafkaTopics, KafkaUsers, KafkaConnects, KafkaMirrorMaker2s and KafkaConnectors
  (the details read the shown object), in every namespace of every cluster.
- Nothing is changed or deleted, no logs are opened, and no Secret is read: a user's Secret and the other objects the
  details name are links that open Sextant's own details, with your own access.
- Its problem rules judge the seven kinds; Sextant asks for that separately at install.
- An update asks for consent again when it needs a new kind or action, or changes a grant.

## Problems

On all seven kinds, from Sextant's watches of them: at most 5000 topics and 5000 users, as the built-in view capped
them, and at most 20 000 objects of each other kind. A problem may notify. Rules of
one group (`not-ready`, `connector-failed`, `task-failed`) notify once per object. An object being deleted has none.
A not-ready object's reason is Strimzi's (`NotReady` when it gives none) and its message Strimzi's. A failure's reason
is `ConnectorFailed` or `TaskFailed`, its message the stack trace's first line that is not blank, cut at 300
characters (in a MirrorMaker 2 with several connectors after the connector's name), and it counts from when the object became not ready (`NotReady`, else `Ready`
False); a connector's or task's failure is told instead of the object's NotReady, which only says "see
connectorStatus".

| Id | Kind | When it holds | Grace | Told by another object |
|---|---|---|---|---|
| `kafka-not-ready` | Kafka | `NotReady` True, or `Ready` False | 5 minutes | No |
| `node-pool-not-ready` | KafkaNodePool | The same | 5 minutes | No |
| `topic-not-ready` | KafkaTopic | The same | 5 minutes | No |
| `user-not-ready` | KafkaUser | The same | 5 minutes | No |
| `connect-not-ready` | KafkaConnect | The same | 5 minutes | No |
| `mirror-maker-not-ready` | KafkaMirrorMaker2 | The same, and none of its connectors or their tasks failed | 5 minutes | No |
| `connector-not-ready` | KafkaConnector | The same, and neither its connector nor a task failed | 5 minutes | No |
| `connector-failed` | KafkaConnector | Its connector is FAILED and no automatic restart is coming: auto-restart is off, or the restarts reached `maxRestarts` (7 without one) | None | No |
| `connector-failed-first-restart` | KafkaConnector | Its connector is FAILED and Strimzi has not restarted it yet | 2 minutes (one reconciliation) | No |
| `connector-failed-restarting` | KafkaConnector | Its connector is FAILED after automatic restarts, more to come | Until the next restart window: n² + n minutes after the n-th restart (at most 60), plus 2 | No |
| `task-failed`, `task-failed-first-restart`, `task-failed-restarting` | KafkaConnector | The same three for a FAILED task (the first one's trace) | As above | No |
| `mirror-connector-failed` | KafkaMirrorMaker2 | Its first FAILED connector, when it runs one (or that connector reports no name or trace) | None | No |
| `mirror-connector-failed-named` | KafkaMirrorMaker2 | Its first FAILED connector of several; the message names it | None | No |
| `mirror-task-failed` | KafkaMirrorMaker2 | A task of its first connector with a FAILED task, when it runs one connector (or that connector reports no name or the task no trace) | None | No |
| `mirror-task-failed-named` | KafkaMirrorMaker2 | A task of its first connector with a FAILED task, of several; the message names the connector | None | No |

## Metrics

None.

## Commands

None.

## Changes it makes

None: it only reads.

## What it does not do

- It does not talk to Kafka, Kafka Connect's REST API or the Strimzi operator: everything comes from the objects'
  status Strimzi writes.
- It does not restart, pause or stop connectors, roll a Kafka or rotate a user's credentials: Strimzi does that from
  annotations and spec fields, which Sextant's editor changes.
- It never reads a user's Secret or any other Secret.

## Requirements and limits

- The Strimzi CRDs, and the cluster operator for the status to be there.
- The table's columns and the problem rules are computed by Sextant from field paths (ADR-0153, ADR-0137); where that
  cannot say exactly what the former built-in view computed, they differ as follows (the details always show the full
  reading):
  - **Listeners** reads a reported listener by its `name`; a status entry of the old shape that names its listener
    only by `type` (Strimzi before `name` was added to `ListenerStatus`) is left out, where the built-in column named
    it by its type. A path cannot pick the items that lack a field.
  - A KafkaConnector's auto-restart status without a count (Strimzi always writes one) counts as before the first
    restart, with its 2-minute grace, where the built-in view read 0 restarts and waited 2 minutes from
    the last restart's time; with a count and a restart time that is no time, the failure is told at once, where the
    built-in view waited 2 minutes. A path has no default value, and a rule's grace cannot depend on a value.
  - The problem watches of Kafkas, node pools, Connect clusters, MirrorMaker 2s and connectors hold at most 20 000
    objects of a kind (a rule source's most); the built-in view watched them uncapped.
- Checked by tests on fixtures of Strimzi's objects (a Kafka with warnings and listeners, a topic, a user, a
  connector with a failed task, a MirrorMaker 2) and variants of them, against the built-in view's readings, ported
  unchanged; not yet tried on a live cluster.

## Troubleshooting

- **No "Strimzi" section:** the cluster serves none of its kinds, or the extension is disabled.
- **"Sextant refused: …" in the details:** the extension's permissions do not cover the object. Check Settings →
  Extensions → Strimzi.
- **A connector's failure is not a problem yet:** Strimzi still restarts it automatically; it counts once the next
  restart window has passed without a cure.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/strimzi        # → extensions/strimzi/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts ../extensions/strimzi
```

- `src/main.ts` starts the details (`details.ts`, drawn with the SDK's `ui` kit) in the frame.
- `model.ts` reads Strimzi's fields: readiness, listeners, connectors, automatic restarts, and the problems as the
  built-in view found them. It is the former built-in view's, ported.
- `model.test.ts` judges the manifest's problem rules, "Only problems" and columns with Sextant's own window engine
  (`src/extensions/problemRules.ts`, `src/extensions/columns.tsx`) and compares them with the model, on the fixtures
  in `fixtures/` and variants of them (every restart count with and without `maxRestarts`, MirrorMaker 2s of up to 30
  connectors), and the columns' texts, tones, sorting and widths; `views.test.ts` drives the details through the
  SDK's test host, the remembered blocks included.
- The texts are in `src/locales/<lang>.json` (English is the source; they are the built-in view's `strimzi` texts
  word for word) and in the manifest's `translations`. `src/locales.test.ts` keeps both complete in every language of
  Sextant's `src/locales/`. A text without words (a tooltip or message that is only field values) is left to English.
- The manifest is at one of Sextant's limits: 40 of 40 conditions in the `*-restarting` rules (17 of 30 problem rules).
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `strimzi` and the
     commit (add `strimzi` to that workflow's `extension` choices first).
  3. The catalog's index picks the release up.
