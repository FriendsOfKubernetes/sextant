// The details sections of the extension (the manifest's `contributes.detailsSections`):
//   `kueue` on the Kueue kinds —
//     ClusterQueue — its state and why it admits nothing, the quota against what is reserved and in use per flavor and
//                    resource, its cohort, policies and admission checks, the LocalQueues pointing at it and the
//                    Workloads waiting in them with the reason each waits;
//     LocalQueue   — its ClusterQueue, its usage and its waiting Workloads;
//     Workload     — why it waits, was evicted or deactivated (the condition Kueue wrote), the job it belongs to, its
//                    queues, pod sets with requests and assigned flavors, admission checks and evictions;
//     ResourceFlavor, Cohort, AdmissionCheck, WorkloadPriorityClass — their fields and the ClusterQueues using them;
//   `queue` on the jobs Kueue queues — one block "Queue" with its LocalQueue and its Workload, found by the label Kueue
//     puts on it (the job's uid) in the job's namespace, or the prebuilt Workload it names, with the Workload's state and
//     why it waits; hidden (the manifest's `startHidden`) unless the job has the queue label or a Workload of it exists,
//     and where the cluster serves no Workloads.
// Neither section has a heading of its own, as the built-in ones had none. Their blocks open and close as the built-in
// panel's did, in Sextant's own memory of details sections (the context's `blocks`, `ui.setBlockOpen`), so "Expand
// all", "Collapse all" and Settings → Appearance apply to them. What a view lists besides its object is watched while
// the block that shows it is open, as the built-in view's: every LocalQueue for a ClusterQueue's LocalQueues or waiting
// list, every Workload of the cluster (at most `MAX_WORKLOAD_ROWS`, as the built-in problems source kept) for a
// ClusterQueue's or LocalQueue's waiting list; every ClusterQueue for a flavor, cohort or check; a job's Workloads by
// label while its Queue block is open, or once to know whether it has one. The frame reads the shown object again
// whenever its resourceVersion changes. Conditions, events and YAML are Sextant's own sections. Read-only (ADR-0114).
import { trackObjects, ui, type KubeObject, type ObjectRef, type Sextant, type UiContent, type Watch, type WatchParams } from "@sextant/extension-sdk";
import { age, dateTime, errorText, note, reasonText, remark } from "./dom";
import { t } from "./i18n";
import {
  ADMISSION_CHECK,
  admissionChecksOf,
  arr,
  CLUSTER_QUEUE,
  clusterQueueOf,
  COHORT,
  cohortOf,
  conditionOf,
  evictionsOf,
  failedDeactivation,
  flavorsOf,
  get,
  isKind,
  isWaiting,
  JOB_UID_LABEL,
  kindOfApiVersion,
  LOCAL_QUEUE,
  localQueueUsage,
  mapTexts,
  num,
  ownerOf,
  parentCohortOf,
  percentKey,
  prebuiltWorkloadOf,
  QUEUE_LABEL,
  QUEUE_TONE,
  queueCounts,
  queueState,
  quotaRows,
  record,
  RESOURCE_FLAVOR,
  selectorTexts,
  str,
  tolerationTexts,
  versionOf,
  waitingFor,
  WORKLOAD,
  WORKLOAD_PRIORITY_CLASS,
  WORKLOAD_TONE,
  workloadInfo,
  workloadRow,
  type KindOf,
  type QuotaRow,
  type WorkloadInfo,
  type WorkloadRow,
} from "./model";

/** Workloads listed in a queue's details at most (oldest first). */
export const MAX_LISTED = 50;
/** Workloads the waiting lists' watch keeps at most, as the built-in view's row tap on the problems source. */
export const MAX_WORKLOAD_ROWS = 5000;
/** The version of Kueue's kinds a link names when no object of them is at hand (Sextant opens the one served). */
const DEFAULT_VERSION = "v1beta2";

/** A list watched while its block is open: its objects, whether the first answer came, whether it failed or was cut. */
export interface Live {
  items: KubeObject[];
  ready: boolean;
  failed: boolean;
  /** More objects than the watch keeps (`maxObjects`). */
  truncated?: boolean;
}

