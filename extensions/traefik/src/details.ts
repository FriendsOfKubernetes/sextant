// The details section `traefik` (the manifest's `contributes.detailsSections`) on every Traefik kind of both groups,
// untitled at the built-in view's place (order 20, in place of the generic fields, before the conditions), drawn as the
// built-in section drew it (ADR-0108): one block titled with the kind. Traefik writes no status, so the view opens
// with what can be judged — whether the objects its references name exist — and says why one breaks the object or
// cannot be judged. Where a cluster serves both groups, it says when the other group holds an object of the same name
// (Traefik v3 reads only `traefik.io`). Then per kind:
//   IngressRoute(TCP/UDP) — entry points, ingress class, parents, TLS (Secret, options, store, resolver, domains) and
//                           "Routes": match, priority, middlewares and services, each a link;
//   TraefikService        — its strategy and the services it sends to (weights, mirror percentages, fallback);
//   Middleware            — its type and, for a chain, the middlewares in order;
//   TLSOption / TLSStore / ServersTransport — their main settings;
// and "References": every reference with what it finds.
//
// The lists the references are judged with are watched only while the block is open and only for this object: each
// Traefik kind the references name (in `traefik.io` where served, else in `traefik.containo.us`; both where both
// serve it), in the namespaces they name, metadata only, at most 5000 objects as the built-in store kept; Services
// there, metadata only; the other group's object of the same name; and the Secrets the object names — one metadata-only
// list of their namespaces, the only Secrets ever listed (ADR-0108). Every list but the Secrets is waited for
// ("Checking…"), as the built-in store was. Read-only.
import { trackObjects, ui, type KindRef, type KubeObject, type ObjectRef, type ResourceKind, type Sextant, type UiContent, type Watch, type WatchParams } from "@sextant/extension-sdk";
import { block, BlockMemory, errorText, note, redraw, type Blocks } from "./dom";
import { t } from "./i18n";
import {
  breaks,
  HEALTH_TONE,
  isRouteKind,
  isRouteTlsSecret,
  isTraefik,
  judge,
  LEGACY_GROUP,
  listsFor,
  lookupOf,
  listHas,
  middlewareRefs,
  middlewareType,
  MIDDLEWARE,
  nameKey,
  otherGroup,
  routeSpec,
  SERVERS_TRANSPORT,
  SERVERS_TRANSPORT_TCP,
  STATE_TONE,
  TLS_OPTION,
  TLS_STORE,
  TRAEFIK_GROUP,
  TRAEFIK_GROUPS,
  TRAEFIK_SERVICE,
  traefikKind,
  traefikServiceRefs,
  traefikServiceType,
  get,
  str,
  type Health,
  type Judgement,
  type NameList,
  type Ref,
  type RefCheck,
  type Route,
  type Served,
} from "./model";

/** Objects a list of one Traefik kind keeps at most, as the built-in store's watches. */
export const MAX_OBJECTS = 5000;
/** The blocks' ids in Sextant's memory of details sections. */
export const FIELDS_BLOCK = "fields";
export const ROUTES_BLOCK = "routes";
export const REFS_BLOCK = "refs";

// ---------- pieces ----------

/** `ui.fields` labelled from `fields.<key>`; nothing when every row is empty, as the built-in `Fields`. */
function fieldsOf(rows: readonly (readonly [string, UiContent])[]): HTMLElement | null {
  const shown = rows.filter(([, value]) => value !== null && value !== undefined && value !== false && value !== "");
  return shown.length > 0 ? ui.fields(shown.map(([key, value]) => [t(`fields.${key}`), value] as const)) : null;
}

/** Several nodes in a wrapping row; nothing when all are empty, as the built-in `inline`. */
function inlineOf(items: readonly UiContent[]): HTMLElement | null {
  const list = items.filter((i) => i !== null && i !== undefined && i !== false && i !== "");
  return list.length > 0 ? ui.inline(list) : null;
}

const muted = (text: string) => note(text, "muted");

/** A link to an object's details in Sextant's panel, named as Sextant's own links are. */
function link(sextant: Sextant, kind: KindRef, name: string, namespace: string | null, label = name): HTMLElement {
  const button = ui.objectLink(sextant, { kind, namespace, name }, label);
  button.setAttribute("aria-label", t("openObject", { kind: kind.kind, name }));
  return button;
}

/** The kind a reference names, in the group of the object it is in. */
function refType(ref: Ref, group: string): KindRef {
  if (ref.kind === "Service") return { group: "", version: "v1", kind: "Service" };
  if (ref.kind === "Secret") return { group: "", version: "v1", kind: "Secret" };
  return { group, version: "v1alpha1", kind: ref.kind };
}

