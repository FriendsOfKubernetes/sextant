// The details sections of the extension (the manifest's `contributes.detailsSections`), as the built-in view's
// (src/features/cert-manager/details.tsx, ADR-0069):
//   `certmanager` on every cert-manager kind — one block titled with the kind, as the built-in section was:
//     Certificate        — the plain-language state, Secret and issuer links, the names asked for, validity with days
//                          left, renewal time, key, revision and, in a block of its own, the last failure;
//     CertificateRequest — approval, readiness in plain words, its Certificate and issuer;
//     Issuer/ClusterIssuer — type, readiness in plain words, the ACME server and account, the CA Secret;
//     Order / Challenge  — ACME state and reason in plain words, names, solver;
//   `chain` on Certificates, CertificateRequests, Orders and Challenges — the chain Certificate → its newest
//     CertificateRequests → their Orders → their Challenges, the opened object marked.
// Neither section has a heading of its own (the built-in ones were blocks); their blocks open and close as the built-in
// panel's did, in Sextant's own memory of details sections (the context's `blocks`, `ui.setBlockOpen`), so "Expand
// all", "Collapse all" and Settings → Appearance apply to them. The chain watches the CertificateRequests, Orders and
// Challenges of the object's namespace — only the kinds the cluster serves, nothing before Sextant says which — while
// its block is open, as the built-in one did. The frame reads the shown object again whenever its resourceVersion
// changes, and draws the expiry again every minute. Conditions, events and YAML are Sextant's own sections. Read-only.
import { objectKey, ui, type KubeObject, type ObjectRef, type Sextant, type UiContent, type Watch, type WatchUpdate } from "@sextant/extension-sdk";
import { dateTime, element, errorText, formatDateTime } from "./dom";
import { t } from "./i18n";
import {
  acmeReason,
  acmeState,
  acmeTone,
  APPROVAL_TONE,
  approvalOf,
  arr,
  CERT_MANAGER_GROUP,
  CERTIFICATE,
  CERTIFICATE_REQUEST,
  certificateFields,
  certificateNameOf,
  CHALLENGE,
  challengesOf,
  challengeType,
  CLUSTER_ISSUER,
  DEFAULT_CERT_EXPIRY_DAYS,
  EXPIRY_TONE,
  expiryOf,
  explainCertificate,
  explainChallenge,
  explainIssuer,
  explainOrder,
  explainRequest,
  get,
  isKind,
  ISSUER,
  issuerRefOf,
  issuerType,
  lastFailure,
  ORDER,
  ordersOf,
  ownerName,
  readyReason,
  readyStatus,
  readyTone,
  requestsOf,
  revisionOf,
  rootCertificateName,
  SECRET,
  str,
  type IssuerRef,
  type KindOf,
  type Phrase,
} from "./model";

/** Newest CertificateRequests shown in the chain. */
export const CHAIN_REQUESTS = 3;
/** How often the expiry is drawn again, as the built-in view's clock (`useNow(60_000)`). */
export const EXPIRY_TICK_MS = 60_000;

const CM_API = `${CERT_MANAGER_GROUP}/v1`;

/** The blocks of a section: whether one is open, and `toggle`, which remembers a change and draws again. */
export interface Blocks {
  isOpen(id: string): boolean;
  toggle(id: string, open: boolean): void;
}

/** A titled block as the built-in panel's: open unless the user closed it, closable with its title. */
function block(blocks: Blocks, id: string, title: string, content: UiContent): HTMLElement {
  const node = ui.block(title, content, { collapsible: true, collapsed: !blocks.isOpen(id), onToggle: (open) => blocks.toggle(id, open) });
  node.dataset.block = id;
  return node;
}

/** A link to an object's details in Sextant's panel; nothing without a name. */
export function link(sextant: Sextant, kind: KindOf, name: string | undefined, namespace: string | null, text?: string): HTMLElement | null {
  if (!name) return null;
  const button = ui.objectLink(sextant, { kind, namespace, name }, text);
  button.setAttribute("aria-label", t("openObject", { kind: kind.kind, name }));
  return button;
}

/** `ui.fields` labelled from `fields.<key>`, or nothing when no row has a value. */
function fieldsOf(rows: readonly (readonly [string, UiContent])[]): HTMLElement | null {
  const list = ui.fields(rows.map(([key, value]) => [t(`fields.${key}`), value] as const));
  return list.childElementCount > 0 ? list : null;
}

