// The details sections (the manifest's `contributes.detailsSections`), as the built-in view drew them (ADR-0116):
//   `gpu-operator` on a ClusterPolicy — the state with the operator's message, where the operands run, the MIG strategy,
//                 and each component: enabled or not (the spec, else the operator's default), its DaemonSet in the
//                 operand namespace and how many of its pods are ready and updated;
//   `gpu-operator` on an NVIDIADriver — the state with the message, the driver type and version, the nodes it selects,
//                 and the DaemonSets it owns;
//   `gpu-node` on a Node (shown by Sextant only on GPU nodes, the section's `when`) — the GPU labels (product, count,
//                 memory), the MIG configuration and its state, and the GPU and MIG resources' capacity and
//                 allocatable, read from the node itself.
// The sections have no heading of their own (the manifest's `heading: false`), as the built-in ones had none; their
// blocks open and close as the built-in panel's did, in Sextant's own memory of details sections (the context's
// `blocks`, `ui.setBlockOpen`), so "Expand all" and "Collapse all" reach them too. The operand namespace's DaemonSets
// are watched while the Components or DaemonSets block is open (at most `MAX_NAMESPACE_DAEMONSETS`, kept by the core,
// a note when more match). The frame reads the shown object again whenever its resourceVersion changes. Conditions,
// events and YAML are Sextant's own sections. Read-only.
import { trackObjects, ui, type KubeObject, type ObjectRef, type Sextant, type UiContent, type Watch, type WatchParams } from "@sextant/extension-sdk";
import { errorText, message, note, remark } from "./dom";
import { t } from "./i18n";
import {
  CLUSTER_POLICY,
  COMPONENT_TONE,
  componentsOf,
  DAEMONSET,
  driverByCrd,
  driverNodeSelectorOf,
  driverTypeOf,
  driverVersionOf,
  failureOf,
  gpuNodeOf,
  hasGpu,
  isKind,
  isRolledOut,
  migStateTone,
  migStrategyOf,
  NODE,
  NVIDIA_DRIVER,
  operandNamespaceOf,
  ownedDaemonSets,
  shownComponent,
  stateOf,
  STATE_TONE,
  type KindOf,
  type Rollout,
} from "./model";

/** DaemonSets of an operand namespace the watch keeps at most, as the built-in view's capped list. */
export const MAX_NAMESPACE_DAEMONSETS = 1000;

/** The ids of the blocks, in Sextant's memory of the sections. */
export const COMPONENTS_BLOCK = "components";
export const DAEMONSETS_BLOCK = "daemonSets";
export const GPU_BLOCK = "gpu";

/** A list watched while its block is open: its objects, whether the first answer came, whether it failed or was cut. */
export interface Live {
  items: KubeObject[];
  ready: boolean;
  failed: boolean;
  truncated: boolean;
}

/** The blocks of a section: whether one is open, and `toggle`, which remembers a change and draws again. */
export interface Blocks {
  isOpen(id: string): boolean;
  toggle(id: string, open: boolean): void;
}

/** Every block open, nothing remembered (the views drawn on their own). */
export const ALL_OPEN: Blocks = { isOpen: () => true, toggle: () => undefined };

/** The operand namespace's DaemonSets as the views read them. */
interface Listed {
  items: KubeObject[];
  loading: boolean;
  unavailable: boolean;
  truncated: boolean;
}

const present = (nodes: (Node | null | false | undefined)[]): Node[] => nodes.filter((n): n is Node => Boolean(n));

/** A titled block as the built-in view's: open unless the user closed it, closable with its title. */
function block(blocks: Blocks, id: string, title: string, content: UiContent): HTMLElement {
  const node = ui.block(title, content, { collapsible: true, collapsed: !blocks.isOpen(id), onToggle: (open) => blocks.toggle(id, open) });
  node.dataset.block = id;
  return node;
}

/** A link to an object's details in Sextant's panel. */
export function link(sextant: Sextant, kind: KindOf, name: string, namespace: string | null): HTMLElement {
  const button = ui.objectLink(sextant, { kind, namespace, name });
  button.setAttribute("aria-label", t("openObject", { kind: kind.kind, name }));
  return button;
}

/** `ui.fields` labelled from `fields.<key>`. */
const fieldsOf = (rows: readonly (readonly [string, UiContent])[]): HTMLElement => ui.fields(rows.map(([key, value]) => [t(`fields.${key}`), value] as const));

