# ADR-0106: Knative Eventing views share the Knative problem category and draw the event path from one namespace

## Context

#234 asks for Knative Eventing next to the Knative Serving views of ADR-0101: Brokers, Triggers (filter, subscriber resolved), Channels and Subscriptions, the sources (ApiServerSource, PingSource, ContainerSource, SinkBinding, KafkaSource when served) with their sinks, Ready conditions explained, the event path Source → Broker → Trigger → subscriber in the details, and not-ready objects as problems. Eventing spans four API groups (`eventing.knative.dev`, `messaging.knative.dev`, `flows.knative.dev`, `sources.knative.dev`), is often installed without Serving, and Knative itself creates many of its objects (a Broker's backing InMemoryChannel, a Trigger's Subscription, a Sequence's Channels and Subscriptions, a ContainerSource's SinkBinding). Shapes were checked against the CRDs and `*_lifecycle.go` of knative/eventing v1.23 and knative-extensions/eventing-kafka-broker v1.23.

## Decision

- **Read-only, frontend only**, in `src/features/knative/` (`eventing*.ts(x)`): no Rust command; the kinds offer the generic Edit and Delete only.
- **A discovered sidebar section of its own, `knativeEventing` ("Knative Eventing")**, beside Serving's (renamed "Knative Serving"): Brokers, Triggers, Channels, InMemoryChannels, Subscriptions, Sequences, Parallels and the five sources, each listed only when the cluster serves it. A section and not a group inside Serving's: the sidebar has no sub-groups outside custom resources, and either half can be installed alone. KafkaSource is registered at `v1beta1` (its stored version; v1 is served since 1.17); discovery picks the version watched.
- **State** as in ADR-0101 (Ready True / Unknown / False → ready / progressing / failed). The explanation names the first False condition other than Ready by its type (IngressReady, FilterReady, TriggerChannelReady, BrokerReady, SubscriberResolved, ReferencesResolved, SinkProvided, Deployed, SufficientPermissions, ConnectionEstablished…), with the Destination that did not resolve where there is one.
- **Destinations** (`ref` and/or `uri`) are shown as a link to the object they name — any kind: a Knative Service, a core Service, a Broker, a Channel — plus the address Knative resolved (`status.subscriberUri`, `status.sinkUri`, `status.physicalSubscription.*`). A Trigger's filter is read from `spec.filters` (the CloudEvents Subscriptions API dialects `exact`, `prefix`, `suffix`, `all`, `any`, `not`, `cesql`) when set — it overrides `spec.filter`, which the details then say — else from `spec.filter.attributes` (an empty value matches any value).
- **The event path** (a tree in the details): sources → Broker → its Triggers → subscribers; sources → Channel → its Subscriptions → subscribers and replies; a source → its sink, followed through a Broker or Channel; a Sequence's steps in order then its reply; a Parallel's branches (filter → subscriber → reply). The lists it needs are watched **in one namespace only** — the hub's — and only for the kinds that path uses and the cluster serves, through the shared watch registry, released when the panel closes. Sources in other namespaces that point at a Broker across namespaces are not looked for. A fan-out shows at most 50 items and counts the rest.
- **Problems: the existing `knative` category** (on by default, never for agents: `NEVER_FOR_AGENTS` already holds it) gains every Eventing kind the cluster serves, each watch capped at 5000 objects (`MAX_SOURCE_OBJECTS`). An object is a problem when Ready is False, after the 2-minute grace, except: an object controlled by another Eventing object is told through its owner (whose conditions carry the failure); a Trigger whose only failure is its Broker's (BrokerReady False with a reason the Broker propagated) is told through the Broker — "BrokerDoesNotExist", "FailedToGetBroker" and "MissingBrokerChannel" are the Trigger's own. The two section counters split the category by API group.

## Why

- A new problem category was rejected: it would add a toggle, a Rust list entry and translations for the same "Knative is not delivering" signal, and agents already get no Knative problems.
- Watching sources cluster-wide for the path was rejected: the path is a details view of one object, and a namespace's lists are bounded where a cluster's are not; the problems watches are cluster-wide only because the Problems screen is.
- Judging every Knative-made child separately was rejected: one broken Broker would raise its InMemoryChannel, every Trigger and every Trigger's Subscription.

## Consequences

- A cluster with Eventing gets up to 12 more problem watches (only for served kinds); Triggers and Subscriptions beyond 5000 make the source say it is truncated.
- A source in another namespace that sends to a Broker is not listed among the Broker's senders.
- Eventing kinds outside this list (KafkaChannel, IntegrationSource, JobSink, EventTransform, RequestReply, third-party sources) appear only as custom resources.
