// The details sections of Contour's objects (the manifest's `contributes.detailsSections`, one per kind; the selected
// object's kind says which view), as Sextant's former built-in view drew them (#233, ADR-0107):
//   HTTPProxy                — its state in plain words and Contour's own errors and warnings, the virtual host (host,
//                              addresses, TLS — a Secret of another namespace with the TLSCertificateDelegation that
//                              allows it — and the policies attached to the host, an authorization ExtensionService
//                              linked), the routes with their match conditions, services with their share of requests
//                              or the percent mirrored and the policies of each route, a TCP proxy's services, the
//                              includes with the state of each included proxy, and the delegation tree;
//   TLSCertificateDelegation — each delegated Secret (a link) and the namespaces that may use it ("*": all);
//   ExtensionService         — its state with Contour's errors, the Services behind it (links) with weights, the
//                              protocol, timeouts and load balancing.
// As the built-in section, the view is a block titled with the kind (the section itself has no heading) with the
// built-in's blocks inside it; they open and close with their titles in Sextant's own memory of details sections
// (`context.blocks`, `ui.setBlockOpen`), with the panel's "Expand all" and "Collapse all". The includes' states and the
// delegation tree read every HTTPProxy of the cluster (at most `MAX_PROXY_ROWS`) while their block is open; a delegated
// TLS Secret's TLSCertificateDelegations are read in the Secret's namespace. Each frame reads the shown object again
// whenever its resourceVersion changes. Conditions, events and YAML are Sextant's own sections. Read-only.
import { trackObjects, ui, type KubeObject, type ObjectRef, type Sextant, type UiContent, type Watch, type WatchParams } from "@sextant/extension-sdk";
import { element, errorText, explanation, fieldsOf, formatNumber, link, message, remark, table } from "./dom";
import { t } from "./i18n";
import {
  authorizationRef,
  contourKind,
  delegationFor,
  delegationsOf,
  description,
  explain,
  EXTENSION_SERVICE,
  extensionFields,
  fqdnOf,
  HEALTH_TONE,
  healthOf,
  hostPoliciesOf,
  HTTP_PROXY,
  includesOf,
  indexRows,
  ingressClassOf,
  MAX_PROXY_ROWS,
  PROXY_HEALTH,
  proxyAddresses,
  proxyKey,
  proxyRow,
  proxyState,
  rootsReaching,
  routesOf,
  sameKind,
  SECRET,
  SERVICE,
  shares,
  tcpServicesOf,
  TLS_DELEGATION,
  tlsOf,
  validCondition,
  delegationTree,
  type KindOf,
  type KindRef,
  type ProxyIndex,
  type ProxyService,
  type ProxyState,
  type SecretRef,
  type TreeNode,
} from "./model";

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

// ---------- What the views read besides the object ----------

/** Every HTTPProxy of the cluster as a row, keyed `namespace/name` (the built-in `useProxyIndex`). */
export interface IndexState {
  index: ProxyIndex;
  loading: boolean;
  /** The list could not be read (no permission, an error): the tree is not known. */
  failed: boolean;
  /** More proxies than are read: the tree may lack some. */
  truncated: boolean;
}

export const NO_INDEX: IndexState = { index: new Map(), loading: false, failed: false, truncated: false };

/** The TLSCertificateDelegations of a delegated Secret's namespace (the built-in `useDelegations`). */
export interface DelegationsState {
  /** `false` where the cluster does not serve the kind; `undefined` until known. */
  served: boolean | undefined;
  status: "loading" | "ready" | "error";
  items: KubeObject[];
}

export interface Lists {
  index: IndexState;
  delegations?: DelegationsState;
}

export const NO_LISTS: Lists = { index: NO_INDEX };

// ---------- HTTPProxy ----------

function stateText(state: ProxyState): HTMLElement {
  return ui.status(t(`state.${state}`), HEALTH_TONE[PROXY_HEALTH[state]]);
}

function proxyExplanation(obj: KubeObject): Node[] {
  const phrase = explain(obj);
  const state = proxyState(obj);
  const said = description(obj);
  const firstMessage = validCondition(obj)?.errors[0]?.message;
  return present([
    explanation(t(`explain.${phrase.key}`, phrase.params ?? {}), state === "invalid" || state === "orphaned"),
    Boolean(said) && said !== firstMessage && state !== "valid" && message(said!),
  ]);
}