/** A reference as a link (another provider's object as its name only). */
function refLink(sextant: Sextant, ref: Ref, group: string): UiContent {
  if (ref.provider) return `${ref.name}@${ref.provider}`;
  return link(sextant, refType(ref, group), ref.name, ref.namespace, ref.crossNamespace ? `${ref.namespace}/${ref.name}` : ref.name);
}

const portText = (ref: Ref) => (ref.port === undefined ? "" : `:${ref.port}`);

function serviceCell(sextant: Sextant, ref: Ref, group: string): HTMLElement {
  const extra = ref.weight === undefined ? "" : t(ref.place === "mirror" ? "values.percent" : "values.weight", { value: ref.weight });
  const span = document.createElement("span");
  const target = refLink(sextant, ref, group);
  span.append(typeof target === "string" ? target : (target as Node), `${portText(ref)}${extra ? ` ${extra}` : ""}`);
  return span;
}

const healthText = (health: Health) => ui.status(t(`health.${health}`), HEALTH_TONE[health]);

// ---------- what can be judged ----------

/** What can be judged without a status, in plain words. */
function judged(judgement: Judgement): Node[] {
  const { health, checks, issues } = judgement;
  const broken = checks.filter(breaks);
  const tlsMissing = checks.find((c) => isRouteTlsSecret(c.ref) && c.state === "missing");
  const nodes: (Node | null)[] = [
    muted(t("explain.noStatus")),
    health === "failed" && broken.length > 0 ? note(t("explain.broken", { count: broken.length }), "danger") : null,
    ...issues.map((i) => note(t(`explain.${i.type}`, { route: i.route + 1, kind: i.value ?? "" }), "danger")),
    tlsMissing ? note(t("explain.tlsSecretMissing", { name: tlsMissing.ref.name }), "warning") : null,
    checks.some((c) => c.state === "crossNamespace") ? note(t("explain.crossNamespace"), "warning") : null,
    checks.some((c) => c.state === "otherProvider") ? note(t("explain.otherProvider"), "warning") : null,
    checks.some((c) => c.state === "unknown") ? note(t("explain.unknown"), "warning") : null,
    checks.some((c) => c.state === "legacyOnly") ? note(t("explain.legacyOnly"), "warning") : null,
    checks.some((c) => c.legacyToo) ? note(t("explain.legacyToo"), "warning") : null,
  ];
  return nodes.filter((n): n is Node => n !== null);
}

/** The other group holds an object of the same kind and name (the cluster serves both groups). */
function twinNote(kind: KindRef, twin: boolean | undefined): Node | null {
  if (kind.group === TRAEFIK_GROUP) return twin ? note(t("explain.legacyTwin", { kind: kind.kind }), "warning") : null;
  if (kind.group !== LEGACY_GROUP || twin === undefined) return null;
  return note(twin ? t("explain.ioTwin", { kind: kind.kind }) : t("explain.legacyIgnored"), "warning");
}

/** Every reference of the object with what it finds. */
function referencesTable(sextant: Sextant, blocks: Blocks, checks: readonly RefCheck[], group: string): HTMLElement | null {
  if (checks.length === 0) return null;
  const rows = checks.map((c) => [
    c.ref.kind,
    refLink(sextant, c.ref, group),
    t(`place.${c.ref.place}`, { route: (c.ref.route ?? 0) + 1 }),
    ui.status(t(`refState.${c.state}`, { kind: c.ref.badKind ?? "" }), STATE_TONE[c.state]),
  ]);
  const headers = [t("refs.kind"), t("refs.name"), t("refs.where"), t("refs.state")];
  return block(blocks, REFS_BLOCK, t("refs.title"), () => ui.table(headers, rows, { label: t("refs.title"), id: "references", sextant, nowrap: [true, false, false, false] }));
}

// ---------- per kind ----------

function routesTable(sextant: Sextant, blocks: Blocks, routes: readonly Route[], group: string): HTMLElement | null {
  if (routes.length === 0) return null;
  const rows = routes.map((r) => [
    String(r.index + 1),
    r.match ? Object.assign(document.createElement("code"), { textContent: r.match }) : "",
    r.priority === undefined ? "" : String(r.priority),
    inlineOf(r.middlewares.map((m) => refLink(sextant, m, group))),
    inlineOf(r.services.map((s) => serviceCell(sextant, s, group))),
  ]);
  const headers = [t("routes.number"), t("routes.match"), t("routes.priority"), t("routes.middlewares"), t("routes.services")];
  return block(blocks, ROUTES_BLOCK, t("routes.title"), () => ui.table(headers, rows, { label: t("routes.title"), id: "routes", sextant, nowrap: [true, false, true, false, false] }));
}

