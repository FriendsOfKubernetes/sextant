// The details sections of the extension (the manifest's `contributes.detailsSections`), as the built-in view drew them
// (src/features/security/TrivySection.tsx and the Trivy part of SecuritySection.tsx, ADR-0076):
//   `report` on the report kinds, untitled at the built-in section's place (order 20, before the conditions) — one
//     block "Report": the object the report is about (a link), its container and image, the operator's summary counts
//     and the first `TOP_LIMIT` rows by severity: vulnerabilities with their fixed versions, failed checks with their
//     remediation, exposed secrets (rule and file, never the matched text), failing compliance controls, or an SBOM's
//     component count — never thousands of rows;
//   `scans` on Pods and workloads (Deployment, StatefulSet, DaemonSet, ReplicaSet, Job, CronJob), right after Sextant's
//     "Security" section, whose last block it was — one block "Image scans (Trivy)": the object's VulnerabilityReports
//     and ConfigAuditReports, each with its counts, its first `DETAILS_TOP` rows and a link to the report. Hidden (the
//     manifest's `startHidden`) where the cluster serves neither kind. The reports are watched by label in the object's
//     namespace only while the block is open (a Deployment's through its ReplicaSets, watched by its selector).
// The blocks open and close as the built-in ones did, in Sextant's own memory of details sections (`context.blocks`,
// `ui.setBlockOpen`), with the panel's "Expand all" and "Collapse all"; a closed block draws and watches nothing. The
// frame reads the shown object again whenever its resourceVersion changes. Read-only: Trivy reports are never a problem
// source (ADR-0076).
import { trackObjects, ui, type KindRef, type KubeObject, type ObjectRef, type Sextant, type UiContent, type Watch, type WatchParams } from "@sextant/extension-sdk";
import { badge, block, BlockMemory, code, element, errorText, muted, note, redraw, table, type BadgeTone } from "./dom";
import { t } from "./i18n";
import {
  API_VERSIONS,
  compliance,
  componentsCount,
  CONFIG_AUDIT_REPORT,
  countsOf,
  DETAILS_TOP,
  fixableCount,
  imageOf,
  kindOfApiVersion,
  REPLICA_SET,
  reportMatches,
  reportSelector,
  scannedAs,
  selectorOf,
  SEVERITIES,
  targetOf,
  topFailedChecks,
  topSecrets,
  topVulnerabilities,
  trivyKind,
  VULNERABILITY_REPORT,
  WORKLOAD_KINDS,
  type Check,
  type ComplianceControl,
  type Counts,
  type ExposedSecret,
  type ReportShape,
  type Top,
  type Vulnerability,
} from "./model";

/** The blocks' ids in Sextant's memory of details sections. */
export const REPORT_BLOCK = "report";
export const SCANS_BLOCK = "scans";

/** Kinds whose live Pods are compared with their template in Sextant's "Security" section (their ReplicaSets known). */
const POD_OWNERS = new Set(["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job"]);

// ---------- Pieces ----------

const SEVERITY_TONE: Record<string, BadgeTone> = { CRITICAL: "danger", HIGH: "danger", MEDIUM: "warning", LOW: "info", UNKNOWN: "neutral" };

export function severityBadge(severity: string): HTMLElement {
  const known = (SEVERITIES as readonly string[]).includes(severity) ? severity : "UNKNOWN";
  return badge(t(`severity.${known}`), SEVERITY_TONE[known]!);
}

/** "Critical: 2", "High: 7", "Medium: 0", "Low: 1": every severity but Unknown, toned only when there are any. */
export function severityCounts(counts: Counts): HTMLElement {
  const values: [string, number][] = [
    ["CRITICAL", counts.critical],
    ["HIGH", counts.high],
    ["MEDIUM", counts.medium],
    ["LOW", counts.low],
  ];
  return element(
    "span",
    { className: "sec-counts" },
    ...values.map(([severity, n]) => badge(t("severityCount", { severity: t(`severity.${severity}`), count: String(n) }), n > 0 ? SEVERITY_TONE[severity]! : "neutral")),
  );
}

