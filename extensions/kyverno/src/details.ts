// The details sections (the manifest's `contributes.detailsSections`), as the built-in view drew them (ADR-0101):
//   a Kyverno kind's own section (`cluster-policy`, `policy`, `policy-report`, …), a block titled by the kind:
//     ClusterPolicy / Policy — readiness in plain words, mode, background scans, the rules (type, mode, kinds) and a
//                              block "Results in reports": the policy's results summed over the reports that carry its
//                              label (`cpol.kyverno.io/<name>`, `pol.kyverno.io/<name>`, at most 1000 reports), with
//                              the objects that fail it;
//     reports                — the object the report is about (a link), its counts and its results;
//   `policy-results` on every kind (`*`/`*`) — a block "Policy results": the results of the object's own report, which
//                              Kyverno names after the object's uid (the context's `uid`, failures first). It stays
//                              hidden (`startHidden`, `ui.setHidden`) on Kyverno's own kinds and Events, where the
//                              cluster serves no reports, and while Kyverno has not reported on the object; an answer
//                              it cannot trust shows as an error.
// The blocks open and close as the built-in ones did, kept in Sextant's own memory of details sections (`context.blocks`,
// `ui.setBlockOpen`) with the panel's "Expand all" and "Collapse all"; a closed block draws nothing and watches nothing,
// and a closed "Policy results" looks once, as the built-in probe did, to show its title or hide. A Kyverno kind's frame
// reads the shown object again whenever its resourceVersion changes. Read-only.
import {
  trackObjects,
  ui,
  type KindRef,
  type KubeObject,
  type ObjectRef,
  type ResourceKind,
  type Sextant,
  type UiContent,
  type Watch,
  type WatchParams,
} from "@sextant/extension-sdk";
import { block, BlockMemory, errorText, explain, message, redraw, remark } from "./dom";
import { i18n, t } from "./i18n";
import {
  backgroundScan,
  CLUSTER_POLICY_REPORT,
  countResults,
  hasObjectResults,
  isPolicyKind,
  KYVERNO_KINDS,
  modeTone,
  POLICY,
  POLICY_REPORT,
  policyMessage,
  policyMode,
  policyReady,
  policyReportLabel,
  policyRules,
  policyTarget,
  readyTone,
  reportResults,
  reportScope,
  RESULT_TONE,
  RESULT_VALUES,
  resultPolicyName,
  sameKind,
  sortResults,
  type PolicyResult,
  type Summary,
} from "./model";

/** Results and failing objects listed at most. */
export const MAX_LISTED = 50;
/** Reports read at most for one policy's summary. */
export const MAX_SUMMARY_REPORTS = 1000;
/** The blocks' ids in Sextant's memory of details sections. */
export const KIND_BLOCK = "kind";
export const SUMMARY_BLOCK = "policySummary";
export const RESULTS_BLOCK = "objectResults";

/**
 * A list watched while the section shows: its objects, whether the first answer came, whether it failed, and whether
 * more match than the core keeps (`maxObjects`).
 */
export interface Live {
  items: KubeObject[];
  ready: boolean;
  failed: boolean;
  capped?: boolean;
}

/** What discovery says: the kinds the cluster serves, `null` while it is asked, or that asking failed. */
export interface Discovery {
  kinds: readonly ResourceKind[] | null;
  failed: boolean;
}

/** The served version of a kind; `null` when the cluster does not serve it, `undefined` while discovery is asked. */
export function servedKind(discovery: Discovery, kind: Pick<KindRef, "group" | "kind">): KindRef | null | undefined {
  if (discovery.failed) return null;
  if (!discovery.kinds) return undefined;
  return discovery.kinds.find((k) => sameKind(k.kindRef, kind))?.kindRef ?? null;
}

// ---------- pieces ----------

/** A link to an object's details in Sextant's panel. */
function link(sextant: Sextant, ref: ObjectRef, text: string): HTMLElement {
  const button = ui.objectLink(sextant, ref, text);
  button.setAttribute("aria-label", t("openObject", { kind: ref.kind.kind, name: ref.name }));
  return button;
}

const objectLink = (sextant: Sextant, ref: ObjectRef) => link(sextant, ref, `${ref.kind.kind}/${ref.name}`);

function policyLink(sextant: Sextant, result: PolicyResult): HTMLElement {
  const target = policyTarget(result);
  return link(sextant, target, result.policy);
}