function explanation(phrase: Phrase | undefined): HTMLElement | null {
  if (!phrase) return null;
  return element("p", { className: "cm-explain", textContent: t(`explain.${phrase.key}`, phrase.params ?? {}) });
}

function readyText(obj: KubeObject): HTMLElement | null {
  const value = readyStatus(obj);
  if (!value) return null;
  const reason = readyReason(obj);
  return ui.status(reason ? t("readyWithReason", { status: value, reason }) : value, readyTone(value));
}

/** A link to the issuer a reference names; an external issuer (another group) as text. */
function issuerLink(sextant: Sextant, ref: IssuerRef | undefined, namespace: string | null): UiContent {
  if (!ref) return null;
  if (ref.group !== CERT_MANAGER_GROUP) return t("externalIssuer", { kind: ref.kind, name: ref.name, group: ref.group });
  const kind = ref.kind === "ClusterIssuer" ? CLUSTER_ISSUER : ISSUER;
  return link(sextant, kind, ref.name, kind === ISSUER ? namespace : null, `${kind.kind}/${ref.name}`);
}

/** Expiry of a certificate, coloured by the expiry warning days. */
export function expiryText(notAfter: string | undefined, notBefore: string | undefined, now: number, warnDays = DEFAULT_CERT_EXPIRY_DAYS): HTMLElement | null {
  const expiry = expiryOf(notAfter, now, warnDays, notBefore);
  if (!notAfter || !expiry) return null;
  const text =
    expiry.state === "expired"
      ? t("expiry.expiredOn", { date: formatDateTime(notAfter) })
      : expiry.state === "notYetValid"
        ? t("expiry.notYetValid", { date: formatDateTime(notBefore ?? notAfter) })
        : t("expiry.until", { date: formatDateTime(notAfter), count: expiry.daysLeft });
  return ui.status(text, EXPIRY_TONE[expiry.state]);
}

const yes = (value: boolean): string | undefined => (value ? t("yes") : undefined);

/**
 * The days before its end a certificate shows as expiring: the user's `notifications.certExpiryDays` as Sextant sends it
 * in the context (clamped to 1–365), 14 where an older Sextant sends none.
 */
export function warnDaysOf(context: { certExpiryDays?: number }): number {
  const days = context.certExpiryDays;
  return typeof days === "number" && Number.isFinite(days) ? Math.min(365, Math.max(1, Math.round(days))) : DEFAULT_CERT_EXPIRY_DAYS;
}

function certificateView(sextant: Sextant, obj: KubeObject, now: number, blocks: Blocks): UiContent[] {
  const f = certificateFields(obj);
  const ns = obj.metadata?.namespace ?? null;
  const failure = lastFailure(obj);
  const key = [f.keyAlgorithm, f.keySize ? String(f.keySize) : undefined].filter(Boolean).join(" ");
  const rows: [string, UiContent][] = [
    ["ready", readyText(obj)],
    ["secret", link(sextant, SECRET, f.secretName, ns)],
    ["issuer", issuerLink(sextant, issuerRefOf(obj), ns)],
    ["commonName", f.commonName],
    ["dnsNames", ui.chips(f.dnsNames)],
    ["ipAddresses", ui.chips(f.ipAddresses)],
    ["uris", ui.chips(f.uris)],
    ["emailAddresses", ui.chips(f.emailAddresses)],
    ["notBefore", dateTime(f.notBefore)],
    ["notAfter", expiryText(f.notAfter, f.notBefore, now, warnDaysOf(sextant.context))],
    ["renewalTime", dateTime(f.renewalTime)],
    ["duration", f.duration],
    ["renewBefore", f.renewBefore],
    ["privateKey", key || undefined],
    ["rotationPolicy", f.rotationPolicy],
    ["isCA", yes(f.isCA)],
    ["revision", f.revision === undefined ? undefined : String(f.revision)],
  ];
  const failed = failure
    ? block(blocks, "lastFailure", t("lastFailure.title"), [
        element("p", {
          className: "cm-explain cm-explain--danger",
          textContent: failure.attempts
            ? t("lastFailure.withAttempts", { date: formatDateTime(failure.time), count: failure.attempts })
            : t("lastFailure.at", { date: formatDateTime(failure.time) }),
        }),
        failure.message ? element("p", { className: "cm-message", textContent: failure.message }) : null,
      ])
    : null;
  return [explanation(explainCertificate(obj)), fieldsOf(rows), failed];
}