/** Contour's errors and warnings of the Valid condition, one row each. */
export function issuesBlock(sextant: Sextant, obj: KubeObject, memory: BlockMemory = OPEN_BLOCKS): HTMLElement | null {
  const valid = validCondition(obj);
  if (!valid) return null;
  const rows = [
    ...valid.errors.map((e) => [t("issues.error"), e.type, e.reason ?? "", e.message ?? ""]),
    ...valid.warnings.map((w) => [t("issues.warning"), w.type, w.reason ?? "", w.message ?? ""]),
  ];
  const headers = ["kind", "type", "reason", "message"].map((h) => t(`issues.${h}`));
  const body = table(sextant, "issues", headers, rows, [0, 1, 2]);
  return body && block(memory, "issues", t("issues.title"), body);
}

/** The TLSCertificateDelegation that lets this proxy use a Secret of another namespace, or why there is none. */
function delegationField(sextant: Sextant, secret: SecretRef, target: string, state: DelegationsState | undefined): UiContent {
  if (state?.served === false) return t("fields.delegationNotServed");
  if (!state || state.served === undefined || state.status === "loading") return t("fields.delegationLoading");
  if (state.status === "error") return t("fields.delegationUnknown");
  const found = delegationFor(state.items, secret, target);
  if (!found) return element("span", { className: "ct-message", textContent: t("fields.delegationMissing", { namespace: secret.namespace, target }) });
  return link(sextant, TLS_DELEGATION, found.metadata?.name, secret.namespace);
}

function hostFields(sextant: Sextant, obj: KubeObject, lists: Lists): HTMLElement | null {
  const own = obj.metadata?.namespace ?? "";
  const tls = tlsOf(obj);
  const auth = authorizationRef(obj);
  const versions = [tls?.minimumProtocolVersion, tls?.maximumProtocolVersion].filter(Boolean).join(" – ");
  const secret = tls?.secret;
  return fieldsOf([
    ["status", stateText(proxyState(obj))],
    ["fqdn", fqdnOf(obj)],
    ["ingressClass", ingressClassOf(obj)],
    ["addresses", ui.chips(proxyAddresses(obj))],
    ["tlsSecret", secret ? link(sextant, SECRET, secret.name, secret.namespace, secret.delegated ? `${secret.namespace}/${secret.name}` : undefined) : null],
    ["tlsDelegation", secret?.delegated ? delegationField(sextant, secret, own, lists.delegations) : null],
    ["tlsPassthrough", tls?.passthrough ? t("yes") : null],
    ["tlsVersions", versions],
    ["fallbackCertificate", tls?.fallbackCertificate ? t("yes") : null],
    ["clientValidation", tls?.clientValidation ? t("yes") : null],
    ["hostPolicies", ui.chips(hostPoliciesOf(obj))],
    ["authorization", auth ? link(sextant, EXTENSION_SERVICE, auth.name, auth.namespace) : null],
  ]);
}

/** The services of a route: a link to each Service, its port, and its share (or the percent mirrored). */
export function serviceCell(sextant: Sextant, services: readonly ProxyService[], namespace: string): HTMLElement {
  const share = shares(services);
  return element(
    "span",
    { className: "ct-services" },
    ...services.map((s, i) =>
      element(
        "span",
        { className: "ct-service" },
        link(sextant, SERVICE, s.name, namespace, s.port === undefined ? s.name : `${s.name}:${s.port}`),
        element("span", {
          className: "ct-extra",
          textContent: s.mirror ? t("routes.mirror", { percent: formatNumber(share[i] ?? 0) }) : t("routes.share", { percent: formatNumber(share[i] ?? 0) }),
        }),
      ),
    ),
  );
}

function routesBlock(sextant: Sextant, obj: KubeObject, memory: BlockMemory): HTMLElement | null {
  const namespace = obj.metadata?.namespace ?? "";
  const rows = routesOf(obj).map((r) => [
    String(r.index + 1),
    r.conditions.length > 0 ? ui.chips(r.conditions) : t("routes.everything"),
    r.services.length > 0 ? serviceCell(sextant, r.services, namespace) : "",
    ui.chips(r.policies),
    r.redirect
      ? t("routes.redirect")
      : r.directResponse !== undefined
        ? t("routes.directResponse", { code: r.directResponse })
        : r.services.every((s) => s.mirror)
          ? t("routes.noService")
          : r.websockets
            ? t("routes.websockets")
            : "",
  ]);
  const headers = ["number", "conditions", "services", "policies", "action"].map((h) => t(`routes.${h}`));
  const body = table(sextant, "routes", headers, rows, [0]);
  return body && block(memory, "routes", t("routes.title"), body);
}

