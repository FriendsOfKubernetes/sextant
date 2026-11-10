// The details sections of the extension (the manifest's `contributes.detailsSections`), as Sextant's former built-in
// view drew them (ADR-0111):
//   `vpa` on a VerticalPodAutoscaler — its state from the conditions with the recommender's message and what it means,
//     the update mode explained, a link to the target, an HPA that fights it, the recommendation per container against
//     the target template's requests and limits with what a pod created now would get (admission.ts), and the VPA
//     components found in the cluster with what a missing one means for this VPA;
//   `workload` on a Deployment, StatefulSet, DaemonSet, ReplicaSet, Job or CronJob — one block "Vertical Pod
//     Autoscaler" with the VPAs of its namespace that target it, each with its state, mode, an HPA that fights it and
//     its recommendation against this workload's template; hidden (the manifest's `startHidden`) where the cluster
//     serves no VPAs or, while the block is open, none targets the workload.
// Neither section has a heading of its own, as the built-in ones had none. The blocks open and close in Sextant's own
// memory of details sections (the context's `blocks`, `ui.setBlockOpen`), so "Expand all", "Collapse all" and
// Settings → Appearance apply to them. What a view lists besides its object is watched as the built-in view watched it:
// a VPA's target by its name and its namespace's HPAs while the VPA is shown; the components (the manifests' three
// Deployments in kube-system and the charts' Deployments by label) while their block is open; a workload's namespace's
// VPAs while its block is open, and the namespace's HPAs only while a VPA targets the workload. The frame reads the
// shown object again whenever its resourceVersion changes. Conditions, events and YAML are Sextant's own sections.
// Read-only.
import { trackObjects, ui, type KubeObject, type ObjectRef, type Sextant, type UiContent, type Watch, type WatchParams } from "@sextant/extension-sdk";
import { baseUnits, templateChanges, templateContainers, type ContainerChange, type ResourceChange } from "./admission";
import { CHART_SELECTOR, COMPONENTS, groupComponents, MANIFEST_NAMES, MANIFEST_NAMESPACE, missingMeaning } from "./components";
import { conflictsOf, valueOverlapsOf } from "./conflicts";
import { dateTime, element, errorText, formatList, paragraph } from "./dom";
import { formatAmount } from "./format";
import { t } from "./i18n";
import {
  containerPoliciesOf,
  DEPLOYMENT,
  get,
  HPA,
  isTargetKind,
  isVpa,
  kindFromApiVersion,
  minReplicasOf,
  modeIsDefault,
  modeKey,
  recommendationsOf,
  recommenderOf,
  STATE_TONE,
  statusOf,
  str,
  targetOf,
  targets,
  updateModeOf,
  VPA,
  type KindOf,
  type TargetRef,
} from "./model";

/** Block ids in Sextant's memory of details sections. */
export const BLOCKS = { recommendation: "recommendation", components: "components", workload: "workload" } as const;

/** A list watched while it is wanted: its objects, whether the first answer came, whether it failed. */
export interface Live {
  items: KubeObject[];
  ready: boolean;
  failed: boolean;
}

/** The blocks of a section: whether one is open, and `toggle`, which remembers a change and draws again. */
export interface Blocks {
  isOpen(id: string): boolean;
  toggle(id: string, open: boolean): void;
}

/** Every block open, nothing remembered. */
export const ALL_OPEN: Blocks = { isOpen: () => true, toggle: () => undefined };

/** What Sextant's kinds say: whether a group and kind is served; `undefined` while not known. */
export type Served = (kind: Pick<KindOf, "group" | "kind">) => boolean | undefined;

/** A collapsible block, open unless the user closed it. */
function block(blocks: Blocks, id: string, title: string, content: UiContent): HTMLElement {
  const node = ui.block(title, content, { collapsible: true, collapsed: !blocks.isOpen(id), onToggle: (open) => blocks.toggle(id, open) });
  node.dataset.block = id;
  return node;
}