function requestView(sextant: Sextant, obj: KubeObject): UiContent[] {
  const ns = obj.metadata?.namespace ?? null;
  const approval = approvalOf(obj);
  const revision = revisionOf(obj);
  const rows: [string, UiContent][] = [
    ["approval", ui.status(t(`approval.${approval}`), APPROVAL_TONE[approval])],
    ["ready", readyText(obj)],
    ["certificate", link(sextant, CERTIFICATE, certificateNameOf(obj), ns)],
    ["issuer", issuerLink(sextant, issuerRefOf(obj), ns)],
    ["revision", revision === undefined ? undefined : String(revision)],
    ["failureTime", dateTime(str(get(obj, "status", "failureTime")))],
  ];
  return [explanation(explainRequest(obj)), fieldsOf(rows)];
}

function issuerView(sextant: Sextant, obj: KubeObject): UiContent[] {
  const ns = obj.metadata?.namespace ?? null;
  const type = issuerType(obj);
  const solvers = arr(get(obj, "spec", "acme", "solvers")).map((s) =>
    get(s, "http01") !== undefined ? "HTTP-01" : get(s, "dns01") !== undefined ? "DNS-01" : undefined,
  );
  // A ClusterIssuer's CA Secret is in cert-manager's cluster resource namespace, which Sextant does not know.
  const caSecret = str(get(obj, "spec", "ca", "secretName"));
  const rows: [string, UiContent][] = [
    ["ready", readyText(obj)],
    ["issuerType", type ? t(`issuerTypes.${type}`) : undefined],
    ["acmeServer", str(get(obj, "spec", "acme", "server"))],
    ["acmeEmail", str(get(obj, "spec", "acme", "email"))],
    ["acmeAccount", str(get(obj, "status", "acme", "uri"))],
    ["solvers", ui.chips([...new Set(solvers)])],
    ["caSecret", ns ? link(sextant, SECRET, caSecret, ns) : caSecret],
    ["vaultServer", str(get(obj, "spec", "vault", "server"))],
    ["vaultPath", str(get(obj, "spec", "vault", "path"))],
  ];
  return [explanation(explainIssuer(obj)), fieldsOf(rows)];
}

function acmeStateText(obj: KubeObject): HTMLElement | null {
  const state = acmeState(obj);
  return state ? ui.status(state, acmeTone(state)) : null;
}

function orderView(sextant: Sextant, obj: KubeObject): UiContent[] {
  const ns = obj.metadata?.namespace ?? null;
  const rows: [string, UiContent][] = [
    ["state", acmeStateText(obj)],
    ["acmeReason", acmeReason(obj)],
    ["request", link(sextant, CERTIFICATE_REQUEST, ownerName(obj, "CertificateRequest"), ns)],
    ["issuer", issuerLink(sextant, issuerRefOf(obj), ns)],
    ["commonName", str(get(obj, "spec", "commonName"))],
    ["dnsNames", ui.chips(arr(get(obj, "spec", "dnsNames")).map((v) => str(v)))],
    ["orderUrl", str(get(obj, "status", "url"))],
    ["failureTime", dateTime(str(get(obj, "status", "failureTime")))],
  ];
  return [explanation(explainOrder(obj)), fieldsOf(rows)];
}

function challengeView(sextant: Sextant, obj: KubeObject): UiContent[] {
  const ns = obj.metadata?.namespace ?? null;
  const rows: [string, UiContent][] = [
    ["state", acmeStateText(obj)],
    ["domain", str(get(obj, "spec", "dnsName"))],
    ["challengeType", challengeType(obj)],
    ["wildcard", yes(get(obj, "spec", "wildcard") === true)],
    ["presented", yes(get(obj, "status", "presented") === true)],
    ["acmeReason", acmeReason(obj)],
    ["order", link(sextant, ORDER, ownerName(obj, "Order"), ns)],
    ["issuer", issuerLink(sextant, issuerRefOf(obj), ns)],
  ];
  return [explanation(explainChallenge(obj)), fieldsOf(rows)];
}

