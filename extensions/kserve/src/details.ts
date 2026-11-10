// The details sections of KServe objects (the manifest's `contributes.detailsSections`, one per kind):
//   inference-service        — its state and why (the failing condition or the model's last failure), URL and address,
//                              the deployment mode, the runtime KServe recorded, each component (predictor,
//                              transformer, explainer) with its model format, runtime, storage URI (never with
//                              credentials or a query), replicas, revisions, traffic split and what KServe made for it
//                              (Knative Services, Deployments, Services by `serving.kserve.io/inferenceservice=<name>`,
//                              metadata only), the model status, and the runtime KServe chooses for the predictor
//                              (the namespace's ServingRuntimes and the ClusterServingRuntimes, chosen as KServe does);
//   serving-runtime, cluster-serving-runtime, inference-graph, trained-model — see ./views.ts.
// Each frame reads the shown object again whenever its resourceVersion changes; the lists it needs besides are watched,
// only for kinds the cluster serves, while the blocks that show them are open, as the built-in view's were: the runtimes
// while "Serving runtime" is, what KServe made while a component's block is. The blocks open and close as the built-in
// section's did, kept in Sextant's own memory of details sections (`context.blocks`, `ui.setBlockOpen`) with the panel's
// "Expand all" and "Collapse all". Conditions, events and YAML are Sextant's own sections. Read-only (ADR-0115).
import { trackObjects, ui, type KubeObject, type ObjectRef, type Sextant, type Watch, type WatchParams } from "@sextant/extension-sdk";
import { block, dateTime, errorText, fieldsOf, formatList, link, links, note, OPEN_BLOCKS, remark, tableOf, uri, type BlockMemory } from "./dom";
import { t } from "./i18n";
import {
  CLUSTER_SERVING_RUNTIME,
  COMPONENT_LABEL,
  componentStatusOf,
  componentsOf,
  deploymentModeOf,
  get,
  invalidSpec,
  ISVC_LABEL,
  modelFailed,
  modelStatusOf,
  record,
  recordedRuntimeOf,
  SERVICE_TONE,
  serviceReason,
  serviceState,
  SERVING_RUNTIME,
  str,
  type ComponentSpec,
  type KindRef,
} from "./model";
import { chooseRuntime, type RuntimeRef } from "./runtimes";
import { graphView, runtimeView, trainedModelView } from "./views";

export const KSERVICE: KindRef = { group: "serving.knative.dev", version: "v1", kind: "Service" };
export const REVISION: KindRef = { group: "serving.knative.dev", version: "v1", kind: "Revision" };
export const DEPLOYMENT: KindRef = { group: "apps", version: "v1", kind: "Deployment" };
export const SERVICE: KindRef = { group: "", version: "v1", kind: "Service" };

/** Runtimes one list keeps (a cluster has a handful; a cap all the same): past it the choice cannot be told. */
export const MAX_RUNTIMES = 500;
/** Objects of one kind KServe made for one InferenceService that are shown (a few per component). */
export const MAX_UNDERLYING = 100;

/** A list watched while the section shows. */
export interface Listed {
  items: KubeObject[];
  /** The first answer came, or the kind is not served. */
  loaded: boolean;
  /** The cluster does not serve the kind. */
  notServed: boolean;
  /** Not readable: "none" is not known. */
  error: boolean;
  /** More than the list keeps. */
  truncated: boolean;
}

/** The lists a section watches besides its object, by name. */
export type Related = Record<string, Listed | undefined>;

export const runtimeKind = (ref: Pick<RuntimeRef, "cluster">): KindRef => (ref.cluster ? CLUSTER_SERVING_RUNTIME : SERVING_RUNTIME);

const present = (nodes: (Node | null | false | undefined)[]): Node[] => nodes.filter((n): n is Node => Boolean(n));

/** The state in words with what explains it on hover. */
export function serviceStateText(obj: KubeObject): HTMLElement {
  const state = serviceState(obj);
  const node = ui.status(t(`state.${state}`), SERVICE_TONE[state]);
  const reason = serviceReason(obj);
  if (reason) node.title = reason;
  return node;
}

// ---------- What it watches ----------

const kindKey = (kind: Pick<KindRef, "group" | "kind">): string => `${kind.group}/${kind.kind}`;

/**
 * What an InferenceService's section watches: the runtimes the choice reads while its block is open, and what KServe
 * made for it while one of its components' blocks is.
 */
