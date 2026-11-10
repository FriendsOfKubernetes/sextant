// The details sections of Knative objects (the manifest's `contributes.detailsSections`, one per kind; the selected
// object's kind says which view), as Sextant's former built-in view drew them:
//   Service / Configuration / Route — the state in plain words with the failing condition's message, URL, address,
//                                     latest created and latest ready revision (links), and for a Service or Route the
//                                     traffic split with links to the revisions;
//   Revision                        — the state (scaled to zero, the failing condition), its Configuration and
//                                     Service, actual of desired replicas, routing state, images, concurrency, timeout;
//   DomainMapping                   — the state, URL and the Service it points at;
//   an Eventing kind                — the state, the kind's own fields (a Broker's class, address and dead letter
//                                     sink; a Trigger's Broker, filter in words and subscriber; a Subscription's
//                                     channel, subscriber and reply; a source's sink and what it reads), each
//                                     Destination as a link with the address it resolved to, and the event path
//                                     (path.ts) from the lists of the hub's namespace, watched while that block is open.
// As the built-in section, the view is a block titled with the kind (the section itself has no heading), and an
// Eventing object's event path a block beside it; the blocks open and close with their titles in Sextant's own memory
// of details sections (`context.blocks`, `ui.setBlockOpen`), with the panel's "Expand all" and "Collapse all". Each
// frame reads the shown object again whenever its resourceVersion changes. Conditions, events and YAML are Sextant's
// own sections. Read-only.
import { trackObjects, ui, type KubeObject, type ObjectRef, type Sextant, type UiContent, type Watch, type WatchParams } from "@sextant/extension-sdk";
import { element, errorText, explanation, fieldsOf, formatList, formatParts, health, link, message, refLink, remark } from "./dom";
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
  groupOf,
  isChannelKind,
  isSourceKind,
  KAFKA_SOURCE,
  kafkaServers,
  kafkaTopics,
  PARALLEL,
  PING_SOURCE,
  replyOf,
  replyUriOf,
  selectorText,
  SEQUENCE,
  SINK_BINDING,
  sinkOf,
  sinkUriOf,
  SOURCE_KINDS,
  stepsOf,
  subjectOf,
  subscriberOf,
  subscriberUriOf,
  SUBSCRIPTION,
  TRIGGER,
  triggerFilter,
  type Destination,
  type FilterTerm,
} from "./eventing";
import { t } from "./i18n";
import {
  arr,
  CONFIGURATION,
  DOMAIN_MAPPING,
  explain,
  failingCondition,
  get,
  healthOf,
  HEALTH_TONE,
  KSERVICE,
  knativeKind,
  mappingRef,
  REVISION,
  revisionFields,
  ROUTE,
  sameKind,
  serviceFields,
  str,
  trafficSplit,
  type KindOf,
  type KindRef,
} from "./model";
import { eventPath, pathNeeds, type PathLists, type PathNeeds, type PathNode } from "./path";

const present = (nodes: (Node | null | false | undefined)[]): Node[] => nodes.filter((n): n is Node => Boolean(n));

// ---------- Blocks that keep their state ----------

/**
 * Which blocks are open, and where a toggle goes: Sextant's own memory of details sections (`context.blocks`, written
 * by `ui.setBlockOpen`), kept per kind as Settings → Appearance says, with the panel's "Expand all" and "Collapse
 * all" — where the built-in section's blocks were kept.
 */
export interface BlockMemory {
  isOpen(block: string): boolean;
  setOpen(block: string, open: boolean): void;
}

/** Blocks that are all open and remember nothing. */
export const OPEN_BLOCKS: BlockMemory = { isOpen: () => true, setOpen: () => undefined };

/** The blocks' memory of the frame's context; every block open by default, as the built-in's were. */
export function sextantBlocks(sextant: Sextant): BlockMemory {
  return {
    isOpen: (id) => ui.blockOpen(sextant.context.blocks, id, true),
    setOpen: (id, open) => void sextant.ui.setBlockOpen(id, open).catch(() => undefined),
  };
}

