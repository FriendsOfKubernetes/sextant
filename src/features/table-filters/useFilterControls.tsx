import type { TFunction } from "i18next";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import type { TableFilters } from "../../api/generated/TableFilters";
import { Button, Icon } from "../../components";
import type { PopupRect } from "../../components/placePopup";
import type { CellContext, ColumnDef } from "../../resources/registry";
import { AdvancedEditor } from "./AdvancedEditor";
import { ColumnEditor } from "./ColumnEditor";
import { FILTER_TOGGLE_ATTRIBUTE, FilterPopup } from "./FilterPopup";
import { formatList } from "../../i18n/format";
import { columnLabel, conditionLabel, expressionLabel, selectionLabel } from "./labels";
import { columnFilterCount, compileTableFilters, EMPTY_TABLE_FILTERS, withColumnFilter, withoutColumnFilter } from "./model";
import { readTableFilters, TableFilterLimitError } from "./validation";
import "./filters.css";

type Popup = { anchor: PopupRect; column: string | null };
type CompiledFilters = ReturnType<typeof compileTableFilters>;
type Undo = { before: TableFilters; after: string; column: string };
interface FilterSource { objects: ReadonlyMap<string, KubeObject>; context: CellContext; revision: number; accept: (obj: KubeObject) => boolean }
interface PopupActions {
  close: () => void; clearColumn: (id: string) => void; openColumn: (id: string, anchor: PopupRect) => void;
  openAdvanced: () => void; commit: (filters: TableFilters) => boolean;
}
const NO_FILTERS = compileTableFilters(EMPTY_TABLE_FILTERS, []);
const NO_COLUMN_FILTER = { values: null, condition: null };

function filterChip({ key, text, edit, remove, paused = false, t }: {
  key: string; text: string; edit: (anchor: PopupRect) => void; remove: () => void; paused?: boolean; t: TFunction;
}) {
  return <span key={key} className={`tf-chip${paused ? " tf-chip--paused" : ""}`}>
    <button type="button" className="tf-chip-label" title={text} onClick={(e) => edit(e.currentTarget.getBoundingClientRect())}>{text}</button>
    <button type="button" className="tf-chip-remove" aria-label={t("filters:remove", { condition: text })} onClick={remove}><Icon name="close" size={12} /></button>
  </span>;
}

function filterChips({ filters, columns, compiled, notReady, openColumn, openAdvanced, commit, t }: {
  filters: TableFilters; columns: readonly ColumnDef[]; compiled: CompiledFilters; notReady: readonly string[]; t: TFunction;
  openColumn: (column: string, anchor: PopupRect) => void; openAdvanced: () => void; commit: (filters: TableFilters) => boolean;
}): ReactNode[] {
  const chips: ReactNode[] = [];
  for (const [id, filter] of Object.entries(filters.columns)) {
    const column = columns.find((column) => column.id === id) ?? { id, value: () => undefined };
    const paused = compiled.unavailableColumns.includes(id) || notReady.includes(id);
    if (filter.values) chips.push(filterChip({ key: `${id}:values`, text: selectionLabel(filter.values.mode, filter.values.values, column, t),
      edit: (anchor) => openColumn(id, anchor), remove: () => commit(withColumnFilter(filters, id, { ...filter, values: null })), paused, t }));
    if (filter.condition) chips.push(filterChip({ key: `${id}:condition`, text: conditionLabel(filter.condition, column, t),
      edit: (anchor) => openColumn(id, anchor), remove: () => commit(withColumnFilter(filters, id, { ...filter, condition: null })), paused, t }));
  }
  if (filters.advanced) chips.push(filterChip({ key: "advanced", text: t("filters:advancedSummary", { expression: expressionLabel(filters.advanced, columns, t) }),
    edit: openAdvanced, remove: () => commit({ ...filters, advanced: null }),
    paused: compiled.advancedUnavailable || advancedWaits(filters.advanced, notReady), t }));
  return chips;
}

function advancedWaits(expression: TableFilters["advanced"], notReady: readonly string[]): boolean {
  if (!expression) return false;
  if (expression.type === "rule") return notReady.includes(expression.column);
  return expression.children.some((child) => advancedWaits(child, notReady));
}

