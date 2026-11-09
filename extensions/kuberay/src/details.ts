// The details sections of KubeRay objects (the manifest's `contributes.detailsSections`, one per kind):
//   ray-cluster — its state and why (the failing condition or `status.reason`), the head pod with its logs, IP and
//                 Service, the workers ready of desired, each worker group's replicas, bounds and ready pods, and the
//                 cluster's pods (watched by `ray.io/cluster=<name>` while open) with the merged logs of the workers;
//   ray-job     — its state, Ray's job status and KubeRay's deployment status, why it failed, the entrypoint as text with
//                 secret-looking flags and variables masked (mask.ts), its RayCluster, the submitter Job with its logs;
//   ray-service — its state and why it is not ready, the serve Service, the active RayCluster and the pending one of an
//                 upgrade with their Serve applications, and `serveConfigV2` with every environment value and
//                 secret-looking value masked (mask.ts), or not at all when it cannot be read safely.
// Each frame reads the shown object again whenever its resourceVersion changes. Conditions, events and YAML are
// Sextant's own sections. Read-only (ADR-0115).
import { trackObjects, ui, type KubeObject, type ObjectRef, type Sextant, type UiContent, type UiTone, type Watch, type WatchParams } from "@sextant/extension-sdk";
import { code, dateTime, element, errorText, note, remark } from "./dom";
import { t } from "./i18n";
import { maskedEntrypoint, maskedServeConfig } from "./mask";
import {
  activeOf,
  appTone,
  clip,
  CLUSTER_TONE,
  clusterReason,
  clusterSelector,
  clusterState,
  conditionOf,
  deploymentStatusOf,
  endpointsOf,
  get,
  GROUP_LABEL,
  headOf,
  isPodReady,
  isUnlimited,
  JOB,
  JOB_TONE,
  jobMessageOf,
  jobState,
  jobStatusOf,
  labelOf,
  MAX_LISTED_PODS,
  NODE_TYPE_LABEL,
  num,
  pendingOf,
  POD,
  podStatus,
  RAY_CLUSTER,
  record,
  serveServiceOf,
  SERVICE,
  SERVICE_TONE,
  serviceReason,
  serviceState,
  statusTone,
  str,
  submissionModeOf,
  submitterJobOf,
  submitterSelector,
  workerGroups,
  workerSelector,
  workersOf,
  type KindOf,
  type ServeApp,
  type ServeCluster,
} from "./model";
import { safeUriText } from "./uri";

/** A list watched while the section shows: its objects, whether the first answer came, whether it failed. */
export interface Live {
  items: KubeObject[];
  ready: boolean;
  failed: boolean;
}

/** The lists a section watches besides its object, by name; `undefined` when it watches none of that name. */
export type Related = Record<string, Live | undefined>;

const present = (nodes: (Node | null | false | undefined)[]): Node[] => nodes.filter((n): n is Node => Boolean(n));

/** A titled block as the built-in view's: open, and closable with its title. */
const block = (title: string, content: UiContent): HTMLElement => ui.block(title, content, { collapsible: true });

/** A link to an object's details in Sextant's panel, named by its name; nothing without a name. */
export function link(sextant: Sextant, kind: KindOf, name: string | undefined, namespace: string | null = null): HTMLElement | null {
  if (!name) return null;
  const button = ui.objectLink(sextant, { kind, namespace, name }, name);
  button.setAttribute("aria-label", t("openObject", { kind: kind.kind, name }));
  return button;
}

/** `ui.fields` labelled from `fields.<key>`, or nothing when no row has a value. */
export function fieldsOf(rows: readonly (readonly [string, UiContent])[]): HTMLElement | null {
  const list = ui.fields(rows.map(([key, value]) => [t(`fields.${key}`), value] as const));
  return list.childElementCount > 0 ? list : null;
}

/** A status word in its tone with a tooltip (the operator's reason), as the built-in tables drew it. */
function statusWord(text: string, tone: UiTone, title: string | undefined): HTMLElement {
  const node = ui.status(text, tone);
  if (title) node.title = title;
  return node;
}

