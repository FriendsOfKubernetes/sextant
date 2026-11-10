// The details sections of OLM objects (the manifest's `contributes.detailsSections`, one per kind):
//   subscription       — package, channel, catalog, approval, installed and current CSV with its InstallPlan (both
//                        watched by name while the section shows, for their phases) and the catalogs' health;
//   csv                — phase, requirements, owned and required CRDs, the Deployments of its install strategy (watched
//                        by OLM's owner labels while their block is open, at most 50) and install modes, the
//                        Subscription that installed it (of at most 500 in its namespace); a copy in a target namespace
//                        says it is one and links its original;
//   install-plan       — approval, CSVs, why it failed, bundle lookups and steps (never a step's manifest);
//   catalog-source, operator-group, operator, cluster-extension, cluster-catalog — see ./views.ts.
// Each frame reads the shown object again whenever its resourceVersion changes. Its blocks open and close as the
// built-in panel's did, in Sextant's own memory of details sections (`BlockMemory`). Conditions, events and YAML are
// Sextant's own sections. Read-only: nothing is approved or changed (ADR-0121).
import { trackObjects, ui, type KubeObject, type ObjectRef, type Sextant, type UiContent, type UiTone, type Watch, type WatchParams } from "@sextant/extension-sdk";
import { dateTime, errorText, note, reasonText, remark } from "./dom";
import { t } from "./i18n";
import {
  bundleLookupsOf,
  catalogHealthOf,
  conditionOf,
  copiedFrom,
  crdsOf,
  CSV,
  csvInfo,
  DEPLOYMENT,
  deploymentSelector,
  INSTALL_PLAN,
  installModesOf,
  installPlanInfo,
  isCopy,
  MAX_DEPLOYMENTS,
  MAX_STEPS,
  MAX_SUBSCRIPTIONS,
  phaseTone,
  planPhaseTone,
  readyOfDesired,
  requirementsOf,
  requirementTone,
  stepsOf,
  stepTone,
  strategyDeployments,
  STATE_CONDITION,
  SUBSCRIPTION,
  SUBSCRIPTION_TONE,
  subscriptionInfo,
  subscriptionState,
  unmetRequirements,
  CATALOG_SOURCE,
  CRD,
  type CrdDescription,
} from "./model";
import { catalogSourceView, clusterCatalogView, clusterExtensionView, fieldsOf, link, operatorGroupView, operatorView } from "./views";

/**
 * A list watched while the section shows: its objects, whether the first answer came, whether it failed, and whether
 * more objects match than it keeps (`maxObjects`, the built-in view's caps).
 */
export interface Live {
  items: KubeObject[];
  ready: boolean;
  failed: boolean;
  truncated: boolean;
}

/** The lists a section watches besides its object, by name; `null` when it needs none of that name. */
export type Related = Record<string, Live | undefined>;

const present = (nodes: (Node | null | false | undefined)[]): Node[] => nodes.filter((n): n is Node => Boolean(n));

/**
 * Which blocks of the section are open, in Sextant's own memory of details sections (the context's `blocks`, kept as
 * Settings → Appearance says — globally, per cluster or for this object — with the panel's "Expand all" and "Collapse
 * all"), as the built-in panel's blocks: open unless the user closed one. A toggle is written back with
 * `ui.setBlockOpen` and holds here until Sextant's context tells the choices again.
 */
export class BlockMemory {
  /** Toggles not yet in the context. */
  private pending: Record<string, boolean> = {};
  private told: string;
  constructor(
    private readonly sextant: Sextant,
    /** Called after a toggle: the section draws again (a block's lists are watched only while it is open). */
    private readonly toggled: () => void = () => undefined,
  ) {
    this.told = JSON.stringify(sextant.context.blocks ?? {});
  }

  /** Whether the context's choices changed since last asked (they then replace the toggles held here). */
  contextChanged(): boolean {
    const now = JSON.stringify(this.sextant.context.blocks ?? {});
    if (now === this.told) return false;
    this.told = now;
    this.pending = {};
    return true;
  }

  isOpen(id: string): boolean {
    return this.pending[id] ?? ui.blockOpen(this.sextant.context.blocks, id, true);
  }