function filterBar({ chips, compiled, notReady, error, validation, undo, commit, filters, t }: {
  chips: ReactNode[]; compiled: CompiledFilters; notReady: readonly string[]; error: boolean; validation: boolean; undo: Undo | null;
  commit: (filters: TableFilters) => boolean; filters: TableFilters; t: TFunction;
}): ReactNode {
  if (!chips.length && !error && !validation && !undo) return null;
  return <div className="tf-bar">
    {chips}
    {compiled.unavailableColumns.length > 0 && <span className="tf-hint" role="status">{t("filters:unavailableColumn")}</span>}
    {notReady.length > 0 && <span className="tf-hint" role="status">{t("filters:notReady", { columns: formatList(notReady) })}</span>}
    {compiled.advancedUnavailable && <span className="tf-hint" role="status">{t("filters:advancedSuspended")}</span>}
    {error && <span className="tf-error" role="alert">{t("filters:saveFailed")} <button type="button" className="tf-link" onClick={() => commit(filters)}>{t("filters:retry")}</button></span>}
    {validation && <span className="tf-error" role="alert">{t("filters:limitReached")}</span>}
    {undo && <span className="tf-undo" role="status">{t("filters:clearedColumn", { column: undo.column })}
      <button type="button" className="tf-link" onClick={() => commit(undo.before)}>{t("filters:undo")}</button></span>}
  </div>;
}

function advancedColumnCounts(expression: TableFilters["advanced"], into = new Map<string, number>()): Map<string, number> {
  if (expression?.type === "rule") into.set(expression.column, (into.get(expression.column) ?? 0) + 1);
  else if (expression) for (const child of expression.children) advancedColumnCounts(child, into);
  return into;
}

