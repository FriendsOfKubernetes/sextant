// The "Best practices" page (#207) of the Cluster section, next to Security: per namespace, the workloads with
// findings, worst first, each with why it matters, the exact field and a fix to copy. Bounded by the namespace filter
// like the Security page: with "All namespaces" it asks for a choice, only the first `MAX_PRACTICES_NAMESPACES` chosen
// namespaces are watched (minus the excluded ones), and only while the page is open. Read-only.
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWatch, type ClusterId, type KindRef, type WatchState } from "../../api";
import { useAppStore } from "../../app/store";
import { Button, EmptyState, ErrorState, LoadingIndicator } from "../../components";
import { formatList } from "../../i18n";
import type { PageProps } from "../../layout/pages";
import { NamespaceFilter, useSelectedNamespaces } from "../namespaces";
import { CRONJOB, DAEMONSET, DEPLOYMENT, inNamespaces, JOB, POD, STATEFULSET } from "../security/hooks";
import "../security/security.css";
import { evaluateAll } from "./checks";
import { FindingList, SeverityCounts, sortFindings } from "./components";
import { enabledFindings, usePracticesConfig, type PracticesConfig } from "./config";
import { contextFrom, HPA, LIMIT_RANGE, listed, PDB, useRecommendations, useSchedulableNodes } from "./hooks";
import { areaOf, workloadInfo, type Area, type PracticeFinding, type Severity, type WorkloadInfo } from "./model";
import { KIND_REFS } from "./problems";
import { PracticesSettingsDialog } from "./SettingsDialog";
import "./practices.css";

export const PRACTICES_PAGE_ID = "practices";
/** At most this many namespaces of the filter are checked. */
export const MAX_PRACTICES_NAMESPACES = 20;
/** At most this many workloads are drawn. */
export const MAX_RENDERED_WORKLOADS = 500;

const WORKLOAD_KINDS: KindRef[] = [DEPLOYMENT, STATEFULSET, DAEMONSET, CRONJOB, JOB];
type AreaFilter = "all" | Area;
type SeverityFilter = "any" | Exclude<Severity, "low">;
const AREA_FILTERS: AreaFilter[] = ["all", "reliability", "efficiency"];
const SEVERITY_FILTERS: SeverityFilter[] = ["any", "high", "medium"];
const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export function PracticesPage({ clusterId }: PageProps) {
  const { t } = useTranslation();
  const selected = useSelectedNamespaces(clusterId);
  const { loaded, config } = usePracticesConfig();
  return (
    <div className="sec-page">
      <h2 className="sec-page__title">{t("practices:title")}</h2>
      <p className="sec-note">{t("practices:intro")}</p>
      {selected === undefined || !loaded ? (
        <LoadingIndicator className="sec-loading" text={t("practices:loading")} />
      ) : selected === null || selected.length === 0 ? (
        <>
          <Toolbar clusterId={clusterId} />
          <EmptyState title={t("practices:chooseNamespace")} text={t("practices:chooseNamespaceText")} />
        </>
      ) : (
        <PracticesView clusterId={clusterId} selected={selected} config={config} />
      )}
    </div>
  );
}

function Toolbar({ clusterId, children }: { clusterId: ClusterId; children?: React.ReactNode }) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(false);
  return (
    <div className="sec-toolbar">
      <NamespaceFilter clusterId={clusterId} />
      {children}
      <Button size="compact" icon="settings" onClick={() => setSettings(true)}>
        {t("practices:settings.open")}
      </Button>
      {settings && <PracticesSettingsDialog close={() => setSettings(false)} />}
    </div>
  );
}

interface Row {
  workload: WorkloadInfo;
  /** What the filters keep. */
  shown: PracticeFinding[];
}

interface Group {
  namespace: string;
  rows: Row[];
  all: PracticeFinding[];
}

const KIND_ORDER = new Map(WORKLOAD_KINDS.map((k, i) => [k.kind, i]));

