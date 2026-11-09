// The details sections of KServe objects (the manifest's `contributes.detailsSections`, one per kind):
//   inference-service        — its state and why (the failing condition or the model's last failure), URL and address,
//                              the deployment mode, the runtime KServe recorded, each component (predictor,
//                              transformer, explainer) with its model format, runtime, storage URI (never with
//                              credentials or a query), replicas, revisions, traffic split and what KServe made for it
//                              (Knative Services, Deployments, Services by `serving.kserve.io/inferenceservice=<name>`,
//                              metadata only), the model status, and the runtime KServe chooses for the predictor
//                              (the namespace's ServingRuntimes and the ClusterServingRuntimes, chosen as KServe does);
//   serving-runtime, cluster-serving-runtime, inference-graph, trained-model — see ./views.ts.
// Each frame reads the shown object again whenever its resourceVersion changes; the lists it needs besides are watched
// while it shows, only for kinds the cluster serves. Conditions, events and YAML are Sextant's own sections.
// Read-only (ADR-0115).
import { trackObjects, ui, type KubeObject, type ObjectRef, type Sextant, type Watch, type WatchParams } from "@sextant/extension-sdk";
import { block, dateTime, errorText, fieldsOf, formatList, link, links, note, remark, tableOf, uri } from "./dom";
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

/** What an InferenceService's section watches: the runtimes the choice reads, and what KServe made for it. */
export function serviceWatches(obj: KubeObject): Record<string, Omit<WatchParams, "clusterId"> | null> {
  const ns = obj.metadata.namespace;
  const name = obj.metadata.name;
  const made = (kind: KindRef): Omit<WatchParams, "clusterId"> | null =>
    ns && name ? { kind, namespaces: [ns], labelSelector: `${ISVC_LABEL}=${name}`, metadataOnly: true } : null;
  return {
    namespaced: ns ? { kind: SERVING_RUNTIME, namespaces: [ns] } : null,
    clusterWide: { kind: CLUSTER_SERVING_RUNTIME },
    knative: made(KSERVICE),
    deployments: made(DEPLOYMENT),
    services: made(SERVICE),
  };
}

const LIMITS: Record<string, number> = { namespaced: MAX_RUNTIMES, clusterWide: MAX_RUNTIMES, knative: MAX_UNDERLYING, deployments: MAX_UNDERLYING, services: MAX_UNDERLYING };

// ---------- InferenceService ----------

const ofComponent = (list: Listed | undefined, name: string): KubeObject[] =>
  (list?.items ?? []).filter((o) => str(record(o.metadata.labels)[COMPONENT_LABEL]) === name);

function componentBlock(sextant: Sextant, obj: KubeObject, spec: ComponentSpec, related: Related): HTMLElement {
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
  return block(t(`component.${spec.name}`), [fields, tableOf(headers, traffic, t(`component.${spec.name}`))]);
}

function modelStatusBlock(obj: KubeObject): HTMLElement | null {
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
  return block(t("modelStatus"), [fields, message]);
}

/** "Serving runtime": the runtime KServe chooses now, the other candidates in its order, why none fits. */
function runtimeChoiceBlock(sextant: Sextant, obj: KubeObject, predictor: ComponentSpec, modelMesh: boolean, related: Related): HTMLElement {
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
  return block(t("choice.title"), body);
}

export function serviceView(sextant: Sextant, obj: KubeObject, related: Related): Node[] {
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
    ...components.map((c) => componentBlock(sextant, obj, c, related)),
    modelStatusBlock(obj),
    predictor ? runtimeChoiceBlock(sextant, obj, predictor, mode?.mode === "modelMesh", related) : null,
  ]);
}

// ---------- The section ----------

/** What each section watches besides its object. */
function watchesOf(contribution: string, obj: KubeObject): Record<string, Omit<WatchParams, "clusterId"> | null> {
  return contribution === "inference-service" ? serviceWatches(obj) : {};
}

/** The section's content for its object and the lists it watches. */
export function sectionView(sextant: Sextant, contribution: string, obj: KubeObject, related: Related): Node[] {
  switch (contribution) {
    case "inference-service":
      return serviceView(sextant, obj, related);
    case "serving-runtime":
    case "cluster-serving-runtime":
      return runtimeView(obj);
    case "inference-graph":
      return graphView(sextant, obj);
    case "trained-model":
      return trainedModelView(sextant, obj);
    default:
      return [ui.empty(t("common.nothingToShow", { view: contribution }))];
  }
}

/**
 * The watches a section holds, by what they watch: started when first wanted, stopped when no longer. A kind the
 * cluster does not serve is never watched: its list is loaded, empty and `notServed`.
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
    for (const [name, spec] of Object.entries(specs)) {
      if (!spec) continue;
      if (served === null) {
        related[name] = { items: [], loaded: false, notServed: false, error: false, truncated: false };
        continue;
      }
      const kind = spec.kind as KindRef;
      if (served !== "unknown" && !served.has(kindKey(kind))) {
        related[name] = { items: [], loaded: true, notServed: true, error: false, truncated: false };
        continue;
      }
      const key = JSON.stringify(spec);
      keep.add(key);
      const live = (this.open.get(key) ?? this.start(key, spec, LIMITS[name] ?? Infinity)).live;
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
          live.truncated = sorted.length > limit;
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
    this.want({}, "unknown");
  }
}

/**
 * Starts the details section `contribution` on the object in the context: read again whenever its resourceVersion
 * changes; the lists it needs besides (an InferenceService's runtimes and what KServe made for it) watched while it
 * shows, and drawn again as they change.
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

  const render = () => {
    if (!object || stopped) return;
    const related = watches.want(watchesOf(contribution, object), served);
    root.replaceChildren(...sectionView(sextant, contribution, object, related));
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
  const stopFollow = sextant.onContextChange(follow);
  return () => {
    stopped = true;
    stopFollow();
    watches.stop();
  };
}

