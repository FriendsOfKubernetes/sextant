// The "Traffic" mode of the map page (#211): who calls whom with an end in the namespaces of the filter (at most
// `MAX_TRAFFIC_NAMESPACES`), from the edge metrics of Istio, Linkerd, Grafana Beyla or Cilium Hubble in Prometheus —
// lines as thick as their rate and coloured by their error rate, filters by namespace, protocol and status, a window
// of 5 minutes or an hour, and a list of the same calls. Read-only; polled only while shown and the window is visible.
import type { MouseEvent } from "react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, TrafficEdge, TrafficGraph, TrafficWindow } from "../../../api";
import { ErrorState, LoadingIndicator, Radio, Tabs } from "../../../components";
import { formatNumber } from "../../../i18n";
import { openClusterSettings } from "../../clusters/clustersStore";
import { SelectionPanel, type Selection } from "./EdgePanel";
import { missingDetails, sourceNames } from "./format";
import { useTrafficGraph } from "./hooks";
import {
  edgeId,
  ERROR_LEVELS,
  layoutTraffic,
  matchesFilters,
  NO_FILTERS,
  PROTOCOL_FILTERS,
  STATUS_FILTERS,
  type ProtocolFilter,
  type StatusFilter,
  type TrafficFilters,
} from "./model";
import { TrafficGraphView } from "./TrafficGraphView";
import { TrafficList } from "./TrafficList";
import "./traffic.css";

/** Namespaces one traffic graph covers (`MAX_TRAFFIC_NAMESPACES` in the core). */
export const MAX_TRAFFIC_NAMESPACES = 5;
const WINDOWS: readonly TrafficWindow[] = ["minutes5", "hour1"];

type View = "graph" | "list";
const VIEWS: readonly View[] = ["graph", "list"];

/** No graph: why, and what would provide one. */
function Missing({ clusterId, graph }: { clusterId: ClusterId; graph: TrafficGraph }) {
  const { t } = useTranslation();
  const open = (e: MouseEvent) => {
    e.stopPropagation();
    openClusterSettings(clusterId);
  };
  if (!graph.prometheus && graph.sources.length === 0)
    return (
      <div className="traffic-missing" role="status">
        <p>
          {t("traffic:noPrometheus")}{" "}
          <button type="button" className="mx-link" onClick={open}>
            {t("traffic:openSettings")}
          </button>
        </p>
        <p className="traffic-note">{t("traffic:wouldProvide")}</p>
      </div>
    );
  if (graph.sources.length === 0)
    return (
      <div className="traffic-missing" role="status">
        <p>{t("traffic:noSource")}</p>
        {graph.requestOnly.length > 0 && (
          <p>{t("traffic:requestOnly", { sources: sourceNames(t, graph.requestOnly) })}</p>
        )}
        <p className="traffic-note">{t("traffic:wouldProvide")}</p>
      </div>
    );
  const answered = graph.sources.map((s) => s.kind).filter((k) => !graph.failed.includes(k));
  if (answered.length === 0) return null;
  return (
    <p className="traffic-note" role="status">
      {t(`traffic:noEdges.${graph.window}`, { sources: sourceNames(t, answered) })}
    </p>
  );
}

/** Sources whose edges could not be read (and why, when a proxy refused the query as too long), and details some
 * edges lack because their own queries failed. */
function Failures({ graph }: { graph: TrafficGraph }) {
  const { t } = useTranslation();
  const tooLong = graph.queryTooLong;
  const other = graph.failed.filter((k) => !tooLong.includes(k));
  const partial = missingDetails(t, graph.edges);
  return (
    <>
      {tooLong.length > 0 && (
        <p className="traffic-note" role="status">
          {t("traffic:tooLong", { sources: sourceNames(t, tooLong) })}
        </p>
      )}
      {other.length > 0 && (
        <p className="traffic-note" role="status">
          {t("traffic:failed", { sources: sourceNames(t, other) })}
        </p>
      )}
      {partial && (
        <p className="traffic-note" role="status">
          {t("traffic:partial", partial)}
        </p>
      )}
    </>
  );
}

function Legend() {
  const { t } = useTranslation();
  return (
    <div className="rmap-legend" aria-label={t("traffic:legend")}>
      {ERROR_LEVELS.map((level) => (
        <span key={level} className="rmap-legend__item">
          <span className={`traffic-swatch traffic-swatch--${level}`} aria-hidden="true" />
          {t(`traffic:level.${level}`)}
        </span>
      ))}
      <span className="rmap-legend__item">{t("traffic:thickness")}</span>
    </div>
  );
}