/** "Listed: the 50 most severe of 4000." when not every row is listed. */
function moreNote(top: Top<unknown>): HTMLElement | null {
  if (top.total <= top.rows.length) return null;
  return note(t("topShown", { shown: String(top.rows.length), total: String(top.total) }));
}

const present = (nodes: (Node | null | undefined | false)[]): Node[] => nodes.filter((n): n is Node => Boolean(n));

export function vulnerabilityTable(sextant: Sextant, top: Top<Vulnerability>): Node[] {
  const headers = ["severity", "id", "package", "installed", "fixed"].map((h) => t(`table.${h}`));
  const rows = top.rows.map((v) => [severityBadge(v.severity), { content: v.id, title: v.title }, v.resource, v.installed, v.fixed ?? muted(t("noFix"))]);
  return present([table(sextant, "vulnerabilities", headers, rows), moreNote(top)]);
}

export function checkList(top: Top<Check>): Node[] {
  const items = top.rows.map((c) =>
    element(
      "li",
      { className: "sec-check" },
      element("div", { className: "sec-finding__head" }, severityBadge(c.severity), element("span", { className: "sec-finding__title", textContent: c.id }), c.title ? element("span", { textContent: c.title }) : null),
      c.messages.length > 0 ? note(c.messages.join("\n")) : null,
      c.remediation ? element("p", { className: "sec-remediation", textContent: c.remediation }) : null,
    ),
  );
  return present([element("ul", { className: "sec-checks" }, ...items), moreNote(top)]);
}

export function secretTable(sextant: Sextant, top: Top<ExposedSecret>): Node[] {
  const headers = ["severity", "rule", "title", "target"].map((h) => t(`table.${h}`));
  const rows = top.rows.map((s) => [severityBadge(s.severity), s.rule, s.title, s.target]);
  return present([table(sextant, "secrets", headers, rows), moreNote(top)]);
}

export function controlTable(sextant: Sextant, top: Top<ComplianceControl>): Node[] {
  const headers = ["severity", "control", "title", "failed"].map((h) => t(`table.${h}`));
  const rows = top.rows.map((c) => [severityBadge(c.severity), c.id, c.name, String(c.failed)]);
  return present([table(sextant, "controls", headers, rows), moreNote(top)]);
}

/** A link to an object's details, labelled "Open <kind> <name>" as Sextant's links are. */
function objectLink(sextant: Sextant, ref: ObjectRef, text: string): HTMLElement {
  const button = ui.objectLink(sextant, ref, text);
  button.setAttribute("aria-label", t("openObject", { kind: ref.kind.kind, name: ref.name }));
  return button;
}

// ---------- The report's details ----------

function reportBody(sextant: Sextant, shape: ReportShape, report: KubeObject): Node[] {
  const counts = () => element("div", { className: "sec-report__counts" }, severityCounts(countsOf(report)));
  switch (shape) {
    case "vulnerabilities": {
      const top = topVulnerabilities(report);
      const head = counts();
      head.append(element("span", { className: "sec-note", textContent: t("fixable", { count: fixableCount(report) }) }));
      return [head, ...(top.rows.length > 0 ? vulnerabilityTable(sextant, top) : [note(t("noVulnerabilities"))])];
    }
    case "checks": {
      const top = topFailedChecks(report);
      return [counts(), ...(top.rows.length > 0 ? checkList(top) : [note(t("noFailed"))])];
    }
    case "secrets": {
      const top = topSecrets(report);
      return [counts(), ...(top.rows.length > 0 ? secretTable(sextant, top) : [note(t("noSecrets"))])];
    }
    case "compliance": {
      const c = compliance(report);
      return [note(t("passFail", { pass: String(c.pass), fail: String(c.fail) })), ...(c.failing.rows.length > 0 ? controlTable(sextant, c.failing) : [])];
    }
    case "sbom": {
      const n = componentsCount(report);
      return n === undefined ? [] : [note(t("components", { count: String(n) }))];
    }
  }
}

