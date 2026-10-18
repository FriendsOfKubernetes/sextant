// The "Security" page (#143) of the Cluster section: per namespace, its Pod Security labels compared with its
// workloads (which would be rejected under `enforce`, recorded under `audit`, warned about under `warn`), the counts
// of findings, and each workload with its posture, its findings (field, value, fix to copy) and — when Trivy Operator
// is installed — its image vulnerabilities and configuration audit. Bounded by the namespace filter like the
// right-sizing page: with "All namespaces" it asks for a choice, and only the first `MAX_SECURITY_NAMESPACES` chosen
// namespaces are watched, only while the page is open. Read-only.
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWatch, type ClusterId, type KubeObject, type WatchSpec } from "../../api";
import { useAppStore } from "../../app/store";
import { Badge, Button, EmptyState, ErrorState, LoadingIndicator } from "../../components";
import type { PageProps } from "../../layout/pages";
import { NamespaceFilter, useSelectedNamespaces } from "../namespaces";
import { FindingList, LevelCounts, ModeComparisons, PostureBadge, SeverityCounts } from "./components";
import { JUDGED_KINDS, MAX_SECURITY_NAMESPACES, NAMESPACE, useTrivyReports, useWorkloads, type Workloads } from "./hooks";
import { psaLabels, type Judged } from "./namespaces";
import type { FindingLevel } from "./pss";
import { countAtLeast, indexReports, reportsFor, sumCounts, type Counts, type TrivySeverity } from "./trivy";
import "./security.css";

export const SECURITY_PAGE_ID = "security";
/** At most this many workloads are drawn. */
export const MAX_RENDERED_WORKLOADS = 500;

type LevelFilter = "all" | FindingLevel;
/** The namespace header counts violations only (hints are listed per workload). */
const VIOLATION_LEVELS: FindingLevel[] = ["baseline", "restricted"];
const LEVEL_FILTERS: LevelFilter[] = ["all", "baseline", "restricted", "hint"];
type SeverityFilter = "any" | TrivySeverity;
const SEVERITY_FILTERS: SeverityFilter[] = ["any", "CRITICAL", "HIGH", "MEDIUM", "LOW"];

const NAMESPACES: WatchSpec = { kind: NAMESPACE, namespaces: null, labelSelector: null, fieldSelector: null };

export function SecurityPage({ clusterId }: PageProps) {
  const { t } = useTranslation();
  const selected = useSelectedNamespaces(clusterId);
  return (
    <div className="sec-page">
      <h2 className="sec-page__title">{t("security:title")}</h2>
      <p className="sec-note">{t("security:intro")}</p>
      {selected === undefined ? (
        <LoadingIndicator className="sec-loading" text={t("security:loading")} />
      ) : selected === null || selected.length === 0 ? (
        <>
          <div className="sec-toolbar">
            <NamespaceFilter clusterId={clusterId} />
          </div>
          <EmptyState title={t("security:chooseNamespace")} text={t("security:chooseNamespaceText")} />
        </>
      ) : (
        <SecurityView clusterId={clusterId} selected={selected} />
      )}
    </div>
  );
}

interface Row {
  judged: Judged;
  /** The findings the level filter keeps. */
  shown: Judged["findings"];
  vulnerabilities?: Counts;
  audit?: Counts;
}

