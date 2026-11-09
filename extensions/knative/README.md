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
owner and the Broker), ADR-0139 (Sextant's own extensions), ADR-0140 (translations), ADR-0144 (problems told through
an owner), ADR-0152 (kinds in a section of their own, `not`), ADR-0153 (computed columns), ADR-0160 (the sections'
icons and places, the UI kit), ADR-0161 (printer columns left out, paths picking an item, notification groups),
ADR-0163 (field values in texts, a problem's reason from the object), ADR-0164 (case tooltips, deeper conditions) and
ADR-0167 (the counters' own labels, 30 rules over 20 kinds).

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

**Columns**, after Name and Namespace, in place of the CRDs' own printer columns (left out, as the built-in view did).
Every kind begins with **Status** (Ready, Progressing, Failed or Unknown from `Ready`, coloured) and ends with
**Reason** (the failing condition's reason while the object is not ready):
- Services: `ksvc-status`, **URL** (`ksvc-url`), **Latest created** (`ksvc-latest-created`), **Latest ready**
  (`ksvc-latest-ready`), `ksvc-reason`.
- Configurations: `configuration-status`, **Latest created** (`configuration-latest-created`), **Latest ready**
  (`configuration-latest-ready`), `configuration-reason`.
- Revisions: `revision-status`, **Configuration** (`revision-configuration`, its label), **Generation**
  (`revision-generation`), **Replicas** (`revision-replicas`: actual/desired), `revision-reason` (a revision scaled to
  zero is ready, with no reason).
- Routes: `route-status`, **URL** (`route-url`), **Traffic** (`route-traffic`: each revision with its share, "name 80%
  · name 20%"), `route-reason`.
- Domain Mappings: `domain-mapping-status`, **URL** (`domain-mapping-url`), **Target** (`domain-mapping-target`),
  `domain-mapping-reason`.
- Brokers: `broker-status`, **Class** (`broker-class`), **Address** (`broker-address`), `broker-reason`.
- Triggers: `trigger-status`, **Broker** (`trigger-broker`), **Filter** (`trigger-filter`: `type=…`, `source=…`, a
  CESQL expression), **Subscriber** (`trigger-subscriber`: `Kind/name`, with its URI, or the URI), `trigger-reason`.
- Channels and In-Memory Channels: `channel-status`, **Address** (`channel-address`), `channel-reason`;
  `in-memory-channel-status`, `in-memory-channel-address`, `in-memory-channel-reason`.
- Subscriptions: `subscription-status`, **Channel** (`subscription-channel`), **Subscriber**
  (`subscription-subscriber`), **Reply** (`subscription-reply`), `subscription-reason`.
- Sequences and Parallels: `sequence-status`, **Steps** (`sequence-steps`), **Address** (`sequence-address`),
  `sequence-reason`; `parallel-status`, **Branches** (`parallel-branches`), **Address** (`parallel-address`),
  `parallel-reason`.
- API Server Sources: `api-server-source-status`, **Mode** (`api-server-source-mode`), **Sink**
  (`api-server-source-sink`), `api-server-source-reason`.
- Ping Sources: `ping-source-status`, **Schedule** (`ping-source-schedule`), **Sink** (`ping-source-sink`),
  `ping-source-reason`.
- Container Sources and Sink Bindings: `container-source-status`, **Sink** (`container-source-sink`),
  `container-source-reason`; `sink-binding-status`, `sink-binding-sink`, `sink-binding-reason`.
- Kafka Sources: `kafka-source-status`, **Topics** (`kafka-source-topics`), **Sink** (`kafka-source-sink`),
  `kafka-source-reason`.

**Details**, a section per kind, titled with the kind, in place of the generic fields and before the conditions,
drawn with the SDK's UI kit in the classes of Sextant's own details panel. Each begins with why the object is (not)
ready in plain words (red when it failed) and the failing condition's message as Knative wrote it:
- **Service** (`service`), **Configuration** (`configuration`) and **Route** (`route`): state, URL, address in the
  cluster, the latest created and latest ready revisions; for a Service or Route the traffic split — each target's
  revision, tag, share, whether it follows the latest ready revision, and its URL — or, while none is in effect, the
  split that was asked.
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
  only while its block is open and only of the kinds the cluster serves.

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
message and time are the first False condition's, in the order Knative writes them (by type); the `-unnamed` rules
give the built-in fallback reason "NotReady" when that condition gives none. Every rule may notify; the rules of one
group notify once per object. Revisions, Routes and DomainMappings are not judged: the latest revision's failure makes
its Configuration and Service not ready, and counts once, there. The "Knative Serving" counter counts the first four
rules, the "Knative Eventing" counter the others.

"Told by another object" — an object a Knative controller made is told through its owner: an owner reference Knative
writes (named in the table) leaves it out, and any other controller of the extension's kinds tells it while that
controller has a problem (`toldThroughOwner`).

| Id | Kind | When it holds | Grace | Told by another object |
|---|---|---|---|---|
| `service-not-ready` | Service (`serving.knative.dev`) | `Ready` is False, with a reason | 2 min | No |
| `service-not-ready-unnamed` | Service | The same without a reason (reason "NotReady") | 2 min | No |
| `configuration-not-ready` | Configuration | `Ready` is False, with a reason | 2 min | The Service that made it (`serving.knative.dev/v1` Service) |
| `configuration-not-ready-unnamed` | Configuration | The same without a reason | 2 min | The Service that made it |
| `broker-not-ready` | Broker | `Ready` is False | 2 min | Its controller, if any |
| `trigger-not-ready` | Trigger | `Ready` is False, unless only its Broker is not ready: `BrokerReady` False with a reason other than BrokerDoesNotExist, FailedToGetBroker and MissingBrokerChannel (those are the Trigger's own) | 2 min | The Broker, when the Broker's own failure is the cause |
| `channel-not-ready` | Channel | `Ready` is False | 2 min | A Broker, Sequence or Parallel that made it |
| `in-memory-channel-not-ready` | InMemoryChannel | `Ready` is False | 2 min | A Channel, Broker, Sequence or Parallel that made it |
| `subscription-not-ready` | Subscription | `Ready` is False | 2 min | A Trigger, Sequence or Parallel that made it |
| `sequence-not-ready` | Sequence | `Ready` is False | 2 min | Its controller, if any |
| `parallel-not-ready` | Parallel | `Ready` is False | 2 min | Its controller, if any |
| `api-server-source-not-ready` | ApiServerSource | `Ready` is False | 2 min | Its controller, if any |
| `ping-source-not-ready` | PingSource | `Ready` is False | 2 min | Its controller, if any |
| `container-source-not-ready` | ContainerSource | `Ready` is False | 2 min | Its controller, if any |
| `sink-binding-not-ready` | SinkBinding | `Ready` is False | 2 min | A ContainerSource that made it |
| `kafka-source-not-ready` | KafkaSource | `Ready` is False | 2 min | Its controller, if any |

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
  - A problem's reason, message and time are the first False condition's in Knative's order, `Ready` included; the
    built-in detector took the first False condition other than `Ready`. Knative copies a failing condition's reason
    and message into `Ready`, so the two agree unless several conditions fail at once (a path step cannot leave one
    match out).
  - An Eventing problem without a reason has the rule's title as its reason (the built-in one said "NotReady"): a
    section counter counts at most 20 rules, too few for a rule without a reason per Eventing kind (#404, literal
    reason fallback). A Serving problem whose reason is empty says "NotReady" (the built-in one said nothing).
  - An object owned by another Eventing object: the built-in detector left out every controller of the four Eventing
    groups, of any version. The rules leave out the owner references Knative writes (`v1`, by kind; a path matches
    only text, so a reference of those pairs counts whether or not it is the controller), and tell any other
    controller's objects through it while it has a problem (`toldThroughOwner`), so such an object is a problem of its
    own while its owner has none. A Configuration owned by a Service of another version than `v1` likewise.
  - A Trigger is told through its Broker when `BrokerReady` is False with the Broker's reason; the built-in detector
    also asked that `BrokerReady` be the first failing condition, which it always is in Knative's order.
  - The Status columns draw Unknown in the neutral colour (the built-in tables muted it), sort by the text shown, not
    by the state, and the columns have Sextant's default widths (#403).
  - Traffic: from the first three targets of `status.traffic`, two shares exactly, and of three shares the first two
    and "…"; a share past the third target shows only as "…", and a split only asked (`spec.traffic`, nothing in
    effect yet) only when it has one target (#404, a list projection).
  - Filter: exactly for one `exact` or `prefix` type filter, a CESQL expression, or the older `type` and `source`
    attributes; otherwise its first exact type and "…", or "…" alone (#404). An empty `source` value, or an empty
    `type` beside a `source`, shows `source=`/`type=` where the built-in one wrote `=*`.
  - Topics are joined with the UI language's list separator and have no hover; Steps and Branches show nothing for an
    object without any (the built-in columns said 0). Text cells lose the credentials and query of any URI in them,
    as every computed column's text does.
  - The details are a section per kind; the event path is a block inside it, not one of its own. A block closed by the
    user stays closed only while the section's frame lives; the built-in panel remembered it (#406).
  - A SinkBinding's subject selector is written as its labels and expressions (`app=heartbeat-cron`); the built-in
    view wrote the selector's own fields (`matchLabels=[object Object]`).
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