/** The `certmanager` section: one block titled with the kind, as the built-in section's. */
export function fieldsView(sextant: Sextant, kind: ObjectRef["kind"], obj: KubeObject, now: number, blocks: Blocks): HTMLElement | null {
  const content = isKind(kind, CERTIFICATE)
    ? certificateView(sextant, obj, now, blocks)
    : isKind(kind, CERTIFICATE_REQUEST)
      ? requestView(sextant, obj)
      : isKind(kind, ISSUER, CLUSTER_ISSUER)
        ? issuerView(sextant, obj)
        : isKind(kind, ORDER)
          ? orderView(sextant, obj)
          : isKind(kind, CHALLENGE)
            ? challengeView(sextant, obj)
            : null;
  return content ? block(blocks, "fields", kind.kind, content) : null;
}

// ---------- The chain ----------

/** What the chain lists: the namespace's CertificateRequests, Orders and Challenges, and whether one is still coming. */
export interface ChainLists {
  requests: KubeObject[];
  orders: KubeObject[];
  challenges: KubeObject[];
  loading: boolean;
}

function chainItem(sextant: Sextant, kind: KindOf, obj: KubeObject, current: boolean, children: UiContent[] = []): HTMLElement {
  const ns = obj.metadata?.namespace ?? null;
  const name = obj.metadata?.name ?? "";
  const isAcme = isKind(kind, ORDER, CHALLENGE);
  const state = isAcme ? acmeState(obj) : readyStatus(obj);
  const tone = isAcme ? acmeTone(state) : readyTone(state);
  const extra = isKind(kind, CHALLENGE) ? str(get(obj, "spec", "dnsName")) : isAcme ? acmeReason(obj) : readyReason(obj);
  const row = element(
    "span",
    { className: "cm-chain__row" },
    element("span", { className: "cm-chain__kind", textContent: kind.kind }),
    current ? element("strong", { textContent: name }) : link(sextant, kind, name, ns),
    state ? ui.status(state, tone) : null,
    extra ? element("span", { className: "cm-chain__extra", textContent: extra }) : null,
  );
  const item = element("li", { className: "cm-chain__item" }, row);
  if (current) item.setAttribute("aria-current", "true");
  for (const child of children) if (child instanceof Node) item.append(child);
  return item;
}

const muted = (text: string): HTMLElement => element("p", { className: "cm-muted", textContent: text });

/** Certificate → its newest CertificateRequests → their Orders → their Challenges, the opened object marked. */
export function chainView(sextant: Sextant, kind: ObjectRef["kind"], obj: KubeObject, lists: ChainLists): HTMLElement {
  const namespace = obj.metadata?.namespace ?? null;
  const certName = rootCertificateName(obj, kind, lists.requests, lists.orders);
  const uid = obj.metadata?.uid;
  const isCurrent = (o: KubeObject) => (uid ? o.metadata?.uid === uid : o.metadata?.name === obj.metadata?.name);

  if (!certName) return muted(t(lists.loading ? "chain.loading" : "chain.noCertificate"));
  // The Certificate itself is not watched here: a stand-in with its name is enough for the links and the owners.
  const cert: KubeObject = isKind(kind, CERTIFICATE)
    ? obj
    : ({ apiVersion: CM_API, kind: "Certificate", metadata: { name: certName, namespace: namespace ?? undefined } } as KubeObject);
  const all = requestsOf(cert, lists.requests);
  // The newest ones, and always the request the opened object belongs to.
  const holdsCurrent = (r: KubeObject) =>
    isCurrent(r) || ordersOf(r, lists.orders).some((o) => isCurrent(o) || challengesOf(o, lists.challenges).some(isCurrent));
  const shown = all.filter((r, i) => i < CHAIN_REQUESTS || holdsCurrent(r));
  const hidden = all.length - shown.length;

  const ordersOfRequest = (request: KubeObject): HTMLElement | null => {
    const orders = ordersOf(request, lists.orders);
    if (orders.length === 0) return null;
    return element(
      "ul",
      {},
      ...orders.map((order) => {
        const challenges = challengesOf(order, lists.challenges);
        const below = challenges.length > 0 ? [element("ul", {}, ...challenges.map((c) => chainItem(sextant, CHALLENGE, c, isCurrent(c))))] : [];
        return chainItem(sextant, ORDER, order, isCurrent(order), below);
      }),
    );
  };
  const requests =
    shown.length > 0
      ? element("ul", {}, ...shown.map((request) => chainItem(sextant, CERTIFICATE_REQUEST, request, isCurrent(request), [ordersOfRequest(request)])))
      : muted(t(lists.loading ? "chain.loading" : "chain.noRequests"));
  const older = hidden > 0 ? muted(t("chain.older", { count: hidden })) : null;
  return element("ul", { className: "cm-chain" }, chainItem(sextant, CERTIFICATE, cert, isKind(kind, CERTIFICATE), [requests, older]));
}

