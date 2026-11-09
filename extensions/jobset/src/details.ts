// The details section of a JobSet (the manifest's `contributes.detailsSections`, id `jobset`): its state, and when it
// failed the controller's reason and message with the first failed Job and that Job's own failure reason; restarts
// against `failurePolicy.maxRestarts`; the success, failure and startup policies; the replicated jobs with their
// counts; its Jobs and their pods (links). Its Jobs and pods are watched while the section shows, in the JobSet's
// namespace only, selected on the API server by the label the controller puts on them
// (`jobset.sigs.k8s.io/jobset-name=<name>`). The frame reads the shown object again whenever its resourceVersion
// changes. Conditions, events and YAML are Sextant's own sections. Read-only (ADR-0114).
import { trackObjects, ui, type KubeObject, type ObjectRef, type Sextant, type UiContent, type Watch, type WatchParams } from "@sextant/extension-sdk";
import { dateTime, errorText, note, reasonText, remark } from "./dom";
import { i18n, t } from "./i18n";
import {
  conditionOf,
  failureRules,
  firstFailedJob,
  get,
  JOB,
  JOB_INDEX_LABEL,
  JOB_TONE,
  JOBSET_NAME_LABEL,
  JOBSET_TONE,
  jobSetState,
  jobState,
  labelOf,
  num,
  POD,
  podStatus,
  REPLICATED_JOB_LABEL,
  replicatedJobs,
  RESTART_ATTEMPT_LABEL,
  restartsOf,
  statusTone,
  str,
  successPolicyOf,
  type KindOf,
} from "./model";

/** Pods listed at most (not running first). */
export const MAX_LISTED_PODS = 50;

/** A list watched while the section shows: its objects, whether the first answer came, whether it failed. */
export interface Live {
  items: KubeObject[];
  ready: boolean;
  failed: boolean;
}

const present = (nodes: (Node | null | false | undefined)[]): Node[] => nodes.filter((n): n is Node => Boolean(n));

/** A titled block as the built-in view's: open, and closable with its title. */
const block = (title: string, content: UiContent): HTMLElement => ui.block(title, content, { collapsible: true });

/** A link to an object's details in Sextant's panel; nothing without a name. */
export function link(sextant: Sextant, kind: KindOf, name: string | undefined, namespace: string | null): HTMLElement | null {
  if (!name) return null;
  const button = ui.objectLink(sextant, { kind, namespace, name });
  button.setAttribute("aria-label", t("openObject", { kind: kind.kind, name }));
  return button;
}

/** `ui.fields` labelled from `fields.<key>`, or nothing when no row has a value. */
function fieldsOf(rows: readonly (readonly [string, UiContent])[]): HTMLElement | null {
  const list = ui.fields(rows.map(([key, value]) => [t(`fields.${key}`), value] as const));
  return list.childElementCount > 0 ? list : null;
}

/** The JobSet's state in its tone, the Failed or Completed condition's reason and message on hover. */
export function stateText(obj: KubeObject): HTMLElement {
  const state = jobSetState(obj);
  const node = ui.status(t(`state.${state}`), JOBSET_TONE[state]);
  const c = conditionOf(obj, state === "completed" ? "Completed" : "Failed");
  const title = state === "failed" || state === "completed" ? reasonText(c?.reason, c?.message) : "";
  if (title) node.title = title;
  return node;
}

/** Why it failed: the Failed condition, the first failed Job and that Job's own reason. */
function failure(sextant: Sextant, obj: KubeObject, jobs: Live): Node[] {
  const failed = conditionOf(obj, "Failed");
  const first = firstFailedJob(failed?.message);
  const job = first ? jobs.items.find((j) => j.metadata.name === first) : undefined;
  const reason = job ? jobState(job) : undefined;
  return present([
    note(reasonText(failed?.reason, failed?.message) || t("failedNoReason"), "danger"),
    first ? fieldsOf([["firstFailedJob", link(sextant, JOB, first, obj.metadata.namespace ?? null)]]) : null,
    reason?.state === "failed" && note(reasonText(reason.reason, reason.message), "danger"),
    Boolean(first) && !job && jobs.ready && remark(t("failedJobGone")),
  ]);
}

