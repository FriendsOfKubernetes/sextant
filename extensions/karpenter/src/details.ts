// The details sections of the extension (the manifest's `contributes.detailsSections`), as Sextant's former built-in
// autoscaling view drew them (src/features/autoscaling/NodeSection.tsx, ADR-0080), each in one block in place of the
// generic fields:
//   `node-pool` — "Limits and disruption": whether the NodePool is at a limit, its node class, consolidation policy and
//     delay, expiry and disruption budgets, its limits against what it launched, and the recent disruption events of
//     its NodeClaims (named `<nodepool>-<suffix>`) — the reasons for nodes already gone;
//   `node-claim` — "Launch and disruption": launch, registration and initialization in plain words, its node, NodePool,
//     capacity type, instance type and zone, why Karpenter disrupts it (or may not) and when it expires, and its
//     disruption events, shown only when there are some.
// Neither section has a heading of its own (the block is the built-in block); the blocks open and close in Sextant's
// own memory of details sections (the context's `blocks`, `ui.setBlockOpen`), so "Expand all", "Collapse all" and
// Settings → Appearance apply to them. What a block lists is watched as the built-in block watched it: the NodePools
// (for a NodeClaim's disruption settings) while the claim's block is open, the NodeClaims' events while their block is
// open — a NodeClaim's own once more while it is closed, to know whether to show it. A node's Karpenter block stays in
// Sextant. Read-only.
import { trackObjects, ui, type KubeObject, type ObjectRef, type Sextant, type UiContent, type Watch, type WatchParams } from "@sextant/extension-sdk";
import { age, block, codedError, dateTimeText, element, errorText, fieldsOf, formatList, lines, link, note, OPEN_BLOCKS, phraseLine, phraseLines, tableOf, warning, type BlockMemory } from "./dom";
import { t } from "./i18n";
import {
  CAPACITY_TYPE_LABEL,
  causeOf,
  disruptionOf,
  disruptionSettings,
  eventRow,
  EVENT,
  get,
  INSTANCE_TYPE_LABEL,
  isDisruptionEvent,
  isKind,
  launchProblem,
  limitRows,
  MAX_EVENTS,
  newestEvents,
  NODE,
  NODE_CLAIM,
  NODE_POOL,
  nodePoolOf,
  phrase,
  record,
  str,
  ZONE_LABEL,
  type EventRow,
  type KindRef,
  type Phrase,
} from "./model";

/** Block ids in Sextant's memory of details sections. */
export const BLOCKS = { pool: "pool", poolDisruptions: "pool.disruptions", claim: "claim", claimDisruptions: "claim.disruptions" } as const;

const CLAIM_READY = phrase("karpenter.ready", undefined, "success");
const LIMIT_NOWRAP = [true, true, true];
const EVENT_NOWRAP = [true, false, true];

/** A list watched while it is wanted: its objects, whether the first answer came, whether it failed and why. */
export interface Live {
  items: KubeObject[];
  ready: boolean;
  failed: boolean;
  /** Why, where the cluster or Sextant said: the error's code and message, as the built-in block named it. */
  error?: { code?: string; message?: string };
}

/** "expiresAt" carries an ISO time: shown in the UI language. */
function withTimes(phrases: Phrase[]): Phrase[] {
  return phrases.map((p) => (p.params?.time ? { ...p, params: { ...p.params, time: dateTimeText(String(p.params.time)) } } : p));
}

const causeText = (e: EventRow) => t(`karpenter.causes.${causeOf(`${e.reason} ${e.message}`)}`);

/**
 * The newest `MAX_EVENTS` of `events` as a table; `first` adds a leading column (the NodeClaim, a cause). Its widths are
 * kept as the built-in table's: one table with the leading column, another without.
 */
export function eventsTable(sextant: Sextant, events: readonly EventRow[], first?: { header: string; cell: (e: EventRow) => string }): HTMLElement | null {
  const rows = newestEvents(events, MAX_EVENTS);
  const headers = [...(first ? [first.header] : []), ...["reason", "message", "age"].map((h) => t(`events.${h}`))];
  return tableOf(
    sextant,
    first ? "eventsWithCause" : "events",
    headers,
    rows.map((e) => [...(first ? [first.cell(e)] : []), e.type === "Warning" ? warning(e.reason) : element("span", { textContent: e.reason }), e.message, age(e.time)]),
    [...(first ? [true] : []), ...EVENT_NOWRAP],
  );
}