const resultText = (value: PolicyResult["result"]) => ui.status(t(`result.${value}`), RESULT_TONE[value]);

/** `ui.fields` labelled from `fields.<key>`. */
const fieldsOf = (rows: readonly (readonly [string, UiContent])[]): HTMLElement => ui.fields(rows.map(([key, value]) => [t(`fields.${key}`), value] as const));

function summaryLine(summary: Summary): HTMLElement | null {
  const parts = RESULT_VALUES.filter((v) => summary[v] > 0).map((v) => t(`summary.${v}`, { count: summary[v] }));
  return parts.length > 0 ? remark(i18n().formatList(parts)) : null;
}

/** Results as a table: (object,) policy (a link), rule, result, message; at most `MAX_LISTED`. */
function resultsTable(sextant: Sextant, results: readonly { result: PolicyResult; object?: ObjectRef }[], withObject = false): Node[] {
  const shown = results.slice(0, MAX_LISTED);
  const headers = [...(withObject ? ["object"] : []), "policy", "rule", "result", "message"].map((h) => t(`results.${h}`));
  const rows = shown.map(({ result, object }) => [
    ...(withObject ? [object ? objectLink(sextant, object) : ""] : []),
    policyLink(sextant, result),
    result.rule ?? "",
    resultText(result.result),
    result.message ?? "",
  ]);
  // No table without rows, as the built-in details' tables.
  if (rows.length === 0) return [];
  const table = ui.table(headers, rows, { label: t(withObject ? "policySummary.title" : "objectResults.title") });
  return results.length > shown.length ? [table, remark(t("results.more", { count: results.length - shown.length }))] : [table];
}

// ---------- policies ----------

/** A policy's results over the reports that carry its label, as the built-in `usePolicySummary` read them. */
export interface PolicySummary {
  served: boolean;
  loading: boolean;
  results: PolicyResult[];
  failed: { object: ObjectRef; result: PolicyResult }[];
  /** More reports carry the label than were read. */
  capped: boolean;
  /** The policy's name cannot be a label: no summary. */
  unlabelled: boolean;
}

/** The report watches a policy's summary needs: PolicyReports (in its namespace for a Policy) and, for a ClusterPolicy, ClusterPolicyReports. */
export function summaryWatches(discovery: Discovery, kind: Pick<KindRef, "group" | "kind">, policy: KubeObject): Record<string, Omit<WatchParams, "clusterId"> | null> {
  const label = policyReportLabel(policy, kind);
  const namespaced = sameKind(kind, POLICY);
  const reportKind = servedKind(discovery, POLICY_REPORT);
  const clusterReportKind = servedKind(discovery, CLUSTER_POLICY_REPORT);
  return {
    reports:
      reportKind && label
        ? { kind: reportKind, ...(namespaced ? { namespaces: [policy.metadata.namespace ?? ""] } : {}), labelSelector: label, maxObjects: MAX_SUMMARY_REPORTS }
        : null,
    clusterReports: !namespaced && clusterReportKind && label ? { kind: clusterReportKind, labelSelector: label, maxObjects: MAX_SUMMARY_REPORTS } : null,
  };
}

export function policySummary(
  discovery: Discovery,
  kind: Pick<KindRef, "group" | "kind">,
  policy: KubeObject,
  reports: Live | undefined,
  clusterReports: Live | undefined,
): PolicySummary {
  const label = policyReportLabel(policy, kind);
  const namespaced = sameKind(kind, POLICY);
  const reportKind = servedKind(discovery, POLICY_REPORT);
  const clusterReportKind = servedKind(discovery, CLUSTER_POLICY_REPORT);
  const summary: PolicySummary = {
    served: !!reportKind || !!clusterReportKind,
    loading:
      reportKind === undefined ||
      (!!reportKind && !!label && !reports?.ready) ||
      (!namespaced && !!clusterReportKind && !!label && !clusterReports?.ready),
    results: [],
    failed: [],
    // The core keeps `MAX_SUMMARY_REPORTS` and counts the rest, as the built-in watch did.
    capped: reports?.capped === true || clusterReports?.capped === true,
    unlabelled: !label,
  };
  const name = resultPolicyName(policy, kind);
  const collect = (reportKindRef: KindRef, live: Live | undefined) => {
    for (const report of live?.items ?? []) {
      const scope = reportScope(reportKindRef, report);
      for (const r of reportResults(reportKindRef, report)) {
        if (r.policy !== name) continue;
        summary.results.push(r);
        if (r.result === "fail" && scope) summary.failed.push({ object: scope, result: r });
      }
    }
  };
  if (reportKind) collect(reportKind, reports);
  if (clusterReportKind && !namespaced) collect(clusterReportKind, clusterReports);
  return summary;
}