/** A link to an object's details in Sextant's panel; nothing without a name. */
function link(sextant: Sextant, kind: KindOf, name: string | undefined, namespace: string | null, text?: string): HTMLElement | null {
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

/**
 * A table whose columns marked `true` stay on one line and the others wrap between words, its column widths resized and
 * remembered under `id` (the built-in table's own word); nothing without rows (as the built-in `table`).
 */
function tableOf(sextant: Sextant, id: string, headers: readonly string[], rows: readonly (readonly UiContent[])[], nowrap: readonly boolean[]): HTMLElement | null {
  if (rows.length === 0) return null;
  return ui.table(headers, rows, { id, sextant, nowrap });
}

// ---------- Pieces shared by both sections ----------

/** The state in words, coloured; the deciding condition's message as its tooltip. */
export function stateCell(vpa: KubeObject): HTMLElement {
  const s = statusOf(vpa);
  const span = element("span", {}, ui.status(t(`reason.${s.reason}`), STATE_TONE[s.state]));
  if (s.message) span.title = s.message;
  return span;
}

/** The update mode and when changes reach the pods. */
const modeText = (vpa: KubeObject): string => {
  const mode = updateModeOf(vpa);
  return t(`modeExplain.${modeKey(mode)}`, { mode });
};

/** An amount as people read it, or the "not set" text. */
const amount = (resource: string, value: number | undefined): string => (value === undefined ? t("table.unset") : formatAmount(resource, baseUnits(resource, value)));

const CHANGES_NOWRAP = [true, true, true, true, false, true];

/**
 * The containers of the target's template with the VPA's recommendation and what a new pod would get; `id` the table
 * whose widths Sextant keeps (the VPA's and a workload's apart, as the built-in ones).
 */
export function changesTable(sextant: Sextant, id: string, vpa: KubeObject, target: KubeObject): Node[] {
  const mode = updateModeOf(vpa);
  const recommendations = recommendationsOf(vpa);
  const changes = templateChanges(target, containerPoliciesOf(vpa), recommendations);
  const inTemplate = new Set(changes.map((c) => c.container));
  const extra = recommendations.filter((r) => !inTemplate.has(r.container)).map((r) => r.container);
  const pair = (resource: string, a: number | undefined, b: number | undefined) => t("table.pair", { request: amount(resource, a), limit: amount(resource, b) });
  const after = (c: ContainerChange, r: ResourceChange): string => {
    if (mode === "Off") return t("table.unchangedOff");
    if (c.state !== "scaled" || r.newRequest === undefined) return t("table.unchanged");
    return pair(r.resource, r.newRequest, r.newLimit ?? r.limit);
  };
  const targetCell = (r: ResourceChange): string => {
    if (r.target === undefined) return t("table.noTarget");
    const lines = [amount(r.resource, r.target)];
    if (r.uncappedTarget !== undefined && r.uncappedTarget !== r.target) lines.push(t("table.uncapped", { value: amount(r.resource, r.uncappedTarget) }));
    if (r.capped) lines.push(t(`table.capped.${r.capped}`));
    return lines.join(" · ");
  };
  const rows: UiContent[][] = [];
  for (const c of changes) {
    if (c.state === "off") {
      rows.push([c.container, t("table.allResources"), "", "", t("table.containerOff"), ""]);
      continue;
    }
    for (const r of c.resources) {
      rows.push([
        c.container,
        r.resource,
        pair(r.resource, r.request, r.limit),
        r.lowerBound === undefined && r.upperBound === undefined ? "" : t("table.rangeValue", { lower: amount(r.resource, r.lowerBound), upper: amount(r.resource, r.upperBound) }),
        targetCell(r),
        after(c, r),
      ]);
    }
  }
  const headers = ["container", "resource", "now", "range", "target", "after"].map((h) => t(`table.${h}`));
  const view = tableOf(sextant, id, headers, rows, CHANGES_NOWRAP);
  const requestsOnly = changes.some((c) => c.state === "scaled" && c.controlledValues === "RequestsOnly");
  const out: Node[] = [view ?? paragraph("muted", t("table.noContainers"))];
  if (extra.length > 0) out.push(paragraph("muted", t("table.notInTemplate", { containers: formatList(extra) })));
  out.push(paragraph("muted", t(requestsOnly ? "table.howRequestsOnly" : "table.how")));
  out.push(paragraph("muted", t("table.notModelled")));
  return out;
}

/** The HPAs that fight the VPA, as a danger line; those on an AverageValue as a note; nothing without either. */
export function conflictLines(vpa: KubeObject, hpas: readonly KubeObject[], target?: KubeObject): Node[] {
  const containers = target ? templateContainers(target).map((c) => str(get(c, "name")) ?? "") : undefined;
  const conflicts = conflictsOf(vpa, hpas, containers);
  const byValue = valueOverlapsOf(vpa, hpas, containers);
  const mode = updateModeOf(vpa);
  const out: Node[] = [];
  for (const c of conflicts) out.push(paragraph("danger", ui.status(t("conflict.line", { hpa: c.hpa, mode, resources: formatList(c.resources) }), "danger")));
  if (conflicts.length > 0) out.push(paragraph("muted", t("conflict.why")));
  for (const c of byValue) out.push(paragraph("note", t("conflict.valueLine", { hpa: c.hpa, mode, resources: formatList(c.resources) })));
  return out;
}

// ---------- A VPA ----------

/** The deciding condition's message and what it means. */
function stateNote(vpa: KubeObject): Node[] {
  const s = statusOf(vpa);
  const out: Node[] = [];
  if (s.message) out.push(paragraph(s.state === "failed" ? "message" : "note", s.message));
  if (s.reason !== "provided") out.push(paragraph("note", t(`hint.${s.reason}`)));
  if (s.noPodsNow) out.push(paragraph("note", t("hint.noPodsNow")));
  if (s.deprecated) out.push(paragraph("note", t("hint.deprecated")));
  return out;
}

const targetKind = (ref: TargetRef): KindOf => kindFromApiVersion(ref.apiVersion, ref.kind);

/** What the VPA section watches: its target by name, its namespace's HPAs, and the components while their block is open. */
export interface VpaLists {
  target?: Live;
  hpas?: Live;
  components?: Live[];
}

function recommendationView(sextant: Sextant, vpa: KubeObject, ref: TargetRef, lists: VpaLists, served: Served, blocks: Blocks): Node[] {
  const target = lists.target?.ready && !lists.target.failed ? lists.target.items.find((o) => o.metadata.name === ref.name) : undefined;
  let body: Node;
  if (served({ group: ref.group, kind: ref.kind }) === false) body = paragraph("note", t("target.notServed", { kind: ref.kind }));
  else if (!target) body = paragraph("muted", t("target.notRead"));
  else body = element("div", {}, ...changesTable(sextant, "recommendation", vpa, target));
  return [...conflictLines(vpa, lists.hpas?.items ?? [], target), block(blocks, BLOCKS.recommendation, t("recommendation.title"), body)];
}

/** The recommender, updater and admission controller found in the cluster, and what a missing one means. */
function componentsView(sextant: Sextant, vpa: KubeObject, lists: Live[] | undefined, blocks: Blocks): HTMLElement {
  const title = t("components.title");
  const states = lists ?? [];
  const error = states.some((s) => s.failed);
  const readable = states.filter((s) => !s.failed);
  if (states.length === 0 || readable.some((s) => !s.ready)) return block(blocks, BLOCKS.components, title, paragraph("muted", t("loading")));
  const found = groupComponents(readable.flatMap((s) => s.items));
  const mode = updateModeOf(vpa);
  // A recommendation in the status shows a recommender works, whatever the conditions say now.
  const provided = recommendationsOf(vpa).length > 0 || statusOf(vpa).state === "ready";
  const rows: UiContent[][] = [];
  const notes: string[] = [];
  for (const c of COMPONENTS) {
    const list = found[c];
    if (list.length === 0) {
      rows.push([t(`components.name.${c}`), ui.status(t(error ? "components.unknown" : "components.notFound"), "warning"), ""]);
      const meaning = missingMeaning(c, mode);
      // A recommendation in the status shows a recommender works, even where it runs outside the cluster (GKE).
      if (meaning && !(c === "recommender" && provided)) notes.push(t(`components.missing.${meaning}`));
      continue;
    }
    for (const d of list) {
      const tone = d.ready >= d.desired && d.desired > 0 ? "success" : "danger";
      rows.push([t(`components.name.${c}`), ui.status(t("components.ready", { ready: d.ready, desired: d.desired }), tone), link(sextant, DEPLOYMENT, d.name, d.namespace)]);
    }
  }
  const missing = COMPONENTS.some((c) => found[c].length === 0);
  const headers = ["component", "state", "deployment"].map((h) => t(`components.${h}`));
  return block(blocks, BLOCKS.components, title, [
    tableOf(sextant, "components", headers, rows, [true, true, false]),
    ...notes.map((n) => paragraph("note", n)),
    missing && paragraph("muted", t("components.managed")),
  ]);
}

export function vpaView(sextant: Sextant, vpa: KubeObject, lists: VpaLists, served: Served, blocks: Blocks): Node[] {
  const ns = vpa.metadata.namespace ?? null;
  const ref = targetOf(vpa);
  const s = statusOf(vpa);
  const minReplicas = minReplicasOf(vpa);
  const fields = fieldsOf([
    ["status", stateCell(vpa)],
    ["since", dateTime(s.since)],
    ["target", ref ? link(sextant, targetKind(ref), ref.name, ns, `${ref.kind}/${ref.name}`) : t("target.missing")],
    ["mode", modeIsDefault(vpa) ? t("fields.modeDefault", { mode: updateModeOf(vpa) }) : updateModeOf(vpa)],
    ["modeExplained", modeText(vpa)],
    ["minReplicas", minReplicas === undefined ? null : String(minReplicas)],
    ["recommender", recommenderOf(vpa)],
  ]);
  return [
    ...(fields ? [fields] : []),
    ...stateNote(vpa),
    ...(ref ? recommendationView(sextant, vpa, ref, lists, served, blocks) : []),
    componentsView(sextant, vpa, lists.components, blocks),
  ];
}

/** The lists the VPA section watches now. */
export function vpaWatches(vpa: KubeObject, served: Served, blocks: Blocks): Record<string, Omit<WatchParams, "clusterId"> | null> {
  const ns = vpa.metadata.namespace;
  const ref = targetOf(vpa);
  const specs: Record<string, Omit<WatchParams, "clusterId"> | null> = {};
  if (ref && ns && served({ group: ref.group, kind: ref.kind }) === true) {
    specs.target = { kind: { group: ref.group, kind: ref.kind }, namespaces: [ns], fieldSelector: `metadata.name=${ref.name}` };
  }
  if (ref && ns && served(HPA) === true) specs.hpas = { kind: { group: HPA.group, kind: HPA.kind }, namespaces: [ns] };
  if (blocks.isOpen(BLOCKS.components)) {
    for (const c of COMPONENTS) {
      specs[`component:${c}`] = { kind: { group: DEPLOYMENT.group, kind: DEPLOYMENT.kind }, namespaces: [MANIFEST_NAMESPACE], fieldSelector: `metadata.name=${MANIFEST_NAMES[c]}` };
    }
    specs["component:charts"] = { kind: { group: DEPLOYMENT.group, kind: DEPLOYMENT.kind }, labelSelector: CHART_SELECTOR };
  }
  return specs;
}

// ---------- A workload's VPAs ----------

const VPA_LINK: KindOf = VPA;

/** The VPAs of the workload's namespace that target it, by name. */
export function vpasOf(list: Live | undefined, kind: Pick<KindOf, "group" | "kind">, name: string): KubeObject[] {
  return (list?.items ?? [])
    .filter((v) => targets(targetOf(v), kind, name))
    .sort((a, b) => (a.metadata.name ?? "").localeCompare(b.metadata.name ?? ""));
}

/** The workload's block, or nothing where it draws nothing (no VPAs served, or, open, none targeting it). */
export function workloadView(
  sextant: Sextant,
  obj: KubeObject,
  kind: Pick<KindOf, "group" | "kind">,
  lists: { vpas?: Live; hpas?: Live },
  served: Served,
  blocks: Blocks,
): HTMLElement | null {
  const namespace = obj.metadata.namespace ?? null;
  if (!namespace || served(VPA) !== true) return null;
  const open = blocks.isOpen(BLOCKS.workload);
  const vpas = vpasOf(lists.vpas, kind, obj.metadata.name);
  if (open && vpas.length === 0) return null;
  const hpas = lists.hpas?.items ?? [];
  const content: UiContent[] = [];
  if (vpas.length > 1) content.push(paragraph("note", t("workload.several", { count: vpas.length })));
  for (const vpa of vpas) {
    const one = element("div", { className: "sx-block" });
    const rows = fieldsOf([
      ["vpa", link(sextant, VPA_LINK, vpa.metadata.name, namespace)],
      ["status", stateCell(vpa)],
      ["mode", updateModeOf(vpa)],
      ["modeExplained", modeText(vpa)],
    ]);
    one.append(...(rows ? [rows] : []), ...conflictLines(vpa, hpas, obj), ...changesTable(sextant, "workload", vpa, obj));
    content.push(one);
  }
  return block(blocks, BLOCKS.workload, t("workload.title"), content);
}

/** The lists the workload section watches now. */
export function workloadWatches(obj: KubeObject, kind: Pick<KindOf, "group" | "kind">, lists: { vpas?: Live }, served: Served, blocks: Blocks): Record<string, Omit<WatchParams, "clusterId"> | null> {
  const ns = obj.metadata.namespace;
  if (!ns || served(VPA) !== true || !blocks.isOpen(BLOCKS.workload)) return {};
  const specs: Record<string, Omit<WatchParams, "clusterId"> | null> = { vpas: { kind: { group: VPA.group, kind: VPA.kind }, namespaces: [ns] } };
  // The namespace's HPAs only while a VPA targets this workload.
  if (served(HPA) === true && vpasOf(lists.vpas, kind, obj.metadata.name).length > 0) specs.hpas = { kind: { group: HPA.group, kind: HPA.kind }, namespaces: [ns] };
  return specs;
}

// ---------- Watches and the frame ----------

/** The watches a section holds, by what they watch: started when first wanted, stopped when no longer. */
class Watches {
  private readonly open = new Map<string, { watch: Watch; live: Live }>();
  constructor(
    private readonly sextant: Sextant,
    private readonly changed: () => void,
  ) {}

  /** The lists of `specs` (by name), each watched from now on; every other watch stops. */
  want(specs: Record<string, Omit<WatchParams, "clusterId"> | null>): Record<string, Live | undefined> {
    const keep = new Set<string>();
    const lists: Record<string, Live | undefined> = {};
    for (const [name, spec] of Object.entries(specs)) {
      if (!spec) continue;
      const key = JSON.stringify(spec);
      keep.add(key);
      lists[name] = (this.open.get(key) ?? this.start(key, spec)).live;
    }
    for (const [key, entry] of this.open) {
      if (keep.has(key)) continue;
      this.open.delete(key);
      void entry.watch.unwatch().catch(() => undefined);
    }
    return lists;
  }

  /** The list of `spec` while it is watched. */
  peek(spec: Omit<WatchParams, "clusterId">): Live | undefined {
    return this.open.get(JSON.stringify(spec))?.live;
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
          live.items = [...items];
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

/** The served kinds of the cluster, asked once per shown object; `undefined` until Sextant answers. */
interface KindsProbe {
  served?: ReadonlySet<string>;
}
const kindKey = (kind: Pick<KindOf, "group" | "kind">) => `${kind.group}/${kind.kind}`;

/**
 * Starts the details section `contribution` on the object in the context: read again whenever its resourceVersion
 * changes; what it lists besides watched as the built-in view watched it, and drawn again as they change.
 */
export function startDetails(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  let shownVersion: string | null | undefined;
  let shownRef: string | null = null;
  let reading = 0;
  let object: KubeObject | null = null;
  let kind: ObjectRef["kind"] | null = null;
  let scheduled = false;
  let stopped = false;
  let probe: KindsProbe = {};
  /** Whether Sextant hides the section now (the workload section starts hidden, the manifest's `startHidden`). */
  let hidden = contribution === "workload";
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
  const setHidden = (hide: boolean) => {
    if (hide === hidden) return;
    hidden = hide;
    void sextant.ui.setHidden(hide).catch(() => undefined);
  };
  const served: Served = (k) => (probe.served ? probe.served.has(kindKey(k)) : undefined);

  const render = () => {
    if (!object || !kind || stopped) return;
    let view: Node[] | null;
    if (contribution === "vpa" && isVpa(kind)) {
      const lists = watches.want(vpaWatches(object, served, blocks));
      const components = COMPONENTS.map((c) => lists[`component:${c}`]).concat(lists["component:charts"]);
      view = vpaView(sextant, object, { target: lists.target, hpas: lists.hpas, components: components.every(Boolean) ? (components as Live[]) : undefined }, served, blocks);
    } else if (contribution === "workload" && isTargetKind(kind)) {
      // The HPAs follow the VPAs found.
      const vpas = workloadWatches(object, kind, {}, served, blocks).vpas;
      const lists = watches.want(workloadWatches(object, kind, { vpas: vpas ? watches.peek(vpas) : undefined }, served, blocks));
      const node = workloadView(sextant, object, kind, { vpas: lists.vpas, hpas: lists.hpas }, served, blocks);
      setHidden(node === null);
      view = node ? [node] : [];
    } else {
      view = null;
    }
    // Drawn again on every change: the focus stays on the toggle of the block it was on.
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-block]")?.dataset.block;
    const onToggle = document.activeElement?.classList.contains("sx-block__toggle") ?? false;
    root.replaceChildren(...(view ?? [ui.empty(t("common.nothingToShow", { view: contribution }))]));
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
      // The workload section stays as it is: hidden unless it had something to show (Sextant's panel tells the error).
      if (attempt === reading && contribution !== "workload") root.replaceChildren(ui.errorState(errorText(err)));
    }
  };

  const askKinds = (current: KindsProbe) => {
    sextant.kinds().then(
      (kinds) => {
        current.served = new Set(kinds.map((k) => kindKey(k.kindRef)));
        if (current === probe) schedule();
      },
      () => {
        // Not known: nothing is watched that needs it, as before discovery.
        current.served = new Set();
        if (current === probe) schedule();
      },
    );
  };

  const follow = () => {
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
      watches.stop();
      probe = {};
      askKinds(probe);
      if (contribution === "workload") root.replaceChildren();
      else root.replaceChildren(ui.loading(t("loading")));
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