  /** A titled block, closable with its title (`id` is stable: never a name or a translated title). */
  block(id: string, title: string, content: UiContent): HTMLElement {
    const node = ui.block(title, content, {
      collapsible: true,
      collapsed: !this.isOpen(id),
      onToggle: (open) => {
        this.pending[id] = open;
        void this.sextant.ui.setBlockOpen(id, open).catch(() => undefined);
        this.toggled();
      },
    });
    node.dataset.block = id;
    return node;
  }
}

const status = (text: string | undefined, tone: UiTone): HTMLElement | null => (text ? ui.status(text, tone) : null);

function csvPhase(obj: KubeObject): HTMLElement | null {
  const info = csvInfo(obj);
  if (!info.phase) return null;
  const node = ui.status(info.phase, phaseTone(info.phase));
  const title = reasonText(info.reason, info.message);
  if (title) node.title = title;
  return node;
}

function subscriptionStateText(obj: KubeObject): HTMLElement {
  const state = subscriptionState(obj);
  const node = ui.status(t(`subscriptionState.${state}`), SUBSCRIPTION_TONE[state]);
  const type = STATE_CONDITION[state];
  const message = type ? conditionOf(obj, type)?.message : undefined;
  if (message) node.title = message;
  return node;
}

// ---------- Subscription ----------

/** What a Subscription's section watches: its InstallPlan and its installed CSV, each by name. */
export function subscriptionWatches(obj: KubeObject): Record<string, Omit<WatchParams, "clusterId"> | null> {
  const ns = obj.metadata.namespace;
  const info = subscriptionInfo(obj);
  const plan = info.installPlan;
  return {
    plan: plan?.namespace && plan.name ? { kind: INSTALL_PLAN, namespaces: [plan.namespace], fieldSelector: `metadata.name=${plan.name}`, maxObjects: 1 } : null,
    installed: ns && info.installedCSV ? { kind: CSV, namespaces: [ns], fieldSelector: `metadata.name=${info.installedCSV}`, maxObjects: 1 } : null,
  };
}

export function subscriptionView(sextant: Sextant, obj: KubeObject, related: Related, blocks: BlockMemory): Node[] {
  const ns = obj.metadata.namespace ?? null;
  const info = subscriptionInfo(obj);
  const state = subscriptionState(obj);
  const plan = related.plan?.items[0];
  const installed = related.installed?.items[0];
  const planPhase = plan ? installPlanInfo(plan).phase : undefined;
  const resolution = conditionOf(obj, "ResolutionFailed");
  const planFailed = conditionOf(obj, "InstallPlanFailed");
  const health = catalogHealthOf(obj).map((h) => [
    link(sextant, CATALOG_SOURCE, h.name, h.namespace ?? null),
    ui.status(h.healthy ? t("healthy") : t("unhealthy"), h.healthy ? "success" : "danger"),
    dateTime(h.lastUpdated),
  ]);
  const healthHeaders = ["catalog", "health", "lastUpdated"].map((h) => t(`catalogHealth.${h}`));
  return present([
    state === "resolutionFailed" && note(reasonText(resolution?.reason, resolution?.message) || t("noReason"), "danger"),
    state === "installPlanFailed" && note(reasonText(planFailed?.reason, planFailed?.message) || t("noReason"), "danger"),
    state === "waitingApproval" && note(t("waitingApproval", { plan: info.installPlan?.name ?? "" }), "warning"),
    (state === "upgradePending" || state === "waitingApproval") &&
      info.installedCSV !== undefined &&
      info.currentCSV !== undefined &&
      info.installedCSV !== info.currentCSV &&
      remark(t("upgradePending", { installed: info.installedCSV, current: info.currentCSV })),
    fieldsOf([
      ["state", subscriptionStateText(obj)],
      ["package", info.packageName],
      ["channel", info.channel],
      ["catalogSource", link(sextant, CATALOG_SOURCE, info.source, info.sourceNamespace ?? null)],
      ["approval", info.approval],
      ["startingCSV", info.startingCSV],
      ["installedCSV", link(sextant, CSV, info.installedCSV, ns)],
      ["installedPhase", installed ? csvPhase(installed) : null],
      ["currentCSV", info.currentCSV && info.currentCSV !== info.installedCSV ? link(sextant, CSV, info.currentCSV, ns) : info.currentCSV],
      ["installPlan", link(sextant, INSTALL_PLAN, info.installPlan?.name, info.installPlan?.namespace ?? null)],
      ["installPlanPhase", planPhase ? ui.status(planPhase, planPhaseTone(planPhase)) : null],
      ["subscriptionState", info.state],
      ["lastUpdated", dateTime(info.lastUpdated)],
    ]),
    health.length > 0 && blocks.block("catalogHealth", t("catalogHealth.title"), ui.table(healthHeaders, health, { label: t("catalogHealth.title"), id: "catalogHealth", sextant, nowrap: [true, true, true] })),
  ]);
}