/** "Results in reports": shown where the cluster serves the reports (an error when discovery failed); drawn while open. */
function summaryBlock(sextant: Sextant, discovery: Discovery, memory: BlockMemory, summaryOf: () => PolicySummary): HTMLElement | null {
  const title = t("policySummary.title");
  if (discovery.failed) return block(memory, SUMMARY_BLOCK, title, () => ui.errorState(t("error.unknown")));
  if (!servesReports(discovery)) return null;
  return block(memory, SUMMARY_BLOCK, title, () => {
    const summary = summaryOf();
    if (!summary.served) return null;
    if (summary.unlabelled) return remark(t("policySummary.unlabelled"));
    if (summary.loading) return remark(t("policySummary.loading"));
    if (summary.results.length === 0) return remark(t("policySummary.none"));
    return [
      summaryLine(countResults(summary.results)),
      summary.capped && remark(t("policySummary.capped", { count: summary.results.length })),
      summary.failed.length > 0 && resultsTable(sextant, summary.failed, true),
    ];
  });
}

const servesReports = (discovery: Discovery) => discovery.kinds?.some((k) => sameKind(k.kindRef, POLICY_REPORT) || sameKind(k.kindRef, CLUSTER_POLICY_REPORT)) === true;

export function policyView(sextant: Sextant, obj: KubeObject, discovery: Discovery, memory: BlockMemory, summaryOf: () => PolicySummary): Node[] {
  const ready = policyReady(obj);
  const mode = policyMode(obj);
  const text = policyMessage(obj);
  const rules = policyRules(obj);
  const explanation = ready === "True" ? t("explain.ready") : ready === "False" ? t("explain.notReady") : ready === "Unknown" ? t("explain.pending") : undefined;
  const rulesTable =
    rules.length > 0
      ? ui.table(
          ["name", "type", "mode", "kinds"].map((h) => t(`rules.${h}`)),
          rules.map((r) => [r.name, r.type ? t(`ruleType.${r.type}`) : "", r.mode ? t(`mode.${r.mode}`) : "", ui.chips(r.kinds)]),
          { label: t("rules.name") },
        )
      : null;
  const nodes: (Node | null | undefined | false)[] = [
    explanation ? explain(explanation, ready === "False") : null,
    text && ready !== "True" ? message(text) : null,
    mode && remark(t(`modeHint.${mode}`)),
    fieldsOf([
      ["ready", ready ? ui.status(t(`ready.${ready}`), readyTone(ready)) : null],
      ["mode", mode ? ui.status(t(`mode.${mode}`), modeTone(mode)) : null],
      ["background", backgroundScan(obj) ? t("yes") : t("no")],
    ]),
    rulesTable,
    summaryBlock(sextant, discovery, memory, summaryOf),
  ];
  return nodes.filter((n): n is Node => Boolean(n));
}

// ---------- reports ----------

export function reportView(sextant: Sextant, kind: Pick<KindRef, "group" | "kind">, obj: KubeObject): Node[] {
  const scope = reportScope(kind, obj);
  const results = sortResults(reportResults(kind, obj));
  const line = summaryLine(countResults(results));
  return [
    fieldsOf([["object", scope ? objectLink(sextant, scope) : null]]),
    ...(line ? [line] : []),
    ...resultsTable(sextant, results.map((result) => ({ result }))),
  ];
}

// ---------- watches ----------

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
      onCapped: () => {
        live.capped = watch.capped !== null;
        this.changed();
      },
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

/** Discovery, asked once per started view. */
function askDiscovery(sextant: Sextant, changed: () => void): Discovery {
  const discovery: Discovery = { kinds: null, failed: false };
  sextant.kinds().then(
    (kinds) => {
      discovery.kinds = kinds;
      changed();
    },
    () => {
      discovery.failed = true;
      changed();
    },
  );
  return discovery;
}

