// The details sections (the manifest's `contributes.detailsSections`, untitled as the built-in ones): one per DRA kind,
// and the "Devices" block of a Pod with claims and the "DRA devices" block of a Node. Each frame reads the shown object
// again whenever its resourceVersion changes (a Node is not read: its name is all the block needs). Its blocks open and
// close as the built-in panel's did, in Sextant's own memory of details sections (the context's `blocks`,
// `ui.setBlockOpen`), so "Expand all" and "Collapse all" reach them too; and it watches, only while the block that
// shows a list is open, what the built-in views watched, with their caps:
//   resource-claim   — the Pending pods of its namespace (`status.phase=Pending`) while it is not allocated;
//   resource-slice   — every ResourceClaim, to tell which of its devices are allocated;
//   pod-devices      — the ResourceClaims of the pod's namespace (nothing where the cluster serves none);
//   node-devices     — the node's ResourceSlices (`spec.nodeName=<node>`) and, once it has any, every ResourceClaim.
// The node's section starts hidden (`startHidden`) and shows itself (`ui.setHidden(false)`) once its slices are read
// and there are some, or they cannot be read, as the built-in block drew nothing before. A closed node block looks at
// the slices once, then keeps that answer and watches nothing, as the built-in probe. Read-only (ADR-0116).
import { ui, type KubeObject, type ObjectRef, type Sextant, type UiContent } from "@sextant/extension-sdk";
import { errorText, flat } from "./dom";
import { t } from "./i18n";
import { serves, Watches, type Related, type Spec } from "./live";
import { RESOURCE_CLAIM, RESOURCE_SLICE } from "./model";
import {
  BLOCKS,
  claimView,
  claimWatches,
  deviceClassView,
  nodeAnswer,
  nodeView,
  nodeWatches,
  podView,
  podWatches,
  sliceView,
  sliceWatches,
  templateView,
  type Blocks,
  type NodeAnswer,
} from "./views";

const CLAIMS = { group: RESOURCE_CLAIM.group, kind: RESOURCE_CLAIM.kind };
const SLICES = { group: RESOURCE_SLICE.group, kind: RESOURCE_SLICE.kind };

/** What a section watches besides its object, with its blocks open as `isOpen` says. */
export function watchesOf(contribution: string, obj: KubeObject, served: boolean | undefined, isOpen: (id: string) => boolean = () => true): Record<string, Spec | null> {
  switch (contribution) {
    case "resource-claim":
      return claimWatches(obj, isOpen);
    case "resource-slice":
      return sliceWatches(isOpen);
    case "pod-devices":
      return podWatches(obj, served, isOpen);
    default:
      return {};
  }
}

/** The section's content for its object and the lists it watches. */
export function sectionView(sextant: Sextant, contribution: string, obj: KubeObject, related: Related, served: boolean | undefined, blocks: Blocks): UiContent[] {
  switch (contribution) {
    case "resource-claim":
      return claimView(sextant, obj, related.pods, blocks);
    case "resource-claim-template":
      return templateView(sextant, obj, blocks);
    case "device-class":
      return deviceClassView(obj, blocks);
    case "resource-slice":
      return sliceView(sextant, obj, related.claims, blocks);
    case "pod-devices":
      return podView(sextant, obj, related.claims, served, blocks);
    default:
      return [ui.empty(t("common.nothingToShow", { view: contribution }))];
  }
}

/** The kind a section needs served before it watches anything (`undefined`: none). */
const NEEDS: Record<string, { group: string; kind: string } | undefined> = { "pod-devices": CLAIMS };

/**
 * The blocks' choices as Sextant remembers them (`context.blocks`): a choice made here counts until the context that
 * carries it (or any other change of the remembered choices, "Collapse all" among them) comes back.
 */
function rememberedBlocks(sextant: Sextant, changed: () => void): { blocks: Blocks; follow: () => void } {
  const choices = new Map<string, boolean>();
  let remembered = JSON.stringify(sextant.context.blocks ?? {});
  return {
    blocks: {
      isOpen: (id) => choices.get(id) ?? ui.blockOpen(sextant.context.blocks, id, true),
      toggle: (id, open) => {
        choices.set(id, open);
        void sextant.ui.setBlockOpen(id, open).catch(() => undefined);
        changed();
      },
    },
    follow: () => {
      const now = JSON.stringify(sextant.context.blocks ?? {});
      if (now === remembered) return;
      remembered = now;
      choices.clear();
      changed();
    },
  };
}