// ---------- NodePool ----------

export interface PoolLists {
  claimEvents?: Live;
}

export function nodePoolView(sextant: Sextant, pool: KubeObject, lists: PoolLists, memory: BlockMemory = OPEN_BLOCKS): Node[] {
  const content = () => {
    const name = pool.metadata.name ?? "";
    const limits = limitRows(pool);
    const settings = disruptionSettings(pool);
    const classRef = get(pool, "spec", "template", "spec", "nodeClassRef");
    const classKind = str(get(classRef, "kind"));
    const classGroup = str(get(classRef, "group")) ?? "karpenter.k8s.aws";
    const reached = limits.filter((l) => l.reached).map((l) => l.resource);
    const budgets = settings.budgets.map((b) =>
      formatList([b.nodes, ...(b.reasons.length > 0 ? [b.reasons.join("/")] : []), ...(b.schedule ? [`${b.schedule}${b.duration ? ` (${b.duration})` : ""}`] : [])]),
    );
    const headers = ["resource", "inUse", "limit"].map((h) => t(`karpenter.${h}`));
    const limitTable = tableOf(
      sextant,
      "limits",
      headers,
      limits.map((l) => [l.resource, l.used ?? "", l.reached ? ui.status(l.limit, "danger") : l.limit]),
      LIMIT_NOWRAP,
    );
    return [
      reached.length > 0 ? phraseLine(phrase("karpenter.poolLimit", { name, resources: formatList(reached) }, "danger")) : null,
      fieldsOf([
        ["nodeClass", classKind ? link(sextant, { group: classGroup, version: "v1", kind: classKind }, str(get(classRef, "name"))) : null],
        ["consolidationPolicy", settings.consolidationPolicy ?? null],
        ["consolidateAfter", settings.consolidateAfter ?? null],
        ["expireAfter", settings.expireAfter ?? null],
        ["budgets", budgets.length > 0 ? lines(budgets) : null],
      ]),
      limits.length > 0 ? limitTable : note(t("karpenter.noLimits")),
      block(memory, BLOCKS.poolDisruptions, t("karpenter.recentDisruptions"), () => {
        // A NodePool names its NodeClaims `<nodepool>-<suffix>`.
        const disruptions = (lists.claimEvents?.items ?? []).map(eventRow).filter((e) => e.involvedName.startsWith(`${name}-`) && isDisruptionEvent(e));
        if (disruptions.length === 0) return note(t("karpenter.noDisruptions"));
        return eventsTable(sextant, disruptions, { header: t("karpenter.nodeClaim"), cell: (e) => `${e.involvedName} · ${causeText(e)}` });
      }),
    ];
  };
  return [block(memory, BLOCKS.pool, t("karpenter.poolTitle"), content)];
}

/** What a NodePool's section watches now: every NodeClaim's events while the block of its disruptions is open. */
export function poolWatches(memory: BlockMemory): Record<string, Omit<WatchParams, "clusterId">> {
  if (!memory.isOpen(BLOCKS.pool) || !memory.isOpen(BLOCKS.poolDisruptions)) return {};
  return { claimEvents: { kind: { group: EVENT.group, kind: EVENT.kind }, fieldSelector: "involvedObject.kind=NodeClaim" } };
}

// ---------- NodeClaim ----------

/** Whether a conditional block has something to show: found, known to be empty, or not known (a list not read). */
export type ProbeResult = "present" | "absent" | "unknown";

/** An answer of `live`: `null` while it is coming (or not watched). */
export function probeAnswer(found: boolean, live: Live | undefined): ProbeResult | null {
  if (found) return "present";
  if (!live) return null;
  if (live.failed) return "unknown";
  return live.ready ? "absent" : null;
}

export interface ClaimLists {
  pools?: Live;
  events?: Live;
}

/** The disruption block's state: whether it is watched, and what it showed last (kept while it is closed). */
export interface ClaimProbe {
  result: ProbeResult | null;
}