/** A logs button: Sextant's logs tab opens; a refusal shows beside the buttons. */
function logsButton(sextant: Sextant, label: string, params: { namespace: string; pod: string } | { namespace: string; labelSelector: string }, error: HTMLElement): HTMLElement {
  return ui.button(label, () => {
    error.replaceChildren();
    void sextant.ui.openLogs(params).catch((err: unknown) => error.replaceChildren(ui.errorState(errorText(err))));
  });
}

// ---------- RayCluster ----------

/** What a RayCluster's section watches: its pods, by KubeRay's label, in its namespace. */
export function clusterWatches(obj: KubeObject): Record<string, Omit<WatchParams, "clusterId"> | null> {
  const ns = obj.metadata.namespace;
  const name = obj.metadata.name;
  return { pods: ns && name ? { kind: POD, namespaces: [ns], labelSelector: clusterSelector(name) } : null };
}

export function clusterView(sextant: Sextant, obj: KubeObject, related: Related): Node[] {
  const ns = obj.metadata.namespace ?? null;
  const name = obj.metadata.name;
  const state = clusterState(obj);
  const head = headOf(obj);
  const workers = workersOf(obj);
  const live = related.pods;
  const loading = live !== undefined && !live.ready;
  const failed = live?.failed === true;
  const pods = [...(live?.items ?? [])].sort((a, b) => (a.metadata.name ?? "").localeCompare(b.metadata.name ?? ""));
  const headPod = pods.find((p) => p.metadata.name === head.podName) ?? pods.find((p) => labelOf(p, NODE_TYPE_LABEL) === "head");
  const reason = clusterReason(obj);
  const desired = (["CPU", "Memory", "GPU", "TPU"] as const).map((r) => {
    const v = get(obj, "status", `desired${r}`);
    return v === undefined || v === null || v === "0" || v === 0 ? undefined : t(`desiredResource.${r}`, { value: String(v as string | number) });
  });
  const ready = new Map<string, number>();
  for (const p of pods) {
    const g = labelOf(p, GROUP_LABEL);
    if (g && labelOf(p, NODE_TYPE_LABEL) === "worker" && isPodReady(p)) ready.set(g, (ready.get(g) ?? 0) + 1);
  }
  const groups = workerGroups(obj).map((g) => [
    g.name,
    g.replicas === undefined ? "" : String(g.replicas * g.hosts),
    isUnlimited(g.max) ? t("boundsUnlimited", { min: g.min ?? 0 }) : t("bounds", { min: g.min ?? 0, max: g.max ?? 0 }),
    loading || failed ? "" : String(ready.get(g.name) ?? 0),
    g.suspended ? t("yes") : t("no"),
  ]);
  const listed = pods.slice(0, MAX_LISTED_PODS).map((p) => {
    const phase = podStatus(p);
    return [link(sextant, POD, p.metadata.name, ns), labelOf(p, NODE_TYPE_LABEL) ?? "", labelOf(p, GROUP_LABEL) ?? "", ui.status(phase, statusTone(phase))];
  });
  const error = element("div");
  const buttons =
    ns && name
      ? element(
          "div",
          { className: "kr-actions" },
          headPod ? logsButton(sextant, t("pods.headLogs"), { namespace: ns, pod: headPod.metadata.name }, error) : null,
          logsButton(sextant, t("pods.workerLogs"), { namespace: ns, labelSelector: workerSelector(name) }, error),
        )
      : null;
  const groupHeaders = ["name", "desired", "bounds", "ready", "suspended"].map((h) => t(`groups.${h}`));
  const podHeaders = ["name", "type", "group", "status"].map((h) => t(`pods.${h}`));
  return present([
    (state === "failed" || state === "headNotReady") && reason ? note(reason, "danger") : null,
    state === "provisioning" && reason ? note(reason, "warning") : null,
    (state === "suspended" || state === "suspending") && remark(t(`suspendedNote.${state}`)),
    fieldsOf([
      ["status", statusWord(t(`clusterState.${state}`), CLUSTER_TONE[state], reason)],
      ["rayVersion", str(get(obj, "spec", "rayVersion"))],
      ["workers", t("workersReady", { ready: workers.ready, desired: workers.desired })],
      [
        "workerBounds",
        workers.min !== undefined && workers.max !== undefined
          ? isUnlimited(workers.max)
            ? t("boundsUnlimited", { min: workers.min })
            : t("bounds", { min: workers.min, max: workers.max })
          : null,
      ],
      ["headPod", link(sextant, POD, head.podName ?? headPod?.metadata.name, ns)],
      ["headPodIP", head.podIP],
      ["headService", link(sextant, SERVICE, head.serviceName, ns)],
      ["headServiceIP", head.serviceIP],
      ["endpoints", ui.chips(endpointsOf(obj))],
      ["desired", ui.chips(desired)],
    ]),
    block(t("groups.title"), [
      groups.length > 0 && ui.table(groupHeaders, groups, { label: t("groups.title") }),
      groups.length === 0 && remark(t("groups.none")),
    ]),
    block(t("pods.title"), [
      buttons,
      error,
      loading && remark(t("pods.loading")),
      failed && remark(t("pods.error")),
      listed.length > 0 && ui.table(podHeaders, listed, { label: t("pods.title") }),
      !loading && !failed && pods.length === 0 && remark(t("pods.none")),
      pods.length > MAX_LISTED_PODS && remark(t("pods.more", { count: pods.length - MAX_LISTED_PODS })),
    ]),
  ]);
}

