import { useId, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ForwardInfo } from "../../api";
import { Badge, Button, Checkbox, EmptyState, ErrorState } from "../../components";
import { ResizableTable } from "../../components/Table";
import { formatNumber } from "../../i18n/format";
import type { PageProps } from "../../layout/pages";
import { ForwardButtons, useForwardControls } from "./ForwardButtons";
import { useBulkStop } from "./useBulkStop";
import { isInternal } from "./model";
import { useForwardRetry } from "./useForwardRetry";
import "./portforward.css";

const STATES = [
  { value: "all", label: "portforward:allStates" },
  { value: "active", label: "portforward:status.active" },
  { value: "error", label: "portforward:status.error" },
];

export function PortForwardPage({ clusterId }: PageProps) {
  // Cluster changes discard search and selection without affecting any running connection.
  return <ClusterForwards key={clusterId} clusterId={clusterId} />;
}

function ClusterForwards({ clusterId }: PageProps) {
  const { t } = useTranslation();
  const statusId = useId();
  const { forwards, loaded, error, pending, requestStop, actionError, confirmation } = useForwardControls();
  const { retry, retryDialog } = useForwardRetry();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const bulk = useBulkStop();
  const mine = useMemo(() => forwards.filter(f => f.cluster === clusterId), [forwards, clusterId]);
  const query = search.trim().toLocaleLowerCase();
  const sourceLabel = (f: ForwardInfo) => t(`portforward:source.${f.source}`);
  const shown = mine.filter(f => (status === "all" || f.status.state === status) && matchesSearch(f, query, sourceLabel));
  const selection = useForwardSelection(shown);
  const { chosen, clear } = selection;
  const stopDisabled = bulk.busy || chosen.some(f => pending.has(f.id));
  const filtered = !!search || status !== "all";
  const reset = () => { setSearch(""); setStatus("all"); };

  return <div className="pf-page">
    <header className="pf-page__header"><h2>{t("portforward:title")}</h2><Badge>{formatNumber(mine.length)}</Badge></header>
    <div className="pf-toolbar">
      <input className="main__search pf-search" type="search" aria-label={t("portforward:searchLabel")} placeholder={t("portforward:search")} value={search} onChange={e => setSearch(e.target.value)} />
      <label className="visually-hidden" htmlFor={statusId}>{t("portforward:statusFilter")}</label>
      <select id={statusId} value={status} onChange={e => setStatus(e.target.value)}>
        {STATES.map(({ value, label }) => <option key={value} value={value}>{t(label)}</option>)}
      </select>
      {filtered && <Button size="compact" onClick={reset}>{t("portforward:clearFilters")}</Button>}
      <span className="pf-counts" role="status">
        <span>{t("portforward:counts.active", { value: formatNumber(mine.filter(f => f.status.state === "active").length) })}</span>
        <span className="pf-error-text">{t("portforward:counts.error", { value: formatNumber(mine.filter(f => f.status.state === "error").length) })}</span>
      </span>
    </div>
    {chosen.length > 0 && <div className="pf-selection">
      <span>{t("portforward:selection", { value: formatNumber(chosen.length) })}</span>
      <Button size="compact" disabled={stopDisabled} onClick={() => bulk.ask(chosen)}>{t("portforward:actions.stopSelected")}</Button>
      <Button size="compact" onClick={clear}>{t("portforward:actions.clearSelection")}</Button>
    </div>}
    {error && <ErrorState error={error} />}{actionError && <ErrorState error={actionError} />}{confirmation}{bulk.error && <ErrorState error={bulk.error} />}
    <ForwardResults loaded={loaded} failed={!!error} total={mine.length} count={shown.length}>
      <ForwardTable shown={shown} selection={selection} pending={pending} disabled={bulk.busy} onStop={requestStop} onRetry={f => void retry(f)} />
    </ForwardResults>
    {bulk.confirmation}
    {retryDialog}
  </div>;
}

