// The details sections of the extension (the manifest's `contributes.detailsSections`), as Sextant's former built-in
// autoscaling view drew them (src/features/autoscaling/KedaSection.tsx, ADR-0080), each in one block "KEDA" or "Where
// the parameters come from" in place of the generic fields:
//   `scaled-object` — a ScaledObject's state in plain words (Ready, Active, Paused, Fallback, failing triggers), its
//     target, replica range, idle replicas, polling interval, cooldown and fallback; its triggers with their metadata,
//     authentication and health; and the HPA KEDA manages for it with that HPA's verdict and metrics;
//   `scaled-job` — a ScaledJob's state, maximum, scaling strategy, polling interval, image and triggers;
//   `trigger-authentication` — where a (Cluster)TriggerAuthentication takes its parameters from (names only).
// Neither section has a heading of its own (the block is the built-in block); the blocks open and close in Sextant's
// own memory of details sections (the context's `blocks`, `ui.setBlockOpen`), so "Expand all", "Collapse all" and
// Settings → Appearance apply to them. The managed HPA is watched by its name only while its block is open, as the
// built-in block watched it. The events are Sextant's own section. Read-only.
import { trackObjects, ui, type KubeObject, type ObjectRef, type Sextant, type UiContent, type Watch, type WatchParams } from "@sextant/extension-sdk";
import { block, element, errorText, fieldsOf, link, note, OPEN_BLOCKS, phraseLine, phraseLines, tableOf, warning, type BlockMemory } from "./dom";
import { analyzeHpa, type MetricRow } from "./hpa";
import { t } from "./i18n";
import {
  authSources,
  CLUSTER_TRIGGER_AUTHENTICATION,
  CONFIG_MAP,
  get,
  HPA,
  isKind,
  kedaState,
  kindFromApiVersion,
  managedHpaName,
  num,
  phrase,
  SCALED_JOB,
  SCALED_OBJECT,
  scaleTargetOf,
  SECRET,
  str,
  TRIGGER_AUTHENTICATION,
  triggersOf,
  type KindRef,
} from "./model";

/** Block ids in Sextant's memory of details sections. */
export const BLOCKS = { keda: "keda", triggers: "keda.triggers", managedHpa: "keda.managedHpa", auth: "keda.auth" } as const;

/** KEDA's defaults of the fields shown. */
const DEFAULTS = { minReplicaCount: 0, maxReplicaCount: 100, pollingInterval: 30, cooldownPeriod: 300 };
const KEDA_API = "keda.sh/v1alpha1";
const HPA_LINK: KindRef = { group: "autoscaling", version: "v2", kind: "HorizontalPodAutoscaler" };
const TRIGGER_NOWRAP = [true, false, true, true];
const SOURCE_NOWRAP = [true, true, false, true];
const METRIC_NOWRAP = [false, true, true, true];

/** A list watched while it is wanted: its objects, whether the first answer came, whether it failed. */
export interface Live {
  items: KubeObject[];
  ready: boolean;
  failed: boolean;
}

function specNumber(obj: KubeObject, field: keyof typeof DEFAULTS | "idleReplicaCount"): number | undefined {
  return num(get(obj, "spec", field)) ?? (field === "idleReplicaCount" ? undefined : DEFAULTS[field]);
}

const seconds = (count: number | undefined) => t("keda.seconds", { count: count ?? 0 });

// ---------- Triggers ----------

function triggersTable(sextant: Sextant, obj: KubeObject): HTMLElement | null {
  const namespace = obj.metadata.namespace ?? null;
  const triggers = triggersOf(obj);
  if (triggers.length === 0) return note(t("keda.noTriggers"));
  const rows: UiContent[][] = triggers.map((tr) => [
    tr.name ? `${tr.type} (${tr.name})` : tr.type,
    ui.chips(tr.metadata),
    tr.auth ? link(sextant, kindFromApiVersion(KEDA_API, tr.auth.kind), tr.auth.name, tr.auth.kind === "TriggerAuthentication" ? namespace : null) : "",
    tr.health ? (tr.failures ? `${tr.health} (${tr.failures})` : tr.health) : "",
  ]);
  const headers = ["trigger", "metadata", "auth", "health"].map((h) => t(`keda.${h}`));
  return tableOf(headers, rows, TRIGGER_NOWRAP);
}

// ---------- The managed HPA (the built-in `HpaSummary` with its metrics) ----------

function metricName(m: MetricRow): string {
  const parts = [`${m.source} ${m.name}`.trim()];
  if (m.container) parts.push(`(${m.container})`);
  if (m.object) parts.push(`(${m.object})`);
  if (m.selector) parts.push(`{${m.selector}}`);
  return parts.join(" ");
}