/** The report section: one block "Report"; `null` for a kind that is not a Trivy report. */
export function reportView(sextant: Sextant, kind: Pick<KindRef, "group" | "kind">, report: KubeObject, memory: BlockMemory): Node[] | null {
  const def = trivyKind(kind);
  if (!def) return null;
  return [
    block(memory, REPORT_BLOCK, t("reportTitle"), () => {
      const target = targetOf(report);
      const image = imageOf(report);
      let head: HTMLElement | null = null;
      if (target) {
        const apiVersion = API_VERSIONS[target.kind];
        const text = `${target.kind}: ${target.name}`;
        head = element(
          "p",
          { className: "sec-report__head" },
          muted(t("scanned")),
          apiVersion ? objectLink(sextant, { kind: kindOfApiVersion(apiVersion, target.kind), namespace: target.namespace, name: target.name }, text) : element("span", { textContent: text }),
          target.container ? element("span", { textContent: t("container", { name: target.container }) }) : null,
          image ? code(image) : null,
        );
      }
      return [head, ...reportBody(sextant, def.shape, report)];
    }),
  ];
}

// ---------- A workload's image scans ----------

/** A list watched while the block shows it, as Sextant's watch state: loading until the first answer, or failed. */
export interface Live {
  items: KubeObject[];
  status: "loading" | "ready" | "error";
}

/** A list that is not watched: loading, as Sextant's `useWatch` of no spec answered. */
export const NOT_WATCHED: Live = { items: [], status: "loading" };

/** The report kinds the cluster serves (in its version), `null` where it does not. */
export interface Served {
  vulnerabilities: KindRef | null;
  audits: KindRef | null;
}

const isWorkload = (kind: Pick<KindRef, "group" | "kind">) => WORKLOAD_KINDS.some((k) => k.group === kind.group && k.kind === kind.kind);

/** What the scans block watches: the ReplicaSets (a Deployment's), the reports; `null` for a list it does not watch. */
export function scansWatches(
  kind: Pick<KindRef, "group" | "kind">,
  obj: KubeObject,
  served: Served,
  open: boolean,
  replicaSets: readonly KubeObject[],
): { replicaSets: Omit<WatchParams, "clusterId"> | null; vulnerabilities: Omit<WatchParams, "clusterId"> | null; audits: Omit<WatchParams, "clusterId"> | null } {
  const none = { replicaSets: null, vulnerabilities: null, audits: null };
  const namespace = obj.metadata.namespace ?? "";
  if (!isWorkload(kind) || !namespace || !open || (!served.vulnerabilities && !served.audits)) return none;
  const withPods = POD_OWNERS.has(kind.kind) ? selectorOf(obj) : null;
  const scanned = scannedAs(kind.kind, obj, replicaSets);
  const selector = scanned ? reportSelector(scanned) : null;
  const of = (k: KindRef | null) => (k && selector ? { kind: k, namespaces: [namespace], labelSelector: selector } : null);
  return {
    replicaSets: withPods && kind.kind === "Deployment" ? { kind: REPLICA_SET, namespaces: [namespace], labelSelector: withPods } : null,
    vulnerabilities: of(served.vulnerabilities),
    audits: of(served.audits),
  };
}

function openReport(sextant: Sextant, report: KubeObject): HTMLElement {
  const ref: ObjectRef = { kind: kindOfApiVersion(report.apiVersion ?? `${VULNERABILITY_REPORT.group}/${VULNERABILITY_REPORT.version}`, report.kind ?? ""), namespace: report.metadata.namespace ?? null, name: report.metadata.name };
  return objectLink(sextant, ref, t("openReport"));
}