// ---------- ClusterServiceVersion ----------

/**
 * What a CSV's section watches: the Subscriptions of its namespace (at most 500), and the Deployments OLM made for it
 * (at most 50) while their block is open. A copy, none.
 */
export function csvWatches(obj: KubeObject, deploymentsOpen = true): Record<string, Omit<WatchParams, "clusterId"> | null> {
  const ns = obj.metadata.namespace;
  if (!ns || isCopy(obj)) return { subscriptions: null, deployments: null };
  const selector = deploymentSelector(obj);
  return {
    subscriptions: { kind: SUBSCRIPTION, namespaces: [ns], maxObjects: MAX_SUBSCRIPTIONS },
    deployments:
      deploymentsOpen && strategyDeployments(obj).length > 0 && selector
        ? { kind: DEPLOYMENT, namespaces: [ns], labelSelector: selector, maxObjects: MAX_DEPLOYMENTS }
        : null,
  };
}

function crdTable(sextant: Sextant, blocks: BlockMemory, id: string, title: string, crds: CrdDescription[]): HTMLElement | null {
  if (crds.length === 0) return null;
  const rows = crds.map((c) => [link(sextant, CRD, c.name), c.kind ?? "", c.version ?? "", c.displayName ?? ""]);
  const headers = ["name", "kind", "version", "displayName"].map((h) => t(`crds.${h}`));
  return blocks.block(id, title, ui.table(headers, rows, { label: title, id, sextant, nowrap: [false, true, true, false] }));
}

function deploymentsBlock(sextant: Sextant, obj: KubeObject, deployments: Live | undefined, blocks: BlockMemory): HTMLElement | null {
  const ns = obj.metadata.namespace ?? null;
  const names = strategyDeployments(obj);
  if (names.length === 0) return null;
  const byName = new Map((deployments?.items ?? []).map((d) => [d.metadata.name, d]));
  const loading = deployments !== undefined && !deployments.ready;
  // Without a watch (a name too long to be a label value, or the block closed), with a failed one or one that keeps
  // only the first 50, a missing Deployment cannot be told.
  const unknown = deployments === undefined || deployments.failed || deployments.truncated;
  const rows = names.map((name) => {
    const dep = byName.get(name);
    if (!dep) {
      const text = loading ? t("loading") : unknown ? t("cannotTell") : t("deploymentMissing");
      return [link(sextant, DEPLOYMENT, name, ns), "", ui.status(text, loading || unknown ? "neutral" : "danger")];
    }
    const available = conditionOf(dep, "Available");
    const ok = available?.status === "True";
    const word = ui.status(ok ? t("available") : t("notAvailable"), ok ? "success" : "warning");
    if (available?.message) word.title = available.message;
    return [link(sextant, DEPLOYMENT, name, ns), readyOfDesired(dep), word];
  });
  const headers = ["name", "ready", "state"].map((h) => t(`deployments.${h}`));
  return blocks.block("deployments", t("deployments.title"), [
    ui.table(headers, rows, { label: t("deployments.title"), id: "csvDeployments", sextant, nowrap: [false, true, true] }),
    deployments?.truncated ? remark(t("truncated", { max: MAX_DEPLOYMENTS })) : null,
  ]);
}

function copyView(sextant: Sextant, obj: KubeObject): Node[] {
  const from = copiedFrom(obj);
  const info = csvInfo(obj);
  return present([
    remark(from ? t("copyOf", { namespace: from }) : t("copy")),
    fieldsOf([
      ["phase", csvPhase(obj)],
      ["original", from ? link(sextant, CSV, obj.metadata.name, from, `${from}/${obj.metadata.name}`) : null],
      ["displayName", info.displayName],
      ["version", info.version],
    ]),
  ]);
}