// ---------- RayJob ----------

export function jobView(sextant: Sextant, obj: KubeObject): Node[] {
  const ns = obj.metadata.namespace ?? null;
  const state = jobState(obj);
  const submitter = submitterJobOf(obj);
  const message = jobMessageOf(obj);
  const command = str(get(obj, "spec", "entrypoint"));
  const entrypoint = code(command === undefined ? undefined : maskedEntrypoint(command));
  const selector = Object.entries(record(get(obj, "spec", "clusterSelector"))).map(([k, v]) => `${k}=${String(v as string)}`);
  const error = element("div");
  const loud = state === "failed" || state === "retrying";
  return present([
    message && loud ? note(clip(message), state === "failed" ? "danger" : "warning") : null,
    message && !loud ? remark(clip(message)) : null,
    fieldsOf([
      ["status", statusWord(t(`jobState.${state}`), JOB_TONE[state], message)],
      ["jobStatus", jobStatusOf(obj)],
      ["deploymentStatus", deploymentStatusOf(obj)],
      ["reason", str(get(obj, "status", "reason"))],
      ["rayCluster", link(sextant, RAY_CLUSTER, str(get(obj, "status", "rayClusterName")), ns)],
      ["clusterSelector", ui.chips(selector)],
      ["submissionMode", submissionModeOf(obj)],
      ["submitter", link(sextant, JOB, submitter, ns)],
      ["jobId", str(get(obj, "status", "jobId"))],
      ["dashboardURL", safeUriText(str(get(obj, "status", "dashboardURL")))],
      ["startTime", dateTime(str(get(obj, "status", "startTime")))],
      ["endTime", dateTime(str(get(obj, "status", "endTime")))],
      ["succeeded", num(get(obj, "status", "succeeded"))?.toString()],
      ["failed", num(get(obj, "status", "failed"))?.toString()],
      ["shutdown", get(obj, "spec", "shutdownAfterJobFinishes") === true ? t("yes") : null],
    ]),
    block(t("entrypoint"), entrypoint ?? remark(t("noEntrypoint"))),
    ns && submitter ? element("div", { className: "kr-actions" }, logsButton(sextant, t("submitterLogs"), { namespace: ns, labelSelector: submitterSelector(submitter) }, error)) : null,
    error,
  ]);
}

// ---------- RayService ----------