/** A titled block as the built-in view's: open as Sextant remembers it, closable with its title. */
function block(memory: BlockMemory, id: string, title: string, content: UiContent): HTMLElement {
  const node = ui.block(title, content, { collapsible: true, collapsed: !memory.isOpen(id), onToggle: (open) => memory.setOpen(id, open) });
  node.dataset.block = id;
  return node;
}

// ---------- Knative Serving ----------

/** Why the object is (not) ready and the failing condition's message, as the built-in view showed them. */
function servingHead(kind: KindOf, obj: KubeObject): Node[] {
  const phrase = explain(kind, obj);
  return present([
    phrase && explanation(t(`explain.${phrase.key}`, phrase.params ?? {}), healthOf(obj) === "failed"),
    message(failingCondition(obj)?.message),
  ]);
}

/** The traffic split of a Service or Route, with links to the revisions. */
export function trafficTable(sextant: Sextant, obj: KubeObject, memory: BlockMemory = OPEN_BLOCKS): HTMLElement | null {
  const { targets, asked } = trafficSplit(obj);
  const ns = obj.metadata.namespace ?? null;
  if (targets.length === 0) return null;
  const latestReady = serviceFields(obj).latestReady;
  const rows = targets.map((target) => [
    target.revisionName
      ? link(sextant, REVISION, target.revisionName, ns)
      : target.latestRevision
        ? t("traffic.latestReady", { revision: latestReady ?? "" })
        : (target.configurationName ?? ""),
    target.tag ?? "",
    target.percent === undefined ? "" : t("traffic.percent", { percent: target.percent }),
    target.latestRevision ? t("traffic.followsLatest") : "",
    target.url ?? "",
  ]);
  const headers = ["revision", "tag", "share", "latest", "url"].map((h) => t(`traffic.${h}`));
  const title = asked ? t("traffic.askedTitle") : t("traffic.title");
  return block(memory, asked ? "askedTraffic" : "traffic", title, ui.table(headers, rows, { label: title, id: "traffic", sextant, nowrap: [true, true, true, false, false] }));
}

function serviceView(sextant: Sextant, kind: KindRef, obj: KubeObject, memory: BlockMemory): Node[] {
  const f = serviceFields(obj);
  const ns = obj.metadata.namespace ?? null;
  return present([
    ...servingHead(kind, obj),
    fieldsOf("fields", [
      ["status", health(obj)],
      ["url", f.url],
      ["address", f.address],
      ["latestCreated", link(sextant, REVISION, f.latestCreated, ns)],
      ["latestReady", link(sextant, REVISION, f.latestReady, ns)],
    ]),
    (sameKind(kind, KSERVICE) || sameKind(kind, ROUTE)) && trafficTable(sextant, obj, memory),
  ]);
}

function revisionView(sextant: Sextant, obj: KubeObject): Node[] {
  const f = revisionFields(obj);
  const ns = obj.metadata.namespace ?? null;
  return present([
    ...servingHead(REVISION, obj),
    fieldsOf("fields", [
      ["status", health(obj)],
      ["configuration", link(sextant, CONFIGURATION, f.configuration, ns)],
      ["service", link(sextant, KSERVICE, f.service, ns)],
      ["generation", f.generation],
      ["replicas", f.actualReplicas === undefined ? undefined : t("replicas", { actual: f.actualReplicas, desired: f.desiredReplicas ?? "?" })],
      ["routingState", f.routingState],
      ["images", ui.chips(f.images)],
      ["concurrency", f.concurrency === undefined ? undefined : f.concurrency === 0 ? t("unlimited") : String(f.concurrency)],
      ["timeout", f.timeoutSeconds === undefined ? undefined : t("timeoutSeconds", { seconds: f.timeoutSeconds })],
    ]),
  ]);
}

function domainMappingView(sextant: Sextant, obj: KubeObject): Node[] {
  const ref = mappingRef(obj);
  const ns = ref.namespace ?? obj.metadata.namespace ?? null;
  const target = ref.kind === "Service" && ref.apiVersion?.startsWith("serving.knative.dev/") ? link(sextant, KSERVICE, ref.name, ns) : ref.name;
  return present([
    ...servingHead(DOMAIN_MAPPING, obj),
    fieldsOf("fields", [
      ["status", health(obj)],
      ["url", serviceFields(obj).url],
      ["target", target],
    ]),
  ]);
}