function routeView(sextant: Sextant, blocks: Blocks, kind: KindRef, obj: KubeObject): (Node | null)[] {
  const spec = routeSpec(kind, obj);
  const tls = spec.tls;
  const ns = obj.metadata.namespace ?? "";
  return [
    fieldsOf([
      ["entryPoints", spec.entryPoints.length > 0 ? ui.chips(spec.entryPoints) : t("values.allEntryPoints")],
      ["ingressClassName", spec.ingressClassName],
      ["parents", inlineOf(spec.parents.map((p) => refLink(sextant, p, kind.group)))],
      ["tlsSecret", tls?.secretName ? link(sextant, { group: "", version: "v1", kind: "Secret" }, tls.secretName, ns) : undefined],
      ["tlsOptions", tls?.options ? refLink(sextant, tls.options, kind.group) : undefined],
      ["tlsStore", tls?.store ? refLink(sextant, tls.store, kind.group) : undefined],
      ["certResolver", tls?.certResolver],
      ["domains", tls && tls.domains.length > 0 ? ui.chips(tls.domains) : undefined],
      ["passthrough", tls?.passthrough ? t("values.yes") : undefined],
    ]),
    spec.ingressClassName ? muted(t("explain.ingressClass", { name: spec.ingressClassName })) : null,
    routesTable(sextant, blocks, spec.routes, kind.group),
    tls?.certResolver && !tls.secretName ? muted(t("explain.certResolver", { name: tls.certResolver })) : null,
  ];
}

function traefikServiceView(sextant: Sextant, kind: KindRef, obj: KubeObject): (Node | null)[] {
  const type = traefikServiceType(obj);
  const children = traefikServiceRefs(obj).filter((r) => r.kind === "Service" || r.kind === "TraefikService");
  const byPlace = (place: Ref["place"]) => inlineOf(children.filter((r) => r.place === place).map((r) => serviceCell(sextant, r, kind.group)));
  return [
    fieldsOf([
      ["strategy", type ? t(`strategy.${type}`) : undefined],
      ["services", byPlace("service")],
      ["mirrors", byPlace("mirror")],
      ["fallback", byPlace("fallback")],
    ]),
  ];
}

function middlewareView(sextant: Sextant, kind: KindRef, obj: KubeObject): (Node | null)[] {
  const chain = isTraefik(kind, MIDDLEWARE) ? middlewareRefs(obj).filter((r) => r.place === "chain") : [];
  return [
    fieldsOf([
      ["type", middlewareType(obj)],
      ["chain", inlineOf(chain.map((r) => refLink(sextant, r, kind.group)))],
    ]),
  ];
}

function settingsView(kind: KindRef, obj: KubeObject): (Node | null)[] {
  const spec = get(obj, "spec");
  const tls = isTraefik(kind, SERVERS_TRANSPORT_TCP) ? get(spec, "tls") : spec;
  const insecure = get(tls, "insecureSkipVerify") === true;
  const rows: [string, UiContent][] = isTraefik(kind, TLS_OPTION)
    ? [
        ["minVersion", str(get(spec, "minVersion"))],
        ["maxVersion", str(get(spec, "maxVersion"))],
        ["clientAuth", str(get(spec, "clientAuth", "clientAuthType"))],
        ["sniStrict", get(spec, "sniStrict") === true ? t("values.yes") : undefined],
      ]
    : isTraefik(kind, TLS_STORE)
      ? [["defaultCertificate", str(get(spec, "defaultCertificate", "secretName"))]]
      : [
          ["serverName", str(get(tls, "serverName"))],
          ["insecureSkipVerify", insecure ? ui.status(t("values.insecure"), "warning") : undefined],
        ];
  return [fieldsOf(rows)];
}

// ---------- the section ----------

/** What the section is drawn from: the judgement (none while the lists load) and the other group's twin. */
export interface Findings {
  loading: boolean;
  judgement?: Judgement;
  twin?: boolean;
}