function tcpBlock(sextant: Sextant, obj: KubeObject, memory: BlockMemory): HTMLElement | null {
  const services = tcpServicesOf(obj);
  if (services.length === 0) return null;
  return block(memory, "tcp", t("tcp.title"), serviceCell(sextant, services, obj.metadata?.namespace ?? ""));
}

export function includesBlock(sextant: Sextant, obj: KubeObject, index: ProxyIndex, memory: BlockMemory = OPEN_BLOCKS): HTMLElement | null {
  const rows = includesOf(obj).map((inc) => {
    const row = index.get(proxyKey(inc.namespace, inc.name));
    const state = row ? t(`state.${row.state}`) : index.size > 0 ? t("tree.missing") : "";
    return [
      link(sextant, HTTP_PROXY, inc.name, inc.namespace, `${inc.namespace}/${inc.name}`),
      inc.tcp ? t("tree.tcp") : inc.conditions.length > 0 ? ui.chips(inc.conditions) : t("routes.everything"),
      state,
    ];
  });
  const headers = ["proxy", "conditions", "state"].map((h) => t(`includes.${h}`));
  const body = table(sextant, "includes", headers, rows, [0, 2]);
  return body && block(memory, "includes", t("includes.title"), body);
}

function treeNode(sextant: Sextant, node: TreeNode, current: string, top: boolean): HTMLElement {
  const slash = node.key.indexOf("/");
  const [namespace, name] = [node.key.slice(0, slash), node.key.slice(slash + 1)];
  const isCurrent = node.key === current;
  const label = node.row?.root ? (node.row.fqdn ?? "") : node.tcp ? t("tree.tcp") : node.prefix;
  const extra = node.cycle
    ? t("tree.cycle")
    : !node.row
      ? t("tree.missing")
      : node.row.root && !top
        ? t("tree.rootIncluded")
        : node.conditions.filter((c) => !c.startsWith("prefix=")).join(", ");
  const item = element(
    "li",
    { className: "ct-chain__item" },
    element(
      "span",
      { className: "ct-chain__row" },
      element("span", { className: "ct-chain__kind", textContent: HTTP_PROXY.kind }),
      isCurrent ? element("strong", { textContent: node.key }) : link(sextant, HTTP_PROXY, name, namespace, node.key),
      node.row && stateText(node.row.state),
      label && element("code", { textContent: label }),
      extra && element("span", { className: "ct-chain__extra", textContent: extra }),
    ),
    node.children.length > 0 && element("ul", {}, ...node.children.map((child) => treeNode(sextant, child, current, false))),
  );
  if (isCurrent) item.setAttribute("aria-current", "true");
  return item;
}

/** The delegation tree: a root's every include, or the roots that reach an included proxy with only its branches. */
export function treeBlock(sextant: Sextant, obj: KubeObject, state: IndexState, memory: BlockMemory = OPEN_BLOCKS): HTMLElement {
  const { index, loading, failed, truncated } = state;
  const key = proxyKey(obj.metadata?.namespace ?? "", obj.metadata?.name ?? "");
  const row = index.get(key);
  const roots = row?.root ? [key] : rootsReaching(index, key);
  const trees = roots.map((root) => delegationTree(index, root, row?.root ? undefined : key));
  const cut = truncated || trees.some((tree) => tree.truncated);
  const body = failed
    ? remark(t("tree.failed"))
    : loading && !row
      ? remark(t("tree.loading"))
      : trees.length === 0
        ? remark(t("tree.noRoot"))
        : element("ul", { className: "ct-chain" }, ...trees.map((tree) => treeNode(sextant, tree.node, key, true)));
  return block(memory, "tree", t("tree.title"), [body, cut && remark(t("tree.truncated"))]);
}

