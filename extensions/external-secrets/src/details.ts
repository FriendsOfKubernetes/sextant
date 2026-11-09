// The details section `external-secrets` of External Secrets objects, as Sextant's former built-in section drew it:
//   ExternalSecret        — Ready with the last error, the store and whether it is ready (the store watched by name
//                           while the section shows), the target Secret (a link; never its data), refresh interval and
//                           last sync, the keys by name and remote key;
//   ClusterExternalSecret — Ready, the ExternalSecret name it makes, the namespaces it reached and failed in;
//   SecretStore/ClusterSecretStore — Ready (validation) with its reason, provider, capabilities;
//   PushSecret            — Ready, the source Secret, the stores and the remote keys it writes.
// Conditions and YAML are Sextant's own sections. Read-only, and never a Secret value: Secrets are only linked
// (`ui.openDetails`), never read (ADR-0100). The frame reads the shown object again whenever its resourceVersion
// changes.
import { trackObjects, ui, type KubeObject, type ObjectRef, type Sextant, type UiContent, type Watch, type WatchParams } from "@sextant/extension-sdk";
import { dateTime, element, errorText } from "./dom";
import { t } from "./i18n";
import {
  capabilitiesOf,
  creationPolicyOf,
  dataFromOf,
  ESO_GROUP,
  ESO_VERSION,
  failedNamespaces,
  get,
  isEsoKind,
  lastSyncOf,
  providerOf,
  provisionedNamespaces,
  pushKeysOf,
  pushSourceSecret,
  pushStoreRefs,
  readinessOf,
  readyTip,
  READY_TONE,
  refreshIntervalOf,
  remoteKeysOf,
  storeRefOf,
  str,
  targetSecretName,
  type RemoteKey,
  type StoreRef,
} from "./model";

const SECRET = { group: "", version: "v1", kind: "Secret" };

/** The store an ExternalSecret reads from, as the section's watch of it saw it. */
export interface StoreLive {
  /** The watch could not start (the cluster does not serve the kind): the row is left out. */
  failed: boolean;
  /** The first answer came. */
  ready: boolean;
  items: KubeObject[];
}

const present = (nodes: (Node | null | false | undefined)[]): Node[] => nodes.filter((n): n is Node => Boolean(n));

/** A titled block as the built-in view's: open, and closable with its title. */
const block = (title: string, content: UiContent): HTMLElement => ui.block(title, content, { collapsible: true });

const muted = (text: string) => element("p", { className: "eso-muted", textContent: text });

/** `ui.fields` labelled by `fields.<key>`, or nothing when no row has a value. */
function fieldsOf(rows: readonly (readonly [string, UiContent])[]): HTMLElement | null {
  const list = ui.fields(rows.map(([key, value]) => [t(`fields.${key}`), value] as const));
  return list.childElementCount > 0 ? list : null;
}

/** A link to an object's details in Sextant's panel; nothing without a name. */
function link(sextant: Sextant, kind: ObjectRef["kind"], name: string | undefined, namespace: string | null, text?: string): HTMLElement | null {
  return name ? ui.objectLink(sextant, { kind, namespace, name }, text ?? name) : null;
}

function storeLink(sextant: Sextant, ref: StoreRef, namespace: string | null): HTMLElement | null {
  const cluster = ref.kind === "ClusterSecretStore";
  const kind = { group: ESO_GROUP, version: ESO_VERSION, kind: cluster ? "ClusterSecretStore" : "SecretStore" };
  return link(sextant, kind, ref.name, cluster ? null : namespace, `${ref.kind}/${ref.name}`);
}

/** The Ready state in words, coloured; the reason and message as its tooltip. */
export function readyText(obj: KubeObject): HTMLElement {
  const r = readinessOf(obj);
  const word = ui.status(t(`state.${r.state}`), READY_TONE[r.state]);
  const tip = readyTip(obj);
  if (tip) word.title = tip;
  return word;
}

/** The failing condition's message, from the cluster, under the fields. */
function lastError(obj: KubeObject): HTMLElement | null {
  const r = readinessOf(obj);
  if (r.state !== "failed" || !r.message) return null;
  return block(t("lastError"), element("p", { className: "eso-message", textContent: r.message }));
}