export function serviceWatches(obj: KubeObject, memory: BlockMemory = OPEN_BLOCKS): Record<string, Omit<WatchParams, "clusterId"> | null> {
  const ns = obj.metadata.namespace;
  const name = obj.metadata.name;
  const components = componentsOf(obj);
  const madeShown = components.some((c) => memory.isOpen(componentBlockId(c.name)));
  const choiceShown = components.some((c) => c.name === "predictor") && memory.isOpen(CHOICE_BLOCK);
  const made = (kind: KindRef): Omit<WatchParams, "clusterId"> | null =>
    madeShown && ns && name ? { kind, namespaces: [ns], labelSelector: `${ISVC_LABEL}=${name}`, metadataOnly: true } : null;
  return {
    namespaced: choiceShown && ns ? { kind: SERVING_RUNTIME, namespaces: [ns] } : null,
    clusterWide: choiceShown ? { kind: CLUSTER_SERVING_RUNTIME } : null,
    knative: made(KSERVICE),
    deployments: made(DEPLOYMENT),
    services: made(SERVICE),
  };
}

/** The blocks' ids, as the built-in view named them (without its `kserve:` prefix: ids are `[A-Za-z0-9._-]`). */
export const componentBlockId = (name: string): string => `component.${name}`;
export const MODEL_STATUS_BLOCK = "modelStatus";
export const CHOICE_BLOCK = "choice";

const LIMITS: Record<string, number> = { namespaced: MAX_RUNTIMES, clusterWide: MAX_RUNTIMES, knative: MAX_UNDERLYING, deployments: MAX_UNDERLYING, services: MAX_UNDERLYING };

// ---------- InferenceService ----------

const ofComponent = (list: Listed | undefined, name: string): KubeObject[] =>
  (list?.items ?? []).filter((o) => str(record(o.metadata.labels)[COMPONENT_LABEL]) === name);

function componentBlock(sextant: Sextant, obj: KubeObject, spec: ComponentSpec, related: Related, memory: BlockMemory): HTMLElement {
  const ns = obj.metadata.namespace ?? null;
  const s = componentStatusOf(obj, spec.name);
  const fields = fieldsOf([
    ["modelFormat", spec.format ? [spec.format.name, spec.format.version].filter(Boolean).join(":") : null],
    ["runtime", spec.runtime],
    ["storageUri", uri(spec.storageUri)],
    ["protocolVersion", spec.protocolVersion],
    ["images", ui.chips(spec.images)],
    [
      "replicas",
      spec.maxReplicas
        ? t("bounds", { min: spec.minReplicas ?? 1, max: spec.maxReplicas })
        : spec.minReplicas !== undefined
          ? String(spec.minReplicas)
          : null,
    ],
    ["canaryTrafficPercent", spec.canaryTrafficPercent === undefined ? null : t("percent", { value: spec.canaryTrafficPercent })],
    ["workers", spec.workers ? t("yes") : null],
    ["componentUrl", uri(s?.url)],
    ["latestReadyRevision", link(sextant, REVISION, s?.latestReadyRevision, ns)],
    ["latestCreatedRevision", s?.latestCreatedRevision !== s?.latestReadyRevision ? link(sextant, REVISION, s?.latestCreatedRevision, ns) : null],
    ["previousRolledoutRevision", s?.previousRolledoutRevision],
    ["knativeService", links(ofComponent(related.knative, spec.name).map((o) => link(sextant, KSERVICE, o.metadata.name, ns)))],
    ["deployment", links(ofComponent(related.deployments, spec.name).map((o) => link(sextant, DEPLOYMENT, o.metadata.name, ns)))],
    ["service", links(ofComponent(related.services, spec.name).map((o) => link(sextant, SERVICE, o.metadata.name, ns)))],
  ]);
  const traffic = (s?.traffic ?? []).map((tr) => [
    link(sextant, REVISION, tr.revision, ns) ?? "",
    tr.percent === undefined ? "" : t("percent", { value: tr.percent }),
    tr.tag ?? "",
    tr.latest ? t("yes") : t("no"),
  ]);
  const headers = ["revision", "percent", "tag", "latest"].map((h) => t(`traffic.${h}`));
  return block(memory, componentBlockId(spec.name), t(`component.${spec.name}`), () => [fields, tableOf(headers, traffic, t(`component.${spec.name}`))]);
}