export function csvView(sextant: Sextant, obj: KubeObject, related: Related, blocks: BlockMemory): Node[] {
  if (isCopy(obj)) return copyView(sextant, obj);
  const ns = obj.metadata.namespace ?? null;
  const info = csvInfo(obj);
  const unmet = unmetRequirements(obj);
  const modes = installModesOf(obj);
  const installedBy = related.subscriptions?.items.find((s) => subscriptionInfo(s).installedCSV === obj.metadata.name);
  const requirements = requirementsOf(obj).map((r) => [
    [r.group, r.version, r.kind].filter(Boolean).join("/"),
    r.name,
    ui.status(r.status, requirementTone(r.status)),
    r.message ?? "",
  ]);
  const reqHeaders = ["kind", "name", "status", "message"].map((h) => t(`requirements.${h}`));
  return present([
    info.phase === "Failed" && note(reasonText(info.reason, info.message) || t("noReason"), "danger"),
    unmet.length > 0 && note(t("requirementsUnmet", { count: unmet.length }), "warning"),
    fieldsOf([
      ["phase", csvPhase(obj)],
      ["reason", info.phase === "Failed" ? null : info.reason],
      ["message", info.phase === "Failed" ? null : info.message],
      ["since", dateTime(info.since)],
      ["displayName", info.displayName],
      ["version", info.version],
      ["provider", info.provider],
      ["replaces", link(sextant, CSV, info.replaces, ns)],
      ["skips", ui.chips(info.skips)],
      ["minKubeVersion", info.minKubeVersion],
      ["installedBy", installedBy ? link(sextant, SUBSCRIPTION, installedBy.metadata.name, ns) : null],
      ["installModes", ui.chips(modes.filter((m) => m.supported).map((m) => m.type))],
      ["unsupportedModes", ui.chips(modes.filter((m) => !m.supported).map((m) => m.type))],
    ]),
    requirements.length > 0 && blocks.block("requirements", t("requirements.title"), ui.table(reqHeaders, requirements, { label: t("requirements.title"), id: "csvRequirements", sextant, nowrap: [true, false, true, false] })),
    crdTable(sextant, blocks, "ownedCrds", t("crds.owned"), crdsOf(obj, "owned")),
    crdTable(sextant, blocks, "requiredCrds", t("crds.required"), crdsOf(obj, "required")),
    deploymentsBlock(sextant, obj, related.deployments, blocks),
  ]);
}

// ---------- InstallPlan ----------

export function installPlanView(sextant: Sextant, obj: KubeObject, blocks: BlockMemory): Node[] {
  const ns = obj.metadata.namespace ?? null;
  const info = installPlanInfo(obj);
  const { steps, total } = stepsOf(obj);
  const stepRows = steps.map((s) => [s.resolving, [s.group, s.version, s.kind].filter(Boolean).join("/"), s.name, ui.status(s.status, stepTone(s.status))]);
  const stepHeaders = ["resolving", "kind", "name", "status"].map((h) => t(`steps.${h}`));
  const lookups = bundleLookupsOf(obj).map((b) => [
    b.path,
    b.identifier,
    b.condition ? ui.status(reasonText(b.condition.type, b.condition.message), b.condition.type === "BundleLookupFailed" ? "danger" : "warning") : "",
  ]);
  const lookupHeaders = ["path", "identifier", "state"].map((h) => t(`lookups.${h}`));
  const failure = info.failure ? reasonText(info.failure.reason, info.failure.message) : info.message;
  return present([
    info.phase === "RequiresApproval" && note(t("planNeedsApproval"), "warning"),
    info.phase === "Failed" && note(failure || t("noReason"), "danger"),
    fieldsOf([
      ["phase", status(info.phase, planPhaseTone(info.phase))],
      ["approval", info.approval],
      ["approved", info.approved ? t("yes") : t("no")],
      ["csvs", info.csvNames.length > 0 ? ui.inline(info.csvNames.map((n) => link(sextant, CSV, n, ns))) : null],
      ["catalogSource", link(sextant, CATALOG_SOURCE, info.source, info.sourceNamespace ?? null)],
      ["startTime", dateTime(info.startTime)],
    ]),
    lookups.length > 0 && blocks.block("lookups", t("lookups.title"), ui.table(lookupHeaders, lookups, { label: t("lookups.title"), id: "planLookups", sextant, nowrap: [false, true, false] })),
    stepRows.length > 0 &&
      blocks.block("steps", t("steps.title"), [
        ui.table(stepHeaders, stepRows, { label: t("steps.title"), id: "planSteps", sextant, nowrap: [false, true, false, true] }),
        total > steps.length ? remark(t("moreSteps", { shown: steps.length, total, max: MAX_STEPS })) : null,
      ]),
  ]);
}