function imageReport(sextant: Sextant, report: KubeObject): HTMLElement {
  const top = topVulnerabilities(report, DETAILS_TOP);
  const container = targetOf(report)?.container;
  const image = imageOf(report);
  const counts = element("div", { className: "sec-report__counts" }, severityCounts(countsOf(report)), element("span", { className: "sec-note", textContent: t("fixable", { count: fixableCount(report) }) }));
  return element(
    "div",
    { className: "sec-report" },
    element(
      "div",
      { className: "sec-report__head" },
      element("span", { className: "sec-report__name", textContent: container ? t("container", { name: container }) : report.metadata.name }),
      image ? code(image) : null,
      openReport(sextant, report),
    ),
    counts,
    ...(top.rows.length > 0 ? vulnerabilityTable(sextant, top) : [note(t("noVulnerabilities"))]),
  );
}

function auditReport(sextant: Sextant, report: KubeObject): HTMLElement {
  const top = topFailedChecks(report, DETAILS_TOP);
  return element(
    "div",
    { className: "sec-report" },
    element("div", { className: "sec-report__head" }, element("span", { className: "sec-report__name", textContent: t("configAudit") }), openReport(sextant, report)),
    element("div", { className: "sec-report__counts" }, severityCounts(countsOf(report))),
    ...(top.rows.length > 0 ? checkList(top) : [note(t("noFailed"))]),
  );
}

/**
 * The scans section of a workload or Pod: one block "Image scans (Trivy)", or `null` — hidden — where the cluster serves
 * neither VulnerabilityReports nor ConfigAuditReports.
 */
export function scansView(
  sextant: Sextant,
  kind: Pick<KindRef, "group" | "kind">,
  obj: KubeObject,
  served: Served,
  lists: { replicaSets: Live; vulnerabilities: Live; audits: Live },
  memory: BlockMemory,
): Node[] | null {
  if (!isWorkload(kind) || !obj.metadata.namespace) return null;
  if (!served.vulnerabilities && !served.audits) return null;
  return [
    block(memory, SCANS_BLOCK, t("section"), (): UiContent => {
      const namespace = obj.metadata.namespace ?? "";
      const scanned = scannedAs(kind.kind, obj, lists.replicaSets.items);
      const vulns = served.vulnerabilities ? lists.vulnerabilities : NOT_WATCHED;
      const audits = served.audits ? lists.audits : NOT_WATCHED;
      const vulnReports = scanned ? vulns.items.filter((r) => reportMatches(r, namespace, scanned)) : [];
      const auditReports = scanned ? audits.items.filter((r) => reportMatches(r, namespace, scanned)) : [];
      // As the built-in block: "none" only once the image reports answered (where they are served).
      const loading = !!served.vulnerabilities && vulns.status === "loading";
      const remark =
        vulns.status === "error" || audits.status === "error"
          ? note(t("watchFailed"), true)
          : vulnReports.length === 0 && auditReports.length === 0 && !loading
            ? note(t("none"))
            : null;
      return [remark, ...vulnReports.map((r) => imageReport(sextant, r)), ...auditReports.map((r) => auditReport(sextant, r))];
    }),
  ];
}

// ---------- Watches ----------

/**
 * The watches a section holds, by what they watch: each drawing asks for the lists it needs between `begin` and `end`
 * (a list is started when first asked for), and `end` stops every list it did not ask for.
 */
class Watches {
  private readonly open = new Map<string, { watch: Watch; live: Live }>();
  private wanted = new Set<string>();
  constructor(
    private readonly sextant: Sextant,
    private readonly changed: () => void,
  ) {}

  begin(): void {
    this.wanted = new Set();
  }

  /** The list of `spec`, watched from now on; not watched for no spec. */
  get(spec: Omit<WatchParams, "clusterId"> | null): Live {
    if (!spec) return NOT_WATCHED;
    const key = JSON.stringify(spec);
    this.wanted.add(key);
    return (this.open.get(key) ?? this.start(key, spec)).live;
  }

  end(): void {
    for (const [key, entry] of this.open) {
      if (this.wanted.has(key)) continue;
      this.open.delete(key);
      void entry.watch.unwatch().catch(() => undefined);
    }
  }

