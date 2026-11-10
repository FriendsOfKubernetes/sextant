// The details section `prometheus-operator` on the Prometheus Operator kinds, as Sextant's former built-in section
// (ADR-0100) drew it, without a heading of its own:
//   ServiceMonitor / PodMonitor — the namespaces it looks in and its selector, the Services (Pods) it selects right
//                                 now, whether each endpoint's port name exists on them, and which Prometheus picks
//                                 it up by its selectors ("selects nothing" and "not picked up" said in words);
//   Probe                       — prober, module, targets, who picks it up;
//   PrometheusRule              — groups with their alerting and recording rules, who picks it up;
//   Prometheus / Alertmanager   — readiness from the conditions, replicas, version; a Prometheus's selectors.
// What it lists besides its object is watched as the built-in section's hooks watched it: the Prometheus and
// PrometheusAgent objects the cluster serves (every namespace) while a monitor is shown or a "Picked up by" block is
// open, the Namespaces' labels (metadata only) only when one of them selects namespaces by labels, and the Services
// (Pods) a monitor selects — its selector sent to the API server, in its namespaces (at most `MAX_DETAIL_NAMESPACES`; a
// monitor of every namespace cluster-wide by its selector, unless the selector is empty) — while "Selects now" is open.
// The blocks open and close in Sextant's own memory of details sections. Conditions, events and YAML are Sextant's own
// sections. Read-only.
import { trackObjects, ui, type KubeObject, type ObjectRef, type Sextant, type UiContent, type Watch, type WatchParams } from "@sextant/extension-sdk";
import { ALL_OPEN, block, BlockMemory, errorText, note, redraw, type Blocks } from "./dom";
import { t } from "./i18n";
import {
  ALERTMANAGER,
  arr,
  endpointsOf,
  get,
  isKind,
  MONITORING_KINDS,
  monitorSelector,
  NAMESPACE,
  needsNamespaceLabels,
  num,
  pickedUpBy,
  POD,
  POD_MONITOR,
  podPortNames,
  PROBE,
  PROMETHEUS,
  PROMETHEUS_AGENT,
  PROMETHEUS_RULE,
  ruleGroupsOf,
  selectorText,
  selectorTexts,
  SERVER_TONE,
  serverReadiness,
  SERVICE,
  SERVICE_MONITOR,
  servicePortNames,
  str,
  targetNamespaces,
  labelsOf,
  type KindOf,
  type Labels,
  type TargetNamespaces,
} from "./model";

/** Namespaces a monitor's targets are listed in at most. */
export const MAX_DETAIL_NAMESPACES = 20;
/** Selected objects listed by name at most. */
export const MAX_LISTED_TARGETS = 30;

/** The columns kept on one line, as the built-in details tables' (the others wrap between words). */
const ENDPOINTS_NOWRAP = [true, false, true, false];
const GROUPS_NOWRAP = [false, true, true, true];
const SELECTORS_NOWRAP = [true, false, false];

/** A list watched while it is needed: its objects, whether the first answer came, whether it failed. */
export interface Live {
  items: KubeObject[];
  ready: boolean;
  failed: boolean;
}

/** What Sextant's discovery says of the kinds the section reads: the served Prometheus and PrometheusAgent kinds. */
export interface Served {
  /** `undefined` until Sextant answered (or when it could not, as the built-in view waited). */
  servers?: KindOf[];
}

/** The lists a view uses besides its object, by name. */
export interface Related {
  /** The Prometheus and PrometheusAgent lists, in that order, of the kinds the cluster serves. */
  servers?: (Live | undefined)[];
  namespaces?: Live;
  targets?: Live;
}

const present = (nodes: (Node | null | false | undefined)[]): Node[] => nodes.filter((n): n is Node => Boolean(n));

/** `ui.fields` labelled from `fields.<key>`, or nothing when no row has a value. */
function fieldsOf(rows: readonly (readonly [string, UiContent])[]): HTMLElement | null {
  const list = ui.fields(rows.map(([key, value]) => [t(`fields.${key}`), value] as const));
  return list.childElementCount > 0 ? list : null;
}