/** Rows by namespace (in the filter's order), filtered by area and severity, worst first. */
export function buildGroups(
  workloads: readonly WorkloadInfo[],
  findings: ReadonlyMap<string, readonly PracticeFinding[]>,
  namespaces: readonly string[],
  config: PracticesConfig,
  area: AreaFilter,
  severity: SeverityFilter,
): Group[] {
  const byNamespace = new Map<string, Group>(namespaces.map((ns) => [ns, { namespace: ns, rows: [], all: [] }]));
  for (const w of workloads) {
    const group = byNamespace.get(w.namespace);
    if (!group) continue;
    const found = enabledFindings(findings.get(w.uid) ?? [], config);
    group.all.push(...found);
    const shown = found.filter(
      (f) => (area === "all" || areaOf(f.check) === area) && (severity === "any" || RANK[f.severity] <= RANK[severity]),
    );
    if (shown.length > 0) group.rows.push({ workload: w, shown: sortFindings(shown) });
  }
  const weight = (r: Row) => r.shown.reduce((n, f) => n + 10 ** (2 - RANK[f.severity]) * 10, 0);
  for (const g of byNamespace.values()) {
    g.rows.sort(
      (a, b) =>
        weight(b) - weight(a) ||
        (KIND_ORDER.get(a.workload.kind) ?? 99) - (KIND_ORDER.get(b.workload.kind) ?? 99) ||
        a.workload.name.localeCompare(b.workload.name),
    );
  }
  return [...byNamespace.values()];
}