/** The state in words, coloured; the operator's message on hover. */
export function stateCell(obj: KubeObject): HTMLElement {
  const state = stateOf(obj);
  const node = ui.status(t(`state.${state}`), STATE_TONE[state]);
  const title = failureOf(obj)?.message;
  if (title) node.title = title;
  return node;
}

function rolloutText(r: Rollout): HTMLElement {
  return ui.status(t("components.rollout", { ready: r.ready, updated: r.updated, desired: r.desired }), isRolledOut(r) ? "success" : "warning");
}

/** The operator's message when it is not ready, and what its state means. */
function stateNote(obj: KubeObject): Node[] {
  const state = stateOf(obj);
  const failure = failureOf(obj);
  if (state === "ready") return [];
  return present([failure?.message ? message(failure.message) : null, note(t(`hint.${state}`))]);
}

function listNote(list: Listed, namespace: string | undefined): HTMLElement | null {
  if (!namespace) return remark(t("components.noNamespace"));
  if (list.loading) return remark(t("loading"));
  if (list.unavailable) return remark(t("components.unavailable", { namespace }));
  if (list.truncated) return remark(t("components.truncated"));
  return null;
}

/** The DaemonSets of the operand namespace as the views read them, from what the watch has. */
export function listedOf(namespace: string | undefined, live: Live | undefined): Listed {
  if (!namespace || !live) return { items: [], loading: false, unavailable: true, truncated: false };
  return { items: live.items, loading: !live.ready, unavailable: live.failed, truncated: live.truncated };
}

export function policyView(sextant: Sextant, policy: KubeObject, live: Live | undefined, blocks: Blocks = ALL_OPEN): Node[] {
  const namespace = operandNamespaceOf(policy);
  const daemonSets = listedOf(namespace, live);
  const strategy = migStrategyOf(policy);
  const known = !daemonSets.loading && !daemonSets.unavailable;
  const rows: UiContent[][] = componentsOf(policy, daemonSets.items)
    .filter(shownComponent)
    .flatMap((row) => {
      const name = t(`component.${row.def.id}`);
      const enabled = t(row.enabled ? "components.on" : "components.off");
      if (row.daemonSets.length === 0) {
        const state = known || row.state === "off" || row.state === "managedByDriver" ? t(`components.state.${row.state}`) : t("components.state.unknown");
        return [[name, enabled, ui.status(state, known ? COMPONENT_TONE[row.state] : "muted"), row.def.daemonSet]];
      }
      return row.daemonSets.map((r) => [name, enabled, rolloutText(r), link(sextant, DAEMONSET, r.name, r.namespace)]);
    });
  const headers = ["component", "enabled", "status", "daemonSet"].map((h) => t(`components.${h}`));
  return [
    fieldsOf([
      ["state", stateCell(policy)],
      ["namespace", namespace ?? null],
      ["migStrategy", strategy ?? t("fields.migStrategyUnset")],
      ["driver", driverByCrd(policy) ? t("fields.driverByCrd") : null],
    ]),
    ...stateNote(policy),
    block(blocks, COMPONENTS_BLOCK, t("components.title"), [ui.table(headers, rows, { label: t("components.title"), id: "components", sextant, nowrap: [true, true, true, false] }), listNote(daemonSets, namespace)]),
  ];
}

export function driverView(sextant: Sextant, driver: KubeObject, live: Live | undefined, blocks: Blocks = ALL_OPEN): Node[] {
  const namespace = operandNamespaceOf(driver);
  const daemonSets = listedOf(namespace, live);
  const owned = ownedDaemonSets(driver, daemonSets.items);
  const headers = ["daemonSet", "status"].map((h) => t(`components.${h}`));
  const content =
    owned.length > 0
      ? ui.table(
          headers,
          owned.map((r) => [link(sextant, DAEMONSET, r.name, r.namespace), rolloutText(r)]),
          { label: t("driver.daemonSets"), id: "driverDaemonSets", sextant, nowrap: [true, true] },
        )
      : !daemonSets.loading && namespace && remark(t("driver.none"));
  return [
    fieldsOf([
      ["state", stateCell(driver)],
      ["driverType", driverTypeOf(driver)],
      ["version", driverVersionOf(driver) ?? null],
      ["nodeSelector", ui.chips(Object.entries(driverNodeSelectorOf(driver)).map(([k, v]) => `${k}=${v}`))],
      ["namespace", namespace ?? null],
    ]),
    ...stateNote(driver),
    block(blocks, DAEMONSETS_BLOCK, t("driver.daemonSets"), [content, listNote(daemonSets, namespace)]),
  ];
}