function modelStatusBlock(obj: KubeObject, memory: BlockMemory): HTMLElement | null {
  const m = modelStatusOf(obj);
  if (!m.transitionStatus && !m.activeModelState && !m.targetModelState && !m.failure) return null;
  const fields = fieldsOf([
    ["transitionStatus", m.transitionStatus],
    ["activeModelState", m.activeModelState],
    ["targetModelState", m.targetModelState],
    ["failureReason", m.failure?.reason],
    ["failureLocation", m.failure?.location],
    ["failureTime", dateTime(m.failure?.time)],
    ["exitCode", m.failure?.exitCode?.toString()],
    ["copies", m.copies?.total !== undefined ? t("copies", { failed: m.copies.failed ?? 0, total: m.copies.total }) : null],
  ]);
  const message = m.failure?.message ? note(m.failure.message, modelFailed(m) || invalidSpec(m) ? "danger" : "warning") : null;
  return block(memory, MODEL_STATUS_BLOCK, t("modelStatus"), () => [fields, message]);
}

/** "Serving runtime": the runtime KServe chooses now, the other candidates in its order, why none fits. */
function runtimeChoiceBlock(sextant: Sextant, obj: KubeObject, predictor: ComponentSpec, modelMesh: boolean, related: Related, memory: BlockMemory): HTMLElement {
  return block(memory, CHOICE_BLOCK, t("choice.title"), () => runtimeChoice(sextant, obj, predictor, modelMesh, related));
}

function runtimeChoice(sextant: Sextant, obj: KubeObject, predictor: ComponentSpec, modelMesh: boolean, related: Related): (Node | null)[] {
  const ns = obj.metadata.namespace ?? null;
  const namespaced = related.namespaced;
  const clusterWide = related.clusterWide;
  const recorded = recordedRuntimeOf(obj);
  let body: (Node | null)[];
  if (!namespaced?.loaded || !clusterWide?.loaded) body = [remark(t("choice.loading"))];
  else if (namespaced.notServed && clusterWide.notServed) body = [remark(t("choice.notServed"))];
  else if (namespaced.error || clusterWide.error || namespaced.truncated || clusterWide.truncated) body = [remark(t("choice.unreadable"))];
  else {
    const choice = chooseRuntime(predictor, namespaced.items, clusterWide.items, modelMesh);
    if (choice.kind === "noFormat") body = [remark(t("choice.noFormat"))];
    else if (choice.kind === "none") body = [note(t("choice.none", { format: predictor.format?.name ?? "" }), "danger")];
    else if (choice.kind === "chosen") {
      const differs = recorded && (recorded.name !== choice.runtime.name || recorded.cluster !== choice.runtime.cluster);
      const others = choice.candidates.slice(1).map((c) => c.name);
      const chosen = link(sextant, runtimeKind(choice.runtime), choice.runtime.name, choice.runtime.cluster ? null : ns);
      body = [
        fieldsOf([[choice.named ? "named" : "auto", chosen]], "choice.fields."),
        others.length > 0 ? remark(t("choice.others", { names: formatList(others) })) : null,
        differs ? note(t("choice.differs", { recorded: recorded.name }), "warning") : null,
      ];
    } else body = [note(t(`choice.${choice.kind}`, { name: choice.runtime.name }), "danger")];
  }
  return body;
}

export function serviceView(sextant: Sextant, obj: KubeObject, related: Related, memory: BlockMemory = OPEN_BLOCKS): Node[] {
  const ns = obj.metadata.namespace ?? null;
  const state = serviceState(obj);
  const reason = serviceReason(obj);
  const mode = deploymentModeOf(obj);
  const recorded = recordedRuntimeOf(obj);
  const components = componentsOf(obj);
  const predictor = components.find((c) => c.name === "predictor");
  return present([
    (state === "failed" || state === "notReady") && reason ? note(reason, state === "failed" ? "danger" : "warning") : null,
    state === "stopped" && remark(t("stoppedNote")),
    fieldsOf([
      ["status", serviceStateText(obj)],
      ["url", uri(str(get(obj, "status", "url")))],
      ["address", uri(str(get(obj, "status", "address", "url")))],
      ["deploymentMode", mode ? t(`mode.${mode.mode}`, { value: mode.raw }) : t("mode.default")],
      ["recordedRuntime", recorded ? link(sextant, runtimeKind(recorded), recorded.name, recorded.cluster ? null : ns) : null],
    ]),
    ...components.map((c) => componentBlock(sextant, obj, c, related, memory)),
    modelStatusBlock(obj, memory),
    predictor ? runtimeChoiceBlock(sextant, obj, predictor, mode?.mode === "modelMesh", related, memory) : null,
  ]);
}

// ---------- The section ----------

/** What each section watches besides its object. */
function watchesOf(contribution: string, obj: KubeObject, memory: BlockMemory): Record<string, Omit<WatchParams, "clusterId"> | null> {
  return contribution === "inference-service" ? serviceWatches(obj, memory) : {};
}

