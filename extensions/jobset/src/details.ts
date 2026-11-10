// The details section of a JobSet (the manifest's `contributes.detailsSections`, id `jobset`): its state, and when it
// failed the controller's reason and message with the first failed Job and that Job's own failure reason; restarts
// against `failurePolicy.maxRestarts`; the success, failure and startup policies; the replicated jobs with their
// counts; its Jobs and their pods (links). Its blocks open and close as the built-in panel's did, in Sextant's own
// memory of details sections (the context's `blocks`, `ui.setBlockOpen`), so "Expand all", "Collapse all" and
// Settings → Appearance apply to them. Its Jobs are watched while their block is open or the JobSet failed, its pods while theirs is
// open, in the JobSet's namespace only, selected on the API server by the label the controller puts on them
// (`jobset.sigs.k8s.io/jobset-name=<name>`), each list at most `MAX_CHILDREN` objects (a TPU multislice JobSet can run
// thousands of pods) with a note when it is cut. The frame reads the shown object again whenever its resourceVersion
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
/** Objects each list of Jobs or pods keeps at most, as the built-in view's. */
export const MAX_CHILDREN = 500;

/** A list watched while its block is open: its objects, whether the first answer came, whether it failed or was cut. */
export interface Live {
  items: KubeObject[];
  ready: boolean;
  failed: boolean;
  truncated: boolean;
}

/** The blocks of the section: whether one is open, and `toggle`, which remembers a change and draws again. */
export interface Blocks {
  isOpen(id: string): boolean;
  toggle(id: string, open: boolean): void;
}

const present = (nodes: (Node | null | false | undefined)[]): Node[] => nodes.filter((n): n is Node => Boolean(n));

/** A titled block as the built-in view's: open unless the user closed it, closable with its title. */
function block(blocks: Blocks, id: string, title: string, content: UiContent): HTMLElement {
  const node = ui.block(title, content, { collapsible: true, collapsed: !blocks.isOpen(id), onToggle: (open) => blocks.toggle(id, open) });
  node.dataset.block = id;
  return node;
}

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

const truncatedNote = (live: Live) => live.truncated && remark(t("truncated", { max: MAX_CHILDREN }));

function jobsBlock(sextant: Sextant, obj: KubeObject, jobs: Live, blocks: Blocks): HTMLElement {
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
      ? ui.table(headers, rows, { label: t("jobs.title"), id: "jobs", sextant, nowrap: [true, true, true, true, true, false] })
      : remark(jobs.failed ? t("listUnknown") : t("noJobs"));
  return block(blocks, "jobs", t("jobs.title"), [content, truncatedNote(jobs) || null]);
}

const RUNNING = new Set(["Running", "Succeeded", "Completed"]);

function podsBlock(sextant: Sextant, obj: KubeObject, pods: Live, blocks: Blocks): HTMLElement {
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
      ? ui.table(headers, rows, { label: t("pods.title"), id: "pods", sextant, nowrap: [true, true, true] })
      : remark(pods.failed ? t("listUnknown") : t("noPods"));
  return block(blocks, "pods", t("pods.title"), [
    content,
    sorted.length > shown.length ? remark(t("morePods", { shown: shown.length, total: sorted.length })) : null,
    truncatedNote(pods) || null,
  ]);
}

/** The success policy in words: `All`/`Any` Job of the targets (every replicated job without targets). */
function successText(obj: KubeObject): string {
  const success = successPolicyOf(obj);
  const op = success.operator === "Any" ? "any" : "all";
  if (success.targets.length === 0) return t(`success.${op}`);
  return t(`success.${op}Of`, { targets: i18n().formatList(success.targets) });
}

/**
 * What the section watches besides its object, by the controller's label: the JobSet's Jobs while their block is open
 * or it failed (the failure names its first failed Job), its pods while theirs is open.
 */
export function childWatches(obj: KubeObject, isOpen: (id: string) => boolean = () => true): Record<"jobs" | "pods", Omit<WatchParams, "clusterId"> | null> {
  const ns = obj.metadata.namespace;
  const name = obj.metadata.name;
  if (!ns || !name) return { jobs: null, pods: null };
  const labelSelector = `${JOBSET_NAME_LABEL}=${name}`;
  const jobsWanted = isOpen("jobs") || jobSetState(obj) === "failed";
  return {
    jobs: jobsWanted ? { kind: JOB, namespaces: [ns], labelSelector, maxObjects: MAX_CHILDREN } : null,
    pods: !isOpen("pods") ? null : { kind: POD, namespaces: [ns], labelSelector, maxObjects: MAX_CHILDREN },
  };
}

const NONE: Live = { items: [], ready: false, failed: false, truncated: false };
const ALL_OPEN: Blocks = { isOpen: () => true, toggle: () => undefined };

export function jobSetView(sextant: Sextant, obj: KubeObject, related: { jobs?: Live; pods?: Live }, blocks: Blocks = ALL_OPEN): Node[] {
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
    replicated.length > 0 && block(blocks, "replicated", t("replicated.title"), ui.table(repHeaders, replicated, { label: t("replicated.title"), id: "replicated", sextant, nowrap: [true, true, true, true, true, true, true, false] })),
    rules.length > 0 && block(blocks, "rules", t("rules.title"), ui.table(ruleHeaders, rules, { label: t("rules.title"), id: "rules", sextant, nowrap: [true, true, false, false] })),
    jobsBlock(sextant, obj, jobs, blocks),
    podsBlock(sextant, obj, pods, blocks),
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
    const live: Live = { items: [], ready: false, failed: false, truncated: false };
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
    if (contribution !== "jobset") {
      root.replaceChildren(ui.empty(t("common.nothingToShow", { view: contribution })));
      return;
    }
    const related = watches.want(childWatches(object, blocks.isOpen));
    // Drawn again on every change: the focus stays on the toggle of the block it was on.
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-block]")?.dataset.block;
    const onToggle = document.activeElement?.classList.contains("sx-block__toggle") ?? false;
    root.replaceChildren(...jobSetView(sextant, object, related, blocks));
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