/** The section of `obj` as it is drawn now. */
export function traefikView(sextant: Sextant, kind: KindRef, obj: KubeObject, blocks: Blocks, found: Findings): Node[] {
  const health: Health = found.judgement?.health ?? "loading";
  const view = isRouteKind(kind)
    ? routeView(sextant, blocks, kind, obj)
    : isTraefik(kind, TRAEFIK_SERVICE)
      ? traefikServiceView(sextant, kind, obj)
      : isTraefik(kind, TLS_OPTION) || isTraefik(kind, TLS_STORE) || isTraefik(kind, SERVERS_TRANSPORT) || isTraefik(kind, SERVERS_TRANSPORT_TCP)
        ? settingsView(kind, obj)
        : middlewareView(sextant, kind, obj);
  return [
    block(blocks, FIELDS_BLOCK, kind.kind, () =>
      [
        fieldsOf([["state", healthText(health)]]),
        ...(found.judgement ? judged(found.judgement) : []),
        found.loading ? null : twinNote(kind, found.twin),
        ...view,
        found.judgement ? referencesTable(sextant, blocks, found.judgement.checks, kind.group) : null,
      ].filter((n): n is Node => n !== null),
    ),
  ];
}

// ---------- what the cluster serves ----------

/** Which groups serve each Traefik kind, from discovery. */
export function servedOf(kinds: readonly ResourceKind[]): Served {
  const out = new Map<string, { own: boolean; legacy: boolean }>();
  for (const k of kinds) {
    const { group, kind } = k.kindRef;
    if (!(TRAEFIK_GROUPS as readonly string[]).includes(group)) continue;
    const entry = out.get(kind) ?? { own: false, legacy: false };
    if (group === TRAEFIK_GROUP) entry.own = true;
    else entry.legacy = true;
    out.set(kind, entry);
  }
  return out;
}

// ---------- watches ----------

/** A list watched while the section shows. */
interface Live extends NameList {
  names: Set<string>;
}

/**
 * The watches a section holds, by what they watch: each drawing asks for the lists it needs between `begin` and
 * `end` (a list is started when first asked for), and `end` stops every list it did not ask for.
 */
class Watches {
  private readonly open = new Map<string, { watch: Watch; live: Live }>();
  private wanted = new Set<string>();
  constructor(
    private readonly sextant: Sextant,
    private readonly changed: () => void,
  ) {}

  begin(): void {
    this.wanted = new Set();
  }

  get(spec: Omit<WatchParams, "clusterId">): Live {
    const key = JSON.stringify(spec);
    this.wanted.add(key);
    return (this.open.get(key) ?? this.start(key, spec)).live;
  }

  end(): void {
    for (const [key, entry] of this.open) {
      if (this.wanted.has(key)) continue;
      this.open.delete(key);
      void entry.watch.unwatch().catch(() => undefined);
    }
  }

  private start(key: string, spec: Omit<WatchParams, "clusterId">): { watch: Watch; live: Live } {
    const live: Live = { ready: false, error: false, forbidden: [], capped: false, namespaces: spec.namespaces ?? null, names: new Set() };
    const watch = this.sextant.resources.watch(spec, {
      onUpdate: trackObjects(
        (items) => {
          live.names = new Set(items.map((o) => nameKey(o.metadata.namespace ?? "", o.metadata.name)));
          live.ready = true;
          live.error = false;
          this.changed();
        },
        (other) => {
          if (other.type === "error") {
            live.ready = true;
            live.error = true;
          } else if (other.type === "forbidden") live.forbidden = [...other.namespaces];
          else return;
          this.changed();
        },
      ),
      onError: () => {
        live.ready = true;
        live.error = true;
        this.changed();
      },
      onCapped: (total) => {
        live.capped = spec.maxObjects !== undefined && total > spec.maxObjects;
        this.changed();
      },
    });
    watch.started.catch(() => undefined);
    const entry = { watch, live };
    this.open.set(key, entry);
    return entry;
  }

  stop(): void {
    this.begin();
    this.end();
  }
}

/** The watch of a list a lookup reads. */
export function listWatch(group: string, kind: string, namespaces: readonly string[]): Omit<WatchParams, "clusterId"> {
  return {
    kind: { group, kind },
    namespaces: [...namespaces],
    metadataOnly: true,
    ...(group === "" ? {} : { maxObjects: MAX_OBJECTS }),
  };
}

/** The watch of the other group's object of the same kind and name. */
export function twinWatch(kind: KindRef, obj: KubeObject): Omit<WatchParams, "clusterId"> {
  return { kind: { group: otherGroup(kind.group), kind: kind.kind }, namespaces: [obj.metadata.namespace ?? ""], fieldSelector: `metadata.name=${obj.metadata.name}`, metadataOnly: true };
}

