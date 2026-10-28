// Details of Knative Eventing objects (#234): the state in plain words with the failing condition's message, the
// kind's own fields (a Broker's class, address and dead letter sink; a Trigger's Broker, filter in words and
// subscriber; a Subscription's channel, subscriber and reply; a source's sink and what it reads), each Destination as
// a link to the object it names with the address it resolved to, and the event path (eventingPath.ts). Read-only.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { status, StatusText } from "../../resources";
import { Block, chips, Fields, link, type FieldRow } from "../details";
import {
  addressOf,
  API_SERVER_SOURCE,
  apiServerResources,
  branchesOf,
  BROKER,
  brokerClassOf,
  brokerOf,
  channelOf,
  CONTAINER_SOURCE,
  deadLetterUriOf,
  eventingKind,
  explainEventing,
  isChannelKind,
  isSourceKind,
  KAFKA_SOURCE,
  kafkaServers,
  kafkaTopics,
  PARALLEL,
  PING_SOURCE,
  replyOf,
  replyUriOf,
  SEQUENCE,
  SINK_BINDING,
  sinkOf,
  sinkUriOf,
  stepsOf,
  subjectOf,
  subscriberOf,
  subscriberUriOf,
  SUBSCRIPTION,
  TRIGGER,
  triggerFilter,
  type Destination,
} from "./eventing";
import { EventPathView, useFilterWords } from "./eventingPathView";
import { failingCondition, HEALTH_TONE, healthOf, sameKind } from "./model";

const { arr, get, str } = status;
const LABELS = "knative:eventing.fields";

/** A Destination as a link to the object it names (any kind), else its URI. */
export function destinationLink(dest: Destination | undefined, namespace: string | null) {
  if (!dest) return null;
  const ref = dest.ref;
  if (ref?.name && ref.kind) return link({ apiVersion: ref.apiVersion ?? "v1", kind: ref.kind }, ref.name, ref.namespace ?? namespace);
  return dest.uri ?? null;
}