export function metricsTable(metrics: readonly MetricRow[]): HTMLElement | null {
  if (metrics.length === 0) return note(t("hpa.noMetrics"));
  const proposes = (m: MetricRow): UiContent => {
    if (m.proposes === undefined) return warning(t("hpa.noValue"));
    return m.withinTolerance ? t("hpa.withinTolerance", { replicas: m.proposes }) : String(m.proposes);
  };
  const rows = metrics.map((m) => [
    metricName(m),
    m.currentText ?? warning(t("hpa.noValue")),
    m.targetType ? `${m.targetText ?? "?"} (${m.targetType})` : (m.targetText ?? "?"),
    proposes(m),
  ]);
  const headers = ["metric", "current", "target", "proposes"].map((h) => t(`hpa.${h}`));
  return tableOf(headers, rows, METRIC_NOWRAP);
}

/** One HPA in a few lines: a link, the replicas, the verdict, its causes and the metrics. */
export function hpaSummary(sextant: Sextant, hpa: KubeObject): HTMLElement {
  const a = analyzeHpa(hpa);
  const name = hpa.metadata.name ?? "";
  const fields = fieldsOf([
    ["hpa", link(sextant, HPA_LINK, name, hpa.metadata.namespace ?? null)],
    ["replicas", t("hpa.replicasNow", { current: a.current, desired: a.desired ?? a.current })],
    ["range", `${a.min}–${a.max}`],
  ]);
  return element("div", { className: "as-summary" }, fields, phraseLine(a.verdict), ...phraseLines(a.causes), metricsTable(a.metrics));
}

function managedHpa(sextant: Sextant, obj: KubeObject, hpas: Live | undefined): UiContent {
  const name = managedHpaName(obj);
  const hpa = hpas?.items[0];
  return hpa ? hpaSummary(sextant, hpa) : phraseLine(phrase("keda.hpaMissing", { name }, "warning"));
}

// ---------- The sections ----------

export interface Related {
  hpa?: Live;
}

export function scaledObjectView(sextant: Sextant, obj: KubeObject, related: Related, memory: BlockMemory = OPEN_BLOCKS): Node[] {
  const namespace = obj.metadata.namespace ?? null;
  const target = scaleTargetOf(obj);
  const state = kedaState(obj);
  const fallback = get(obj, "spec", "fallback");
  const content = () => [
    ...phraseLines(state.phrases),
    fieldsOf([
      ["target", target ? link(sextant, kindFromApiVersion(target.apiVersion, target.kind), target.name, namespace, `${target.kind}/${target.name}`) : null],
      ["range", `${specNumber(obj, "minReplicaCount")}–${specNumber(obj, "maxReplicaCount")}`],
      ["idleReplicas", specNumber(obj, "idleReplicaCount") ?? null],
      ["pollingInterval", seconds(specNumber(obj, "pollingInterval"))],
      ["cooldownPeriod", seconds(specNumber(obj, "cooldownPeriod"))],
      [
        "fallback",
        fallback
          ? t("keda.fallbackSpec", {
              failures: num(get(fallback, "failureThreshold")) ?? "?",
              replicas: num(get(fallback, "replicas")) ?? "?",
            })
          : null,
      ],
    ]),
    block(memory, BLOCKS.triggers, t("keda.triggers"), () => triggersTable(sextant, obj)),
    block(memory, BLOCKS.managedHpa, t("keda.managedHpa"), () => managedHpa(sextant, obj, related.hpa)),
  ];
  return [block(memory, BLOCKS.keda, t("keda.title"), content)];
}

export function scaledJobView(sextant: Sextant, obj: KubeObject, memory: BlockMemory = OPEN_BLOCKS): Node[] {
  const state = kedaState(obj, true);
  const content = () => [
    ...phraseLines(state.phrases),
    fieldsOf([
      ["maxReplicas", specNumber(obj, "maxReplicaCount")],
      ["strategy", str(get(obj, "spec", "scalingStrategy", "strategy")) ?? null],
      ["pollingInterval", seconds(specNumber(obj, "pollingInterval"))],
      ["image", str(get(obj, "spec", "jobTargetRef", "template", "spec", "containers", 0, "image")) ?? null],
    ]),
    block(memory, BLOCKS.triggers, t("keda.triggers"), () => triggersTable(sextant, obj)),
  ];
  return [block(memory, BLOCKS.keda, t("keda.title"), content)];
}