function ForwardRow({ forward: f, selected, disabled, onSelect, onStop, onRetry }: {
  forward: ForwardInfo; selected: boolean; disabled: boolean;
  onSelect: (checked: boolean) => void; onStop: () => void; onRetry: () => void;
}) {
  const { t } = useTranslation();
  return <tr data-forward={f.id} className={selected ? "pf-table__row pf-table__selected" : "pf-table__row"} aria-selected={selected}>
          <td className="pf-check"><Checkbox aria-label={t("portforward:selectForward", { target: f.target.name, port: f.localPort })} title={isInternal(f) ? t("portforward:protected") : undefined}
            checked={selected} disabled={isInternal(f) || disabled} onChange={e => onSelect(e.target.checked)} /></td>
          <td title={t(`portforward:target.${f.target.type}`, { name: f.target.name })}>{t(`portforward:target.${f.target.type}`, { name: f.target.name })}</td>
          <td title={f.target.namespace}>{f.target.namespace}</td>
          <td className="pf-route" title={t("portforward:ports", { local: f.localPort, remote: f.remotePort })}>{t("portforward:ports", { local: f.localPort, remote: f.remotePort })}</td>
          <td><Badge tone={f.status.state === "error" ? "danger" : "success"}>{t(`portforward:status.${f.status.state}`)}</Badge></td>
          <td className={isInternal(f) ? "pf-internal" : "pf-muted"} title={t(`portforward:source.${f.source}`)}>{t(`portforward:source.${f.source}`)}</td>
          <td className={f.status.state === "error" ? "pf-error-text" : "pf-muted"} title={f.status.state === "error" ? f.status.message : undefined}>{f.status.state === "error" ? f.status.message : "—"}</td>
          <td><ForwardButtons forward={f} pending={disabled} onStop={onStop} onRetry={onRetry} /></td>
        </tr>;
}

function matchesSearch(f: ForwardInfo, query: string, sourceLabel: (forward: ForwardInfo) => string): boolean {
  if (!query) return true;
  const message = f.status.state === "error" ? f.status.message : "";
  return `${f.target.type} ${f.target.name} ${f.target.namespace} ${f.localPort} ${f.remotePort} ${sourceLabel(f)} ${message}`.toLocaleLowerCase().includes(query);
}

function useForwardSelection(shown: ForwardInfo[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const eligible = shown.filter(f => !isInternal(f));
  const chosen = eligible.filter(f => selected.has(f.id));
  // Hidden, removed or protected entries cannot reappear selected after an event or filter reset.
  if (selected.size > 0) {
    const ids = new Set(eligible.map(f => f.id));
    if ([...selected].some(id => !ids.has(id))) setSelected(new Set([...selected].filter(id => ids.has(id))));
  }
  return { selected, eligible, chosen,
    clear: () => setSelected(new Set()),
    toggleAll: (checked: boolean) => setSelected(checked ? new Set(eligible.map(f => f.id)) : new Set()),
    toggle: (id: string, checked: boolean) => setSelected(prev => {
      const next = new Set(prev);
      if (checked) next.add(id); else next.delete(id);
      return next;
    }),
  };
}

function ForwardTable({ shown, selection, pending, disabled, onStop, onRetry }: {
  shown: ForwardInfo[]; selection: ReturnType<typeof useForwardSelection>; pending: ReadonlySet<string>; disabled: boolean;
  onStop: (forward: ForwardInfo) => void; onRetry: (forward: ForwardInfo) => void;
}) {
  const { t } = useTranslation();
  const { selected, eligible, chosen, toggle, toggleAll } = selection;
  return <ResizableTable tableId="portforward.manager" wrapperClassName="pf-table-scroll" className="pf-table" aria-label={t("portforward:title")}>
        <thead><tr>
          <th data-col="selection" className="pf-check"><Checkbox aria-label={t("portforward:selectAll")} disabled={eligible.length === 0 || disabled} checked={eligible.length > 0 && chosen.length === eligible.length}
            ref={node => { if (node) node.indeterminate = chosen.length > 0 && chosen.length < eligible.length; }}
            onChange={e => toggleAll(e.target.checked)} /></th>
          <th data-col="target">{t("portforward:columns.target")}</th><th data-col="namespace">{t("portforward:columns.namespace")}</th>
          <th data-col="ports">{t("portforward:columns.ports")}</th><th data-col="status">{t("portforward:columns.status")}</th>
          <th data-col="source">{t("portforward:columns.source")}</th><th data-col="details">{t("portforward:columns.details")}</th>
          <th data-col="actions" className="pf-actions-heading">{t("resources:table.actions")}</th>
        </tr></thead>
        <tbody>{shown.map(f => <ForwardRow key={f.id} forward={f} selected={selected.has(f.id)} disabled={pending.has(f.id) || disabled}
          onSelect={checked => toggle(f.id, checked)}
          onStop={() => onStop(f)} onRetry={() => onRetry(f)} />)}</tbody>
      </ResizableTable>;
}

function ForwardResults({ loaded, failed, total, count, children }: {
  loaded: boolean; failed: boolean; total: number; count: number; children: ReactNode;
}) {
  const { t } = useTranslation();
  if (!loaded && !failed) return <div className="pf-muted" role="status">{t("portforward:loading")}</div>;
  if (total === 0 && !failed) return <EmptyState title={t("portforward:empty")} text={t("portforward:emptyText")} />;
  if (count === 0 && !failed) return <EmptyState title={t("portforward:noMatches")} />;
  return children;
}