export function nodeClaimView(sextant: Sextant, claim: KubeObject, lists: ClaimLists, probe: ClaimProbe, memory: BlockMemory = OPEN_BLOCKS): Node[] {
  const content = () => {
    const poolName = nodePoolOf(claim);
    const pool = lists.pools?.items.find((p) => p.metadata.name === poolName);
    const labels = record(claim.metadata.labels);
    const disruptions = (lists.events?.items ?? []).map(eventRow).filter(isDisruptionEvent);
    const open = memory.isOpen(BLOCKS.claimDisruptions);
    const enabled = open || probe.result === null;
    const answer = enabled ? probeAnswer(disruptions.length > 0, lists.events) : null;
    if (answer) probe.result = answer;
    const result = probe.result;
    const visible = result === "present" || result === "unknown";
    return [
      phraseLine(launchProblem(claim) ?? CLAIM_READY),
      fieldsOf([
        ["node", link(sextant, NODE, str(get(claim, "status", "nodeName")))],
        ["nodePool", link(sextant, NODE_POOL, poolName)],
        ["capacityType", str(labels[CAPACITY_TYPE_LABEL]) ?? null],
        ["instanceType", str(labels[INSTANCE_TYPE_LABEL]) ?? null],
        ["zone", str(labels[ZONE_LABEL]) ?? null],
      ]),
      ...phraseLines(withTimes(disruptionOf(claim, pool))),
      visible
        ? block(memory, BLOCKS.claimDisruptions, t("karpenter.disruptions"), (): UiContent =>
            answer === "unknown" ? codedError(lists.events?.error) : eventsTable(sextant, disruptions, { header: t("karpenter.cause"), cell: causeText }),
          )
        : null,
    ];
  };
  return [block(memory, BLOCKS.claim, t("karpenter.claimTitle"), content)];
}

/**
 * What a NodeClaim's section watches now, while its block is open: the NodePools (where the cluster serves them), and
 * its events while their block is open or until it is known whether there are any.
 */
export function claimWatches(claim: KubeObject, probe: ClaimProbe, memory: BlockMemory, servesPools: boolean): Record<string, Omit<WatchParams, "clusterId">> {
  if (!memory.isOpen(BLOCKS.claim)) return {};
  const specs: Record<string, Omit<WatchParams, "clusterId">> = {};
  if (servesPools) specs.pools = { kind: { group: NODE_POOL.group, kind: NODE_POOL.kind } };
  if (memory.isOpen(BLOCKS.claimDisruptions) || probe.result === null) {
    specs.events = { kind: { group: EVENT.group, kind: EVENT.kind }, fieldSelector: `involvedObject.kind=NodeClaim,involvedObject.name=${claim.metadata.name}` };
  }
  return specs;
}

/** The section `contribution` of `obj`, or nothing for a kind it is not for. */
export function sectionView(
  sextant: Sextant,
  contribution: string,
  kind: Pick<KindRef, "group" | "kind">,
  obj: KubeObject,
  lists: Record<string, Live>,
  probe: ClaimProbe,
  memory: BlockMemory = OPEN_BLOCKS,
): Node[] | null {
  if (contribution === "node-pool" && isKind(kind, NODE_POOL)) return nodePoolView(sextant, obj, { claimEvents: lists.claimEvents }, memory);
  if (contribution === "node-claim" && isKind(kind, NODE_CLAIM)) return nodeClaimView(sextant, obj, { pools: lists.pools, events: lists.events }, probe, memory);
  return null;
}

// ---------- Watches and the frame ----------

/** The watches a section holds, by what they watch: started when first wanted, stopped when no longer. */
class Watches {
  private readonly open = new Map<string, { watch: Watch; live: Live }>();
  constructor(
    private readonly sextant: Sextant,
    private readonly changed: () => void,
  ) {}