/** The section's content for its object and the lists it watches. */
export function sectionView(sextant: Sextant, contribution: string, obj: KubeObject, related: Related, memory: BlockMemory = OPEN_BLOCKS): Node[] {
  switch (contribution) {
    case "inference-service":
      return serviceView(sextant, obj, related, memory);
    case "serving-runtime":
    case "cluster-serving-runtime":
      return runtimeView(obj, memory);
    case "inference-graph":
      return graphView(sextant, obj, memory);
    case "trained-model":
      return trainedModelView(sextant, obj);
    default:
      return [ui.empty(t("common.nothingToShow", { view: contribution }))];
  }
}

/**
 * The watches a section holds, by what they watch: started when first wanted, stopped when no longer. A kind the
 * cluster does not serve is never watched: its list is loaded, empty and `notServed`. Each keeps at most its limit
 * (`maxObjects`, as the built-in watches did); one that matches more is `truncated`.
 */
class Watches {
  private readonly open = new Map<string, { watch: Watch; live: Listed }>();
  constructor(
    private readonly sextant: Sextant,
    private readonly changed: () => void,
  ) {}

  /** The lists of `specs` (by name), each watched from now on; every other watch stops. `served`: `null` until known. */
  want(specs: Record<string, Omit<WatchParams, "clusterId"> | null>, served: Set<string> | null | "unknown"): Related {
    const keep = new Set<string>();
    const related: Related = {};
    for (const [name, wanted] of Object.entries(specs)) {
      if (!wanted) continue;
      if (served === null) {
        related[name] = { items: [], loaded: false, notServed: false, error: false, truncated: false };
        continue;
      }
      const kind = wanted.kind as KindRef;
      if (served !== "unknown" && !served.has(kindKey(kind))) {
        related[name] = { items: [], loaded: true, notServed: true, error: false, truncated: false };
        continue;
      }
      const limit = LIMITS[name];
      const spec = limit === undefined ? wanted : { ...wanted, maxObjects: limit };
      const key = JSON.stringify(spec);
      keep.add(key);
      const live = (this.open.get(key) ?? this.start(key, spec, limit ?? Infinity)).live;
      related[name] = live;
    }
    for (const [key, entry] of this.open) {
      if (keep.has(key)) continue;
      this.open.delete(key);
      void entry.watch.unwatch().catch(() => undefined);
    }
    return related;
  }

  private start(key: string, spec: Omit<WatchParams, "clusterId">, limit: number): { watch: Watch; live: Listed } {
    const live: Listed = { items: [], loaded: false, notServed: false, error: false, truncated: false };
    /** How many match in all, when the core kept fewer. */
    let total = 0;
    let kept = 0;
    const settle = (error: boolean) => {
      live.loaded = true;
      live.error = error;
      this.changed();
    };
    const watch = this.sextant.resources.watch(spec, {
      onUpdate: trackObjects(
        (items) => {
          const sorted = [...items].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
          live.items = sorted.slice(0, limit);
          kept = sorted.length;
          live.truncated = kept > limit || total > limit;
          settle(false);
        },
        (other) => {
          if (other.type === "error" || other.type === "forbidden") settle(true);
        },
      ),
      onCapped: (count) => {
        total = count;
        live.truncated = kept > limit || total > limit;
        this.changed();
      },
      onError: () => settle(true),
    });
    watch.started.catch(() => undefined);
    const entry = { watch, live };
    this.open.set(key, entry);
    return entry;
  }

  stop(): void {
    this.want({}, "unknown");
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
 * changes; the lists it needs besides (an InferenceService's runtimes and what KServe made for it) watched while the
 * blocks that show them are open, and drawn again as they change. Its blocks open and close as Sextant remembers them:
 * a toggle is written there and draws the section again (the focus stays on the toggle), and the section follows the
 * panel's "Expand all" and "Collapse all".
 */
export function startDetails(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  let shownVersion: string | null | undefined;
  let shownRef: string | null = null;
  let reading = 0;
  let object: KubeObject | null = null;
  let scheduled = false;
  let stopped = false;
  // The kinds the cluster serves, of those the extension may read: `null` until known, "unknown" when not readable.
  let served: Set<string> | null | "unknown" = contribution === "inference-service" ? null : "unknown";

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
    if (!object || stopped) return;
    const focused = focusedBlock(root);
    shownBlocks.clear();
    const related = watches.want(watchesOf(contribution, object, memory), served);
    root.replaceChildren(...sectionView(sextant, contribution, object, related, memory));
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