function ColumnManager({ filters, columns, anchor, openColumn, openAdvanced, onClose, onClearAll, canClear }: {
  filters: TableFilters; columns: readonly ColumnDef[]; anchor: PopupRect; openColumn: (column: string, anchor: PopupRect) => void;
  openAdvanced: () => void; onClose: () => void; onClearAll: () => void; canClear: boolean;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const matchedColumns = useMemo(() => {
    const advancedCounts = advancedColumnCounts(filters.advanced);
    return columns.map((column) => ({ column, count: columnFilterCount(filters.columns[column.id]) + (advancedCounts.get(column.id) ?? 0) }))
      .filter(({ column }) => columnLabel(column, t).toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => Number(b.count > 0) - Number(a.count > 0));
  }, [columns, filters, query, t]);
  return <>
    <header className="tf-popup-heading"><strong>{t("filters:title")}</strong><Button iconOnly icon="close" label={t("filters:close")} size="compact" onClick={onClose} /></header>
    <div className="tf-manager-body"><input className="tf-control" data-autofocus type="search" aria-label={t("filters:columnSearch")} placeholder={t("filters:columnSearch")}
      value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="tf-column-list">{matchedColumns.map(({ column, count }) => <button key={column.id} type="button" className="tf-column-choice"
        onClick={() => openColumn(column.id, anchor)}><span>{columnLabel(column, t)}</span>{count > 0 && <span className="tf-count">{count}</span>}<Icon name="chevronRight" size={12} /></button>)}
        {!matchedColumns.length && <p className="tf-hint">{t("filters:noColumns")}</p>}</div>
    </div><footer className="tf-manager-footer"><Button onClick={openAdvanced}>{t("filters:advanced")}</Button>
      <Button disabled={!canClear} onClick={onClearAll}>{t("filters:clearAll")}</Button></footer>
  </>;
}

function FilterToggle({ popup, activeCount, onChange, toggleRef }: {
  popup: Popup | null; activeCount: number; onChange: (popup: Popup | null) => void; toggleRef: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useTranslation();
  return <Button ref={toggleRef} icon="filter" className={activeCount ? "tf-button--active" : undefined} {...{ [FILTER_TOGGLE_ATTRIBUTE]: "" }}
    aria-haspopup="dialog" aria-expanded={!!popup} onClick={(e) => onChange(popup ? null : { column: null, anchor: e.currentTarget.getBoundingClientRect() })}>
    {t("filters:title")}{activeCount > 0 && <span className="tf-count">{activeCount}</span>}
  </Button>;
}

function ColumnPopup({ column, columnId, filters, source, actions }: {
  column: ColumnDef | undefined; columnId: string; filters: TableFilters; source: FilterSource; actions: PopupActions;
}) {
  const { t } = useTranslation();
  if (!column) return <div className="tf-tab-body"><p>{t("filters:unavailableColumn")}</p><Button onClick={() => actions.clearColumn(columnId)}>{t("filters:clearColumn")}</Button></div>;
  return <ColumnEditor column={column} filter={filters.columns[column.id] ?? NO_COLUMN_FILTER}
    {...source} onClose={actions.close} onClear={() => actions.clearColumn(column.id)}
    onChange={(filter) => actions.commit(withColumnFilter(filters, column.id, filter))} />;
}

function FilterOverlays({ popup, advanced, filters, columns, source, actions, inspect, closeAdvanced, applyAdvanced, canClear }: {
  popup: Popup | null; advanced: boolean; filters: TableFilters; columns: readonly ColumnDef[]; source: FilterSource; actions: PopupActions;
  inspect: (ids: readonly string[]) => void; closeAdvanced: () => void; applyAdvanced: (expression: TableFilters["advanced"]) => void;
  canClear: boolean;
}) {
  const { t } = useTranslation();
  const chosen = popup?.column ? columns.find((column) => column.id === popup.column) : undefined;
  return <>
    {popup && <FilterPopup key={popup.column ?? "manager"} anchor={popup.anchor}
      title={chosen ? t("filters:editColumn", { column: columnLabel(chosen, t) }) : t("filters:title")} onClose={actions.close}>
      {popup.column ? <ColumnPopup column={chosen} columnId={popup.column} filters={filters} source={source} actions={actions} />
        : <ColumnManager filters={filters} columns={columns} anchor={popup.anchor} openColumn={actions.openColumn} openAdvanced={actions.openAdvanced}
          onClose={actions.close} canClear={canClear} onClearAll={() => { actions.commit(EMPTY_TABLE_FILTERS); actions.close(); }} />}
    </FilterPopup>}
    {advanced && <AdvancedEditor filters={filters} columns={columns} {...source} onInspect={inspect} onClose={closeAdvanced} onApply={applyAdvanced} />}
  </>;
}

function useFilterEditors() {
  const [popup, setPopup] = useState<Popup | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [inspected, setInspected] = useState("");
  const inspect = useCallback((ids: readonly string[]) => setInspected([...new Set(ids)].sort().join("\0")), []);
  return { popup, setPopup, advanced, setAdvanced, inspected, inspect };
}

function useFilterChanges(filters: TableFilters, onChange: (filters: TableFilters) => void | Promise<void>) {
  const [validation, setValidation] = useState(false);
  const commitSequence = useRef(0);
  const [undo, setUndo] = useState<Undo | null>(null);
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
  return { validation, setValidation, undo, setUndo, commit };
}

export function useFilterControls({ enabled, filters, error, onChange, columns, objects, context, accept, revision }: {
  enabled: boolean; filters: TableFilters; error: boolean; onChange: (filters: TableFilters) => void | Promise<void>;
  columns: readonly ColumnDef[]; objects: ReadonlyMap<string, KubeObject>; context: CellContext;
  accept: (obj: KubeObject) => boolean; revision: number;
}) {
  const { t } = useTranslation();
  const { popup, setPopup, advanced, setAdvanced, inspected, inspect } = useFilterEditors();
  const { validation, setValidation, undo, setUndo, commit } = useFilterChanges(filters, onChange);
  const compiled = useMemo(() => enabled ? compileTableFilters(filters, columns) : NO_FILTERS, [enabled, filters, columns]);
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
    return <button type="button" className={`tf-header-filter icon-btn icon-btn--small${active ? " tf-header-filter--active" : ""}`}
      aria-label={t("filters:editColumn", { column: columnLabel(column, t) })}
      title={t("filters:headerHint", { column: columnLabel(column, t) })} aria-haspopup="dialog"
      onClick={(e) => openColumn(column.id, e.currentTarget.getBoundingClientRect())}
      onContextMenu={(e) => { if (active) { e.preventDefault(); clearColumn(column.id); } }}>
      <Icon name="filter" size={12} />
    </button>;
  };
  // A chip, Undo or Retry that is pressed goes away with the change: the focus moves to the "Filters" button.
  const toggleRef = useRef<HTMLButtonElement>(null);
  const commitFromBar = (next: TableFilters): boolean => {
    const done = commit(next);
    setTimeout(() => toggleRef.current?.focus({ preventScroll: true }), 0);
    return done;
  };
  const notReadyIds = enabled ? compiled.notReadyColumns(context) : [];
  const notReady = notReadyIds.map((id) => columnLabel(columns.find((c) => c.id === id) ?? { id, value: () => undefined }, t));
  const chips = enabled ? filterChips({ filters, columns, compiled, notReady: notReadyIds, openColumn, openAdvanced, commit: commitFromBar, t }) : [];
  const applyAdvanced = (expression: TableFilters["advanced"]) => { if (commit({ ...filters, advanced: expression })) setAdvanced(false); };
  return {
    compiled,
    inspectedColumns: advanced ? inspected : popup?.column ?? "",
    headerButton,
    button: enabled ? <FilterToggle popup={popup} activeCount={compiled.activeCount} onChange={setPopup} toggleRef={toggleRef} /> : null,
    bar: enabled ? filterBar({ chips, compiled, notReady, error, validation, undo, commit: commitFromBar, filters, t }) : null,
    overlays: enabled ? <FilterOverlays popup={popup} advanced={advanced} filters={filters} columns={columns}
      source={{ objects, context, accept, revision }} actions={{ close: () => setPopup(null), clearColumn, openColumn, openAdvanced, commit }}
      inspect={inspect} closeAdvanced={() => setAdvanced(false)} applyAdvanced={applyAdvanced} canClear={compiled.activeCount > 0} /> : null,
  };
}