/** The kind of `apiVersion` and `kind` as a link names it. */
function kindOf(apiVersion: string, kind: string): KindOf {
  const slash = apiVersion.lastIndexOf("/");
  return { group: slash < 0 ? "" : apiVersion.slice(0, slash), version: slash < 0 ? apiVersion : apiVersion.slice(slash + 1), kind };
}

/** A link to an object's details in Sextant's panel, labelled `namespace/name`; nothing without a name. */
function link(sextant: Sextant, kind: KindOf, name: string | undefined, namespace: string | null, text: string): HTMLElement | null {
  if (!name) return null;
  return ui.objectLink(sextant, { kind, namespace, name }, text);
}

// ---------- Prometheus objects ----------

export interface Prometheuses {
  loading: boolean;
  /** Prometheus and PrometheusAgent objects. */
  servers: KubeObject[];
  namespaceLabels: (name: string) => Labels | undefined;
}

/** The Prometheus objects as the built-in `usePrometheuses` read them. */
export function prometheusesOf(served: Served, related: Related): Prometheuses {
  const lists = served.servers === undefined ? [] : (related.servers ?? []);
  const servers = lists.flatMap((l) => l?.items ?? []);
  const needLabels = needsNamespaceLabels(servers);
  const ns = related.namespaces;
  const labels = new Map<string, Labels>();
  for (const n of ns?.items ?? []) labels.set(n.metadata.name, labelsOf(n));
  const loading = served.servers === undefined || lists.length < served.servers.length || lists.some((l) => !l?.ready) || (needLabels && (!ns || !ns.ready));
  const nsReady = ns !== undefined && ns.ready && !ns.failed;
  return { loading, servers, namespaceLabels: (name) => (nsReady ? labels.get(name) : undefined) };
}

/** Where a monitor looks, once the Prometheus objects that pick it up are known (`ignoreNamespaceSelectors`). */
export function whereOf(kind: { kind: string }, obj: KubeObject, proms: Prometheuses): { where: TargetNamespaces; ignored: boolean } {
  const spec = targetNamespaces(obj);
  if (proms.loading || proms.servers.length === 0) return { where: spec, ignored: false };
  const picked = pickedUpBy(proms.servers, kind, obj, proms.namespaceLabels);
  if (picked.unknown) return { where: spec, ignored: false };
  const where = targetNamespaces(obj, picked.by);
  return { where, ignored: JSON.stringify(where) !== JSON.stringify(spec) };
}

/** Which Prometheus picks the object up, or a warning that none does. */
function pickedUpBody(sextant: Sextant, kind: KindOf, obj: KubeObject, proms: Prometheuses): Node {
  if (proms.loading) return note(t("loading"), "muted");
  if (proms.servers.length === 0) return note(t("pickup.noPrometheus"), "muted");
  const picked = pickedUpBy(proms.servers, kind, obj, proms.namespaceLabels);
  if (picked.by.length > 0)
    return ui.inline(
      picked.by.map((p) => {
        const type = p.apiVersion && p.kind ? kindOf(p.apiVersion, p.kind) : PROMETHEUS;
        return link(sextant, type, p.metadata.name, p.metadata.namespace ?? null, `${p.metadata.namespace}/${p.metadata.name}`);
      }),
    );
  return note(t(picked.unknown ? "pickup.unknown" : "pickup.none"), "warning");
}

const pickedUp = (sextant: Sextant, kind: KindOf, obj: KubeObject, proms: Prometheuses, blocks: Blocks): HTMLElement =>
  block(blocks, "pickup", t("pickup.title"), () => pickedUpBody(sextant, kind, obj, proms));

// ---------- Monitors ----------

/** What a monitor's targets are, as the built-in `useMonitorTargets` told them. */
export type Targets =
  | { status: "loading" }
  /** The selector cannot select anything (an operator the API does not define). */
  | { status: "nothing" }
  /** An empty selector in every namespace: everything, not listed. */
  | { status: "everything" }
  | { status: "tooManyNamespaces"; count: number }
  | { status: "error" }
  | { status: "ready"; objects: KubeObject[] };