/** Calls `schedule`'s function once in the next microtask, however often it is asked. */
function batched(run: () => void): () => void {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      run();
    });
  };
}

/**
 * Follows the shown object: `onObject` with it, now and whenever its resourceVersion changes (`changed` when it is
 * another object); `onError` when it cannot be read. Returns the function that stops following it.
 */
function followShown(
  sextant: Sextant,
  onObject: (ref: ObjectRef, obj: KubeObject) => void,
  onError: (err: unknown) => void,
  onNone: () => void,
): () => void {
  let shown: string | null = null;
  let version: string | null | undefined;
  let reading = 0;
  let stopped = false;
  const read = async (ref: ObjectRef) => {
    const attempt = ++reading;
    try {
      const obj = await sextant.resources.get({ ref });
      if (!stopped && attempt === reading) onObject(ref, obj);
    } catch (err) {
      if (!stopped && attempt === reading) onError(err);
    }
  };
  const follow = () => {
    const ref = sextant.context.selection[0];
    if (!ref) {
      shown = null;
      onNone();
      return;
    }
    const key = JSON.stringify([ref.kind.group, ref.kind.kind, ref.namespace, ref.name]);
    if (key !== shown) {
      shown = key;
      version = undefined;
    }
    if (sextant.context.resourceVersion === version) return;
    version = sextant.context.resourceVersion;
    void read(ref);
  };
  follow();
  const off = sextant.onContextChange(follow);
  return () => {
    stopped = true;
    off();
  };
}

// ---------- a Kyverno kind's own section ----------

function startKindSection(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  const def = KYVERNO_KINDS.find((d) => d.section === contribution);
  const policy = isPolicyKind(def?.kind ?? { group: "", kind: "" });
  let object: { ref: ObjectRef; obj: KubeObject } | null = null;
  let stopped = false;
  const render = () => {
    if (stopped || !object) return;
    const { ref, obj } = object;
    if (!def || !sameKind(def.kind, ref.kind)) {
      watches.stop();
      root.replaceChildren(ui.empty(t("common.nothingToShow", { view: contribution })));
      return;
    }
    // A closed block draws and watches nothing: the reports only while "Results in reports" shows open.
    const open = memory.isOpen(KIND_BLOCK);
    const summaryShown = open && policy && !discovery.failed && servesReports(discovery) && memory.isOpen(SUMMARY_BLOCK);
    const live = watches.want(summaryShown ? summaryWatches(discovery, def.kind, obj) : {});
    const summaryOf = () => policySummary(discovery, def.kind, obj, live.reports, live.clusterReports);
    redraw(root, [
      block(memory, KIND_BLOCK, def.kind.kind, () => (policy ? policyView(sextant, obj, discovery, memory, summaryOf) : reportView(sextant, def.kind, obj))),
    ]);
  };
  const schedule = batched(render);
  const watches = new Watches(sextant, schedule);
  const memory = new BlockMemory(sextant, schedule);
  const discovery: Discovery = policy ? askDiscovery(sextant, schedule) : { kinds: [], failed: false };
  // Nothing until the object is read, as the built-in section drew nothing without it.
  root.replaceChildren();
  const stopFollow = followShown(
    sextant,
    (ref, obj) => {
      if (object && JSON.stringify(object.ref) !== JSON.stringify(ref)) {
        watches.stop();
        memory.reset();
      }
      object = { ref, obj };
      render();
    },
    (err) => root.replaceChildren(ui.errorState(errorText(err))),
    () => root.replaceChildren(ui.empty(t("common.nothingSelected"))),
  );
  const stopBlocks = sextant.onContextChange(() => {
    if (memory.follow()) schedule();
  });
  return () => {
    stopped = true;
    stopFollow();
    stopBlocks();
    watches.stop();
  };
}

// ---------- "Policy results" of every other object ----------

/** The policy results of one object: its own report (by name, the object's uid) about this very object. */
export function objectResults(reportKind: KindRef, ref: ObjectRef, reports: readonly KubeObject[]): PolicyResult[] {
  const results: PolicyResult[] = [];
  for (const report of reports) {
    // Only a report about this very object (its scope names it, or it carries no scope).
    const scope = reportScope(reportKind, report);
    if (scope && (scope.name !== ref.name || scope.kind.kind !== ref.kind.kind)) continue;
    results.push(...reportResults(reportKind, report));
  }
  return results;
}