// ---------- The section ----------

/** What each section watches besides its object (a block's lists only while it is open). */
function watchesOf(contribution: string, obj: KubeObject, blocks: BlockMemory): Record<string, Omit<WatchParams, "clusterId"> | null> {
  if (contribution === "subscription") return subscriptionWatches(obj);
  if (contribution === "csv") return csvWatches(obj, blocks.isOpen("deployments"));
  return {};
}

/** The section's content for its object and the lists it watches. */
export function sectionView(sextant: Sextant, contribution: string, obj: KubeObject, related: Related, blocks: BlockMemory): Node[] {
  switch (contribution) {
    case "subscription":
      return subscriptionView(sextant, obj, related, blocks);
    case "csv":
      return csvView(sextant, obj, related, blocks);
    case "install-plan":
      return installPlanView(sextant, obj, blocks);
    case "catalog-source":
      return catalogSourceView(sextant, obj);
    case "operator-group":
      return operatorGroupView(sextant, obj);
    case "operator":
      return operatorView(sextant, obj, blocks);
    case "cluster-extension":
      return clusterExtensionView(sextant, obj);
    case "cluster-catalog":
      return clusterCatalogView(obj);
    default:
      return [ui.empty(t("common.nothingToShow", { view: contribution }))];
  }
}

/** The watches a section holds, by what they watch: started when first wanted, stopped when no longer. */
class Watches {
  private readonly open = new Map<string, { watch: Watch; live: Live }>();
  constructor(
    private readonly sextant: Sextant,
    private readonly changed: () => void,
  ) {}

  /** The lists of `specs` (by name), each watched from now on; every other watch stops. */
  want(specs: Record<string, Omit<WatchParams, "clusterId"> | null>): Related {
    const keep = new Set<string>();
    const related: Related = {};
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
    const live: Live = { items: [], ready: false, failed: false, truncated: false };
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
      onCapped: (total) => {
        live.truncated = spec.maxObjects !== undefined && total > spec.maxObjects;
        this.changed();
      },
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

/**
 * Starts the details section `contribution` on the object in the context: read again whenever its resourceVersion
 * changes; the lists it needs besides (a Subscription's plan and CSV, a CSV's Subscriptions and Deployments) watched
 * while it shows, and drawn again as they change.
 */
export function startDetails(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  let shownVersion: string | null | undefined;
  let shownRef: string | null = null;
  let reading = 0;
  let object: KubeObject | null = null;
  let scheduled = false;
  let stopped = false;

  const render = () => {
    if (!object || stopped) return;
    const related = watches.want(watchesOf(contribution, object, blocks));
    const nodes = sectionView(sextant, contribution, object, related, blocks);
    // Drawn again on every change: a block's toggle that had the focus keeps it.
    const focused = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : null;
    const focusedBlock = focused?.classList.contains("sx-block__toggle") ? focused.closest<HTMLElement>("[data-block]")?.dataset.block : undefined;
    root.replaceChildren(...nodes);
    if (focusedBlock !== undefined) root.querySelector<HTMLElement>(`[data-block="${focusedBlock}"] .sx-block__toggle`)?.focus();
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
  const blocks = new BlockMemory(sextant, schedule);

  const read = async (ref: ObjectRef) => {
    const attempt = ++reading;
    try {
      const fresh = await sextant.resources.get({ ref });
      if (attempt !== reading) return;
      object = fresh;
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
    if (version === shownVersion) return;
    shownVersion = version;
    void read(ref);
  };
  follow();
  const stopFollow = sextant.onContextChange(() => {
    follow();
    // "Expand all", "Collapse all", or a choice written here: drawn again, a block's lists watched as it now is.
    if (blocks.contextChanged()) schedule();
  });
  return () => {
    stopped = true;
    stopFollow();
    watches.stop();
  };
}