/** The watch of a monitor's targets: its selector sent to the API server, in its namespaces; `null` when none is made. */
export function targetsWatch(kind: { group: string; kind: string }, obj: KubeObject, where: TargetNamespaces): Omit<WatchParams, "clusterId"> | null {
  const text = selectorText(monitorSelector(obj));
  if (text === null) return null;
  if (where.type === "list" && where.names.length > MAX_DETAIL_NAMESPACES) return null;
  if (where.type === "any" && text === "") return null;
  return {
    kind: isKind(kind, POD_MONITOR) ? POD : SERVICE,
    ...(where.type === "any" ? {} : { namespaces: where.names }),
    ...(text ? { labelSelector: text } : {}),
  };
}

export function targetsOf(obj: KubeObject, where: TargetNamespaces, live: Live | undefined): Targets {
  const text = selectorText(monitorSelector(obj));
  if (text === null) return { status: "nothing" };
  if (where.type === "list" && where.names.length > MAX_DETAIL_NAMESPACES) return { status: "tooManyNamespaces", count: where.names.length };
  if (where.type === "any" && text === "") return { status: "everything" };
  if (!live || !live.ready) return { status: "loading" };
  if (live.failed) return { status: "error" };
  return { status: "ready", objects: live.items };
}

function targetsBody(sextant: Sextant, kind: KindOf, obj: KubeObject, targets: Targets): UiContent {
  const pods = isKind(kind, POD_MONITOR);
  const what = pods ? "pods" : "services";
  if (targets.status === "loading") return note(t("loading"), "muted");
  if (targets.status === "error") return note(t("targets.error"), "warning");
  if (targets.status === "nothing") return note(t("targets.invalidSelector"), "danger");
  if (targets.status === "everything") return note(t(`targets.everything.${what}`), "muted");
  if (targets.status === "tooManyNamespaces") return note(t("targets.tooMany", { count: targets.count }), "muted");
  const key = (o: KubeObject) => `${o.metadata.namespace}/${o.metadata.name}`;
  const objects = [...targets.objects].sort((a, b) => key(a).localeCompare(key(b)));
  if (objects.length === 0) return note(t(`targets.none.${what}`), "danger");
  const names = objects.map((o) => new Set(pods ? podPortNames(o) : servicePortNames(o)));
  const rows = endpointsOf(obj, kind).map((e) => {
    const found = e.port ? names.filter((s) => s.has(e.port!)).length : undefined;
    const portText = e.port ?? (e.number !== undefined ? String(e.number) : (e.targetPort ?? ""));
    const foundCell =
      found === undefined
        ? ""
        : Object.assign(document.createElement("span"), {
            className: found === 0 ? "promop-bad" : found < objects.length ? "promop-warn" : "",
            textContent: t("targets.portFound", { found, total: objects.length }),
          });
    return [portText, e.path ?? "/metrics", e.interval ?? "", foundCell];
  });
  const shown = objects.slice(0, MAX_LISTED_TARGETS);
  const type = pods ? POD : SERVICE;
  const headers = ["port", "path", "interval", "found"].map((h) => t(`endpoints.${h}`));
  return present([
    Object.assign(document.createElement("p"), { className: "promop-summary", textContent: t(`targets.selected.${what}`, { count: objects.length }) }),
    ui.inline(shown.map((o) => link(sextant, type, o.metadata.name, o.metadata.namespace ?? null, key(o)))),
    objects.length > shown.length && note(t("targets.more", { count: objects.length - shown.length }), "muted"),
    // As the built-in table: none without an endpoint.
    rows.length > 0 && ui.table(headers, rows, { label: t("targets.title"), id: "endpoints", sextant, nowrap: ENDPOINTS_NOWRAP }),
  ]);
}