/** The block titled with the kind, as the built-in section's. */
export function servingView(sextant: Sextant, kind: KindRef, obj: KubeObject, memory: BlockMemory = OPEN_BLOCKS): Node[] {
  const content = sameKind(kind, REVISION)
    ? revisionView(sextant, obj)
    : sameKind(kind, DOMAIN_MAPPING)
      ? domainMappingView(sextant, obj)
      : serviceView(sextant, kind, obj, memory);
  return [block(memory, "fields", kind.kind, content)];
}

// ---------- Knative Eventing ----------

/** One filter term in words. */
export function filterWords(term: FilterTerm): string {
  switch (term.op) {
    case "exact":
    case "prefix":
    case "suffix":
      return t(`eventing.filter.${term.op}`, { attribute: term.attribute, value: term.value });
    case "anyValue":
      return t("eventing.filter.anyValue", { attribute: term.attribute });
    case "cesql":
      return t("eventing.filter.cesql", { expression: term.expression });
    case "all":
    case "any":
    case "not":
      return t(`eventing.filter.${term.op}`, { terms: formatList(term.terms.map(filterWords)) });
  }
}

/** A Destination as a link to the object it names (any kind), else its URI. */
export function destinationLink(sextant: Sextant, dest: Destination | undefined, namespace: string | null): Node | string | null {
  if (!dest) return null;
  const ref = dest.ref;
  if (ref?.name && ref.kind) return refLink(sextant, { apiVersion: ref.apiVersion ?? "v1", kind: ref.kind }, ref.name, ref.namespace ?? namespace);
  return dest.uri ?? null;
}

/** A destination and, beside it, the address it resolved to. */
function resolved(sextant: Sextant, dest: Destination | undefined, uri: string | undefined, ns: string | null): UiContent {
  const target = destinationLink(sextant, dest, ns);
  if (!target) return uri;
  if (!uri || uri === dest?.uri) return target;
  return element("span", { className: "kn-resolved" }, target, element("span", { className: "kn-chain__extra", textContent: uri }));
}

function filterField(obj: KubeObject): Node {
  const { terms, legacyIgnored } = triggerFilter(obj);
  const list =
    terms.length === 0
      ? element("span", { textContent: t("eventing.filter.none") })
      : element("ul", { className: "kn-list" }, ...terms.map((term) => element("li", { textContent: filterWords(term) })));
  const out = element("div", {}, list);
  if (legacyIgnored) out.append(element("p", { className: "kn-message", textContent: t("eventing.filter.legacyIgnored") }));
  return out;
}

type Row = readonly [string, UiContent];