// ---------- Watches ----------

/**
 * Keeps a watch's objects in the order they came, as Sextant's own watch state keeps them (a map by uid: the list's
 * order first, a new object last, a changed one where it was), and calls `onChange` after every snapshot or delta.
 * The chain sorts by revision and creation, so ties keep this order, as the built-in chain's did.
 */
export function inArrivalOrder(onChange: (objects: KubeObject[]) => void, onOther: (update: WatchUpdate) => void): (update: WatchUpdate) => void {
  let objects = new Map<string, KubeObject>();
  return (update) => {
    switch (update.type) {
      case "snapshot":
        objects = new Map((update.items as unknown as KubeObject[]).map((item) => [objectKey(item), item]));
        onChange([...objects.values()]);
        return;
      case "delta":
        for (const item of update.upserted as unknown as KubeObject[]) objects.set(objectKey(item), item);
        for (const uid of update.deleted) objects.delete(uid);
        onChange([...objects.values()]);
        return;
      default:
        onOther(update);
    }
  };
}

/** A list watched while the chain block is open: its objects and whether the first answer (or a failure) came. */
interface Live {
  items: KubeObject[];
  ready: boolean;
}

/** The kinds the chain lists, in the version the cluster serves; `null` where it serves none; unknown until asked. */
interface Served {
  requests: KindOf | null;
  orders: KindOf | null;
  challenges: KindOf | null;
}

async function servedKinds(sextant: Sextant): Promise<Served> {
  try {
    const kinds = await sextant.kinds();
    const find = (kind: KindOf) => kinds.find((k) => isKind(k.kindRef, kind))?.kindRef ?? null;
    return { requests: find(CERTIFICATE_REQUEST), orders: find(ORDER), challenges: find(CHALLENGE) };
  } catch {
    // Discovery failed: nothing is watched, as the built-in view watched nothing then.
    return { requests: null, orders: null, challenges: null };
  }
}

class ChainWatches {
  private readonly open = new Map<string, { watch: Watch; live: Live }>();
  constructor(
    private readonly sextant: Sextant,
    private readonly changed: () => void,
  ) {}

  /** The lists of `kinds` in `namespace`, each watched from now on; every other watch stops. */
  want(kinds: (KindOf | null)[], namespace: string): (Live | null)[] {
    const keep = new Set<string>();
    const lists = kinds.map((kind) => {
      if (!kind) return null;
      const key = JSON.stringify([kind.group, kind.version, kind.kind, namespace]);
      keep.add(key);
      return (this.open.get(key) ?? this.start(key, kind, namespace)).live;
    });
    for (const [key, entry] of this.open) {
      if (keep.has(key)) continue;
      this.open.delete(key);
      void entry.watch.unwatch().catch(() => undefined);
    }
    return lists;
  }

  private start(key: string, kind: KindOf, namespace: string): { watch: Watch; live: Live } {
    const live: Live = { items: [], ready: false };
    const settle = () => {
      live.ready = true;
      this.changed();
    };
    const watch = this.sextant.resources.watch(
      { kind, namespaces: [namespace] },
      {
        onUpdate: inArrivalOrder(
          (items) => {
            live.items = items;
            settle();
          },
          (other) => {
            if (other.type === "error" || other.type === "forbidden") settle();
          },
        ),
        onError: settle,
      },
    );
    watch.started.catch(() => undefined);
    const entry = { watch, live };
    this.open.set(key, entry);
    return entry;
  }