export function monitorView(sextant: Sextant, kind: KindOf, obj: KubeObject, proms: Prometheuses, related: Related, blocks: Blocks = ALL_OPEN): Node[] {
  const { where, ignored } = whereOf(kind, obj, proms);
  return present([
    fieldsOf([
      ["namespaces", where.type === "any" ? t("anyNamespace") : ui.chips(where.names)],
      ["selector", ui.chips(selectorTexts(get(obj, "spec", "selector"))) ?? t("selectsAll")],
      ["jobLabel", str(get(obj, "spec", "jobLabel"))],
    ]),
    ignored && note(t("ignoredNamespaceSelector"), "muted"),
    block(blocks, "targets", t("targets.title"), () => targetsBody(sextant, kind, obj, targetsOf(obj, where, related.targets))),
    pickedUp(sextant, kind, obj, proms, blocks),
  ]);
}

// ---------- Probes and rules ----------

export function probeView(sextant: Sextant, kind: KindOf, obj: KubeObject, proms: Prometheuses, blocks: Blocks = ALL_OPEN): Node[] {
  const statics = arr(get(obj, "spec", "targets", "staticConfig", "static")).map(String);
  return present([
    fieldsOf([
      ["prober", str(get(obj, "spec", "prober", "url"))],
      ["module", str(get(obj, "spec", "module"))],
      ["interval", str(get(obj, "spec", "interval"))],
      ["staticTargets", ui.chips(statics)],
      ["ingressSelector", ui.chips(selectorTexts(get(obj, "spec", "targets", "ingress", "selector")))],
    ]),
    pickedUp(sextant, kind, obj, proms, blocks),
  ]);
}

export function ruleView(sextant: Sextant, kind: KindOf, obj: KubeObject, proms: Prometheuses, blocks: Blocks = ALL_OPEN): Node[] {
  const groups = ruleGroupsOf(obj);
  const headers = ["name", "interval", "alerts", "records"].map((h) => t(`groups.${h}`));
  const rows = groups.map((g) => [g.name, g.interval ?? "", String(g.alerts), String(g.records)]);
  return [
    block(blocks, "groups", t("groups.title"), () => (groups.length === 0 ? note(t("groups.none"), "muted") : ui.table(headers, rows, { label: t("groups.title"), id: "groups", sextant, nowrap: GROUPS_NOWRAP }))),
    pickedUp(sextant, kind, obj, proms, blocks),
  ];
}

// ---------- Prometheus and Alertmanager ----------

/** A Prometheus's or Alertmanager's state in its tone, the condition's reason and message on hover. */
export function serverStateText(obj: KubeObject): HTMLElement {
  const r = serverReadiness(obj);
  const node = ui.status(t(`state.${r.state}`), SERVER_TONE[r.state]);
  const title = [r.reason, r.message].filter(Boolean).join(": ");
  if (title) node.title = title;
  return node;
}

/** A Prometheus selector in words: none (null), all (empty) or its terms. */
const selectorValue = (value: unknown): UiContent =>
  value === undefined || value === null ? t("selectors.none") : (ui.chips(selectorTexts(value)) ?? t("selectors.all"));

const namespacesValue = (value: unknown): UiContent =>
  value === undefined || value === null ? t("selectors.ownNamespace") : (ui.chips(selectorTexts(value)) ?? t("selectors.allNamespaces"));

const SELECTORS: [label: string, selector: string, namespaces: string][] = [
  ["serviceMonitors", "serviceMonitorSelector", "serviceMonitorNamespaceSelector"],
  ["podMonitors", "podMonitorSelector", "podMonitorNamespaceSelector"],
  ["probes", "probeSelector", "probeNamespaceSelector"],
  ["rules", "ruleSelector", "ruleNamespaceSelector"],
];