  private start(key: string, spec: Omit<WatchParams, "clusterId">): { watch: Watch; live: Live } {
    const live: Live = { items: [], status: "loading" };
    const watch = this.sextant.resources.watch(spec, {
      onUpdate: trackObjects(
        (items) => {
          live.items = items;
          live.status = "ready";
          this.changed();
        },
        (other) => {
          if (other.type !== "error") return;
          live.status = "error";
          this.changed();
        },
      ),
      onError: () => {
        live.status = "error";
        this.changed();
      },
    });
    watch.started.catch(() => undefined);
    const entry = { watch, live };
    this.open.set(key, entry);
    return entry;
  }

  stop(): void {
    this.begin();
    this.end();
  }
}

/** Calls `run` once in the next microtask, however often it is asked. */
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

/** The report kinds Sextant says the cluster serves (any version, as the built-in view looked them up). */
export async function servedKinds(sextant: Sextant): Promise<Served> {
  const kinds = await sextant.kinds();
  const find = (ref: KindRef) => kinds.find((k) => k.kindRef.group === ref.group && k.kindRef.kind === ref.kind)?.kindRef ?? null;
  return { vulnerabilities: find(VULNERABILITY_REPORT), audits: find(CONFIG_AUDIT_REPORT) };
}

/**
 * Follows the shown object: `onObject` with it, now and whenever its resourceVersion changes; `onError` when it cannot
 * be read. Returns the function that stops following it.
 */
function followShown(sextant: Sextant, onObject: (ref: ObjectRef, obj: KubeObject) => void, onError: (err: unknown) => void, onNone: () => void): () => void {
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

/** Starts the details section `contribution` on the object in the context. */
export function startDetails(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  let object: { ref: ObjectRef; obj: KubeObject } | null = null;
  let stopped = false;
  /** What Sextant's kinds say (the scans section only); `null` until they answer. */
  let served: Served | null = null;
  /** Whether Sextant hides the section now (the scans section starts hidden, the manifest's `startHidden`). */
  let hidden = contribution === "scans";
  const setHidden = (hide: boolean) => {
    if (hide === hidden) return;
    hidden = hide;
    void sextant.ui.setHidden(hide).catch(() => undefined);
  };

  const render = () => {
    if (stopped || !object) return;
    const { ref, obj } = object;
    if (contribution === "report") {
      const view = reportView(sextant, ref.kind, obj, memory);
      redraw(root, view ?? [ui.empty(t("common.nothingToShow", { view: contribution }))]);
      return;
    }
    if (contribution !== "scans") {
      redraw(root, [ui.empty(t("common.nothingToShow", { view: contribution }))]);
      return;
    }
    // Hidden until Sextant's kinds say the reports are served, as the built-in block was absent before discovery.
    if (!served) return;
    const open = memory.peek(SCANS_BLOCK);
    watches.begin();
    const replicaSets = watches.get(scansWatches(ref.kind, obj, served, open, []).replicaSets);
    const specs = scansWatches(ref.kind, obj, served, open, replicaSets.items);
    const lists = { replicaSets, vulnerabilities: watches.get(specs.vulnerabilities), audits: watches.get(specs.audits) };
    watches.end();
    const view = scansView(sextant, ref.kind, obj, served, lists, memory);
    setHidden(view === null);
    redraw(root, view ?? []);
  };
  const schedule = batched(render);
  const watches = new Watches(sextant, schedule);
  const memory = new BlockMemory(sextant, schedule);
  if (contribution === "scans") {
    // Asked once: a cluster whose kinds cannot be told shows no scans, as the built-in block did.
    servedKinds(sextant).then(
      (kinds) => {
        served = kinds;
        schedule();
      },
      () => {
        served = { vulnerabilities: null, audits: null };
        schedule();
      },
    );
  }
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
    // The scans section stays hidden unless it showed something (Sextant's panel tells the error of the object).
    (err) => {
      if (!hidden) root.replaceChildren(ui.errorState(errorText(err)));
    },
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