function jobsBlock(sextant: Sextant, obj: KubeObject, jobs: Live): HTMLElement {
  const ns = obj.metadata.namespace ?? null;
  const rows = jobs.items.map((j) => {
    const s = jobState(j);
    return [
      link(sextant, JOB, j.metadata.name, ns),
      labelOf(j, REPLICATED_JOB_LABEL) ?? "",
      labelOf(j, JOB_INDEX_LABEL) ?? "",
      ui.status(t(`jobState.${s.state}`), JOB_TONE[s.state]),
      labelOf(j, RESTART_ATTEMPT_LABEL) ?? "",
      reasonText(s.reason, s.message),
    ];
  });
  const headers = ["job", "replicatedJob", "index", "state", "attempt", "reason"].map((h) => t(`jobs.${h}`));
  const content = !jobs.ready
    ? remark(t("loading"))
    : rows.length > 0
      ? ui.table(headers, rows, { label: t("jobs.title") })
      : remark(jobs.failed ? t("listUnknown") : t("noJobs"));
  return block(t("jobs.title"), content);
}

const RUNNING = new Set(["Running", "Succeeded", "Completed"]);

function podsBlock(sextant: Sextant, obj: KubeObject, pods: Live): HTMLElement {
  const ns = obj.metadata.namespace ?? null;
  const sorted = [...pods.items].sort((a, b) => Number(RUNNING.has(podStatus(a))) - Number(RUNNING.has(podStatus(b))));
  const shown = sorted.slice(0, MAX_LISTED_PODS);
  const rows = shown.map((p) => {
    const phase = podStatus(p);
    return [link(sextant, POD, p.metadata.name, ns), labelOf(p, "batch.kubernetes.io/job-name") ?? labelOf(p, "job-name") ?? "", ui.status(phase, statusTone(phase))];
  });
  const headers = ["pod", "job", "status"].map((h) => t(`pods.${h}`));
  const content = !pods.ready
    ? remark(t("loading"))
    : rows.length > 0
      ? ui.table(headers, rows, { label: t("pods.title") })
      : remark(pods.failed ? t("listUnknown") : t("noPods"));
  return block(t("pods.title"), [content, sorted.length > shown.length ? remark(t("morePods", { shown: shown.length, total: sorted.length })) : null]);
}

/** The success policy in words: `All`/`Any` Job of the targets (every replicated job without targets). */
function successText(obj: KubeObject): string {
  const success = successPolicyOf(obj);
  const op = success.operator === "Any" ? "any" : "all";
  if (success.targets.length === 0) return t(`success.${op}`);
  return t(`success.${op}Of`, { targets: i18n().formatList(success.targets) });
}

/** What the section watches besides its object: the JobSet's Jobs and their pods, by the controller's label. */
export function childWatches(obj: KubeObject): Record<"jobs" | "pods", Omit<WatchParams, "clusterId"> | null> {
  const ns = obj.metadata.namespace;
  const name = obj.metadata.name;
  if (!ns || !name) return { jobs: null, pods: null };
  const labelSelector = `${JOBSET_NAME_LABEL}=${name}`;
  return {
    jobs: { kind: JOB, namespaces: [ns], labelSelector },
    pods: { kind: POD, namespaces: [ns], labelSelector },
  };
}

const NONE: Live = { items: [], ready: false, failed: false };

