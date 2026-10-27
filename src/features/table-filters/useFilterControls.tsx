import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import type { TableFilters } from "../../api/generated/TableFilters";
import { Button, Icon } from "../../components";
import type { PopupRect } from "../../components/placePopup";
import type { CellContext, ColumnDef } from "../../resources/registry";
import { AdvancedEditor } from "./AdvancedEditor";
import { ColumnEditor } from "./ColumnEditor";
import { FilterPopup } from "./FilterPopup";
import { columnLabel, conditionLabel, expressionLabel, selectionLabel } from "./labels";
import { columnFilterCount, compileTableFilters, EMPTY_TABLE_FILTERS, withColumnFilter, withoutColumnFilter } from "./model";
import { readTableFilters, TableFilterLimitError } from "./validation";
import "./filters.css";

type Popup = { anchor: PopupRect; column: string | null };
const NO_FILTERS = compileTableFilters(EMPTY_TABLE_FILTERS, []);
const NO_COLUMN_FILTER = { values: null, condition: null };

export function useFilterControls({ enabled, filters, error, onChange, columns, objects, context, accept, revision }: {
  enabled: boolean; filters: TableFilters; error: boolean; onChange: (filters: TableFilters) => void | Promise<void>;
  columns: readonly ColumnDef[]; objects: ReadonlyMap<string, KubeObject>; context: CellContext;
  accept: (obj: KubeObject) => boolean; revision: number;
}) {
  const { t } = useTranslation();
  const [popup, setPopup] = useState<Popup | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [query, setQuery] = useState("");
  const [inspected, setInspected] = useState("");
  const [validation, setValidation] = useState(false);
  const commitSequence = useRef(0);
  const [undo, setUndo] = useState<{ before: TableFilters; after: string; column: string } | null>(null);
  const compiled = useMemo(() => enabled ? compileTableFilters(filters, columns) : NO_FILTERS, [enabled, filters, columns]);
  const inspect = useCallback((ids: readonly string[]) => setInspected([...new Set(ids)].sort().join("\0")), []);
  useEffect(() => { if (undo && JSON.stringify(filters) !== undo.after) setUndo(null); }, [filters, undo]);
  const commit = (next: TableFilters): boolean => {
    try {
      const validated = readTableFilters(next);
      const sequence = ++commitSequence.current;
      const pending = onChange(validated);
      if (pending) void pending.catch((error: unknown) => {
        if (sequence === commitSequence.current && error instanceof TableFilterLimitError) setValidation(true);
      });
      setValidation(false); setUndo(null);
      return true;
    } catch { setValidation(true); return false; }
  };
  const openColumn = (column: string, anchor: PopupRect) => { setPopup({ column, anchor }); setValidation(false); };
  const clearColumn = (id: string) => {
    const next = withoutColumnFilter(filters, id);
    const before = filters;
    if (commit(next)) setUndo({ before, after: JSON.stringify(next), column: columnLabel(columns.find((c) => c.id === id) ?? { id, value: () => undefined }, t) });
    setPopup(null);
  };
  const openAdvanced = () => { setPopup(null); setAdvanced(true); };
  const headerButton = (column: ColumnDef): ReactNode => {
    if (!enabled) return null;
    const active = columnFilterCount(filters.columns[column.id]) > 0 || compiled.columnIds.includes(column.id);
    return <button type="button" className={`tf-header-filter icon-btn${active ? " tf-header-filter--active" : ""}`}
      aria-label={t("filters:editColumn", { column: columnLabel(column, t) })}
      title={t("filters:headerHint", { column: columnLabel(column, t) })} aria-haspopup="dialog"
      onClick={(e) => openColumn(column.id, e.currentTarget.getBoundingClientRect())}
      onContextMenu={(e) => { if (active) { e.preventDefault(); clearColumn(column.id); } }}>
      <Icon name="filter" size={12} />
    </button>;
  };
  const chip = (key: string, text: string, edit: (anchor: PopupRect) => void, remove: () => void, paused = false) => <span key={key} className={`tf-chip${paused ? " tf-chip--paused" : ""}`}>
    <button type="button" className="tf-chip-label" title={text} onClick={(e) => edit(e.currentTarget.getBoundingClientRect())}>{text}</button>
    <button type="button" className="tf-chip-remove" aria-label={t("filters:remove", { condition: text })} onClick={remove}><Icon name="close" size={12} /></button>
  </span>;
  const chips: ReactNode[] = [];
  if (enabled) for (const [id, filter] of Object.entries(filters.columns)) {
    const column = columns.find((column) => column.id === id) ?? { id, value: () => undefined };
    const paused = compiled.unavailableColumns.includes(id);
    if (filter.values) chips.push(chip(`${id}:values`, selectionLabel(filter.values.mode, filter.values.values, column, t),
      (anchor) => openColumn(id, anchor), () => commit(withColumnFilter(filters, id, { ...filter, values: null })), paused));
    if (filter.condition) chips.push(chip(`${id}:condition`, conditionLabel(filter.condition, column, t),
      (anchor) => openColumn(id, anchor), () => commit(withColumnFilter(filters, id, { ...filter, condition: null })), paused));
  }
  if (enabled && filters.advanced) chips.push(chip("advanced", t("filters:advancedSummary", { expression: expressionLabel(filters.advanced, columns, t) }),
    openAdvanced, () => commit({ ...filters, advanced: null }), compiled.advancedUnavailable));
  const chosen = popup?.column ? columns.find((column) => column.id === popup.column) : undefined;
  const matchedColumns = useMemo(() => {
    if (!popup || popup.column) return [];
    const advancedCounts = new Map<string, number>();
    const visit = (expression: TableFilters["advanced"]) => {
      if (expression?.type === "rule") advancedCounts.set(expression.column, (advancedCounts.get(expression.column) ?? 0) + 1);
      else if (expression) for (const child of expression.children) visit(child);
    };
    visit(filters.advanced);
    return columns.map((column) => ({ column, count: columnFilterCount(filters.columns[column.id]) + (advancedCounts.get(column.id) ?? 0) }))
      .filter(({ column }) => columnLabel(column, t).toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => Number(b.count > 0) - Number(a.count > 0));
  }, [popup, columns, filters, query, t]);
  return {
    compiled,
    inspectedColumns: advanced ? inspected : popup?.column ?? "",
    headerButton,
    button: enabled ? <Button icon="filter" className={compiled.activeCount ? "tf-button--active" : undefined}
      aria-haspopup="dialog" aria-expanded={!!popup} onClick={(e) => { setQuery(""); setPopup(popup ? null : { column: null, anchor: e.currentTarget.getBoundingClientRect() }); }}>
      {t("filters:title")}{compiled.activeCount > 0 && <span className="tf-count">{compiled.activeCount}</span>}
    </Button> : null,
    bar: enabled && (chips.length > 0 || error || validation || undo) ? <div className="tf-bar">
      {chips}
      {compiled.unavailableColumns.length > 0 && <span className="tf-hint" role="status">{t("filters:unavailableColumn")}</span>}
      {compiled.advancedUnavailable && <span className="tf-hint" role="status">{t("filters:advancedSuspended")}</span>}
      {error && <span className="tf-error" role="alert">{t("filters:saveFailed")} <button type="button" className="tf-link" onClick={() => commit(filters)}>{t("filters:retry")}</button></span>}
      {validation && <span className="tf-error" role="alert">{t("filters:limitReached")}</span>}
      {undo && <span className="tf-undo" role="status">{t("filters:clearedColumn", { column: undo.column })}
        <button type="button" className="tf-link" onClick={() => commit(undo.before)}>{t("filters:undo")}</button></span>}
    </div> : null,
    overlays: enabled ? <>
      {popup && <FilterPopup key={popup.column ?? "manager"} anchor={popup.anchor}
        title={chosen ? t("filters:editColumn", { column: columnLabel(chosen, t) }) : t("filters:title")} onClose={() => setPopup(null)}>
        {popup.column ? chosen ? <ColumnEditor column={chosen} filter={filters.columns[chosen.id] ?? NO_COLUMN_FILTER}
          objects={objects} context={context} revision={revision} accept={accept} onClose={() => setPopup(null)}
          onClear={() => clearColumn(chosen.id)} onChange={(filter) => commit(withColumnFilter(filters, chosen.id, filter))} />
          : <div className="tf-tab-body"><p>{t("filters:unavailableColumn")}</p><Button onClick={() => clearColumn(popup.column!)}>{t("filters:clearColumn")}</Button></div>
          : <>
            <header className="tf-popup-heading"><strong>{t("filters:title")}</strong><Button iconOnly icon="close" label={t("filters:close")} size="compact" onClick={() => setPopup(null)} /></header>
            <div className="tf-manager-body"><input className="tf-control" data-autofocus type="search" aria-label={t("filters:columnSearch")} placeholder={t("filters:columnSearch")}
              value={query} onChange={(e) => setQuery(e.target.value)} />
              <div className="tf-column-list">{matchedColumns.map(({ column, count }) => <button key={column.id} type="button" className="tf-column-choice"
                onClick={() => openColumn(column.id, popup.anchor)}><span>{columnLabel(column, t)}</span>{count > 0 && <span className="tf-count">{count}</span>}<Icon name="chevronRight" size={12} /></button>)}
                {!matchedColumns.length && <p className="tf-hint">{t("filters:noColumns")}</p>}</div>
            </div><footer className="tf-manager-footer"><Button onClick={openAdvanced}>{t("filters:advanced")}</Button>
              <Button disabled={!compiled.activeCount} onClick={() => { commit(EMPTY_TABLE_FILTERS); setPopup(null); }}>{t("filters:clearAll")}</Button></footer>
          </>}
      </FilterPopup>}
      {advanced && <AdvancedEditor filters={filters} columns={columns} objects={objects} context={context} accept={accept} revision={revision}
        onInspect={inspect} onClose={() => setAdvanced(false)} onApply={(expression) => { if (commit({ ...filters, advanced: expression })) setAdvanced(false); }} />}
    </> : null,
  };
}