function eventingRows(sextant: Sextant, obj: KubeObject, kind: KindOf): Row[] {
  const ns = obj.metadata.namespace ?? null;
  const head: Row[] = [["status", health(obj)]];
  const deadLetter: Row = ["deadLetter", deadLetterUriOf(obj)];
  if (sameKind(kind, BROKER)) {
    const config = get(obj, "spec", "config");
    const configName = str(get(config, "name"));
    return [
      ...head,
      ["class", brokerClassOf(obj)],
      ["address", addressOf(obj)],
      ["config", configName ? refLink(sextant, { apiVersion: str(get(config, "apiVersion")) ?? "v1", kind: str(get(config, "kind")) ?? "ConfigMap" }, configName, str(get(config, "namespace")) ?? ns) : undefined],
      deadLetter,
    ];
  }
  if (sameKind(kind, TRIGGER)) {
    const broker = brokerOf(obj);
    return [
      ...head,
      ["broker", broker ? link(sextant, BROKER, broker.name, broker.namespace) : undefined],
      ["filter", filterField(obj)],
      ["subscriber", resolved(sextant, subscriberOf(obj), subscriberUriOf(obj), ns)],
      deadLetter,
    ];
  }
  if (sameKind(kind, SUBSCRIPTION)) {
    const channel = channelOf(obj);
    return [
      ...head,
      ["channel", channel ? refLink(sextant, { apiVersion: channel.apiVersion ?? "messaging.knative.dev/v1", kind: channel.kind.kind }, channel.name, channel.namespace) : undefined],
      ["subscriber", resolved(sextant, subscriberOf(obj), subscriberUriOf(obj), ns)],
      ["reply", resolved(sextant, replyOf(obj), replyUriOf(obj), ns)],
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
      [
        "backingChannel",
        backingName
          ? refLink(sextant, { apiVersion: str(get(backing, "apiVersion")) ?? "messaging.knative.dev/v1", kind: str(get(backing, "kind")) ?? "InMemoryChannel" }, backingName, ns)
          : undefined,
      ],
      ["subscribers", String(arr(get(obj, "spec", "subscribers")).length)],
      deadLetter,
    ];
  }
  if (sameKind(kind, SEQUENCE)) return [...head, ["address", addressOf(obj)], ["steps", String(stepsOf(obj).length)], ["reply", destinationLink(sextant, replyOf(obj), ns)]];
  if (sameKind(kind, PARALLEL)) return [...head, ["address", addressOf(obj)], ["branches", String(branchesOf(obj).length)], ["reply", destinationLink(sextant, replyOf(obj), ns)]];
  if (!isSourceKind(kind)) return head;
  const sink: Row = ["sink", resolved(sextant, sinkOf(obj), sinkUriOf(obj), ns)];
  if (sameKind(kind, PING_SOURCE)) {
    return [...head, ["schedule", str(get(obj, "spec", "schedule"))], ["timezone", str(get(obj, "spec", "timezone"))], ["contentType", str(get(obj, "spec", "contentType"))], sink];
  }
  if (sameKind(kind, API_SERVER_SOURCE)) {
    return [
      ...head,
      ["mode", str(get(obj, "spec", "mode"))],
      ["resources", ui.chips(apiServerResources(obj))],
      ["serviceAccount", refLink(sextant, { apiVersion: "v1", kind: "ServiceAccount" }, str(get(obj, "spec", "serviceAccountName")), ns)],
      sink,
    ];
  }
  if (sameKind(kind, CONTAINER_SOURCE)) {
    const images = arr(get(obj, "spec", "template", "spec", "containers")).map((c) => str(get(c, "image")));
    return [...head, ["images", ui.chips(images)], sink];
  }
  if (sameKind(kind, SINK_BINDING)) {
    const subject = subjectOf(obj);
    const target = subject.name && subject.kind ? refLink(sextant, { apiVersion: subject.apiVersion ?? "v1", kind: subject.kind }, subject.name, subject.namespace ?? ns) : undefined;
    const selector = subject.selector ? selectorText(subject.selector) : undefined;
    return [...head, ["subject", target ?? (subject.kind && selector ? `${subject.kind} ${selector}` : subject.kind)], sink];
  }
  if (sameKind(kind, KAFKA_SOURCE)) {
    return [...head, ["topics", ui.chips(kafkaTopics(obj))], ["bootstrapServers", ui.chips(kafkaServers(obj))], ["consumerGroup", str(get(obj, "spec", "consumerGroup"))], sink];
  }
  return [...head, sink];
}

/** Roles whose label is shown before the kind (a hub, Trigger, Subscription or source says what it is by its kind). */
const LABELLED = new Set(["sink", "subscriber", "reply", "filter"]);

const kindLabel = (text: string) => element("span", { className: "kn-chain__kind", textContent: text });
const extra = (text: string) => element("span", { className: "kn-chain__extra", textContent: text });