function Health({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const health = healthOf(obj);
  return <StatusText value={t(`knative:health.${health}`)} tone={HEALTH_TONE[health]} />;
}

function FilterField({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const words = useFilterWords();
  const { terms, legacyIgnored } = triggerFilter(obj);
  return (
    <>
      {terms.length === 0 ? (
        <span>{t("knative:eventing.filter.none")}</span>
      ) : (
        <ul className="cm-cert-list">
          {terms.map((term, i) => (
            <li key={i}>{words(term)}</li>
          ))}
        </ul>
      )}
      {legacyIgnored && <p className="cm-message">{t("knative:eventing.filter.legacyIgnored")}</p>}
    </>
  );
}

/** A destination and, below it, the address it resolved to. */
function resolved(dest: Destination | undefined, uri: string | undefined, ns: string | null) {
  const target = destinationLink(dest, ns);
  if (!target) return uri;
  if (!uri || uri === dest?.uri) return target;
  return (
    <span className="dt-links">
      {target}
      <span className="cm-chain__extra">{uri}</span>
    </span>
  );
}

function rowsOf(obj: KubeObject, kind: DetailsSectionProps["objectRef"]["kind"]): FieldRow[] {
  const ns = obj.metadata?.namespace ?? null;
  const head: FieldRow[] = [["status", <Health key="h" obj={obj} />]];
  const deadLetter: FieldRow = ["deadLetter", deadLetterUriOf(obj)];
  if (sameKind(kind, BROKER)) {
    const config = get(obj, "spec", "config");
    const configName = str(get(config, "name"));
    return [
      ...head,
      ["class", brokerClassOf(obj)],
      ["address", addressOf(obj)],
      ["config", configName ? link({ apiVersion: str(get(config, "apiVersion")) ?? "v1", kind: str(get(config, "kind")) ?? "ConfigMap" }, configName, str(get(config, "namespace")) ?? ns) : undefined],
      deadLetter,
    ];
  }
  if (sameKind(kind, TRIGGER)) {
    const broker = brokerOf(obj);
    return [
      ...head,
      ["broker", broker ? link({ apiVersion: "eventing.knative.dev/v1", kind: "Broker" }, broker.name, broker.namespace) : undefined],
      ["filter", <FilterField key="f" obj={obj} />],
      ["subscriber", resolved(subscriberOf(obj), subscriberUriOf(obj), ns)],
      deadLetter,
    ];
  }
  if (sameKind(kind, SUBSCRIPTION)) {
    const channel = channelOf(obj);
    return [
      ...head,
      ["channel", channel ? link({ apiVersion: channel.apiVersion ?? "messaging.knative.dev/v1", kind: channel.kind.kind }, channel.name, channel.namespace) : undefined],
      ["subscriber", resolved(subscriberOf(obj), subscriberUriOf(obj), ns)],
      ["reply", resolved(replyOf(obj), replyUriOf(obj), ns)],
      ["deadLetter", str(get(obj, "status", "physicalSubscription", "deadLetterSinkUri"))],
    ];
  }
  if (isChannelKind(kind)) {
    const backing = get(obj, "status", "channel");
    const backingName = str(get(backing, "name"));
    return [
      ...head,
      ["address", addressOf(obj)],
      ["channelTemplate", str(get(obj, "spec", "channelTemplate", "kind"))],
      ["backingChannel", backingName ? link({ apiVersion: str(get(backing, "apiVersion")) ?? "messaging.knative.dev/v1", kind: str(get(backing, "kind")) ?? "InMemoryChannel" }, backingName, ns) : undefined],
      ["subscribers", String(arr(get(obj, "spec", "subscribers")).length)],
      deadLetter,
    ];
  }
  if (sameKind(kind, SEQUENCE) || sameKind(kind, PARALLEL)) {
    const count = sameKind(kind, SEQUENCE) ? stepsOf(obj).length : branchesOf(obj).length;
    return [...head, ["address", addressOf(obj)], [sameKind(kind, SEQUENCE) ? "steps" : "branches", String(count)], ["reply", destinationLink(replyOf(obj), ns)]];
  }
  if (!isSourceKind(kind)) return head;
  const sink: FieldRow = ["sink", resolved(sinkOf(obj), sinkUriOf(obj), ns)];
  if (sameKind(kind, PING_SOURCE)) {
    return [...head, ["schedule", str(get(obj, "spec", "schedule"))], ["timezone", str(get(obj, "spec", "timezone"))], ["contentType", str(get(obj, "spec", "contentType"))], sink];
  }
  if (sameKind(kind, API_SERVER_SOURCE)) {
    return [...head, ["mode", str(get(obj, "spec", "mode"))], ["resources", chips(apiServerResources(obj))], ["serviceAccount", link({ apiVersion: "v1", kind: "ServiceAccount" }, str(get(obj, "spec", "serviceAccountName")), ns)], sink];
  }
  if (sameKind(kind, CONTAINER_SOURCE)) {
    const images = arr(get(obj, "spec", "template", "spec", "containers")).map((c) => str(get(c, "image")));
    return [...head, ["images", chips(images)], sink];
  }
  if (sameKind(kind, SINK_BINDING)) {
    const subject = subjectOf(obj);
    const target = subject.name && subject.kind ? link({ apiVersion: subject.apiVersion ?? "v1", kind: subject.kind }, subject.name, subject.namespace ?? ns) : undefined;
    const selector = subject.selector ? status.selectorText(subject.selector) : undefined;
    return [...head, ["subject", target ?? (subject.kind && selector ? `${subject.kind} ${selector}` : subject.kind)], sink];
  }
  if (sameKind(kind, KAFKA_SOURCE)) {
    return [...head, ["topics", chips(kafkaTopics(obj))], ["bootstrapServers", chips(kafkaServers(obj))], ["consumerGroup", str(get(obj, "spec", "consumerGroup"))], sink];
  }
  return [...head, sink];
}

export function EventingSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const def = eventingKind(objectRef.kind);
  if (!obj || !def) return null;
  const kind = def.kind;
  const phrase = explainEventing(kind, obj);
  const failing = failingCondition(obj);
  const danger = healthOf(obj) === "failed";
  return (
    <>
      <Block id="details:sections.fields" title={t("details:sections.fields", { kind: kind.kind })}>
        {phrase && <p className={danger ? "cm-explain cm-explain--danger" : "cm-explain"}>{t(`knative:eventing.explain.${phrase.key}`, phrase.params ?? {})}</p>}
        {failing?.message && <p className="cm-message">{failing.message}</p>}
        <Fields rows={rowsOf(obj, kind)} labelPrefix={LABELS} />
      </Block>
      <EventPathView clusterId={clusterId} kind={kind} obj={obj} />
    </>
  );
}