function PracticesView({ clusterId, selected, config }: { clusterId: ClusterId; selected: string[]; config: PracticesConfig }) {
  const { t } = useTranslation();
  const first = selected.slice(0, MAX_PRACTICES_NAMESPACES);
  const nsKey = first.filter((ns) => !config.excluded.has(ns)).join("\u0000");
  // `nsKey` stands for the checked namespaces by value.
  const namespaces = useMemo(() => (nsKey ? nsKey.split("\u0000") : []), [nsKey]);
  const excluded = first.filter((ns) => config.excluded.has(ns));
  const [area, setArea] = useState<AreaFilter>("all");
  const [severity, setSeverity] = useState<SeverityFilter>("any");

  // One watch per kind, always called in the same order (the Security page's specs, so the lists are shared).
  const kinds: WatchState[] = [
    useWatch(clusterId, inNamespaces(WORKLOAD_KINDS[0], namespaces)),
    useWatch(clusterId, inNamespaces(WORKLOAD_KINDS[1], namespaces)),
    useWatch(clusterId, inNamespaces(WORKLOAD_KINDS[2], namespaces)),
    useWatch(clusterId, inNamespaces(WORKLOAD_KINDS[3], namespaces)),
    useWatch(clusterId, inNamespaces(WORKLOAD_KINDS[4], namespaces)),
  ];
  const hpas = useWatch(clusterId, inNamespaces(HPA, namespaces));
  const pdbs = useWatch(clusterId, inNamespaces(PDB, namespaces));
  const limitRanges = useWatch(clusterId, inNamespaces(LIMIT_RANGE, namespaces));
  const podWatch = useWatch(clusterId, inNamespaces(POD, namespaces));
  const schedulableNodes = useSchedulableNodes(clusterId);
  const pods = useMemo(() => listed(podWatch), [podWatch]);
  const recommendations = useRecommendations(clusterId, namespaces.length > 0 ? { type: "namespaces", namespaces } : null, pods);
  const surround = [hpas, pdbs, limitRanges];

  const itemsKey = kinds.map((w) => w.items);
  const workloads = useMemo(
    () =>
      WORKLOAD_KINDS.flatMap((kind, i) =>
        [...itemsKey[i]!.values()].map((o) => workloadInfo(kind.kind, o)).filter((w): w is WorkloadInfo => w !== null),
      ),
    // One dependency per watch: a new list of any kind recomputes (unchanged objects keep their rows).
    itemsKey,
  );
  const ctx = useMemo(
    () =>
      contextFrom({
        hpas: listed(hpas),
        pdbs: listed(pdbs),
        limitRanges: listed(limitRanges),
        pods,
        schedulableNodes,
        recommendations,
      }),
    [hpas, pdbs, limitRanges, pods, schedulableNodes, recommendations],
  );
  const findings = useMemo(() => evaluateAll(workloads, ctx), [workloads, ctx]);
  const groups = useMemo(
    () => buildGroups(workloads, findings, namespaces, config, area, severity),
    [workloads, findings, namespaces, config, area, severity],
  );

  let budget = MAX_RENDERED_WORKLOADS;
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  const filtered = area !== "all" || severity !== "any";
  const loading = namespaces.length > 0 && (kinds.some((w) => w.status === "loading") || surround.some((w) => w.status === "loading"));
  const failed = WORKLOAD_KINDS.map((kind, i) => ({ kind, watch: kinds[i]! })).filter((f) => f.watch.status === "error");
  const skipped = [
    ...[HPA, PDB, LIMIT_RANGE].filter((_, i) => surround[i]!.status === "error"),
    ...(podWatch.status === "error" ? [POD] : []),
  ];

  return (
    <>
      <Toolbar clusterId={clusterId}>
        <label className="sec-choice">
          {t("practices:filter.area")}
          <select className="sec-select" value={area} onChange={(e) => setArea(e.target.value as AreaFilter)}>
            {AREA_FILTERS.map((a) => (
              <option key={a} value={a}>
                {t(`practices:filter.areas.${a}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="sec-choice">
          {t("practices:filter.severity")}
          <select className="sec-select" value={severity} onChange={(e) => setSeverity(e.target.value as SeverityFilter)}>
            {SEVERITY_FILTERS.map((s) => (
              <option key={s} value={s}>
                {t(`practices:filter.severities.${s}`)}
              </option>
            ))}
          </select>
        </label>
      </Toolbar>
      {selected.length > MAX_PRACTICES_NAMESPACES && (
        <p className="sec-note sec-note--warning" role="status">
          {t("practices:firstNamespaces", { count: MAX_PRACTICES_NAMESPACES })}
        </p>
      )}
      {excluded.length > 0 && <p className="sec-note">{t("practices:excluded", { namespaces: formatList(excluded) })}</p>}
      {failed.map(({ kind, watch }) => (
        <ErrorState key={kind.kind} className="sec-error" title={t("practices:watchFailed", { kind: kind.kind })} error={watch.error!} />
      ))}
      {skipped.map((kind) => (
        <p key={kind.kind} className="sec-note sec-note--warning">
          {t("practices:skipped", { kind: kind.kind })}
        </p>
      ))}
      {total > MAX_RENDERED_WORKLOADS && (
        <p className="sec-note sec-note--warning" role="status">
          {t("practices:truncated", { count: MAX_RENDERED_WORKLOADS })}
        </p>
      )}
      {loading && total === 0 ? (
        <LoadingIndicator className="sec-loading" text={t("practices:loading")} />
      ) : (
        groups.map((g) => {
          const take = g.rows.slice(0, Math.max(0, budget));
          budget -= take.length;
          return (
            <section key={g.namespace} className="sec-ns" aria-label={g.namespace}>
              <h3 className="sec-ns__heading">
                <span className="sec-ns__name">{g.namespace}</span>
                <SeverityCounts findings={g.all} />
              </h3>
              {take.length === 0 ? (
                <p className="sec-note">{filtered && g.all.length > 0 ? t("practices:emptyFiltered") : t("practices:empty")}</p>
              ) : (
                <ul className="sec-rows">
                  {take.map((row) => (
                    <WorkloadRow key={row.workload.uid} row={row} />
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

function WorkloadRow({ row }: { row: Row }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const openDetails = useAppStore((s) => s.openDetails);
  const { workload: w } = row;
  return (
    <li className="sec-row">
      <div className="sec-row__head">
        <Button
          size="compact"
          icon={open ? "chevronDown" : "chevronRight"}
          iconOnly
          label={open ? t("practices:row.collapse", { name: w.name }) : t("practices:row.expand", { name: w.name })}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        />
        <button
          type="button"
          className="rt-link sec-row__object"
          aria-label={t("resources:table.openObject", { kind: w.kind, name: w.name })}
          onClick={() => openDetails({ kind: KIND_REFS[w.kind], namespace: w.namespace, name: w.name })}
        >
          {`${w.kind}: ${w.name}`}
        </button>
        <SeverityCounts findings={row.shown} />
      </div>
      {open && <FindingList findings={row.shown} />}
    </li>
  );
}