function nodeItem(sextant: Sextant, node: PathNode, lists: PathLists): HTMLElement {
  const state = node.obj ? healthOf(node.obj) : undefined;
  const name = node.name
    ? node.current
      ? element("strong", { textContent: node.name })
      : node.kind
        ? refLink(sextant, { apiVersion: node.apiVersion ?? "v1", kind: node.kind }, node.name, node.namespace ?? null)
        : node.name
    : null;
  const nodeKind = { group: groupOf(node.apiVersion), kind: node.kind ?? "" };
  let empty: HTMLElement | null = null;
  if (node.children.length === 0 && node.kind) {
    if (sameKind(nodeKind, BROKER) && lists.triggers) empty = remark(t("eventing.path.noTriggers"));
    else if (isChannelKind(nodeKind) && lists.subscriptions) empty = remark(t("eventing.path.noSubscriptions"));
  }
  const filter = node.filter ? (node.filter.length === 0 ? t("eventing.filter.none") : formatParts(node.filter.map(filterWords))) : undefined;
  const row = element(
    "span",
    { className: "kn-chain__row" },
    node.role === "step" && kindLabel(t("eventing.path.step", { index: node.index ?? 0 })),
    node.role === "branch" && element("span", { textContent: t("eventing.path.branch", { index: node.index ?? 0 }) }),
    LABELLED.has(node.role) && kindLabel(t(`eventing.path.role.${node.role}`)),
    node.kind ? kindLabel(node.kind) : null,
    name,
    state ? ui.status(t(`health.${state}`), HEALTH_TONE[state]) : null,
    filter ? extra(filter) : null,
    node.uri ? extra(node.uri) : null,
  );
  const item = element("li", { className: "kn-chain__item" }, row, empty);
  if (node.current) item.setAttribute("aria-current", "true");
  if (node.children.length > 0) {
    const list = element("ul", {}, ...node.children.map((child) => nodeItem(sextant, child, lists)));
    if (node.more) list.append(element("li", { className: "kn-chain__item kn-muted", textContent: t("eventing.path.more", { count: node.more }) }));
    item.append(list);
  }
  return item;
}

/** The "Event path" block: the sources that send to the hub, the hub, its Triggers or Subscriptions and their subscribers. */
export function eventPathView(sextant: Sextant, kind: KindRef, obj: KubeObject, lists: PathLists, loading: boolean, memory: BlockMemory = OPEN_BLOCKS): HTMLElement | null {
  const path = eventPath(kind, obj, lists);
  if (!path) return null;
  const title = t("eventing.path.title");
  const tree = element("ul", { className: "kn-chain" }, nodeItem(sextant, path.root, lists));
  tree.setAttribute("aria-label", title);
  const from = path.from;
  return block(
    memory,
    "eventPath",
    title,
    [
      loading && remark(t("eventing.path.loading")),
      from &&
        from.length > 0 && [
          remark(t("eventing.path.from")),
          element(
            "ul",
            { className: "kn-chain" },
            ...from.map((node) => nodeItem(sextant, node, lists)),
            path.fromMore ? element("li", { className: "kn-chain__item kn-muted", textContent: t("eventing.path.more", { count: path.fromMore }) }) : null,
          ),
        ],
      from && from.length === 0 && remark(t("eventing.path.noSources")),
      tree,
    ],
  );
}

/** The block titled with the kind and, beside it, the event path, as the built-in section's. */
export function eventingView(sextant: Sextant, kind: KindRef, obj: KubeObject, lists: PathLists, loading: boolean, memory: BlockMemory = OPEN_BLOCKS): Node[] {
  const phrase = explainEventing(kind, obj);
  const content = present([
    phrase && explanation(t(`eventing.explain.${phrase.key}`, phrase.params ?? {}), healthOf(obj) === "failed"),
    message(failingCondition(obj)?.message),
    fieldsOf("eventing.fields", eventingRows(sextant, obj, kind)),
  ]);
  return present([block(memory, "fields", kind.kind, content), eventPathView(sextant, kind, obj, lists, loading, memory)]);
}

// ---------- The lists of the event path ----------

/** A list watched while the event path shows. */
interface Listed {
  items: KubeObject[];
  /** The first answer came. */
  loaded: boolean;
  /** Not readable: what it holds is not known. */
  error: boolean;
}

const kindKey = (kind: KindOf) => `${kind.group}/${kind.kind}`;

/**
 * The watches the event path holds, by what they watch: started when first wanted, stopped when no longer. A kind the
 * cluster does not serve is never watched: its list is empty.
 */