/** The lists of `obj` (watched while the section's block is open) and what they find. */
function findingsOf(watches: Watches, kind: KindRef, obj: KubeObject, served: Served | undefined): Findings {
  if (!served) return { loading: true };
  const lists = new Map<string, Live>();
  let loading = false;
  for (const want of listsFor(kind, obj, served)) {
    const live = watches.get(listWatch(want.group, want.kind, want.namespaces));
    lists.set(`${want.group}/${want.kind}`, live);
    if (want.waited && !live.ready) loading = true;
  }
  const other = served.get(kind.kind);
  const otherServed = kind.group === TRAEFIK_GROUP ? other?.legacy : other?.own;
  const twinList = otherServed ? watches.get(twinWatch(kind, obj)) : undefined;
  if (twinList && !twinList.ready) loading = true;
  if (loading) return { loading: true };
  const lookup = lookupOf(served, (group, k) => lists.get(`${group}/${k}`));
  return {
    loading: false,
    judgement: judge(kind, obj, lookup),
    twin: twinList ? listHas(twinList, obj.metadata.namespace ?? "", obj.metadata.name) : undefined,
  };
}

/** Calls `run` once in the next microtask, however often it is asked. */
function batched(run: () => void): () => void {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      run();
    });
  };
}

/**
 * Follows the shown object: `onObject` with it, now and whenever its resourceVersion changes; `onError` when it cannot
 * be read. Returns the function that stops following it.
 */
function followShown(sextant: Sextant, onObject: (ref: ObjectRef, obj: KubeObject) => void, onError: (err: unknown) => void, onNone: () => void): () => void {
  let shown: string | null = null;
  let version: string | null | undefined;
  let reading = 0;
  let stopped = false;
  const read = async (ref: ObjectRef) => {
    const attempt = ++reading;
    try {
      const obj = await sextant.resources.get({ ref });
      if (!stopped && attempt === reading) onObject(ref, obj);
    } catch (err) {
      if (!stopped && attempt === reading) onError(err);
    }
  };
  const follow = () => {
    const ref = sextant.context.selection[0];
    if (!ref) {
      shown = null;
      onNone();
      return;
    }
    const key = JSON.stringify([ref.kind.group, ref.kind.kind, ref.namespace, ref.name]);
    if (key !== shown) {
      shown = key;
      version = undefined;
    }
    if (sextant.context.resourceVersion === version) return;
    version = sextant.context.resourceVersion;
    void read(ref);
  };
  follow();
  const off = sextant.onContextChange(follow);
  return () => {
    stopped = true;
    off();
  };
}

/** Starts the details section `contribution` on the object in the context. */
export function startDetails(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  let object: { ref: ObjectRef; obj: KubeObject } | null = null;
  let served: Served | undefined;
  let discovery: Promise<void> | undefined;
  let stopped = false;
  // What the cluster serves, asked once (its answer decides which group each reference is looked up in).
  const discover = () => {
    discovery ??= sextant.kinds().then(
      (kinds) => {
        served = servedOf(kinds);
        schedule();
      },
      // Without discovery nothing can be looked up: the references stay "Checking…", as the built-in store did.
      () => undefined,
    );
  };
  const render = () => {
    if (stopped || !object) return;
    const { ref, obj } = object;
    const def = traefikKind(ref.kind);
    if (!def) {
      watches.stop();
      root.replaceChildren(ui.empty(t("common.nothingToShow", { view: contribution })));
      return;
    }
    // A closed block draws and watches nothing, as the built-in block's body was not drawn while closed.
    watches.begin();
    const found = memory.peek(FIELDS_BLOCK) ? findingsOf(watches, def.kind, obj, served) : { loading: true };
    watches.end();
    redraw(root, traefikView(sextant, def.kind, obj, memory, found));
  };
  const schedule = batched(render);
  const watches = new Watches(sextant, schedule);
  const memory = new BlockMemory(sextant, schedule);
  root.replaceChildren();
  discover();
  const stopFollow = followShown(
    sextant,
    (ref, obj) => {
      if (object && JSON.stringify(object.ref) !== JSON.stringify(ref)) {
        watches.stop();
        memory.reset();
      }
      object = { ref, obj };
      render();
    },
    (err) => root.replaceChildren(ui.errorState(errorText(err))),
    () => root.replaceChildren(ui.empty(t("common.nothingSelected"))),
  );
  const stopBlocks = sextant.onContextChange(() => {
    if (memory.follow()) schedule();
  });
  return () => {
    stopped = true;
    stopFollow();
    stopBlocks();
    watches.stop();
  };
}