export function triggerAuthenticationView(sextant: Sextant, obj: KubeObject, memory: BlockMemory = OPEN_BLOCKS): Node[] {
  const namespace = obj.metadata.namespace ?? null;
  const { sources, podIdentity } = authSources(obj);
  const target = (from: string, name: string | undefined): UiContent => {
    if (!name) return "";
    if (from === "Secret" && namespace) return link(sextant, SECRET, name, namespace);
    if (from === "ConfigMap" && namespace) return link(sextant, CONFIG_MAP, name, namespace);
    return name;
  };
  const headers = ["parameter", "from", "name", "key"].map((h) => t(`keda.${h}`));
  const rows: UiContent[][] = sources.map((s) => [s.parameter, s.from, target(s.from, s.name), s.key ?? ""]);
  const content = () => [
    fieldsOf([
      ["podIdentity", podIdentity ?? null],
    ]),
    sources.length === 0 && !podIdentity ? note(t("keda.noSources")) : null,
    tableOf(headers, rows, SOURCE_NOWRAP),
  ];
  return [block(memory, BLOCKS.auth, t("keda.authTitle"), content)];
}

/** The section `contribution` of `obj`, or nothing for a kind it is not for. */
export function sectionView(sextant: Sextant, contribution: string, kind: Pick<KindRef, "group" | "kind">, obj: KubeObject, related: Related, memory: BlockMemory = OPEN_BLOCKS): Node[] | null {
  if (contribution === "scaled-object" && isKind(kind, SCALED_OBJECT)) return scaledObjectView(sextant, obj, related, memory);
  if (contribution === "scaled-job" && isKind(kind, SCALED_JOB)) return scaledJobView(sextant, obj, memory);
  if (contribution === "trigger-authentication" && isKind(kind, TRIGGER_AUTHENTICATION, CLUSTER_TRIGGER_AUTHENTICATION)) return triggerAuthenticationView(sextant, obj, memory);
  return null;
}

const kindKey = (kind: Pick<KindRef, "group" | "kind">) => `${kind.group}/${kind.kind}`;

/**
 * What a section watches now: a ScaledObject's managed HPA by its name, while the KEDA block and the HPA's block are
 * open and the cluster serves HPAs (or discovery is not known: the built-in view then took autoscaling/v2).
 */
export function watchesOf(contribution: string, obj: KubeObject, memory: BlockMemory, served: Set<string> | null | "unknown"): Record<string, Omit<WatchParams, "clusterId">> {
  if (contribution !== "scaled-object") return {};
  const namespace = obj.metadata.namespace;
  if (!namespace || !memory.isOpen(BLOCKS.keda) || !memory.isOpen(BLOCKS.managedHpa)) return {};
  if (served === null || (served !== "unknown" && !served.has(kindKey(HPA)))) return {};
  return { hpa: { kind: { group: HPA.group, kind: HPA.kind }, namespaces: [namespace], fieldSelector: `metadata.name=${managedHpaName(obj)}` } };
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

/** The toggle a block of `root` has the focus on: its id and which of the blocks with that id. */
function focusedBlock(root: HTMLElement): { id: string; index: number } | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root.contains(active) || !active.classList.contains("sx-block__toggle")) return null;
  const node = active.closest<HTMLElement>("[data-block]");
  const id = node?.dataset.block;
  if (!node || id === undefined) return null;
  return { id, index: [...root.querySelectorAll<HTMLElement>("[data-block]")].filter((b) => b.dataset.block === id).indexOf(node) };
}

/**
 * Starts the details section `contribution` on the object in the context: read again whenever its resourceVersion
 * changes; the managed HPA watched while its block is open, and drawn again as it changes. The blocks open and close
 * as Sextant remembers them: a toggle is written there and draws the section again (the focus stays on the toggle),
 * and the section follows the panel's "Expand all" and "Collapse all".
 */
export function startDetails(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  let shownVersion: string | null | undefined;
  let shownRef: string | null = null;
  let reading = 0;
  let object: KubeObject | null = null;
  let kind: ObjectRef["kind"] | null = null;
  let scheduled = false;
  let stopped = false;
  // The kinds the cluster serves: `null` until known, "unknown" when Sextant could not tell.
  let served: Set<string> | null | "unknown" = contribution === "scaled-object" ? null : "unknown";

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

  const render = () => {
    if (!object || !kind || stopped) return;
    const focused = focusedBlock(root);
    shownBlocks.clear();
    const related = watches.want(watchesOf(contribution, object, memory, served));
    const view = sectionView(sextant, contribution, kind, object, related, memory);
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
  if (served === null) {
    sextant
      .kinds()
      .then((kinds) => new Set(kinds.map((k) => kindKey(k.kindRef))))
      .catch(() => "unknown" as const)
      .then((known) => {
        served = known;
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