  want(specs: Record<string, Omit<WatchParams, "clusterId">>): Record<string, Live> {
    const keep = new Set<string>();
    const lists: Record<string, Live> = {};
    for (const [name, spec] of Object.entries(specs)) {
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

  private start(key: string, spec: Omit<WatchParams, "clusterId">): { watch: Watch; live: Live } {
    const live: Live = { items: [], ready: false, failed: false };
    const settle = (error: Live["error"] | false) => {
      live.ready = true;
      live.failed = error !== false;
      if (error) live.error = error;
      else delete live.error;
      this.changed();
    };
    const watch = this.sextant.resources.watch(spec, {
      onUpdate: trackObjects(
        (items) => {
          live.items = [...items];
          settle(false);
        },
        (other) => {
          // The watch's error by its code and message; a namespace refused says no more, as the built-in block.
          if (other.type === "error") settle({ code: other.code, message: other.message });
          else if (other.type === "forbidden") settle(undefined);
        },
      ),
      onError: (err) => settle(err),
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

/** The toggle a block of `root` has the focus on: its id and which of the blocks with that id. */
function focusedBlock(root: HTMLElement): { id: string; index: number } | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root.contains(active) || !active.classList.contains("sx-block__toggle")) return null;
  const node = active.closest<HTMLElement>("[data-block]");
  const id = node?.dataset.block;
  if (!node || id === undefined) return null;
  return { id, index: [...root.querySelectorAll<HTMLElement>("[data-block]")].filter((b) => b.dataset.block === id).indexOf(node) };
}

const kindKey = (kind: Pick<KindRef, "group" | "kind">) => `${kind.group}/${kind.kind}`;

/**
 * Starts the details section `contribution` on the object in the context: read again whenever its resourceVersion
 * changes; what it lists besides watched while the blocks that show it are open, and drawn again as it changes. The
 * blocks open and close as Sextant remembers them: a toggle is written there and draws the section again (the focus
 * stays on the toggle), and the section follows the panel's "Expand all" and "Collapse all".
 */
export function startDetails(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  let shownVersion: string | null | undefined;
  let shownRef: string | null = null;
  let reading = 0;
  let object: KubeObject | null = null;
  let kind: ObjectRef["kind"] | null = null;
  let scheduled = false;
  let stopped = false;
  let probe: ClaimProbe = { result: null };
  // Whether the cluster serves NodePools: `null` until known; when Sextant cannot tell, they are not watched, as the
  // built-in view watched no installed tool's kind without discovery.
  let servesPools: boolean | null = contribution === "node-claim" ? null : false;

  /** The user's toggles until Sextant's memory tells them back. */
  const toggled = new Map<string, boolean>();
  /** How each block shows now. */
  const shownBlocks = new Map<string, boolean>();
  let everyBlock = sextant.context.blocks?.["*"];
  const openNow = (id: string) => toggled.get(id) ?? ui.blockOpen(sextant.context.blocks, id, true);
  const memory: BlockMemory = {
    isOpen: (id) => {
      const open = openNow(id);
      shownBlocks.set(id, open);
      return open;
    },
    setOpen: (id, open) => {
      toggled.set(id, open);
      void sextant.ui.setBlockOpen(id, open).catch(() => undefined);
      schedule();
    },
  };

  const watchesNow = (obj: KubeObject): Record<string, Omit<WatchParams, "clusterId">> => {
    if (contribution === "node-pool") return poolWatches(memory);
    if (contribution === "node-claim" && servesPools !== null) return claimWatches(obj, probe, memory, servesPools);
    return {};
  };

  const render = () => {
    if (!object || !kind || stopped) return;
    const focused = focusedBlock(root);
    shownBlocks.clear();
    const lists = watches.want(watchesNow(object));
    const view = sectionView(sextant, contribution, kind, object, lists, probe, memory);
    // A probe settled while drawing stops the closed block's watch.
    if (contribution === "node-claim" && servesPools !== null && !("events" in watchesNow(object))) watches.want(watchesNow(object));
    root.replaceChildren(...(view ?? [ui.empty(t("common.nothingToShow", { view: contribution }))]));
    if (focused) {
      const again = [...root.querySelectorAll<HTMLElement>("[data-block]")].filter((b) => b.dataset.block === focused.id)[focused.index];
      again?.querySelector<HTMLElement>(".sx-block__toggle")?.focus();
    }
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
  if (servesPools === null) {
    sextant
      .kinds()
      .then((kinds) => kinds.some((k) => kindKey(k.kindRef) === kindKey(NODE_POOL)))
      .catch(() => false)
      .then((serves) => {
        servesPools = serves;
        schedule();
      });
  }

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

  /** Sextant's memory changed: "Expand all"/"Collapse all" overrides the toggles, a toggle told back is its own. */
  const followBlocks = () => {
    const blocks = sextant.context.blocks ?? {};
    if (blocks["*"] !== everyBlock) {
      everyBlock = blocks["*"];
      toggled.clear();
    }
    for (const [id, open] of toggled) if (blocks[id] === open) toggled.delete(id);
  };

  const follow = () => {
    followBlocks();
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
      probe = { result: null };
      toggled.clear();
      watches.stop();
      root.replaceChildren(ui.loading(t("loading")));
    }
    const version = sextant.context.resourceVersion;
    if (version === shownVersion) {
      if (object && [...shownBlocks].some(([id, open]) => openNow(id) !== open)) schedule();
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