/** The blocks of a section: whether one is open, and `toggle`, which remembers a change and draws again. */
export interface Blocks {
  isOpen(id: string): boolean;
  toggle(id: string, open: boolean): void;
}

/** Every block open, nothing remembered. */
export const ALL_OPEN: Blocks = { isOpen: () => true, toggle: () => undefined };

const present = (nodes: (Node | null | false | undefined)[]): Node[] => nodes.filter((n): n is Node => Boolean(n));

/** A titled block as the built-in view's: open unless the user closed it, closable with its title. */
function block(blocks: Blocks, id: string, title: string, content: UiContent): HTMLElement {
  const node = ui.block(title, content, { collapsible: true, collapsed: !blocks.isOpen(id), onToggle: (open) => blocks.toggle(id, open) });
  node.dataset.block = id;
  return node;
}

/** A link to an object's details in Sextant's panel; nothing without a name. */
export function link(sextant: Sextant, kind: { group: string; version: string; kind: string }, name: string | undefined, namespace: string | null, text?: string): HTMLElement | null {
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

/** Links to Kueue's kinds in the version of the object shown. */
function kueueLinks(sextant: Sextant, version: string) {
  const of = (kind: KindOf) => ({ group: kind.group, version, kind: kind.kind });
  return {
    clusterQueue: (name: string | undefined) => link(sextant, of(CLUSTER_QUEUE), name, null),
    localQueue: (name: string | undefined, namespace: string | null) => link(sextant, of(LOCAL_QUEUE), name, namespace),
    workload: (name: string | undefined, namespace: string | null) => link(sextant, of(WORKLOAD), name, namespace),
    resourceFlavor: (name: string | undefined) => link(sextant, of(RESOURCE_FLAVOR), name, null),
    cohort: (name: string | undefined) => link(sextant, of(COHORT), name, null),
    admissionCheck: (name: string | undefined) => link(sextant, of(ADMISSION_CHECK), name, null),
  };
}
type Links = ReturnType<typeof kueueLinks>;

// ---------- States ----------

/** A queue's state in its tone, the Active condition's reason and message on hover. */
export function queueStateText(obj: KubeObject): HTMLElement {
  const state = queueState(obj);
  const active = conditionOf(obj, "Active");
  const node = ui.status(t(`queueState.${state}`), QUEUE_TONE[state]);
  const title = reasonText(active?.reason, active?.message);
  if (title) node.title = title;
  return node;
}

/** A Workload's state in its tone, the reason Kueue wrote on hover. */
export function workloadStateText(obj: KubeObject): HTMLElement {
  const info = workloadInfo(obj);
  const node = ui.status(t(`workloadState.${info.state}`), WORKLOAD_TONE[info.state]);
  const title = reasonText(info.why?.reason, info.why?.message);
  if (title) node.title = title;
  return node;
}

/** Why a queue admits nothing, or that it was stopped. */
function queueNote(obj: KubeObject): HTMLElement | null {
  const state = queueState(obj);
  const active = conditionOf(obj, "Active");
  if (state === "inactive") return note(reasonText(active?.reason, active?.message), "danger");
  if (state === "stopped") return remark(t("stopped", { policy: str(get(obj, "spec", "stopPolicy")) ?? "Hold" }));
  return null;
}

const countRows = (obj: KubeObject): [string, UiContent][] => {
  const c = queueCounts(obj);
  return [
    ["pending", String(c.pending)],
    ["reserving", String(c.reserving)],
    ["admitted", String(c.admitted)],
  ];
};

// ---------- Queues ----------

/** The quota table: flavor, resource, quota, reserved (with the borrowed part and the share of the quota), in use, limits. */
function quotaTable(links: Links, rows: QuotaRow[], usage: boolean): HTMLElement {
  const reservedText = (r: QuotaRow) => {
    if (!r.reserved) return "";
    const base = r.percent === undefined ? r.reserved : t(percentKey("quota.ofQuota", r.percent), { value: r.reserved, percent: r.percent });
    return r.borrowed ? t("quota.borrowed", { value: base, borrowed: r.borrowed }) : base;
  };
  const headers = [t("quota.flavor"), t("quota.resource"), t("quota.nominal")];
  if (usage) headers.push(t("quota.reserved"), t("quota.used"));
  headers.push(t("quota.borrowingLimit"), t("quota.lendingLimit"));
  const cells = rows.map((r) => {
    const row: UiContent[] = [links.resourceFlavor(r.flavor), r.resource, r.nominal ?? ""];
    if (usage) {
      const full = r.percent !== undefined && r.percent >= 100;
      row.push(full ? ui.status(reservedText(r), "warning") : reservedText(r), r.used ?? "");
    }
    row.push(r.borrowingLimit ?? "", r.lendingLimit ?? "");
    return row;
  });
  return ui.table(headers, cells, { label: t("quota.title") });
}

/** The Workloads of a list as rows, and whether the watch kept fewer than there are. */
export function rowsOf(list: Live): { rows: WorkloadRow[]; truncated: boolean } {
  return { rows: list.items.slice(0, MAX_WORKLOAD_ROWS).map(workloadRow), truncated: Boolean(list.truncated) || list.items.length > MAX_WORKLOAD_ROWS };
}

/** The waiting Workloads of a queue: link, LocalQueue, how long, and why (the reason and message Kueue wrote). */
function waitingList(links: Links, waiting: WorkloadRow[], data: Live, truncated: boolean, showQueue: boolean): Node[] {
  if (!data.ready) return [remark(t("loading"))];
  if (data.failed) return [remark(t("waitingUnknown"))];
  const shown = waiting.slice(0, MAX_LISTED);
  const rows = shown.map((r) => [
    links.workload(r.name, r.namespace),
    showQueue ? links.localQueue(r.queue, r.namespace) : r.namespace,
    age(r.since ?? r.created),
    reasonText(r.reason, r.message),
  ]);
  const headers = [t("waiting.workload"), showQueue ? t("waiting.queue") : t("waiting.namespace"), t("waiting.since"), t("waiting.why")];
  return present([
    waiting.length === 0 ? remark(t("noneWaiting")) : ui.table(headers, rows, { label: t("waiting.title") }),
    waiting.length > shown.length && remark(t("moreWaiting", { shown: shown.length, total: waiting.length })),
    truncated && remark(t("workloadsTruncated")),
  ]);
}

const NONE: Live = { items: [], ready: false, failed: false };

export function clusterQueueView(sextant: Sextant, obj: KubeObject, related: { localQueues?: Live; workloads?: Live }, blocks: Blocks = ALL_OPEN): Node[] {
  const links = kueueLinks(sextant, versionOf(obj) ?? DEFAULT_VERSION);
  const localQueues = related.localQueues ?? NONE;
  const workloads = related.workloads ?? NONE;
  const name = obj.metadata.name;
  const mine = localQueues.items.filter((lq) => clusterQueueOf(lq) === name);
  const keys = new Set(mine.map((lq) => `${lq.metadata.namespace ?? ""}/${lq.metadata.name}`));
  const preemption = get(obj, "spec", "preemption");
  const selector = get(obj, "spec", "namespaceSelector");
  const selected = ui.chips(selectorTexts(selector));
  const quota = quotaRows(obj);
  const lqRows = mine.map((lq) => {
    const c = queueCounts(lq);
    return [links.localQueue(lq.metadata.name, lq.metadata.namespace ?? null), lq.metadata.namespace ?? "", String(c.pending), String(c.admitted)];
  });
  const lqHeaders = [t("columns.name"), t("columns.namespace"), t("columns.pending"), t("columns.admitted")];
  const { rows, truncated } = rowsOf(workloads);
  const waiting = waitingFor(rows, keys);
  return present([
    queueNote(obj),
    fieldsOf([
      ["status", queueStateText(obj)],
      ["cohort", links.cohort(cohortOf(obj))],
      ["strategy", str(get(obj, "spec", "queueingStrategy")) ?? "BestEffortFIFO"],
      // No selector selects no namespace; an empty one selects all (ClusterQueueSpec.namespaceSelector).
      ["namespaces", selector == null ? t("noNamespaces") : (selected ?? t("allNamespaces"))],
      ["stopPolicy", str(get(obj, "spec", "stopPolicy"))],
      ["withinClusterQueue", str(get(preemption, "withinClusterQueue"))],
      ["reclaimWithinCohort", str(get(preemption, "reclaimWithinCohort"))],
      ["borrowWithinCohort", str(get(preemption, "borrowWithinCohort", "policy"))],
      ["admissionChecks", ui.chips(admissionChecksOf(obj))],
      ...countRows(obj),
    ]),
    block(blocks, "quota", t("quota.title"), quota.length > 0 ? quotaTable(links, quota, true) : remark(t("quota.none"))),
    block(
      blocks,
      "localQueues",
      t("localQueues"),
      !localQueues.ready
        ? remark(t("loading"))
        : lqRows.length > 0
          ? ui.table(lqHeaders, lqRows, { label: t("localQueues") })
          : remark(localQueues.failed ? t("listUnknown") : t("noLocalQueues")),
    ),
    block(blocks, "waiting", t("waiting.title"), waitingList(links, waiting, workloads, truncated, true)),
  ]);
}

export function localQueueView(sextant: Sextant, obj: KubeObject, related: { workloads?: Live }, blocks: Blocks = ALL_OPEN): Node[] {
  const links = kueueLinks(sextant, versionOf(obj) ?? DEFAULT_VERSION);
  const workloads = related.workloads ?? NONE;
  const ns = obj.metadata.namespace ?? "";
  const name = obj.metadata.name;
  const usage = localQueueUsage(obj).map((r) => [links.resourceFlavor(r.flavor), r.resource, r.reserved ?? "", r.used ?? ""]);
  const { rows, truncated } = rowsOf(workloads);
  const waiting = rows.filter((r) => isWaiting(r) && r.namespace === ns && r.queue === name).sort((a, b) => (a.created ?? "").localeCompare(b.created ?? ""));
  const usageHeaders = [t("quota.flavor"), t("quota.resource"), t("quota.reserved"), t("quota.used")];
  return present([
    queueNote(obj),
    fieldsOf([
      ["status", queueStateText(obj)],
      ["clusterQueue", links.clusterQueue(clusterQueueOf(obj))],
      ["stopPolicy", str(get(obj, "spec", "stopPolicy"))],
      ...countRows(obj),
    ]),
    usage.length > 0 && block(blocks, "usage", t("usage"), ui.table(usageHeaders, usage, { label: t("usage") })),
    block(blocks, "waiting", t("waiting.title"), waitingList(links, waiting, workloads, truncated, false)),
  ]);
}

/** Links to the ClusterQueues `pick` keeps, or a note while they load or cannot be read. */
function clusterQueueLinks(links: Links, queues: Live, pick: (cq: KubeObject) => boolean): Node {
  if (!queues.ready) return remark(t("loading"));
  if (queues.failed) return remark(t("listUnknown"));
  const names = queues.items
    .filter(pick)
    .map((cq) => cq.metadata.name)
    .sort();
  if (names.length === 0) return remark(t("noClusterQueues"));
  return ui.inline(names.map((n) => links.clusterQueue(n)));
}

export function resourceFlavorView(sextant: Sextant, obj: KubeObject, related: { clusterQueues?: Live }, blocks: Blocks = ALL_OPEN): Node[] {
  const links = kueueLinks(sextant, versionOf(obj) ?? DEFAULT_VERSION);
  const name = obj.metadata.name;
  const taints = arr(get(obj, "spec", "nodeTaints")).map(
    (x) => `${str(get(x, "key")) ?? ""}${str(get(x, "value")) ? `=${str(get(x, "value"))}` : ""}:${str(get(x, "effect")) ?? ""}`,
  );
  return present([
    fieldsOf([
      ["nodeLabels", ui.chips(mapTexts(get(obj, "spec", "nodeLabels")))],
      ["nodeTaints", ui.chips(taints)],
      ["tolerations", ui.chips(tolerationTexts(get(obj, "spec", "tolerations")))],
      ["topology", str(get(obj, "spec", "topologyName"))],
    ]),
    block(blocks, "usedBy", t("usedBy"), clusterQueueLinks(links, related.clusterQueues ?? NONE, (cq) => flavorsOf(cq).includes(name))),
  ]);
}

export function cohortView(sextant: Sextant, obj: KubeObject, related: { clusterQueues?: Live }, blocks: Blocks = ALL_OPEN): Node[] {
  const links = kueueLinks(sextant, versionOf(obj) ?? DEFAULT_VERSION);
  const name = obj.metadata.name;
  const quota = quotaRows(obj);
  return present([
    fieldsOf([["parent", links.cohort(parentCohortOf(obj))]]),
    block(blocks, "members", t("members"), clusterQueueLinks(links, related.clusterQueues ?? NONE, (cq) => cohortOf(cq) === name)),
    quota.length > 0 && block(blocks, "quota", t("quota.title"), quotaTable(links, quota, false)),
  ]);
}

export function admissionCheckView(sextant: Sextant, obj: KubeObject, related: { clusterQueues?: Live }, blocks: Blocks = ALL_OPEN): Node[] {
  const links = kueueLinks(sextant, versionOf(obj) ?? DEFAULT_VERSION);
  const name = obj.metadata.name;
  const params = get(obj, "spec", "parameters");
  const paramsText = str(get(params, "name")) ? `${str(get(params, "kind")) ?? ""}/${str(get(params, "name"))}` : undefined;
  return present([
    queueNote(obj),
    fieldsOf([
      ["status", queueStateText(obj)],
      ["controller", str(get(obj, "spec", "controllerName"))],
      ["parameters", paramsText],
    ]),
    block(blocks, "usedBy", t("usedBy"), clusterQueueLinks(links, related.clusterQueues ?? NONE, (cq) => admissionChecksOf(cq).includes(name))),
  ]);
}

export function priorityClassView(obj: KubeObject): Node[] {
  return present([
    fieldsOf([
      ["value", num(get(obj, "value"))?.toString()],
      ["description", str(get(obj, "description"))],
    ]),
  ]);
}

// ---------- Workloads ----------

const DANGER = new Set(["inadmissible", "failed"]);

/** The state in words and the condition's own reason and message. */
function workloadWhy(obj: KubeObject, info: WorkloadInfo): Node[] {
  if (info.state === "admitted" || info.state === "finished") return [];
  const failure = DANGER.has(info.state) || (info.state === "deactivated" && failedDeactivation(obj));
  const text = reasonText(info.why?.reason, info.why?.message);
  return present([remark(t(`explain.${info.state}`)), text !== "" && note(text, failure ? "danger" : "warning")]);
}

/** The job a Workload belongs to, as a link. */
function ownerLink(sextant: Sextant, obj: KubeObject): HTMLElement | null {
  const owner = ownerOf(obj);
  if (!owner) return null;
  return link(sextant, kindOfApiVersion(owner.apiVersion, owner.kind), owner.name, obj.metadata.namespace ?? null, `${owner.kind}/${owner.name}`);
}

const quantities = (value: unknown) => ui.chips(Object.entries(record(value)).map(([key, v]) => `${key}: ${String(v)}`));

export function workloadView(sextant: Sextant, obj: KubeObject, blocks: Blocks = ALL_OPEN): Node[] {
  const links = kueueLinks(sextant, versionOf(obj) ?? DEFAULT_VERSION);
  const ns = obj.metadata.namespace ?? null;
  const info = workloadInfo(obj);
  const requeueAt = str(get(obj, "status", "requeueState", "requeueAt"));
  const requests = new Map(arr(get(obj, "status", "resourceRequests")).map((r) => [str(get(r, "name")) ?? "", get(r, "resources")]));
  const assignments = new Map(arr(get(obj, "status", "admission", "podSetAssignments")).map((a) => [str(get(a, "name")) ?? "", a]));
  const podSets = arr(get(obj, "spec", "podSets")).map((p) => {
    const name = str(get(p, "name")) ?? "main";
    const count = num(get(p, "count")) ?? 1;
    const min = num(get(p, "minCount"));
    const assigned = assignments.get(name);
    return [
      name,
      min === undefined ? String(count) : t("podSets.minCount", { count, min }),
      quantities(requests.get(name) ?? get(assigned, "resourceUsage")),
      quantities(get(assigned, "flavors")),
    ];
  });
  const checks = arr(get(obj, "status", "admissionChecks")).map((c) => {
    const state = str(get(c, "state")) ?? "";
    const tone = state === "Ready" ? "success" : state === "Rejected" ? "danger" : "warning";
    return [links.admissionCheck(str(get(c, "name"))), ui.status(state, tone), str(get(c, "message")) ?? "", dateTime(str(get(c, "lastTransitionTime")))];
  });
  const evictions = evictionsOf(obj).map((e) => [e.reason, e.cause ?? "", String(e.count)]);
  const podSetHeaders = ["name", "count", "requests", "flavors"].map((h) => t(`podSets.${h}`));
  const checkHeaders = ["name", "state", "message", "since"].map((h) => t(`checks.${h}`));
  const evictionHeaders = ["reason", "cause", "count"].map((h) => t(`evictions.${h}`));
  return present([
    ...workloadWhy(obj, info),
    fieldsOf([
      ["status", workloadStateText(obj)],
      ["owner", ownerLink(sextant, obj)],
      ["queue", links.localQueue(info.queue, ns)],
      ["clusterQueue", links.clusterQueue(info.clusterQueue)],
      ["priority", info.priority?.toString()],
      ["priorityClass", info.priorityClass],
      ["evictions", info.evictions > 0 ? String(info.evictions) : null],
      ["requeueAt", dateTime(requeueAt)],
      ["maxExecution", num(get(obj, "spec", "maximumExecutionTimeSeconds"))?.toString()],
    ]),
    podSets.length > 0 && block(blocks, "podSets", t("podSets.title"), ui.table(podSetHeaders, podSets, { label: t("podSets.title") })),
    checks.length > 0 && block(blocks, "checks", t("checks.title"), ui.table(checkHeaders, checks, { label: t("checks.title") })),
    evictions.length > 0 && block(blocks, "evictions", t("evictions.title"), ui.table(evictionHeaders, evictions, { label: t("evictions.title") })),
  ]);
}

/** One Workload of a job in short: its link and state, why, and its queues. */
function workloadSummary(sextant: Sextant, obj: KubeObject): Node[] {
  const links = kueueLinks(sextant, versionOf(obj) ?? DEFAULT_VERSION);
  const ns = obj.metadata.namespace ?? null;
  const info = workloadInfo(obj);
  return present([
    ...workloadWhy(obj, info),
    fieldsOf([
      ["workload", links.workload(obj.metadata.name, ns)],
      ["status", workloadStateText(obj)],
      ["queue", links.localQueue(info.queue, ns)],
      ["clusterQueue", links.clusterQueue(info.clusterQueue)],
      ["evictions", info.evictions > 0 ? String(info.evictions) : null],
    ]),
  ]);
}

// ---------- The "Queue" section of a job ----------

/** Whether a job's Queue block has something to show: as the built-in section's disclosure probe answered. */
export type QueueAnswer = "present" | "absent" | "unknown";

/**
 * What the Queue section knows of the job shown, kept while it shows: whether the cluster serves Workloads (from
 * Sextant's kinds), and the answer it settled on — the built-in section checked once while its block was closed, then
 * kept that answer and watched nothing until the block opened again.
 */
export interface QueueProbe {
  /** The cluster serves Workloads; `undefined` before Sextant said. */
  served: boolean | undefined;
  /** Sextant could not tell the cluster's kinds. */
  kindsFailed: boolean;
  result: QueueAnswer | null;
}

export const newQueueProbe = (): QueueProbe => ({ served: undefined, kindsFailed: false, result: null });

/** The Workloads of a job: Kueue's own (by the job-uid label and owner reference) or the prebuilt one it names. */
export function jobWorkloads(job: KubeObject, related: { byUid?: Live; prebuilt?: Live }): { items: KubeObject[] | undefined; failed: boolean } {
  const lists = [related.byUid, related.prebuilt].filter((l): l is Live => l !== undefined);
  if (lists.length === 0 || lists.some((l) => !l.ready)) return { items: undefined, failed: false };
  const uid = job.metadata.uid;
  const prebuilt = prebuiltWorkloadOf(job);
  const byUid = new Map<string, KubeObject>();
  for (const list of lists) for (const o of list.items) byUid.set(o.metadata.uid ?? o.metadata.name, o);
  // A Workload labelled with the uid belongs to the job; one owned by another object is left out.
  const items = [...byUid.values()].filter((w) => {
    const owners = arr(w.metadata.ownerReferences);
    return owners.length === 0 || owners.some((r) => get(r, "uid") === uid) || w.metadata.name === prebuilt;
  });
  return { items, failed: lists.some((l) => l.failed) };
}

/** Whether the Queue section watches the job's Workloads now: while its block is open, or until it settled an answer. */
export const queueEnabled = (probe: QueueProbe, blocks: Blocks): boolean => blocks.isOpen("queue") || probe.result === null;

/**
 * The Queue section of a job: its block, or `null` when it is hidden — the job has no queue label and no Workload of
 * it was found, or the cluster serves no Workloads. Settles `probe.result` as the built-in section did.
 */
export function queueSectionView(sextant: Sextant, job: KubeObject, related: { byUid?: Live; prebuilt?: Live }, probe: QueueProbe, blocks: Blocks = ALL_OPEN): Node[] | null {
  const open = blocks.isOpen("queue");
  const enabled = queueEnabled(probe, blocks);
  const queue = str(record(job.metadata.labels)[QUEUE_LABEL]);
  const found = enabled && probe.served === true ? jobWorkloads(job, related) : { items: undefined, failed: false };
  const items = found.items;
  const answer: QueueAnswer | null =
    queue || (items?.length ?? 0) > 0 ? "present" : found.failed || probe.kindsFailed ? "unknown" : probe.served === false || items ? "absent" : null;
  const previous = probe.result;
  if (enabled && answer) probe.result = answer;
  const result = enabled || previous === null ? (answer ?? previous) : previous;
  const visible = result === "present" || result === "unknown";
  const title = t("queue.title");
  if (!open && probe.result) return visible ? [block(blocks, "queue", title, [])] : null;
  if (probe.served === false && !probe.kindsFailed) return null;
  if (!visible) return null;
  const links = kueueLinks(sextant, versionOf(items?.[0]) ?? DEFAULT_VERSION);
  const ns = job.metadata.namespace ?? null;
  return [
    block(
      blocks,
      "queue",
      title,
      present([
        queue ? fieldsOf([["queue", links.localQueue(queue, ns)]]) : null,
        ...(answer === "unknown"
          ? [remark(t("listUnknown"))]
          : items === undefined
            ? [remark(t("loading"))]
            : items.length === 0
              ? [remark(found.failed ? t("listUnknown") : t("queue.noWorkload"))]
              : items.flatMap((w) => workloadSummary(sextant, w))),
      ]),
    ),
  ];
}

/** Every Workload of the cluster, kept as the built-in view's row tap kept them: the waiting lists of the queues. */
const ALL_WORKLOADS: Omit<WatchParams, "clusterId"> = { kind: WORKLOAD, maxObjects: MAX_WORKLOAD_ROWS };

/** What a section watches besides its object, by its contribution, the object's kind and which blocks are open. */
export function relatedWatches(
  contribution: string,
  kind: { group: string; kind: string },
  obj: KubeObject,
  blocks: Blocks = ALL_OPEN,
  probe: QueueProbe = { served: true, kindsFailed: false, result: null },
): Record<string, Omit<WatchParams, "clusterId"> | null> {
  const ns = obj.metadata.namespace;
  if (contribution === "queue") {
    const uid = obj.metadata.uid;
    if (!ns || !uid || probe.served !== true || !queueEnabled(probe, blocks)) return {};
    const prebuilt = prebuiltWorkloadOf(obj);
    return {
      byUid: { kind: WORKLOAD, namespaces: [ns], labelSelector: `${JOB_UID_LABEL}=${uid}` },
      prebuilt: prebuilt ? { kind: WORKLOAD, namespaces: [ns], fieldSelector: `metadata.name=${prebuilt}` } : null,
    };
  }
  const waiting = blocks.isOpen("waiting");
  if (isKind(kind, CLUSTER_QUEUE))
    return { localQueues: blocks.isOpen("localQueues") || waiting ? { kind: LOCAL_QUEUE } : null, workloads: waiting ? ALL_WORKLOADS : null };
  if (isKind(kind, LOCAL_QUEUE)) return { workloads: waiting ? ALL_WORKLOADS : null };
  if (isKind(kind, RESOURCE_FLAVOR, COHORT, ADMISSION_CHECK)) return { clusterQueues: { kind: CLUSTER_QUEUE } };
  return {};
}

/** The view of the Kueue section for `obj` of `kind`; `null` for a kind it does not show. */
export function sectionView(sextant: Sextant, kind: { group: string; kind: string }, obj: KubeObject, related: Record<string, Live | undefined>, blocks: Blocks = ALL_OPEN): Node[] | null {
  if (isKind(kind, CLUSTER_QUEUE)) return clusterQueueView(sextant, obj, related, blocks);
  if (isKind(kind, LOCAL_QUEUE)) return localQueueView(sextant, obj, related, blocks);
  if (isKind(kind, WORKLOAD)) return workloadView(sextant, obj, blocks);
  if (isKind(kind, RESOURCE_FLAVOR)) return resourceFlavorView(sextant, obj, related, blocks);
  if (isKind(kind, COHORT)) return cohortView(sextant, obj, related, blocks);
  if (isKind(kind, ADMISSION_CHECK)) return admissionCheckView(sextant, obj, related, blocks);
  if (isKind(kind, WORKLOAD_PRIORITY_CLASS)) return priorityClassView(obj);
  return null;
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
          // In the order the API server lists them: by namespace, then name.
          live.items = [...items].sort((a, b) => (a.metadata.namespace ?? "").localeCompare(b.metadata.namespace ?? "") || (a.metadata.name ?? "").localeCompare(b.metadata.name ?? ""));
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

/** Whether the cluster serves Kueue's Workloads, as Sextant's kinds tell. */
async function servesWorkloads(sextant: Sextant): Promise<boolean> {
  const kinds = await sextant.kinds();
  return kinds.some((k) => isKind(k.kindRef, WORKLOAD));
}

/**
 * Starts the details section `contribution` on the object in the context: read again whenever its resourceVersion
 * changes; what it lists besides watched while the block that shows it is open, and drawn again as they change.
 */
export function startDetails(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  let shownVersion: string | null | undefined;
  let shownRef: string | null = null;
  let reading = 0;
  let object: KubeObject | null = null;
  let kind: ObjectRef["kind"] | null = null;
  let scheduled = false;
  let stopped = false;
  let probe = newQueueProbe();
  /** Whether Sextant hides the section now (the Queue section starts hidden, the manifest's `startHidden`). */
  let hidden = contribution === "queue";
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

  const render = () => {
    if (!object || !kind || stopped) return;
    if (contribution !== "kueue" && contribution !== "queue") {
      root.replaceChildren(ui.empty(t("common.nothingToShow", { view: contribution })));
      return;
    }
    const related = watches.want(relatedWatches(contribution, kind, object, blocks, probe));
    const view = contribution === "queue" ? queueSectionView(sextant, object, related, probe, blocks) : sectionView(sextant, kind, object, related, blocks);
    // The Queue block's answer may have settled: what it watches follows.
    if (contribution === "queue") watches.want(relatedWatches(contribution, kind, object, blocks, probe));
    if (contribution === "queue") setHidden(view === null);
    // Drawn again on every change: the focus stays on the toggle of the block it was on.
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-block]")?.dataset.block;
    const onToggle = document.activeElement?.classList.contains("sx-block__toggle") ?? false;
    root.replaceChildren(...(view ?? (contribution === "queue" ? [] : [ui.empty(t("common.nothingToShow", { view: contribution }))])));
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
      // The Queue section stays as it is: hidden unless it had something to show (Sextant's panel tells the error).
      if (attempt === reading) root.replaceChildren(ui.errorState(errorText(err)));
    }
  };

  /** Asks Sextant once per job whether the cluster serves Workloads (the Queue section only). */
  const askKinds = (current: QueueProbe) => {
    servesWorkloads(sextant).then(
      (served) => {
        current.served = served;
        if (current === probe) schedule();
      },
      () => {
        current.kindsFailed = true;
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
      probe = newQueueProbe();
      if (contribution === "queue") askKinds(probe);
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