class Watches {
  private readonly open = new Map<string, { watch: Watch; live: Listed }>();
  constructor(
    private readonly sextant: Sextant,
    private readonly changed: () => void,
  ) {}

  /** The lists of `kinds` in `namespace`, each watched from now on; every other watch stops. */
  want(namespace: string | undefined, kinds: readonly KindRef[], served: Map<string, KindRef> | null | "unknown"): Map<string, Listed> {
    const keep = new Set<string>();
    const out = new Map<string, Listed>();
    for (const kind of namespace === undefined || served === null ? [] : kinds) {
      const watched = served === "unknown" ? kind : served?.get(kindKey(kind));
      if (!watched) {
        out.set(kindKey(kind), { items: [], loaded: true, error: false });
        continue;
      }
      const spec: Omit<WatchParams, "clusterId"> = { kind: watched, namespaces: [namespace!] };
      const key = JSON.stringify(spec);
      keep.add(key);
      out.set(kindKey(kind), (this.open.get(key) ?? this.start(key, spec)).live);
    }
    for (const [key, entry] of this.open) {
      if (keep.has(key)) continue;
      this.open.delete(key);
      void entry.watch.unwatch().catch(() => undefined);
    }
    return out;
  }

  private start(key: string, spec: Omit<WatchParams, "clusterId">): { watch: Watch; live: Listed } {
    const live: Listed = { items: [], loaded: false, error: false };
    const settle = (error: boolean) => {
      live.loaded = true;
      live.error = error;
      this.changed();
    };
    const watch = this.sextant.resources.watch(spec, {
      onUpdate: trackObjects(
        (items) => {
          live.items = items;
          settle(false);
        },
        (other) => {
          if (other.type === "error" || other.type === "forbidden") settle(true);
        },
      ),
      onError: () => settle(true),
    });
    watch.started.catch(() => undefined);
    const entry = { watch, live };
    this.open.set(key, entry);
    return entry;
  }

  stop(): void {
    this.want(undefined, [], "unknown");
  }
}

/** The kinds the path of `needs` lists. */
function neededKinds(needs: PathNeeds | undefined): KindRef[] {
  if (!needs) return [];
  return [...(needs.brokers ? [BROKER] : []), ...(needs.triggers ? [TRIGGER] : []), ...(needs.subscriptions ? [SUBSCRIPTION] : []), ...(needs.sources ? SOURCE_KINDS : [])];
}

/** The path's lists from the watched ones: a list not read (yet) is `undefined`, as the built-in view's. */
function pathLists(needs: PathNeeds | undefined, listed: Map<string, Listed>): { lists: PathLists; loading: boolean } {
  const items = (kind: KindRef) => {
    const l = listed.get(kindKey(kind));
    return l && l.loaded && !l.error ? l.items : undefined;
  };
  const sources = needs?.sources ? SOURCE_KINDS.map((kind) => ({ kind, items: items(kind) })) : undefined;
  const lists: PathLists = {
    brokers: needs?.brokers ? items(BROKER) : undefined,
    triggers: needs?.triggers ? items(TRIGGER) : undefined,
    subscriptions: needs?.subscriptions ? items(SUBSCRIPTION) : undefined,
    sources: sources?.every((s) => s.items !== undefined) ? sources.map((s) => ({ kind: s.kind, items: s.items! })) : undefined,
  };
  const loading = neededKinds(needs).some((kind) => {
    const l = listed.get(kindKey(kind));
    return !l || !l.loaded;
  });
  return { lists, loading };
}

// ---------- The section ----------

/**
 * Starts the details section on the object in the context: read again whenever its resourceVersion changes; the lists
 * of an Eventing object's path watched while its block is open, and drawn again as they change.
 */