export function serverView(sextant: Sextant, kind: KindOf, obj: KubeObject, blocks: Blocks = ALL_OPEN): Node[] {
  const r = serverReadiness(obj);
  const spec = get(obj, "spec");
  const selectors = isKind(kind, PROMETHEUS)
    ? SELECTORS.map(([label, sel, nsSel]) => [t(`selectors.${label}`), selectorValue(get(spec, sel)), namespacesValue(get(spec, nsSel))])
    : [];
  const headers = ["what", "selector", "namespaces"].map((h) => t(`selectors.${h}`));
  return present([
    (r.state === "failed" || r.state === "degraded") && !!r.message && note(r.message, "danger"),
    fieldsOf([
      ["status", serverStateText(obj)],
      ["reason", r.reason],
      ["replicas", t("replicasAvailable", { available: r.available ?? 0, total: r.desired })],
      ["shards", num(get(spec, "shards"))?.toString()],
      ["version", str(get(spec, "version"))],
      ["retention", str(get(spec, "retention"))],
      ["paused", get(spec, "paused") === true ? t("yes") : undefined],
    ]),
    selectors.length > 0 && block(blocks, "selectors", t("selectors.title"), () => ui.table(headers, selectors, { label: t("selectors.title"), id: "selectors", sextant, nowrap: SELECTORS_NOWRAP })),
  ]);
}

// ---------- The section ----------

const SECTION_KINDS = MONITORING_KINDS.map((d) => d.kind);

/** The served kind's version a list is watched at: as Sextant serves it. */
const watchOfKind = (kind: KindOf): Omit<WatchParams, "clusterId"> => ({ kind });

/**
 * What the section watches besides its object: the Prometheus objects (a monitor always, a probe or rule while its
 * "Picked up by" block is open), the Namespaces' labels when one of them selects namespaces by labels, and a monitor's
 * targets while "Selects now" is open. `peek` gives what a watch already holds.
 */
export function relatedWatches(
  kind: { group: string; kind: string },
  obj: KubeObject,
  served: Served,
  peek: (spec: Omit<WatchParams, "clusterId">) => Live | undefined,
  blocks: Pick<Blocks, "isOpen">,
): Record<string, Omit<WatchParams, "clusterId"> | null> {
  const monitor = isKind(kind, SERVICE_MONITOR, POD_MONITOR);
  const wantsServers = monitor || (isKind(kind, PROBE, PROMETHEUS_RULE) && blocks.isOpen("pickup"));
  if (!wantsServers || served.servers === undefined) return {};
  const specs: Record<string, Omit<WatchParams, "clusterId"> | null> = {};
  served.servers.forEach((k, i) => (specs[`server${i}`] = watchOfKind(k)));
  const related: Related = { servers: served.servers.map((k) => peek(watchOfKind(k))) };
  const items = related.servers!.flatMap((l) => l?.items ?? []);
  const namespaces: Omit<WatchParams, "clusterId"> = { kind: NAMESPACE, metadataOnly: true };
  if (needsNamespaceLabels(items)) {
    specs.namespaces = namespaces;
    related.namespaces = peek(namespaces);
  }
  if (monitor && blocks.isOpen("targets")) {
    const { where } = whereOf(kind, obj, prometheusesOf(served, related));
    specs.targets = targetsWatch(kind, obj, where);
  }
  return specs;
}

/** The view of the section for `obj` of `kind`; `null` for a kind it does not show. */
export function sectionView(sextant: Sextant, kind: KindOf, obj: KubeObject, served: Served, related: Related, blocks: Blocks = ALL_OPEN): Node[] | null {
  const proms = prometheusesOf(served, related);
  if (isKind(kind, SERVICE_MONITOR, POD_MONITOR)) return monitorView(sextant, kind, obj, proms, related, blocks);
  if (isKind(kind, PROBE)) return probeView(sextant, kind, obj, proms, blocks);
  if (isKind(kind, PROMETHEUS_RULE)) return ruleView(sextant, kind, obj, proms, blocks);
  if (isKind(kind, PROMETHEUS, ALERTMANAGER)) return serverView(sextant, kind, obj, blocks);
  return null;
}

/** The watches a section holds, by what they watch: started when first wanted, stopped when no longer. */
class Watches {
  private readonly open = new Map<string, { watch: Watch; live: Live }>();
  constructor(
    private readonly sextant: Sextant,
    private readonly changed: () => void,
  ) {}

  peek(spec: Omit<WatchParams, "clusterId">): Live | undefined {
    return this.open.get(JSON.stringify(spec))?.live;
  }