/** The keys by name: the Secret's key, the remote key and its property; nothing for none. */
function keysTable(keys: RemoteKey[], label: string): HTMLElement | null {
  if (keys.length === 0) return null;
  const headers = [t("keys.secretKey"), t("keys.remoteKey"), t("keys.property")];
  return ui.table(
    headers,
    keys.map((k) => [k.secretKey, k.remoteKey, k.property ?? ""]),
    { label },
  );
}

/** Whether the store is ready: "Loading…", "Store not found", or its Ready state; nothing where the kind is not served. */
function storeState(store: StoreLive | undefined): HTMLElement | null {
  if (!store || store.failed) return null;
  if (!store.ready) return element("span", { className: "eso-muted", textContent: t("loading") });
  const obj = store.items[0];
  if (!obj) return ui.status(t("storeMissing"), "danger");
  return readyText(obj);
}

/** What an ExternalSecret's section watches: its store, by name. */
export function storeSpec(obj: KubeObject): Omit<WatchParams, "clusterId"> | null {
  const ref = storeRefOf(obj);
  if (!ref) return null;
  const cluster = ref.kind === "ClusterSecretStore";
  const ns = obj.metadata.namespace;
  return {
    kind: { group: ESO_GROUP, kind: cluster ? "ClusterSecretStore" : "SecretStore" },
    ...(!cluster && ns ? { namespaces: [ns] } : {}),
    fieldSelector: `metadata.name=${ref.name}`,
  };
}

export function externalSecretView(sextant: Sextant, obj: KubeObject, store: StoreLive | undefined): Node[] {
  const ns = obj.metadata.namespace ?? null;
  const ref = storeRefOf(obj);
  const interval = refreshIntervalOf(obj);
  const keys = remoteKeysOf(obj);
  const bulk = dataFromOf(obj).map((d) => {
    if (d.how === "extract") return t("dataFrom.extract", { key: d.what ?? "" });
    if (d.how === "find") return d.what ? t("dataFrom.find", { what: d.what }) : t("dataFrom.findAll");
    if (d.how === "generator") return t("dataFrom.generator", { name: d.what ?? "" });
    return t("dataFrom.other");
  });
  return present([
    fieldsOf([
      ["status", readyText(obj)],
      ["store", ref ? storeLink(sextant, ref, ns) : null],
      ["storeStatus", ref ? storeState(store) : null],
      ["target", link(sextant, SECRET, targetSecretName(obj), ns)],
      ["creationPolicy", creationPolicyOf(obj)],
      ["refreshInterval", interval === "0" || interval === "0s" ? t("refreshOnce") : interval],
      ["lastSync", dateTime(lastSyncOf(obj))],
    ]),
    lastError(obj),
    (keys.length > 0 || bulk.length > 0) &&
      block(t("keys.title"), [muted(t("keys.namesOnly")), keysTable(keys, t("keys.title")), fieldsOf([["dataFrom", ui.chips(bulk)]])]),
  ]);
}

export function clusterExternalSecretView(obj: KubeObject): Node[] {
  const failed = failedNamespaces(obj);
  const failedTable =
    failed.length > 0
      ? ui.table(
          [t("failedNamespaces.namespace"), t("failedNamespaces.reason")],
          failed.map((f) => [f.namespace, f.reason ?? ""]),
          { label: t("failedNamespaces.title") },
        )
      : null;
  return present([
    fieldsOf([
      ["status", readyText(obj)],
      ["externalSecretName", str(get(obj, "spec", "externalSecretName")) ?? obj.metadata.name],
      ["refreshInterval", str(get(obj, "spec", "refreshTime"))],
      ["provisioned", ui.chips(provisionedNamespaces(obj))],
    ]),
    lastError(obj),
    failedTable && block(t("failedNamespaces.title"), failedTable),
  ]);
}

export function storeView(obj: KubeObject): Node[] {
  const r = readinessOf(obj);
  return present([
    fieldsOf([
      ["status", readyText(obj)],
      ["reason", r.reason ? ui.status(r.reason, READY_TONE[r.state]) : null],
      ["provider", providerOf(obj)],
      ["capabilities", capabilitiesOf(obj)],
      ["refreshInterval", str(get(obj, "spec", "refreshInterval"))],
    ]),
    lastError(obj),
  ]);
}