  stop(): void {
    this.open.forEach((entry) => void entry.watch.unwatch().catch(() => undefined));
    this.open.clear();
  }
}

/**
 * Starts the details section `contribution` on the object in the context: read again whenever its resourceVersion
 * changes; the chain's lists watched while its block is open; drawn again as they change and every minute.
 */
export function startDetails(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  let shownVersion: string | null | undefined;
  let shownRef: string | null = null;
  let reading = 0;
  let object: KubeObject | null = null;
  let kind: ObjectRef["kind"] | null = null;
  let scheduled = false;
  let stopped = false;
  /** The served kinds of the chain, asked once per object; `undefined` while not known. */
  let served: Served | undefined;
  let asking = false;
  // The blocks' choices as Sextant remembers them (`context.blocks`); a choice made here counts until the context that
  // carries it (or any other change of the remembered choices, "Collapse all" among them) comes back.
  const choices = new Map<string, boolean>();
  let rememberedBlocks = JSON.stringify(sextant.context.blocks ?? {});
  const blocks: Blocks = {
    isOpen: (id) => choices.get(id) ?? ui.blockOpen(sextant.context.blocks, id, true),
    toggle: (id, open) => {
      choices.set(id, open);
      void sextant.ui.setBlockOpen(id, open).catch(() => undefined);
      schedule();
    },
  };

  const askKinds = () => {
    if (asking || served) return;
    asking = true;
    const ref = shownRef;
    void servedKinds(sextant).then((answer) => {
      asking = false;
      if (ref !== shownRef) return;
      served = answer;
      schedule();
    });
  };

  const chainLists = (obj: KubeObject): ChainLists | null => {
    const namespace = obj.metadata?.namespace ?? null;
    if (!blocks.isOpen("chain") || !namespace) {
      watches.want([], "");
      return null;
    }
    if (!served) {
      askKinds();
      return { requests: [], orders: [], challenges: [], loading: true };
    }
    const [requests, orders, challenges] = watches.want([served.requests, served.orders, served.challenges], namespace);
    return {
      requests: requests?.items ?? [],
      orders: orders?.items ?? [],
      challenges: challenges?.items ?? [],
      loading: [requests, orders, challenges].some((live) => live !== null && live !== undefined && !live.ready),
    };
  };

  const render = () => {
    if (!object || !kind || stopped) return;
    let view: HTMLElement | null;
    if (contribution === "certmanager") view = fieldsView(sextant, kind, object, Date.now(), blocks);
    else if (contribution === "chain") {
      const lists = chainLists(object);
      // Without a namespace nothing is listed, as the built-in lists watched nothing then.
      const shown = lists ?? { requests: [], orders: [], challenges: [], loading: false };
      view = block(blocks, "chain", t("chain.title"), blocks.isOpen("chain") ? chainView(sextant, kind, object, shown) : null);
    } else view = null;
    // Drawn again on every change: the focus stays on the toggle of the block it was on.
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-block]")?.dataset.block;
    const onToggle = document.activeElement?.classList.contains("sx-block__toggle") ?? false;
    root.replaceChildren(view ?? ui.empty(t("common.nothingToShow", { view: contribution })));
    if (focused && onToggle) root.querySelector<HTMLElement>(`[data-block="${focused}"] .sx-block__toggle`)?.focus();
  };
  const schedule = () => {
    if (scheduled || stopped) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      render();
    });
  };
  const watches = new ChainWatches(sextant, schedule);
  // The days left change with the clock.
  const tick = contribution === "certmanager" ? setInterval(schedule, EXPIRY_TICK_MS) : undefined;

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

  let warnDays = warnDaysOf(sextant.context);
  const follow = () => {
    // The user's warning days changed: the expiry is coloured again.
    const days = warnDaysOf(sextant.context);
    if (days !== warnDays) {
      warnDays = days;
      schedule();
    }
    const nowRemembered = JSON.stringify(sextant.context.blocks ?? {});
    if (nowRemembered !== rememberedBlocks) {
      rememberedBlocks = nowRemembered;
      choices.clear();
      schedule();
    }
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
      served = undefined;
      asking = false;
      watches.stop();
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
    if (tick !== undefined) clearInterval(tick);
    stopFollow();
    watches.stop();
  };
}