export function jobSetView(sextant: Sextant, obj: KubeObject, related: { jobs?: Live; pods?: Live }): Node[] {
  const jobs = related.jobs ?? NONE;
  const pods = related.pods ?? NONE;
  const state = jobSetState(obj);
  const restarts = restartsOf(obj);
  const coordinator = get(obj, "spec", "coordinator");
  const coordinatorText = str(get(coordinator, "replicatedJob"))
    ? `${str(get(coordinator, "replicatedJob"))}-${num(get(coordinator, "jobIndex")) ?? 0}-${num(get(coordinator, "podIndex")) ?? 0}`
    : undefined;
  const nearLimit = restarts.max !== undefined && restarts.max > 0 && restarts.counted >= restarts.max - 1 && state !== "failed" && state !== "completed";
  const replicated = replicatedJobs(obj).map((r) => [
    r.name,
    String(r.replicas),
    r.completions === undefined && r.parallelism === undefined ? "" : `${r.completions ?? 1}/${r.parallelism ?? 1}`,
    String(r.ready),
    String(r.active),
    String(r.succeeded),
    r.failed > 0 ? ui.status(String(r.failed), "danger") : "0",
    ui.chips(r.dependsOn),
  ]);
  const rules = failureRules(obj).map((r) => [r.name, r.action, ui.chips([...r.reasons, ...r.patterns]), ui.chips(r.targets)]);
  const repHeaders = ["name", "replicas", "completions", "ready", "active", "succeeded", "failed", "dependsOn"].map((h) => t(`replicated.${h}`));
  const ruleHeaders = ["name", "action", "onFailure", "targets"].map((h) => t(`rules.${h}`));
  return present([
    ...(state === "failed" ? failure(sextant, obj, jobs) : []),
    nearLimit && note(t("nearLimit", { counted: restarts.counted, max: restarts.max ?? 0 }), "warning"),
    state === "suspended" && remark(t("suspendedNote")),
    fieldsOf([
      ["status", stateText(obj)],
      ["terminalState", str(get(obj, "status", "terminalState"))],
      ["restarts", restarts.max === undefined ? String(restarts.total) : t("restartsOfMax", { counted: restarts.counted, max: restarts.max, total: restarts.total })],
      ["restartStrategy", str(get(obj, "spec", "failurePolicy", "restartStrategy")) ?? (restarts.max === undefined ? null : "Recreate")],
      ["successPolicy", successText(obj)],
      ["startupPolicy", str(get(obj, "spec", "startupPolicy", "startupPolicyOrder"))],
      ["suspend", get(obj, "spec", "suspend") === true ? t("yes") : null],
      ["startTime", dateTime(str(get(obj, "status", "startTime")))],
      ["activeDeadline", num(get(obj, "spec", "activeDeadlineSeconds"))?.toString()],
      ["ttlAfterFinished", num(get(obj, "spec", "ttlSecondsAfterFinished"))?.toString()],
      ["subdomain", str(get(obj, "spec", "network", "subdomain"))],
      ["coordinator", coordinatorText],
      ["managedBy", str(get(obj, "spec", "managedBy"))],
    ]),
    replicated.length > 0 && block(t("replicated.title"), ui.table(repHeaders, replicated, { label: t("replicated.title") })),
    rules.length > 0 && block(t("rules.title"), ui.table(ruleHeaders, rules, { label: t("rules.title") })),
    jobsBlock(sextant, obj, jobs),
    podsBlock(sextant, obj, pods),
  ]);
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
    const live: Live = { items: [], ready: false, failed: false };
    const settle = (failed: boolean) => {
      live.ready = true;
      live.failed = failed;
      this.changed();
    };
    const watch = this.sextant.resources.watch(spec, {
      onUpdate: trackObjects(
        (items) => {
          live.items = [...items].sort((a, b) => (a.metadata.name ?? "").localeCompare(b.metadata.name ?? ""));
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
 * changes; its Jobs and pods watched while it shows, and drawn again as they change.
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
    if (contribution !== "jobset") {
      root.replaceChildren(ui.empty(t("common.nothingToShow", { view: contribution })));
      return;
    }
    const related = watches.want(childWatches(object));
    root.replaceChildren(...jobSetView(sextant, object, related));
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