/** The GPU and MIG resources of a node: resource, capacity, allocatable. */
function amountsTable(sextant: Sextant, node: KubeObject): HTMLElement {
  const rows = gpuNodeOf(node).amounts.map((a) => [a.resource, a.capacity ?? "", a.allocatable ?? ""]);
  if (rows.length === 0) return remark(t("node.noResources"));
  const headers = ["resource", "capacity", "allocatable"].map((h) => t(`node.${h}`));
  return ui.table(headers, rows, { label: t("node.title"), id: "nodeAmounts", sextant, nowrap: [true, true, true] });
}

export function nodeView(sextant: Sextant, node: KubeObject, blocks: Blocks = ALL_OPEN): Node[] {
  const gpu = gpuNodeOf(node);
  if (!hasGpu(gpu)) return [];
  const content = present([
    fieldsOf([
      ["product", gpu.product ?? null],
      ["count", gpu.count ?? null],
      ["memory", gpu.memory ? t("node.memoryMiB", { value: gpu.memory }) : null],
      ["migConfig", gpu.migConfig ?? null],
      ["migState", gpu.migState ? ui.status(gpu.migState, migStateTone(gpu.migState)) : null],
    ]),
    gpu.migState === "failed" && message(t("node.migFailed", { config: gpu.migConfig ?? "" })),
    amountsTable(sextant, node),
  ]);
  return [block(blocks, GPU_BLOCK, t("node.title"), content)];
}

/**
 * What a section watches besides its object: the DaemonSets of the operand namespace, while the block that lists them
 * (Components, DaemonSets) is open, as the built-in view watched them.
 */
export function daemonSetWatch(
  obj: KubeObject,
  kind: { group: string; kind: string },
  isOpen: (id: string) => boolean = () => true,
): Omit<WatchParams, "clusterId"> | null {
  const id = isKind(kind, CLUSTER_POLICY) ? COMPONENTS_BLOCK : isKind(kind, NVIDIA_DRIVER) ? DAEMONSETS_BLOCK : null;
  if (id === null || !isOpen(id)) return null;
  const namespace = operandNamespaceOf(obj);
  return namespace ? { kind: DAEMONSET, namespaces: [namespace], maxObjects: MAX_NAMESPACE_DAEMONSETS } : null;
}

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
        live.truncated = total > (spec.maxObjects ?? Infinity);
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

/** The view of `contribution` for the shown object; nothing when it does not apply. */
function viewOf(sextant: Sextant, contribution: string, ref: ObjectRef, obj: KubeObject, live: Live | undefined, blocks: Blocks): Node[] | null {
  if (contribution === "gpu-operator" && isKind(ref.kind, CLUSTER_POLICY)) return policyView(sextant, obj, live, blocks);
  if (contribution === "gpu-operator" && isKind(ref.kind, NVIDIA_DRIVER)) return driverView(sextant, obj, live, blocks);
  if (contribution === "gpu-node" && isKind(ref.kind, NODE)) return nodeView(sextant, obj, blocks);
  return null;
}

/**
 * Starts the details section `contribution` on the object in the context: read again whenever its resourceVersion
 * changes; the operand namespace's DaemonSets watched while their block is open, and drawn again as they change.
 */
export function startDetails(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  let shownVersion: string | null | undefined;
  let shownRef: string | null = null;
  let reading = 0;
  let object: { ref: ObjectRef; obj: KubeObject } | null = null;
  let scheduled = false;
  let stopped = false;
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

  const render = () => {
    if (!object || stopped) return;
    const { ref, obj } = object;
    const related = watches.want({ daemonSets: daemonSetWatch(obj, ref.kind, blocks.isOpen) });
    const view = viewOf(sextant, contribution, ref, obj, related.daemonSets, blocks);
    // Drawn again on every change: the focus stays on the toggle of the block it was on.
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-block]")?.dataset.block;
    const onToggle = document.activeElement?.classList.contains("sx-block__toggle") ?? false;
    if (view === null) root.replaceChildren(ui.empty(t("common.nothingToShow", { view: contribution })));
    else root.replaceChildren(...view);
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
      object = { ref, obj: fresh };
      render();
    } catch (err) {
      if (attempt === reading) root.replaceChildren(ui.errorState(errorText(err)));
    }
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
