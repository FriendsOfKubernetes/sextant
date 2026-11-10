# Knative

Read-only views of [Knative](https://knative.dev/) Serving and Eventing, in every language Sextant has. It lists
Knative Serving's Services, Configurations, Revisions, Routes and DomainMappings (`serving.knative.dev`) and Knative
Eventing's Brokers, Triggers, Channels, In-Memory Channels, Subscriptions, Sequences, Parallels and sources
(`eventing.knative.dev`, `messaging.knative.dev`, `flows.knative.dev`, `sources.knative.dev`) in two sidebar sections
of their own with Sextant's tables; tells each object's state and why it is not ready in plain words, a Service's
revisions and traffic split, where an Eventing object sends its events and the event path from the sources through a
Broker or Channel to the subscribers; and reports objects that are not ready, each told once, where the user acts. It
replaces Sextant's former built-in Knative views with the same behaviour where the extension API allows (see
"Requirements and limits"). Its id is `sextant.knative`. Why it is built this way: ADR-0101 (Knative Serving's
readings and problems), ADR-0106 (Eventing's kinds, the event path from one namespace, the problems told through the
owner and the Broker), ADR-0139 (Sextant's own extensions), ADR-0140 (translations), ADR-0152 (kinds in a section of their own, `not`), ADR-0153 (computed columns), ADR-0160 (the sections'
icons and places, the UI kit), ADR-0161 (printer columns left out, paths picking an item, notification groups),
ADR-0163 (field values in texts, a problem's reason from the object), ADR-0164 (case tooltips, deeper conditions) and
ADR-0167 (the counters' own labels, 30 rules over 20 kinds, `reasonOr`, match steps with `!=`, text conditions, sums
and counts in conditions, `|join`, column widths and sort values, the `muted` tone, details sections without a
heading, blocks in Sextant's own memory).

## At a glance

| | |
|---|---|
| Id | `sextant.knative` |
| Version | 1.0.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `knative-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → Knative |
| Checked against | Knative Serving's and Eventing's objects as `serving.knative.dev/v1` (DomainMapping `v1beta1`), `eventing.knative.dev/v1`, `messaging.knative.dev/v1`, `flows.knative.dev/v1` and `sources.knative.dev/v1` write them (Eventing 1.23), and eventing-kafka-broker's KafkaSource (`v1beta1`) |

## What it adds

**A sidebar section "Knative Serving"** (`knative`), shown while the cluster serves one of its kinds, with the
built-in section's icon and place: Services, Configurations, Revisions, Routes and Domain Mappings. **A sidebar section
"Knative Eventing"** (`knativeEventing`), likewise: Brokers, Triggers, Channels, In-Memory Channels, Subscriptions,
Sequences, Parallels, API Server Sources, Ping Sources, Container Sources, Sink Bindings and Kafka Sources. Each kind has
Sextant's own table, filters, selection bar and details, and Edit and Delete as on every kind. Each section's counter
shows how many of its objects need attention (the problems below, each section counting its own rules).

**"Only problems"** on every kind, as the built-in tables had it (no grace, no owner): the objects whose `Ready`
condition is False.

**Columns**, after Name and Namespace, in place of the CRDs' own printer columns (left out, as the built-in view did),
with the built-in columns' widths. Every kind begins with **Status** (Ready, Progressing, Failed or Unknown from
`Ready`, coloured, Unknown muted, sorted and filtered by the state's name) and ends with **Reason** (the reason of the first False
condition other than `Ready` — a Revision's `Active` left out — else of `Ready`, while the object is not ready):
- Services: `ksvc-status`, **URL** (`ksvc-url`), **Latest created** (`ksvc-latest-created`), **Latest ready**
  (`ksvc-latest-ready`), `ksvc-reason`.
- Configurations: `configuration-status`, **Latest created** (`configuration-latest-created`), **Latest ready**
  (`configuration-latest-ready`), `configuration-reason`.
- Revisions: `revision-status`, **Configuration** (`revision-configuration`, its label), **Generation**
  (`revision-generation`), **Replicas** (`revision-replicas`: actual/desired), `revision-reason` (a revision scaled to
  zero is ready, with no reason).
- Routes: `route-status`, **URL** (`route-url`), **Traffic** (`route-traffic`: every target with a share, "name 80%
  · latest 20%", or the split asked while none is in effect), `route-reason`.
- Domain Mappings: `domain-mapping-status`, **URL** (`domain-mapping-url`), **Target** (`domain-mapping-target`),
  `domain-mapping-reason`.
- Brokers: `broker-status`, **Class** (`broker-class`), **Address** (`broker-address`), `broker-reason`.
- Triggers: `trigger-status`, **Broker** (`trigger-broker`: `spec.brokerRef.name`, else `spec.broker`), **Filter**
  (`trigger-filter`: each filter's attributes, `type=…`, `source=…*`, or a CESQL expression, joined with ", "), **Subscriber** (`trigger-subscriber`: `Kind/name`, with
  its URI, or the URI), `trigger-reason`.
- Channels and In-Memory Channels: `channel-status`, **Address** (`channel-address`), `channel-reason`;
  `in-memory-channel-status`, `in-memory-channel-address`, `in-memory-channel-reason`.
- Subscriptions: `subscription-status`, **Channel** (`subscription-channel`), **Subscriber**
  (`subscription-subscriber`), **Reply** (`subscription-reply`), `subscription-reason`.
- Sequences and Parallels: `sequence-status`, **Steps** (`sequence-steps`, 0 without any), **Address**
  (`sequence-address`), `sequence-reason`; `parallel-status`, **Branches** (`parallel-branches`, 0 without any),
  **Address** (`parallel-address`), `parallel-reason`.
- API Server Sources: `api-server-source-status`, **Mode** (`api-server-source-mode`), **Sink**
  (`api-server-source-sink`), `api-server-source-reason`.
- Ping Sources: `ping-source-status`, **Schedule** (`ping-source-schedule`), **Sink** (`ping-source-sink`),
  `ping-source-reason`.
- Container Sources and Sink Bindings: `container-source-status`, **Sink** (`container-source-sink`),
  `container-source-reason`; `sink-binding-status`, `sink-binding-sink`, `sink-binding-reason`.
- Kafka Sources: `kafka-source-status`, **Topics** (`kafka-source-topics`, joined with ", ", the list on hover),
  **Sink** (`kafka-source-sink`), `kafka-source-reason`.

**Details**, a section per kind in place of the generic fields and before the conditions, drawn with the SDK's UI
kit in the classes of Sextant's own details panel: as the built-in section, a block titled with the kind (the section
has no heading of its own) and, for an Eventing object, the event path in a block beside it. The blocks open and
close with their titles, kept in Sextant's own memory of details sections (as Settings → Appearance says) and
following the panel's "Expand all" and "Collapse all". Each begins with why the object is (not) ready in plain words
(red when it failed) and the failing condition's message as Knative wrote it:
- **Service** (`service`), **Configuration** (`configuration`) and **Route** (`route`): state, URL, address in the
  cluster, the latest created and latest ready revisions; for a Service or Route the traffic split in a block of its
  own — each target's revision, tag, share, whether it follows the latest ready revision, and its URL — or, while none
  is in effect, the split that was asked; its columns resize and Sextant remembers their widths, as the built-in
  table's (the widths set there carry over), the revision, tag and share on one line.
- **Revision** (`revision`): state (scaled to zero, starting, the container unhealthy, resources unavailable), its
  Configuration and Service, generation, actual of desired replicas, routing state, images, requests per container
  at once and the request timeout.
- **DomainMapping** (`domain-mapping`): state, URL and the Service it points at.
- **Broker** (`broker`), **Trigger** (`trigger`), **Channel** (`channel`), **InMemoryChannel**
  (`in-memory-channel`), **Subscription** (`subscription`), **Sequence** (`sequence`), **Parallel** (`parallel`),
  **ApiServerSource** (`api-server-source`), **PingSource** (`ping-source`), **ContainerSource** (`container-source`),
  **SinkBinding** (`sink-binding`) and **KafkaSource** (`kafka-source`): the kind's own fields — a Broker's class,
  address, configuration and dead letter sink; a Trigger's Broker, filter in words (`type is …`, `any of: …`, and a
  note when `spec.filters` overrides `spec.filter`) and subscriber; a Subscription's channel, subscriber, reply and
  dead letter sink; a channel's implementation, backing channel and subscribers; a flow's steps or branches and reply;
  a source's sink with the address it resolved to, and what it reads (a PingSource's schedule, time zone and content
  type, an ApiServerSource's mode, watched resources and service account, a ContainerSource's images, a SinkBinding's
  subject, a KafkaSource's topics, bootstrap servers and consumer group) — and the **Event path**: the sources of the
  hub's namespace that send to it, the Broker or Channel, its Triggers or Subscriptions with their filters, and their
  subscribers and replies with the addresses they resolved to; a Sequence's steps in order; a Parallel's branches with
  their filters. The opened object is marked; each object is a link with its state. A fan-out shows at most 50 items
  and counts the rest. The path reads the Brokers, Triggers, Subscriptions and sources of that one namespace, watched
  only while its block is open (closed, or collapsed by "Collapse all", it reads nothing) and only of the kinds the
  cluster serves.

Every object named is a link to its details in Sextant's panel.

## Permissions

- **Read** the seventeen kinds of both sections, in every namespace of every cluster: each section reads the object it
  shows, and the event path lists Brokers, Triggers, Subscriptions and the sources of one namespace.
- Nothing is changed or deleted by the extension; Edit and Delete are Sextant's own actions, under your own rules.
- Its problem rules judge Services, Configurations and the twelve Eventing kinds; Sextant asks for that separately at
  install.
- An update asks for consent again when it needs a new kind or action, or changes a grant.

## Problems

As the built-in category `knative`, on by default. An object has a problem when its `Ready` condition is False, for
2 minutes from when its failing condition changed (a rollout the next reconcile fixes passes quietly). Its reason,
message and time are the failing condition's: the first False condition other than `Ready` (a Revision's `Active`
never counts), in the order Knative writes them, else `Ready`'s own — each kind has a rule for either, so the two never
hold at once — and the reason is "NotReady" when that condition gives none. Every rule may notify, all in one group:
an object notifies once. Revisions, Routes and DomainMappings are not judged: the latest revision's failure makes its
Configuration and Service not ready, and counts once, there. The "Knative Serving" counter counts the first four rules,
the "Knative Eventing" counter the others.

"Told by another object" — an object a Knative controller made is left out, its owner telling its failure, judged on
the object alone as the built-in detector did: a Configuration with an owner reference to a Knative Service (any
version), an Eventing object whose controller reference is of `eventing.knative.dev`, `messaging.knative.dev`,
`flows.knative.dev` or `sources.knative.dev` (any kind and version; the API server allows one controller reference).

| Id | Kind | When it holds | Grace | Told by another object |
|---|---|---|---|---|
| `service-not-ready` | Service (`serving.knative.dev`) | `Ready` is False and another condition is False | 2 min | No |
| `service-not-ready-ready-only` | Service | `Ready` alone is False | 2 min | No |
| `configuration-not-ready` | Configuration | `Ready` is False and another condition is False | 2 min | The Knative Service that owns it |
| `configuration-not-ready-ready-only` | Configuration | `Ready` alone is False | 2 min | The Knative Service that owns it |
| `broker-not-ready` | Broker | `Ready` is False and another condition is False | 2 min | Its Eventing controller, if any |
| `broker-not-ready-ready-only` | Broker | `Ready` alone is False | 2 min | Its Eventing controller, if any |
| `trigger-not-ready` | Trigger | `Ready` is False and another condition is False, unless only its Broker is not ready: it names a Broker, its failing condition is `BrokerReady` and the reason is not BrokerDoesNotExist, FailedToGetBroker or MissingBrokerChannel (those are the Trigger's own) | 2 min | The Broker, when the Broker's own failure is the cause; its Eventing controller, if any |
| `trigger-not-ready-ready-only` | Trigger | `Ready` alone is False | 2 min | Its Eventing controller, if any |
| `channel-not-ready` | Channel | `Ready` is False and another condition is False | 2 min | A Broker, Sequence or Parallel that made it |
| `channel-not-ready-ready-only` | Channel | `Ready` alone is False | 2 min | A Broker, Sequence or Parallel that made it |
| `in-memory-channel-not-ready` | InMemoryChannel | `Ready` is False and another condition is False | 2 min | A Channel, Broker, Sequence or Parallel that made it |
| `in-memory-channel-not-ready-ready-only` | InMemoryChannel | `Ready` alone is False | 2 min | A Channel, Broker, Sequence or Parallel that made it |
| `subscription-not-ready` | Subscription | `Ready` is False and another condition is False | 2 min | A Trigger, Sequence or Parallel that made it |
| `subscription-not-ready-ready-only` | Subscription | `Ready` alone is False | 2 min | A Trigger, Sequence or Parallel that made it |
| `sequence-not-ready` | Sequence | `Ready` is False and another condition is False | 2 min | Its Eventing controller, if any |
| `sequence-not-ready-ready-only` | Sequence | `Ready` alone is False | 2 min | Its Eventing controller, if any |
| `parallel-not-ready` | Parallel | `Ready` is False and another condition is False | 2 min | Its Eventing controller, if any |
| `parallel-not-ready-ready-only` | Parallel | `Ready` alone is False | 2 min | Its Eventing controller, if any |
| `api-server-source-not-ready` | ApiServerSource | `Ready` is False and another condition is False | 2 min | Its Eventing controller, if any |
| `api-server-source-not-ready-ready-only` | ApiServerSource | `Ready` alone is False | 2 min | Its Eventing controller, if any |
| `ping-source-not-ready` | PingSource | `Ready` is False and another condition is False | 2 min | Its Eventing controller, if any |
| `ping-source-not-ready-ready-only` | PingSource | `Ready` alone is False | 2 min | Its Eventing controller, if any |
| `container-source-not-ready` | ContainerSource | `Ready` is False and another condition is False | 2 min | Its Eventing controller, if any |
| `container-source-not-ready-ready-only` | ContainerSource | `Ready` alone is False | 2 min | Its Eventing controller, if any |
| `sink-binding-not-ready` | SinkBinding | `Ready` is False and another condition is False | 2 min | A ContainerSource that made it |
| `sink-binding-not-ready-ready-only` | SinkBinding | `Ready` alone is False | 2 min | A ContainerSource that made it |
| `kafka-source-not-ready` | KafkaSource | `Ready` is False and another condition is False | 2 min | Its Eventing controller, if any |
| `kafka-source-not-ready-ready-only` | KafkaSource | `Ready` alone is False | 2 min | Its Eventing controller, if any |

## Metrics

None.

## Commands

None.

## Changes it makes

None: the extension is read-only and has no action of its own.

## What it does not do

- It does not create, change or delete Knative objects, and sends no event.
- It does not talk to Knative's controllers, a Broker's ingress or any URL it shows: every URL is shown as text.
- It does not show live traffic: the event path is read from the objects' specs and statuses only.
- It judges no Revision, Route or DomainMapping as a problem, as the built-in view did not.

## Requirements and limits

- Knative Serving's or Eventing's CRDs; each section shows only the kinds the cluster serves.
- Where it differs from the former built-in view, because the extension API cannot say it yet:
  - Traffic sorts by the text shown, the latest revision by its word; the built-in sorted it with no word there (an
    item's own sort text would close it).
  - Filter: each filter of `spec.filters` is exact when it has terms of one dialect only — one exact, prefix or suffix
    attribute, a CESQL expression, or an exact `source` and `type` — and "…" otherwise: several dialects in one filter,
    several attributes of one dialect, and the nested `all`, `any` and `not`, which a case cannot write out (a text
    projection of the filter tree would close it, #404). The older `spec.filter.attributes` are exact for a `type`, a
    `source`, both, or one attribute of another name (whose empty value shows `name=` where the built-in wrote
    `name=*`); more attributes show "…".
  - Text cells and problem messages lose the credentials and query of any URI in them and are clipped (200 characters
    a cell, 1200 a message), as every extension text from the cluster is; the built-in ones showed them as written.
  - A problem whose reason Knative wrote as an empty text says "NotReady" (the built-in one said nothing); Knative
    leaves an empty reason out, so it is not met in practice.
  - A SinkBinding's subject selector is written as its labels and expressions (`app=heartbeat-cron`); the built-in
    view wrote the selector's own fields (`matchLabels=[object Object]`), a fault not carried over.
- Checked by tests on fixtures of Knative's objects (copied from the built-in views) against the built-in readings
  and rules; not yet tried on a live cluster.

## Troubleshooting

- **No "Knative Serving" or "Knative Eventing" section:** the cluster serves none of its kinds, or the extension is
  disabled.
- **The event path names no sources, Triggers or Subscriptions:** the extension may not list Brokers, Triggers,
  Subscriptions or a source kind in that namespace; the path is drawn from what it could read.
- **"Sextant refused: …" in a section:** the extension's permissions do not cover the object. Check Settings →
  Extensions → Knative.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/knative        # → extensions/knative/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts ../extensions/knative
```

- `src/main.ts` starts the details section of the selected object: `details.ts` draws the Serving and Eventing views
  and holds the event path's watches, with the SDK's `ui` kit.
- `model.ts` (Serving), `eventing.ts` (Eventing) and `path.ts` (the event path) are the former built-in views' model,
  ported, with their problem detectors (`servingProblems`, `eventingProblems`) and filter (`isProblem`) kept as the
  reference the manifest is tested against.
- `model.test.ts` judges the manifest's problem rules, "Only problems" and the columns with Sextant's own window
  engine (`src/extensions/problemRules.ts`, `src/extensions/columns.tsx`) and compares them with the model on the
  fixtures in `fixtures/` and variants of them; `views.test.ts` drives the details through the SDK's test host.
- The texts are in `src/locales/<lang>.json` (English is the source; they come from the built-in views' `knative`
  texts) and in the manifest's `translations` (texts made only of field values and punctuation are left to English).
  `src/locales.test.ts` keeps both complete in every language of Sextant's `src/locales/`.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `knative` and the
     commit (add `knative` to that workflow's `extension` choices first).
  3. The catalog's index picks the release up.