function Filters({
  namespaces,
  filters,
  onChange,
}: {
  namespaces: readonly string[];
  filters: TrafficFilters;
  onChange: (filters: TrafficFilters) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="traffic-filters">
      {namespaces.length > 1 && (
        <label className="traffic-choice">
          {t("traffic:filter.namespace")}
          <select
            value={filters.namespace ?? ""}
            onChange={(e) => onChange({ ...filters, namespace: e.target.value || null })}
          >
            <option value="">{t("traffic:filter.allNamespaces")}</option>
            {namespaces.map((ns) => (
              <option key={ns} value={ns}>
                {ns}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="traffic-choice">
        {t("traffic:filter.protocol")}
        <select
          value={filters.protocol}
          onChange={(e) => onChange({ ...filters, protocol: e.target.value as ProtocolFilter })}
        >
          {PROTOCOL_FILTERS.map((p) => (
            <option key={p} value={p}>
              {t(`traffic:protocolFilter.${p}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="traffic-choice">
        {t("traffic:filter.status")}
        <select value={filters.status} onChange={(e) => onChange({ ...filters, status: e.target.value as StatusFilter })}>
          {STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>
              {t(`traffic:statusFilter.${s}`)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** What is selected, by id, so a refresh keeps it while it is still there. */
type Picked = { type: "link" | "node"; id: string } | null;

/** The window and the view chosen on each cluster's traffic graph, kept while the window lives. */
const chosen = new Map<ClusterId, { window: TrafficWindow; view: View }>();

/** Forgets the choices (tests). */
export function resetTrafficChoices(): void {
  chosen.clear();
}

export function TrafficView({ clusterId, namespaces }: { clusterId: ClusterId; namespaces: string[] }) {
  const { t } = useTranslation();
  const [choice, setChoiceState] = useState(() => chosen.get(clusterId) ?? { window: "minutes5" as TrafficWindow, view: "graph" as View });
  const setChoice = (next: Partial<typeof choice>) => {
    const merged = { ...choice, ...next };
    chosen.set(clusterId, merged);
    setChoiceState(merged);
  };
  const [filters, setFilters] = useState<TrafficFilters>(NO_FILTERS);
  const [picked, setPicked] = useState<Picked>(null);
  const graph = useTrafficGraph(clusterId, namespaces, choice.window);
  const data = graph.data;
  const shown: TrafficEdge[] = useMemo(
    () => (data ? data.edges.filter((e) => matchesFilters(e, filters)) : []),
    [data, filters],
  );
  const layout = useMemo(() => layoutTraffic(shown), [shown]);

  let selection: Selection | null = null;
  if (picked?.type === "link") {
    const link = layout.links.find((l) => l.id === picked.id);
    if (link) selection = { type: "link", link };
  } else if (picked?.type === "node") {
    const node = layout.nodes.find((n) => n.id === picked.id);
    if (node) selection = { type: "node", node, links: layout.links };
  }
  const pick = (next: Selection) =>
    setPicked(next.type === "link" ? { type: "link", id: next.link.id } : { type: "node", id: next.node.id });
  const selectEdge = (edge: TrafficEdge) => {
    const link = layout.links.find((l) => l.edges.some((e) => edgeId(e) === edgeId(edge)));
    if (link) setPicked({ type: "link", id: link.id });
  };

  let body;
  if (graph.error) body = <ErrorState error={graph.error} />;
  else if (!data) body = <LoadingIndicator text={t("traffic:loading")} />;
  else if (data.edges.length === 0) body = <Missing clusterId={clusterId} graph={data} />;
  else
    body = (
      <>
        {data.totalEdges > data.edges.length && (
          <p className="traffic-note" role="status">
            {t("traffic:truncated", { count: data.totalEdges, shown: formatNumber(data.edges.length, 0) })}
          </p>
        )}
        <Filters namespaces={data.namespaces} filters={filters} onChange={setFilters} />
        {shown.length === 0 ? (
          <p className="traffic-note" role="status">
            {t("traffic:filteredOut")}
          </p>
        ) : (
          <Tabs
            label={t("traffic:view.label")}
            tabs={VIEWS.map((id) => ({ id, label: t(`traffic:view.${id}`) }))}
            selected={choice.view}
            onSelect={(view) => setChoice({ view })}
          >
            <div className="traffic-body">
              <div className="traffic-main">
                {choice.view === "graph" ? (
                  <>
                    <Legend />
                    <TrafficGraphView
                      layout={layout}
                      selectedId={picked?.id ?? null}
                      onLink={(link) => setPicked({ type: "link", id: link.id })}
                      onNode={(node) => setPicked({ type: "node", id: node.id })}
                    />
                  </>
                ) : (
                  <TrafficList
                    edges={shown}
                    selectedEdge={selection?.type === "link" ? edgeId(selection.link.edges[0]!) : null}
                    onEdge={selectEdge}
                  />
                )}
              </div>
              {selection && (
                <SelectionPanel
                  clusterId={clusterId}
                  selection={selection}
                  onSelect={pick}
                  onClose={() => setPicked(null)}
                />
              )}
            </div>
          </Tabs>
        )}
      </>
    );

  return (
    <div className="traffic">
      <p className="traffic-note">{t("traffic:about")}</p>
      <div className="traffic-controls">
        <div className="traffic-windows" role="radiogroup" aria-label={t("traffic:window.label")}>
          {WINDOWS.map((w) => (
            <label key={w} className="traffic-choice">
              <Radio
                name={`traffic-window-${clusterId}`}
                checked={choice.window === w}
                onChange={() => setChoice({ window: w })}
              />
              {t(`traffic:window.${w}`)}
            </label>
          ))}
        </div>
      </div>
      {data && <Failures graph={data} />}
      {body}
    </div>
  );
}