export function proxyView(sextant: Sextant, obj: KubeObject, lists: Lists, memory: BlockMemory = OPEN_BLOCKS): Node[] {
  return present([
    ...proxyExplanation(obj),
    hostFields(sextant, obj, lists),
    issuesBlock(sextant, obj, memory),
    routesBlock(sextant, obj, memory),
    tcpBlock(sextant, obj, memory),
    includesBlock(sextant, obj, lists.index.index, memory),
    treeBlock(sextant, obj, lists.index, memory),
  ]);
}

// ---------- TLSCertificateDelegation and ExtensionService ----------

export function delegationView(sextant: Sextant, obj: KubeObject): Node[] {
  const namespace = obj.metadata?.namespace ?? null;
  const rows = delegationsOf(obj).map((d) => [
    link(sextant, SECRET, d.secretName, namespace),
    d.targetNamespaces.includes("*") ? t("delegations.all") : ui.chips(d.targetNamespaces),
  ]);
  const headers = [t("delegations.secret"), t("delegations.targets")];
  return [explanation(t("delegations.explain"), false), table(sextant, "delegations", headers, rows, [0]) ?? remark(t("delegations.none"))];
}

export function extensionView(sextant: Sextant, obj: KubeObject, memory: BlockMemory = OPEN_BLOCKS): Node[] {
  const f = extensionFields(obj);
  const health = healthOf(EXTENSION_SERVICE, obj);
  const namespace = obj.metadata?.namespace ?? null;
  const valid = validCondition(obj);
  const rows = f.services.map((s) => [link(sextant, SERVICE, s.name, namespace), s.port === undefined ? "" : String(s.port), s.weight === undefined ? "" : String(s.weight)]);
  const headers = ["service", "port", "weight"].map((h) => t(`extension.${h}`));
  const services = table(sextant, "services", headers, rows, [0, 1, 2]);
  return present([
    valid?.status === "False" && explanation(t("explain.extensionInvalid", { reason: valid.errors[0]?.reason ?? valid.reason ?? "" }), true),
    fieldsOf([
      ["status", ui.status(t(`health.${health}`), HEALTH_TONE[health])],
      ["protocol", f.protocol],
      ["timeout", f.timeout],
      ["idleTimeout", f.idleTimeout],
      ["loadBalancing", f.loadBalancing],
      ["upstreamValidation", f.validated ? t("yes") : null],
    ]),
    issuesBlock(sextant, obj, memory),
    services && block(memory, "services", t("extension.services"), services),
  ]);
}

/** The block titled with the kind, as the built-in section's. */
export function contourView(sextant: Sextant, kind: KindOf, obj: KubeObject, lists: Lists = NO_LISTS, memory: BlockMemory = OPEN_BLOCKS): Node[] {
  const known = contourKind(kind);
  if (!known) return [];
  const content = sameKind(kind, HTTP_PROXY)
    ? proxyView(sextant, obj, lists, memory)
    : sameKind(kind, TLS_DELEGATION)
      ? delegationView(sextant, obj)
      : extensionView(sextant, obj, memory);
  return [block(memory, "fields", known.kind, content)];
}

// ---------- The lists ----------

/** A list watched while a block needs it. */
interface Listed {
  items: KubeObject[];
  /** The first answer came. */
  loaded: boolean;
  /** Not readable: what it holds is not known. */
  error: boolean;
  /** More objects match than are kept. */
  capped: boolean;
}

/** The watches the views hold, by what they watch: started when first wanted, stopped when no longer. */
class Watches {
  private readonly open = new Map<string, { watch: Watch; live: Listed }>();
  constructor(
    private readonly sextant: Sextant,
    private readonly changed: () => void,
  ) {}

  /** The lists of `specs`, each watched from now on; every other watch stops. */
  want(specs: readonly Omit<WatchParams, "clusterId">[]): Listed[] {
    const keep = new Set<string>();
    const out = specs.map((spec) => {
      const key = JSON.stringify(spec);
      keep.add(key);
      return (this.open.get(key) ?? this.start(key, spec)).live;
    });
    for (const [key, entry] of this.open) {
      if (keep.has(key)) continue;
      this.open.delete(key);
      void entry.watch.unwatch().catch(() => undefined);
    }
    return out;
  }