  /** The lists of `specs` (by name), each watched from now on; every other watch stops. */
  want(specs: Record<string, Omit<WatchParams, "clusterId"> | null>): Record<string, Live | undefined> {
    const keep = new Set<string>();
    const related: Record<string, Live | undefined> = {};
    for (const [name, spec] of Object.entries(specs)) {
      if (!spec) continue;
      const key = JSON.stringify(spec);
      keep.add(key);
      related[name] = (this.open.get(key) ?? this.start(key, spec)).live;
    }
    for (const [key, entry] of this.open) {
      if (keep.has(key)) continue;
      this.open.delete(key);
      void entry.watch.unwatch().catch(() => undefined);
    }
    return related;
  }

  private start(key: string, spec: Omit<WatchParams, "clusterId">): { watch: Watch; live: Live } {
    const live: Live = { items: [], ready: false, failed: false };
    const settle = (failed: boolean) => {
      live.ready = true;
      live.failed = failed;
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
    this.want({});
  }
}

/** The Prometheus and PrometheusAgent kinds the cluster serves, at the version it serves them. */
async function servedServers(sextant: Sextant): Promise<KindOf[]> {
  const kinds = await sextant.kinds();
  return [PROMETHEUS, PROMETHEUS_AGENT].flatMap((want) => {
    const found = kinds.find((k) => isKind(k.kindRef, want));
    return found ? [{ group: found.kindRef.group, version: found.kindRef.version, kind: found.kindRef.kind }] : [];
  });
}

/**
 * Starts the details section on the object in the context: read again whenever its resourceVersion changes; what it
 * lists besides watched as the built-in section watched it, and drawn again as they change.
 */
export function startDetails(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  let shownVersion: string | null | undefined;
  let shownRef: string | null = null;
  let reading = 0;
  let object: KubeObject | null = null;
  let kind: ObjectRef["kind"] | null = null;
  let scheduled = false;
  let stopped = false;
  const served: Served = {};
  let askedKinds = false;

  const render = () => {
    if (!object || !kind || stopped) return;
    if (contribution !== "prometheus-operator" || !SECTION_KINDS.some((k) => isKind(kind!, k))) {
      root.replaceChildren(ui.empty(t("common.nothingToShow", { view: contribution })));
      return;
    }
    const specs = relatedWatches(kind, object, served, (spec) => watches.peek(spec), { isOpen: (id) => memory.peek(id) });
    const lives = watches.want(specs);
    const related: Related = {
      servers: (served.servers ?? []).map((_, i) => lives[`server${i}`]),
      namespaces: lives.namespaces,
      targets: lives.targets,
    };
    redraw(root, sectionView(sextant, kind, object, served, related, memory) ?? []);
  };
  const schedule = () => {
    if (scheduled || stopped) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      render();
    });
  };
  const watches = new Watches(sextant, schedule);
  const memory = new BlockMemory(sextant, schedule);

  /** Asks Sextant once which Prometheus kinds the cluster serves; unanswered, the lists wait as the built-in did. */
  const askKinds = () => {
    if (askedKinds) return;
    askedKinds = true;
    servedServers(sextant).then(
      (kinds) => {
        served.servers = kinds;
        schedule();
      },
      () => undefined,
    );
  };

  const read = async (ref: ObjectRef) => {
    const attempt = ++reading;
    try {
      const fresh = await sextant.resources.get({ ref });
      if (attempt !== reading) return;
      object = fresh;
      kind = ref.kind;
      if (isKind(kind, SERVICE_MONITOR, POD_MONITOR, PROBE, PROMETHEUS_RULE)) askKinds();
      render();
    } catch (err) {
      if (attempt === reading) root.replaceChildren(ui.errorState(errorText(err)));
    }
  };

  const follow = () => {
    if (memory.follow()) schedule();
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
      memory.reset();
      root.replaceChildren(ui.loading(t("loading")));
    }
    const version = sextant.context.resourceVersion;
    if (version === shownVersion) return;
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