export function startDetails(sextant: Sextant, root: HTMLElement): () => void {
  let shownVersion: string | null | undefined;
  let shownRef: string | null = null;
  let reading = 0;
  let object: KubeObject | null = null;
  let kind: KindRef | null = null;
  let scheduled = false;
  let stopped = false;
  // The kinds the cluster serves, of those the extension may read: `null` until known, "unknown" when not readable.
  let served: Map<string, KindRef> | null | "unknown" = null;
  let askedKinds = false;
  // How the drawn blocks show now (each toggle included): a change of Sextant's memory that differs draws them again.
  const remembered = sextantBlocks(sextant);
  const shownBlocks = new Map<string, boolean>();
  // A toggle of this frame until Sextant's memory tells it back (the next change of `context.blocks`): the event path
  // is drawn again at once.
  const blocksNow = () => JSON.stringify(sextant.context.blocks ?? {});
  const pending = new Map<string, { open: boolean; before: string }>();
  const openNow = (id: string) => {
    const choice = pending.get(id);
    if (choice && choice.before === blocksNow()) return choice.open;
    pending.delete(id);
    return remembered.isOpen(id);
  };
  const memory: BlockMemory = {
    isOpen: (id) => {
      const open = openNow(id);
      shownBlocks.set(id, open);
      return open;
    },
    setOpen: (id, open) => {
      shownBlocks.set(id, open);
      pending.set(id, { open, before: blocksNow() });
      remembered.setOpen(id, open);
      // The event path watches its lists only while open.
      if (id === "eventPath") schedule();
    },
  };

  /** Draws `nodes`, keeping the focus on a block's toggle that was drawn again. */
  const show = (nodes: Node[]) => {
    const focused = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : null;
    const focusedBlock = focused?.classList.contains("sx-block__toggle") ? focused.closest<HTMLElement>("[data-block]")?.dataset.block : undefined;
    root.replaceChildren(...nodes);
    if (focusedBlock) root.querySelector<HTMLElement>(`[data-block="${focusedBlock}"] .sx-block__toggle`)?.focus();
  };

  const render = () => {
    if (!object || !kind || stopped) return;
    shownBlocks.clear();
    if (knativeKind(kind)) {
      show(servingView(sextant, kind, object, memory));
      return;
    }
    if (!eventingKind(kind)) {
      root.replaceChildren(ui.empty(t("common.nothingToShow", { view: kind.kind })));
      return;
    }
    const needs = pathNeeds(kind, object);
    const open = needs !== undefined && memory.isOpen("eventPath");
    if (open && !askedKinds) {
      askedKinds = true;
      sextant
        .kinds()
        .then((kinds) => new Map(kinds.map((k) => [kindKey(k.kindRef), k.kindRef] as const)))
        .catch(() => "unknown" as const)
        .then((known) => {
          served = known;
          schedule();
        });
    }
    const listed = watches.want(open ? needs?.namespace : undefined, open ? neededKinds(needs) : [], served);
    const { lists, loading } = open ? pathLists(needs, listed) : { lists: {}, loading: false };
    show(eventingView(sextant, kind, object, lists, loading, memory));
  };
  function schedule() {
    if (scheduled || stopped) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      render();
    });
  }
  const watches = new Watches(sextant, schedule);

  const read = async (ref: ObjectRef) => {
    const attempt = ++reading;
    try {
      const fresh = await sextant.resources.get({ ref });
      if (attempt !== reading) return;
      object = fresh;
      kind = ref.kind;
      render();
    } catch (err) {
      if (attempt === reading) root.replaceChildren(ui.errorState(errorText(err)));
    }
  };

  const follow = () => {
    const ref = sextant.context.selection[0];
    if (!ref) {
      root.replaceChildren(ui.empty(t("common.nothingSelected")));
      return;
    }
    const key = JSON.stringify([ref.kind.group, ref.kind.kind, ref.namespace, ref.name]);
    if (key !== shownRef) {
      shownRef = key;
      shownVersion = undefined;
      object = null;
      watches.stop();
      root.replaceChildren(ui.loading(t("loading")));
    }
    const version = sextant.context.resourceVersion;
    if (version === shownVersion) {
      // The panel's "Expand all" or "Collapse all", or a choice made elsewhere.
      if (object && [...shownBlocks].some(([id, open]) => openNow(id) !== open)) render();
      return;
    }
    shownVersion = version;
    void read(ref);
  };
  follow();
  const stopFollow = sextant.onContextChange(follow);
  return () => {
    stopped = true;
    stopFollow();
    watches.stop();
  };
}