function SecurityView({ clusterId, selected }: { clusterId: ClusterId; selected: string[] }) {
  const { t } = useTranslation();
  const nsKey = selected.slice(0, MAX_SECURITY_NAMESPACES).join("\u0000");
  // `nsKey` stands for the first namespaces by value.
  const namespaces = useMemo(() => nsKey.split("\u0000"), [nsKey]);
  const [level, setLevel] = useState<LevelFilter>("all");
  const [severity, setSeverity] = useState<SeverityFilter>("any");

  const workloads = useWorkloads(clusterId, namespaces);
  const trivy = useTrivyReports(clusterId, namespaces);
  const nsObjects = useWatch(clusterId, NAMESPACES);

  const groups = useMemo(
    () => buildGroups(workloads, trivy.vulnerabilities, trivy.configAudits, namespaces, level, severity),
    [workloads, trivy.vulnerabilities, trivy.configAudits, namespaces, level, severity],
  );
  const nsByName = useMemo(() => {
    const map = new Map<string, KubeObject>();
    for (const ns of nsObjects.items.values()) if (ns.metadata?.name) map.set(ns.metadata.name, ns);
    return map;
  }, [nsObjects.items]);

  let budget = MAX_RENDERED_WORKLOADS;
  const truncated = groups.reduce((n, g) => n + g.rows.length, 0) > MAX_RENDERED_WORKLOADS;
  const filtered = level !== "all" || severity !== "any";

  return (
    <>
      <div className="sec-toolbar">
        <NamespaceFilter clusterId={clusterId} />
        <label className="sec-choice">
          {t("security:filter.level")}
          <select className="sec-select" value={level} onChange={(e) => setLevel(e.target.value as LevelFilter)}>
            {LEVEL_FILTERS.map((l) => (
              <option key={l} value={l}>
                {t(`security:filter.levels.${l}`)}
              </option>
            ))}
          </select>
        </label>
        {trivy.served && (
          <label className="sec-choice">
            {t("security:filter.severity")}
            <select className="sec-select" value={severity} onChange={(e) => setSeverity(e.target.value as SeverityFilter)}>
              {SEVERITY_FILTERS.map((s) => (
                <option key={s} value={s}>
                  {t(`security:filter.severities.${s}`)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {selected.length > MAX_SECURITY_NAMESPACES && (
        <p className="sec-note sec-note--warning" role="status">
          {t("security:firstNamespaces", { count: MAX_SECURITY_NAMESPACES })}
        </p>
      )}
      {workloads.failed.map(({ kind, watch }) => (
        <ErrorState
          key={kind.kind}
          className="sec-error"
          title={t("security:watchFailed", { kind: kind.kind })}
          error={watch.error!}
        />
      ))}
      {trivy.failed && <p className="sec-note sec-note--warning">{t("security:trivy.watchFailed")}</p>}
      {truncated && (
        <p className="sec-note sec-note--warning" role="status">
          {t("security:truncated", { count: MAX_RENDERED_WORKLOADS })}
        </p>
      )}

      {workloads.loading && groups.every((g) => g.rows.length === 0) ? (
        <LoadingIndicator className="sec-loading" text={t("security:loading")} />
      ) : groups.every((g) => g.rows.length === 0) && !groups.some((g) => g.judged.length > 0) ? (
        <p className="sec-note">{t("security:empty")}</p>
      ) : (
        groups.map((g) => {
          const take = g.rows.slice(0, Math.max(0, budget));
          budget -= take.length;
          const all = g.judged.flatMap((j) => j.findings);
          return (
            <section key={g.namespace} className="sec-ns" aria-label={g.namespace}>
              <h3 className="sec-ns__heading">
                <span className="sec-ns__name">{g.namespace}</span>
                <LevelCounts findings={all} levels={VIOLATION_LEVELS} />
              </h3>
              <ModeComparisons
                labels={nsObjects.status === "ready" && nsByName.has(g.namespace) ? psaLabels(nsByName.get(g.namespace)) : undefined}
                judged={g.judged}
              />
              {take.length === 0 ? (
                <p className="sec-note">{filtered ? t("security:emptyFiltered") : t("security:empty")}</p>
              ) : (
                <ul className="sec-rows">
                  {take.map((row) => (
                    <WorkloadRow key={row.judged.obj.metadata?.uid ?? `${row.judged.kind}/${row.judged.obj.metadata?.name}`} row={row} />
                  ))}
                </ul>
              )}
            </section>
          );
        })
      )}
    </>
  );
}

interface Group {
  namespace: string;
  /** Every judged object of the namespace (the comparison with its labels uses them all). */
  judged: Judged[];
  /** What the filters keep, worst first. */
  rows: Row[];
}

const KIND_ORDER = new Map(JUDGED_KINDS.map((k, i) => [k.kind, i]));

/** Rows by namespace (in the filter's order), filtered by level and severity, worst first. */
export function buildGroups(
  workloads: Pick<Workloads, "judged" | "replicaSets">,
  vulnerabilityReports: readonly KubeObject[],
  auditReports: readonly KubeObject[],
  namespaces: readonly string[],
  level: LevelFilter,
  severity: SeverityFilter,
): Group[] {
  const vulnIndex = indexReports(vulnerabilityReports);
  const auditIndex = indexReports(auditReports);
  const byNamespace = new Map<string, Judged[]>(namespaces.map((ns) => [ns, []]));
  for (const j of workloads.judged) byNamespace.get(j.obj.metadata?.namespace ?? "")?.push(j);
  return [...byNamespace.entries()].map(([namespace, judged]) => {
    const rows: Row[] = [];
    for (const j of judged) {
      const shown = level === "all" ? j.findings : j.findings.filter((f) => f.level === level);
      if (level !== "all" && shown.length === 0) continue;
      const vulnReports = reportsFor(vulnIndex, j.kind, j.obj, workloads.replicaSets);
      const auditReportsOf = reportsFor(auditIndex, j.kind, j.obj, workloads.replicaSets);
      const vulnerabilities = vulnReports.length > 0 ? sumCounts(vulnReports) : undefined;
      if (severity !== "any" && (!vulnerabilities || countAtLeast(vulnerabilities, severity) === 0)) continue;
      rows.push({
        judged: j,
        shown,
        vulnerabilities,
        audit: auditReportsOf.length > 0 ? sumCounts(auditReportsOf) : undefined,
      });
    }
    const weight = (r: Row) =>
      r.judged.findings.filter((f) => f.level === "baseline").length * 1000 +
      r.judged.findings.filter((f) => f.level === "restricted").length;
    rows.sort(
      (a, b) =>
        weight(b) - weight(a) ||
        (KIND_ORDER.get(a.judged.kind) ?? 99) - (KIND_ORDER.get(b.judged.kind) ?? 99) ||
        (a.judged.obj.metadata?.name ?? "").localeCompare(b.judged.obj.metadata?.name ?? ""),
    );
    return { namespace, judged, rows };
  });
}

function WorkloadRow({ row }: { row: Row }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const openDetails = useAppStore((s) => s.openDetails);
  const { judged } = row;
  const kind = JUDGED_KINDS.find((k) => k.kind === judged.kind)!;
  const name = judged.obj.metadata?.name ?? "";
  return (
    <li className="sec-row">
      <div className="sec-row__head">
        <Button
          size="compact"
          icon={open ? "chevronDown" : "chevronRight"}
          iconOnly
          label={open ? t("security:row.collapse", { name }) : t("security:row.expand", { name })}
          aria-expanded={open}
          disabled={row.shown.length === 0}
          onClick={() => setOpen(!open)}
        />
        <button
          type="button"
          className="rt-link sec-row__object"
          aria-label={t("resources:table.openObject", { kind: judged.kind, name })}
          onClick={() => openDetails({ kind, namespace: judged.obj.metadata?.namespace ?? null, name })}
        >
          {`${judged.kind}: ${name}`}
        </button>
        <PostureBadge findings={judged.findings} />
        <LevelCounts findings={row.shown} />
        {row.vulnerabilities && <SeverityCounts counts={row.vulnerabilities} />}
        {row.audit && row.audit.critical + row.audit.high > 0 && (
          <Badge tone="warning">{t("security:trivy.auditCount", { count: row.audit.critical + row.audit.high })}</Badge>
        )}
      </div>
      {open && <FindingList findings={row.shown} />}
    </li>
  );
}