export function pushSecretView(sextant: Sextant, obj: KubeObject): Node[] {
  const ns = obj.metadata.namespace ?? null;
  const keys = pushKeysOf(obj);
  const stores = pushStoreRefs(obj);
  return present([
    fieldsOf([
      ["status", readyText(obj)],
      ["source", link(sextant, SECRET, pushSourceSecret(obj), ns)],
      ["stores", stores.length > 0 ? ui.inline(stores.map((r) => storeLink(sextant, r, ns))) : null],
      ["refreshInterval", refreshIntervalOf(obj)],
      ["lastSync", dateTime(lastSyncOf(obj))],
    ]),
    lastError(obj),
    keys.length > 0 && block(t("keys.pushTitle"), keysTable(keys, t("keys.pushTitle"))),
  ]);
}

/** The view of one External Secrets object, by its kind; nothing for another kind. */
export function viewOf(sextant: Sextant, kind: string, obj: KubeObject, store?: StoreLive): Node[] {
  if (!isEsoKind(kind)) return [];
  switch (kind) {
    case "ExternalSecret":
      return externalSecretView(sextant, obj, store);
    case "ClusterExternalSecret":
      return clusterExternalSecretView(obj);
    case "SecretStore":
    case "ClusterSecretStore":
      return storeView(obj);
    case "PushSecret":
      return pushSecretView(sextant, obj);
  }
}

/** The store's watch while the section shows: started when first wanted, stopped when another (or none) is. */
class StoreWatch {
  private key: string | null = null;
  private watch: Watch | null = null;
  private live: StoreLive | undefined;
  constructor(
    private readonly sextant: Sextant,
    private readonly changed: () => void,
  ) {}

  want(spec: Omit<WatchParams, "clusterId"> | null): StoreLive | undefined {
    const key = spec ? JSON.stringify(spec) : null;
    if (key === this.key) return this.live;
    this.stop();
    if (!spec) return undefined;
    this.key = key;
    const live: StoreLive = { failed: false, ready: false, items: [] };
    this.live = live;
    const watch = this.sextant.resources.watch(spec, {
      onUpdate: trackObjects(
        (items) => {
          live.items = items;
          live.ready = true;
          this.changed();
        },
        (other) => {
          // A refused or failed list: the built-in view read it as an empty list, "Store not found".
          if (other.type === "error" || other.type === "forbidden") {
            live.items = [];
            live.ready = true;
            this.changed();
          }
        },
      ),
      // The watch could not start: the cluster does not serve the kind.
      onError: () => {
        live.failed = true;
        this.changed();
      },
    });
    watch.started.catch(() => undefined);
    this.watch = watch;
    return live;
  }

  stop(): void {
    if (this.watch) void this.watch.unwatch().catch(() => undefined);
    this.watch = null;
    this.key = null;
    this.live = undefined;
  }
}

/**
 * Starts the details section on the object in the context: read again whenever its resourceVersion changes; an
 * ExternalSecret's store watched by name while it shows, and drawn again as it changes.
 */
export function startDetails(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  let shownVersion: string | null | undefined;
  let shownRef: string | null = null;
  let reading = 0;
  let object: { kind: string; obj: KubeObject } | null = null;
  let scheduled = false;
  let stopped = false;

  const render = () => {
    if (!object || stopped) return;
    if (contribution !== "external-secrets") {
      root.replaceChildren(ui.empty(t("common.nothingToShow", { view: contribution })));
      return;
    }
    const store = storeWatch.want(object.kind === "ExternalSecret" ? storeSpec(object.obj) : null);
    root.replaceChildren(...viewOf(sextant, object.kind, object.obj, store));
  };
  const schedule = () => {
    if (scheduled || stopped) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      render();
    });
  };
  const storeWatch = new StoreWatch(sextant, schedule);

  const read = async (ref: ObjectRef) => {
    const attempt = ++reading;
    try {
      const fresh = await sextant.resources.get({ ref });
      if (attempt !== reading) return;
      object = { kind: ref.kind.kind, obj: fresh };
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
      storeWatch.stop();
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
    storeWatch.stop();
  };
}