/** Draws `content` into `root`, the focus kept on the toggle of the block it was on. */
function draw(root: HTMLElement, content: readonly UiContent[]): void {
  const active = document.activeElement as HTMLElement | null;
  const focused = active?.classList.contains("sx-block__toggle") ? active.closest<HTMLElement>("[data-block]")?.dataset.block : undefined;
  root.replaceChildren(...flat(content));
  if (focused) root.querySelector<HTMLElement>(`[data-block="${focused}"] .sx-block__toggle`)?.focus();
}

/** A function that runs `fn` once in the next microtask however often it is asked. */
function scheduler(fn: () => void, stopped: () => boolean): () => void {
  let scheduled = false;
  return () => {
    if (scheduled || stopped()) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      fn();
    });
  };
}

/**
 * Starts the details section `contribution` on the object in the context: read again whenever its resourceVersion
 * changes; the lists it watches drawn again as they change.
 */
export function startDetails(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  if (contribution === "node-devices") return startNode(sextant, root);
  let shownVersion: string | null | undefined;
  let shownRef: string | null = null;
  let reading = 0;
  let object: KubeObject | null = null;
  let stopped = false;
  const need = NEEDS[contribution];
  let served: boolean | undefined;

  const render = () => {
    if (!object || stopped) return;
    if (need && served === undefined) {
      root.replaceChildren(ui.loading(t("loading")));
      return;
    }
    const related = watches.want(watchesOf(contribution, object, served, memory.blocks.isOpen));
    draw(root, sectionView(sextant, contribution, object, related, served, memory.blocks));
  };
  const schedule = scheduler(render, () => stopped);
  const memory = rememberedBlocks(sextant, schedule);
  const watches = new Watches(sextant, schedule);
  if (need) {
    void serves(sextant, need).then((answer) => {
      // Not known (the kinds could not be read): watched all the same, the watch tells.
      served = answer ?? true;
      schedule();
    });
  }

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
    memory.follow();
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

/** The "DRA devices" block of the Node in the context: hidden until its slices are read, and while it has none. */
function startNode(sextant: Sextant, root: HTMLElement): () => void {
  let stopped = false;
  let served: boolean | undefined;
  // The section starts hidden (`startHidden`).
  let hidden = true;
  // The settled answer, kept while the closed block watches nothing (the built-in `useDisclosureProbe`).
  let result: NodeAnswer | null = null;
  let wantClaims = false;
  const hide = (value: boolean) => {
    if (value === hidden) return;
    hidden = value;
    void sextant.ui.setHidden(value).catch(() => undefined);
  };

  const render = () => {
    if (stopped) return;
    const node = sextant.context.selection[0]?.name;
    if (!node || served === undefined) {
      watches.stop();
      return;
    }
    const open = memory.blocks.isOpen(BLOCKS.node);
    // A closed block looks once; an open one watches.
    const enabled = served && (open || result === null);
    let related = watches.want(nodeWatches(node, enabled, wantClaims));
    let answer = enabled ? nodeAnswer(related.slices, served) : served ? result : "absent";
    // Which of its devices are allocated: every claim, while the block is open and the node has slices.
    if ((open && answer === "present") !== wantClaims) {
      wantClaims = open && answer === "present";
      related = watches.want(nodeWatches(node, enabled, wantClaims));
    }
    if (enabled && answer !== null) {
      result = answer;
      // Closed: the one look is done; drawn again without the watch.
      if (!open) schedule();
    }
    answer = answer ?? result;
    hide(answer !== "present" && answer !== "unknown");
    if (hidden) {
      root.replaceChildren();
      return;
    }
    draw(root, nodeView(sextant, related.slices, related.claims, answer, memory.blocks));
  };
  const schedule = scheduler(render, () => stopped);
  const memory = rememberedBlocks(sextant, schedule);
  const watches = new Watches(sextant, schedule);
  void serves(sextant, SLICES).then((answer) => {
    // Not known (the kinds could not be read): watched all the same, the watch tells.
    served = answer ?? true;
    schedule();
  });
  let shown = sextant.context.selection[0]?.name;
  const stopFollow = sextant.onContextChange((context) => {
    memory.follow();
    const name = context.selection[0]?.name;
    if (name === shown) return;
    shown = name;
    result = null;
    wantClaims = false;
    watches.stop();
    schedule();
  });
  return () => {
    stopped = true;
    stopFollow();
    watches.stop();
  };
}