  private start(key: string, spec: Omit<WatchParams, "clusterId">): { watch: Watch; live: Listed } {
    const live: Listed = { items: [], loaded: false, error: false, capped: false };
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
      onCapped: (total) => {
        live.capped = total > (spec.maxObjects ?? Infinity);
        this.changed();
      },
    });
    watch.started.catch(() => undefined);
    const entry = { watch, live };
    this.open.set(key, entry);
    return entry;
  }

  stop(): void {
    this.want([]);
  }
}

/** The index of the HTTPProxy list, built again only when the list changes. */
function indexOf(listed: Listed | undefined, cache: { items?: KubeObject[]; index?: ProxyIndex }): IndexState {
  if (!listed) return NO_INDEX;
  if (cache.items !== listed.items) {
    cache.items = listed.items;
    cache.index = indexRows(listed.items.map(proxyRow));
  }
  return { index: listed.error ? new Map() : cache.index!, loading: !listed.loaded, failed: listed.error, truncated: listed.capped };
}

// ---------- The section ----------

/**
 * Starts the details section on the object in the context: read again whenever its resourceVersion changes; the
 * HTTPProxies of the cluster watched while the includes or the delegation tree are open, a delegated Secret's
 * TLSCertificateDelegations while the proxy's block is, and drawn again as they change.
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
  const indexCache: { items?: KubeObject[]; index?: ProxyIndex } = {};
  // How the drawn blocks show now (each toggle included): a change of Sextant's memory that differs draws them again.
  const remembered = sextantBlocks(sextant);
  const shownBlocks = new Map<string, boolean>();
  // A toggle of this frame until Sextant's memory tells it back (the next change of `context.blocks`).
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
      // The lists are read only while the blocks that show them are open.
      schedule();
    },
  };

  /** Draws `nodes`, keeping the focus on a block's toggle that was drawn again. */
  const show = (nodes: Node[]) => {
    const focused = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : null;
    const focusedBlock = focused?.classList.contains("sx-block__toggle") ? focused.closest<HTMLElement>("[data-block]")?.dataset.block : undefined;
    root.replaceChildren(...nodes);
    if (focusedBlock) root.querySelector<HTMLElement>(`[data-block="${focusedBlock}"] .sx-block__toggle`)?.focus();
  };

  const askKinds = () => {
    if (askedKinds) return;
    askedKinds = true;
    sextant
      .kinds()
      .then((kinds) => new Map(kinds.map((k) => [`${k.kindRef.group}/${k.kindRef.kind}`, k.kindRef] as const)))
      .catch(() => "unknown" as const)
      .then((known) => {
        served = known;
        schedule();
      });
  };

  const render = () => {
    if (!object || !kind || stopped) return;
    shownBlocks.clear();
    if (!contourKind(kind)) {
      watches.stop();
      root.replaceChildren(ui.empty(t("common.nothingToShow", { view: kind.kind })));
      return;
    }
    let lists: Lists = NO_LISTS;
    if (sameKind(kind, HTTP_PROXY)) {
      const obj = object;
      const open = (id: string) => openNow(id);
      const outer = open("fields");
      const wantIndex = outer && (open("tree") || (open("includes") && includesOf(obj).length > 0));
      const secret = tlsOf(obj)?.secret;
      const wantDelegations = outer && secret?.delegated === true;
      if (wantDelegations) askKinds();
      const delegationKind = served === "unknown" ? TLS_DELEGATION : served?.get(`${TLS_DELEGATION.group}/${TLS_DELEGATION.kind}`);
      const specs: Omit<WatchParams, "clusterId">[] = [];
      if (wantIndex) specs.push({ kind: { ...HTTP_PROXY, version: kind.version }, maxObjects: MAX_PROXY_ROWS });
      if (wantDelegations && delegationKind) specs.push({ kind: delegationKind, namespaces: [secret!.namespace] });
      const listed = watches.want(specs);
      const delegations: DelegationsState | undefined = !wantDelegations
        ? undefined
        : served === null
          ? { served: undefined, status: "loading", items: [] }
          : !delegationKind
            ? { served: false, status: "ready", items: [] }
            : (() => {
                const l = listed[wantIndex ? 1 : 0]!;
                return { served: true, status: !l.loaded ? "loading" : l.error ? "error" : "ready", items: l.items };
              })();
      lists = { index: wantIndex ? indexOf(listed[0], indexCache) : NO_INDEX, delegations };
    } else {
      watches.stop();
    }
    show(contourView(sextant, kind, object, lists, memory));
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