/** The Serve applications of one cluster: name, status, deployments (healthy of all) and the messages. */
function appsTable(title: string, apps: ServeApp[]): HTMLElement | null {
  if (apps.length === 0) return null;
  const rows = apps.map((a) => [
    a.name,
    a.status ? ui.status(a.status, appTone(a.status)) : "",
    t("deploymentsHealthy", { healthy: a.deployments.filter((d) => d.status === "HEALTHY").length, total: a.deployments.length }),
    element(
      "span",
      { className: "kr-messages" },
      [a.message, ...a.deployments.filter((d) => d.status !== "HEALTHY" && d.message).map((d) => `${d.name}: ${d.message ?? ""}`)]
        .filter((m): m is string => Boolean(m))
        .map(clip)
        .join("\n"),
    ),
  ]);
  const headers = ["name", "status", "deployments", "message"].map((h) => t(`apps.${h}`));
  return ui.table(headers, rows, { label: title });
}

function serveClusterBlock(sextant: Sextant, title: string, cluster: ServeCluster, ns: string | null): HTMLElement | null {
  if (!cluster.rayClusterName && cluster.apps.length === 0) return null;
  return block(title, [
    fieldsOf([
      ["rayCluster", link(sextant, RAY_CLUSTER, cluster.rayClusterName, ns)],
      ["trafficPercent", cluster.trafficPercent === undefined ? null : t("percent", { value: cluster.trafficPercent })],
      ["targetCapacity", cluster.targetCapacity === undefined ? null : t("percent", { value: cluster.targetCapacity })],
    ]),
    appsTable(title, cluster.apps),
  ]);
}

export function serviceView(sextant: Sextant, obj: KubeObject): Node[] {
  const ns = obj.metadata.namespace ?? null;
  const state = serviceState(obj);
  const reason = serviceReason(obj);
  const upgrade = conditionOf(obj, "UpgradeInProgress");
  const rollback = conditionOf(obj, "RollbackInProgress");
  const configText = str(get(obj, "spec", "serveConfigV2"));
  const masked = configText ? maskedServeConfig(configText) : undefined;
  const serveConfig = !configText ? remark(t("noServeConfig")) : masked === undefined ? remark(t("serveConfigUnreadable")) : code(masked);
  return present([
    state !== "ready" && state !== "suspended" && reason ? note(clip(reason), state === "failed" ? "danger" : "warning") : null,
    state === "suspended" && remark(t("suspendedNote.service")),
    fieldsOf([
      ["status", statusWord(t(`serviceState.${state}`), SERVICE_TONE[state], reason)],
      ["serviceStatus", str(get(obj, "status", "serviceStatus"))],
      ["serveService", link(sextant, SERVICE, serveServiceOf(obj), ns)],
      ["serveEndpoints", num(get(obj, "status", "numServeEndpoints"))?.toString()],
      ["upgradeStrategy", str(get(obj, "spec", "upgradeStrategy", "type"))],
      ["upgrade", upgrade?.status === "True" ? upgrade.message || upgrade.reason : null],
      ["rollback", rollback?.status === "True" ? rollback.message || rollback.reason || t("yes") : null],
    ]),
    serveClusterBlock(sextant, t("activeCluster"), activeOf(obj), ns),
    serveClusterBlock(sextant, t("pendingCluster"), pendingOf(obj), ns),
    block(t("serveConfig"), serveConfig),
  ]);
}

// ---------- The section ----------

/** What each section watches besides its object. */
function watchesOf(contribution: string, obj: KubeObject): Record<string, Omit<WatchParams, "clusterId"> | null> {
  if (contribution === "ray-cluster") return clusterWatches(obj);
  return {};
}

/** The section's content for its object and the lists it watches. */
export function sectionView(sextant: Sextant, contribution: string, obj: KubeObject, related: Related): Node[] {
  switch (contribution) {
    case "ray-cluster":
      return clusterView(sextant, obj, related);
    case "ray-job":
      return jobView(sextant, obj);
    case "ray-service":
      return serviceView(sextant, obj);
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
    const live: Live = { items: [], ready: false, failed: false };
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
 * changes; a RayCluster's pods watched while it shows, and drawn again as they change.
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
    const related = watches.want(watchesOf(contribution, object));
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