/** The open block's content: the results, failures first, under how many fail. */
export function objectResultsView(sextant: Sextant, results: readonly PolicyResult[]): Node[] {
  const sorted = sortResults(results);
  const failed = sorted.filter((r) => r.result === "fail").length;
  return [
    failed > 0
      ? explain(t("objectResults.failing", { count: failed, total: sorted.length }), true)
      : remark(t("objectResults.passing", { count: sorted.length })),
    ...resultsTable(sextant, sorted.map((result) => ({ result }))),
  ];
}

/** What a look at the object's report found, as the built-in probe settled it. */
export type Answer = "present" | "absent" | "unknown";

function startObjectResults(sextant: Sextant, root: HTMLElement): () => void {
  let hidden: boolean | undefined;
  const setHidden = (value: boolean) => {
    if (hidden === value) return;
    hidden = value;
    void sextant.ui.setHidden(value).catch(() => undefined);
  };
  // Nothing shows until a report on the object is found (the manifest's `startHidden`).
  setHidden(true);
  root.replaceChildren();
  let stopped = false;
  /** The shown object, and what was found about it (kept while the block is closed, as the built-in probe kept it). */
  let shown: string | null = null;
  let answer: Answer | null = null;
  // Asked once there is an object to ask about.
  let discovery: Discovery | null = null;
  const show = (nodes: Node[] | null) => {
    if (nodes) redraw(root, nodes);
    else root.replaceChildren();
    setHidden(nodes === null);
  };
  const render = () => {
    if (stopped) return;
    const ref = sextant.context.selection[0];
    const uid = sextant.context.uid ?? undefined;
    const key = ref ? JSON.stringify([ref.kind.group, ref.kind.kind, ref.namespace, ref.name]) : null;
    if (key !== shown) {
      shown = key;
      answer = null;
      memory.reset();
    }
    // Kyverno's own kinds, reports and Events have no policy results; an object not read yet has no uid to look by.
    if (!ref || !hasObjectResults(ref.kind) || !uid) {
      watches.stop();
      show(null);
      return;
    }
    discovery ??= askDiscovery(sextant, schedule);
    const open = memory.isOpen(RESULTS_BLOCK);
    // Closed, it looks once, until it knows whether there is anything (the built-in `useDisclosureProbe`).
    const enabled = open || answer === null;
    const reportKind = servedKind(discovery, ref.namespace ? POLICY_REPORT : CLUSTER_POLICY_REPORT);
    const spec = enabled && reportKind ? { kind: reportKind, ...(ref.namespace ? { namespaces: [ref.namespace] } : {}), fieldSelector: `metadata.name=${uid}` } : null;
    const live = watches.want({ report: spec }).report;
    const loading = reportKind === undefined || (spec !== null && !live?.ready);
    const results = reportKind && live?.ready && !live.failed ? objectResults(reportKind, ref, live.items) : [];
    const unknown = discovery.failed || live?.failed === true;
    const now: Answer | null = loading ? null : results.length > 0 ? "present" : unknown ? "unknown" : "absent";
    if (enabled && now && answer !== now) {
      // Closed, the look is done: drawn again without the watch.
      if (!open && answer === null) schedule();
      answer = now;
    }
    const title = t("objectResults.title");
    const titled = (content: () => UiContent) => [block(memory, RESULTS_BLOCK, title, content)];
    if (!open && answer) show(answer === "absent" ? null : titled(() => null));
    else if (loading && answer !== null && answer !== "absent") show(titled(() => remark(t("loading"))));
    else if (loading || results.length === 0) show(unknown ? titled(() => ui.errorState(t("error.unknown"))) : null);
    else show(titled(() => objectResultsView(sextant, results)));
  };
  const schedule = batched(render);
  const watches = new Watches(sextant, schedule);
  const memory = new BlockMemory(sextant, schedule);
  render();
  const off = sextant.onContextChange(() => {
    memory.follow();
    schedule();
  });
  return () => {
    stopped = true;
    off();
    watches.stop();
  };
}

/** Starts the details section `contribution` on the object in the context. */
export function startDetails(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  if (contribution === "policy-results") return startObjectResults(sextant, root);
  return startKindSection(sextant, root, contribution);
}
