// The "Right-sizing" page (#137) in the Workloads section: per workload and container, requests and limits against
// the usage of the last day or week, a recommendation and findings, grouped by namespace with the namespace's totals
// and sorted by waste. Bounded by the namespace filter: with "All namespaces" the page asks for a choice, and pods are
// watched, and history is asked for, only in the first `MAX_RIGHTSIZING_NAMESPACES` chosen namespaces and only while
// the page is open. Read-only: the snippet goes to the clipboard.
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { HistoryScope, HistoryWindow, WatchSpec } from "../../api";
import { useWatch } from "../../api";
import { Badge, Checkbox, EmptyState, ErrorState, LoadingIndicator } from "../../components";
import type { PageProps } from "../../layout/pages";
import { formatBytes, formatCpu } from "../metrics/format";
import { NamespaceFilter, useSelectedNamespaces } from "../namespaces";
import { hasFindings, isRiskRow, RowsTable, SourceNote } from "./components";
import { buildRows, groupByNamespace, type SortBy } from "./group";
import { useRightsizingSource } from "./hooks";
import "./rightsizing.css";

export const RIGHTSIZING_PAGE_ID = "rightsizing";
/** At most this many namespaces of the filter are looked at. */
export const MAX_RIGHTSIZING_NAMESPACES = 10;
/** At most this many rows are drawn. */
export const MAX_RENDERED_ROWS = 1000;

const POD = { group: "", version: "v1", kind: "Pod" };
const WINDOWS: HistoryWindow[] = ["day", "week"];
const SORTS: SortBy[] = ["cpuWaste", "memoryWaste", "name"];

export function RightsizingPage({ clusterId }: PageProps) {
  const { t } = useTranslation();
  const selected = useSelectedNamespaces(clusterId);
  return (
    <div className="rs-page">
      <h2 className="rs-page__title">{t("rightsizing:title")}</h2>
      <p className="rs-note">{t("rightsizing:intro")}</p>
      {selected === undefined ? (
        <LoadingIndicator className="rs-loading" text={t("rightsizing:loading")} />
      ) : selected === null || selected.length === 0 ? (
        <>
          <div className="rs-toolbar">
            <NamespaceFilter clusterId={clusterId} />
          </div>
          <EmptyState title={t("rightsizing:chooseNamespace")} text={t("rightsizing:chooseNamespaceText")} />
        </>
      ) : (
        <RightsizingView clusterId={clusterId} selected={selected} />
      )}
    </div>
  );
}

function RightsizingView({ clusterId, selected }: PageProps & { selected: string[] }) {
  const { t } = useTranslation();
  const nsKey = selected.slice(0, MAX_RIGHTSIZING_NAMESPACES).join("\u0000");
  // `nsKey` stands for the first namespaces by value.
  const namespaces = useMemo(() => nsKey.split("\u0000"), [nsKey]);
  const [window, setWindow] = useState<HistoryWindow>("week");
  const [sortBy, setSortBy] = useState<SortBy>("cpuWaste");
  const [onlyFlagged, setOnlyFlagged] = useState(false);

  const spec: WatchSpec = { kind: POD, namespaces, labelSelector: null, fieldSelector: null };
  const pods = useWatch(clusterId, spec);
  const scope: HistoryScope = { type: "namespaces", namespaces };
  const source = useRightsizingSource(clusterId, scope, window);

  const rows = useMemo(
    () => (pods.status === "ready" ? buildRows(pods.items.values(), source.data, Date.now()) : []),
    [pods, source.data],
  );
  const shown = onlyFlagged ? rows.filter(hasFindings) : rows;
  const groups = groupByNamespace(shown, sortBy, isRiskRow);
  let budget = MAX_RENDERED_ROWS;
  const visible = groups.map((g) => {
    const take = g.rows.slice(0, Math.max(0, budget));
    budget -= take.length;
    return { ...g, rows: take };
  });

  return (
    <>
      <div className="rs-toolbar">
        <NamespaceFilter clusterId={clusterId} />
        {source.mode === "history" && (
          <label className="rs-choice">
            {t("rightsizing:window.label")}
            <select className="rs-select" value={window} onChange={(e) => setWindow(e.target.value as HistoryWindow)}>
              {WINDOWS.map((w) => (
                <option key={w} value={w}>
                  {t(`rightsizing:window.${w}`)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="rs-choice">
          {t("rightsizing:sort.label")}
          <select className="rs-select" value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}>
            {SORTS.map((s) => (
              <option key={s} value={s}>
                {t(`rightsizing:sort.${s}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="rs-choice">
          <Checkbox checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} />
          {t("rightsizing:onlyFlagged")}
        </label>
      </div>
      {selected.length > MAX_RIGHTSIZING_NAMESPACES && (
        <p className="rs-note rs-note--warning" role="status">
          {t("rightsizing:firstNamespaces", { count: MAX_RIGHTSIZING_NAMESPACES })}
        </p>
      )}
      <SourceNote source={source} window={window} />

      {pods.status === "error" && pods.error && (
        <ErrorState className="rs-error" title={t("rightsizing:podsFailed")} error={pods.error} />
      )}
      {pods.status === "loading" ? (
        <LoadingIndicator className="rs-loading" text={t("rightsizing:loading")} />
      ) : groups.length === 0 ? (
        pods.status === "ready" && <p className="rs-note">{onlyFlagged ? t("rightsizing:emptyFiltered") : t("rightsizing:empty")}</p>
      ) : (
        visible
          .filter((g) => g.rows.length > 0)
          .map((g) => (
            <section key={g.namespace} className="rs-ns" aria-label={g.namespace}>
              <h3 className="rs-ns__heading">
                <span className="rs-ns__name">{g.namespace}</span>
                <span className="rs-ns__totals">
                  {t("rightsizing:totals", {
                    cpu: formatCpu(g.waste.cpu),
                    memory: formatBytes(g.waste.memory),
                    requestedCpu: formatCpu(g.requested.cpu),
                    requestedMemory: formatBytes(g.requested.memory),
                  })}
                </span>
                {g.atRisk > 0 && <Badge tone="danger">{t("rightsizing:atRisk", { count: g.atRisk })}</Badge>}
              </h3>
              <RowsTable rows={g.rows} window={window} showWorkload />
            </section>
          ))
      )}
      {shown.length > MAX_RENDERED_ROWS && (
        <p className="rs-note rs-note--warning">{t("rightsizing:tooMany", { count: MAX_RENDERED_ROWS })}</p>
      )}
    </>
  );
}
