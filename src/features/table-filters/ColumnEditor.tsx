import type { TFunction } from "i18next";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import type { ColumnFilter } from "../../api/generated/ColumnFilter";
import type { FilterValue } from "../../api/generated/FilterValue";
import { Button, Checkbox, Tabs } from "../../components";
import type { CellContext, ColumnDef } from "../../resources/registry";
import { ConditionFields, conditionDraft, draftCondition, type ConditionDraft } from "./ConditionFields";
import { buildFacetOptions, filterType, type FacetOption } from "./facets";
import { columnLabel, valueLabel } from "./labels";
import { filterValueKey, isEmptyValue, valueForSelection } from "./model";
import { parseFilterNumber, filterUnits, type FilterUnit } from "./units";
import { FILTER_LIMITS } from "./validation";
const FILTER_TABS = ["values", "condition"] as const;

interface FacetOrder { keys: Map<string, number>; next: number }

function orderedOptions(candidates: readonly FacetOption[], picked: Iterable<FilterValue>, order: FacetOrder,
  query: string, label: (value: FilterValue) => string): FacetOption[] {
  const options = [...candidates];
  const keys = new Set(options.map((option) => filterValueKey(option.value)));
  for (const value of picked) {
    const key = filterValueKey(value);
    if (!keys.has(key) && label(value).toLowerCase().includes(query.toLowerCase())) { options.push({ value, count: 0 }); keys.add(key); }
  }
  for (const option of options) {
    const key = filterValueKey(option.value);
    if (!order.keys.has(key)) order.keys.set(key, order.next++);
  }
  // Forget ranks of vanished, unselected candidates; typing through a large list must not grow a permanent index.
  for (const key of order.keys.keys()) if (!keys.has(key)) order.keys.delete(key);
  return options.sort((a, b) => Number(isEmptyValue(b.value)) - Number(isEmptyValue(a.value))
    || order.keys.get(filterValueKey(a.value))! - order.keys.get(filterValueKey(b.value))!);
}

function candidateFilterType(column: ColumnDef, filter: ColumnFilter, facetsType: ReturnType<typeof filterType> | null,
  options: readonly FacetOption[]): ReturnType<typeof filterType> | null {
  if (column.filter?.type) return column.filter.type;
  if (typeof filter.condition?.value === "number") return "number";
  if (typeof filter.condition?.value === "boolean") return "boolean";
  if (facetsType) return facetsType;
  return options.some((option) => !isEmptyValue(option.value)) ? filterType(column, options) : null;
}

function initialValueUnit(column: ColumnDef, units: readonly FilterUnit[]): string {
  if (column.filter?.type === "age") return units[1]!.id;
  return (column.filter?.unit === "bytes" ? units[2] : units[0])!.id;
}

function typedBoolean(query: string, t: TFunction): boolean | undefined {
  const text = query.trim().toLowerCase();
  if (text === t("filters:yes").toLowerCase() || text === "true") return true;
  if (text === t("filters:no").toLowerCase() || text === "false") return false;
  return undefined;
}

function typedValue(query: string, type: string, column: ColumnDef, factor: number, t: TFunction): FilterValue | undefined {
  if (type === "boolean") return typedBoolean(query, t);
  if (type !== "number" && type !== "age") return query.trim();
  const parsed = parseFilterNumber(query, factor);
  return parsed === null ? undefined : valueForSelection(parsed, column);
}

function useConditionDraft(column: ColumnDef, condition: ColumnFilter["condition"], candidateType: ReturnType<typeof filterType> | null) {
  const [inferredType, setInferredType] = useState(candidateType);
  const type = inferredType ?? "string";
  const [draft, setDraft] = useState(() => conditionDraft({ ...column, filter: { ...column.filter, type } }, condition));
  if (inferredType === null && candidateType !== null) {
    setInferredType(candidateType);
    if (candidateType === "boolean" && draft.value === "" && draft.upper === "" && draft.operator === "eq")
      setDraft({ ...draft, value: "true" });
  }
  return { type, draft, setDraft };
}

function ValueSearch({ query, onQueryChange, onAdd, units, unit, onUnitChange }: {
  query: string; onQueryChange: (query: string) => void; onAdd: () => void;
  units: readonly FilterUnit[]; unit: string; onUnitChange: (unit: string) => void;
}) {
  const { t } = useTranslation();
  return <div className="tf-operands"><input className="tf-control" data-autofocus type="search" aria-label={t("filters:valueSearch")} placeholder={t("filters:valueSearch")}
    value={query} onChange={(e) => onQueryChange(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onAdd(); } }} />
    {units.length > 1 && <select className="tf-control tf-value-unit" aria-label={t("filters:unit")} value={unit} onChange={(e) => onUnitChange(e.target.value)}>
      {units.map((option) => <option key={option.id} value={option.id}>{t(`filters:units.${option.id}`)}</option>)}
    </select>}</div>;
}

function ValueOptions({ options, selected, label, onToggle, truncated }: {
  options: readonly FacetOption[]; selected: ReadonlySet<string>; label: (value: FilterValue) => string;
  onToggle: (value: FilterValue) => void; truncated: boolean;
}) {
  const { t } = useTranslation();
  return <><div className="tf-value-list">{options.map((option) => <label className="tf-value" key={filterValueKey(option.value)}>
    <Checkbox aria-label={label(option.value)} checked={selected.has(filterValueKey(option.value))} onChange={() => onToggle(option.value)} />
    <span className="tf-value-text" title={label(option.value)}>{label(option.value)}</span><span className="tf-value-count">{option.count}</span>
  </label>)}{!options.length && <p className="tf-hint">{t("filters:noValues")}</p>}</div>
    {truncated && <p className="tf-hint" role="status">{t("filters:facetLimited")}</p>}</>;
}

function ValuesTab({ mode, onModeChange, children }: {
  mode: "include" | "exclude"; onModeChange: (mode: "include" | "exclude") => void; children: ReactNode;
}) {
  const { t } = useTranslation();
  return <div className="tf-tab-body">
    <div className="tf-segments" role="group" aria-label={t("filters:selectionMode")}>
      <button type="button" aria-pressed={mode === "include"} onClick={() => onModeChange("include")}>{t("filters:include")}</button>
      <button type="button" aria-pressed={mode === "exclude"} onClick={() => onModeChange("exclude")}>{t("filters:exclude")}</button>
    </div>{children}<p className="tf-hint">{t("filters:valueHint")}</p>
  </div>;
}

function ConditionTab({ column, type, draft, onChange, onApply, onClose }: {
  column: ColumnDef; type: string; draft: ConditionDraft; onChange: (draft: ConditionDraft) => void; onApply: () => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  return <div className="tf-tab-body">
    <ConditionFields column={column} type={type} draft={draft} onChange={onChange} />
    <p className="tf-hint">{t("filters:conditionHint")}</p>
    <div className="tf-condition-actions"><Button onClick={onClose}>{t("filters:cancel")}</Button>
      <Button variant="primary" onClick={onApply}>{t("filters:apply")}</Button></div>
  </div>;
}

interface ValueSource {
  objects: ReadonlyMap<string, KubeObject>; context: CellContext; revision: number; accept: (obj: KubeObject) => boolean;
}

function useColumnValues(column: ColumnDef, filter: ColumnFilter, source: ValueSource,
  onChange: (filter: ColumnFilter) => void, setError: (error: string | null) => void, t: TFunction) {
  const { objects, context, revision, accept } = source;
  const [mode, setMode] = useState(filter.values?.mode ?? "include");
  const [query, setQuery] = useState("");
  const [pinned] = useState(() => filter.values?.values ?? []);
  const pinnedKeys = useMemo(() => new Set(pinned.map(filterValueKey)), [pinned]);
  const [typed, setTyped] = useState<FilterValue[]>([]);
  const units = filterUnits(column);
  const [valueUnit, setValueUnit] = useState(() => initialValueUnit(column, units));
  const picked = useRef(new Map<string, FilterValue>());
  const label = (value: FilterValue) => valueLabel(value, column, t);
  // Selection changes never rebuild or reorder the list. The original selection and typed values live until close.
  const retained = useMemo(() => [...pinned, ...typed], [pinned, typed]);
  const ageNow = column.filter?.type === "age" ? context.now : 0;
  const facetContext = useMemo(() => context, [context.clusterId, context.kind, ageNow]);
  const facets = useMemo(() => buildFacetOptions(objects.values(), column, facetContext,
    { selected: retained, query, accept, label: (value) => valueLabel(value, column, t) }),
  [objects, column, facetContext, retained, query, accept, t, revision]);
  const order = useRef({ query, keys: new Map<string, number>(), next: 0 });
  if (order.current.query !== query) order.current = { query, keys: new Map(), next: 0 };
  const options = orderedOptions(facets.options, picked.current.values(), order.current, query, label);
  // A search yielding no candidates must not turn numeric/boolean literals into strings.
  const candidateType = candidateFilterType(column, filter, facets.type, options);
  const current = filter.values?.values ?? [];
  const selected = new Set(current.map(filterValueKey));
  const remember = (value: FilterValue): boolean => {
    const key = filterValueKey(value);
    // Initial choices already stay in pinned; allow replacing them at the selection limit.
    // Only new choices consume the separate, bounded history for this open editor.
    if (pinnedKeys.has(key)) return true;
    if (!picked.current.has(key) && picked.current.size >= FILTER_LIMITS.values) { setError(t("filters:limitReached")); return false; }
    picked.current.set(key, value);
    return true;
  };
  const toggle = (value: FilterValue) => {
    const key = filterValueKey(value);
    if (!selected.has(key) && current.length >= FILTER_LIMITS.values) {
      setError(t("filters:limitReached")); return;
    }
    if (!remember(value)) return;
    setError(null);
    onChange({ ...filter, values: { mode, values: selected.has(key) ? current.filter((v) => filterValueKey(v) !== key) : [...current, value] } });
  };
  const addTyped = (type: string) => {
    if (!query.trim()) return;
    const exact = options.find((option) => label(option.value).toLowerCase() === query.trim().toLowerCase())?.value;
    const value = exact === undefined ? typedValue(query, type, column, units.find((unit) => unit.id === valueUnit)?.factor ?? 1, t) : exact;
    if (value === undefined || [...String(value)].length > FILTER_LIMITS.text) { setError(t("filters:invalidValue")); return; }
    const literal = value;
    if (!remember(literal)) return;
    if (!typed.some((v) => filterValueKey(v) === filterValueKey(literal))) setTyped((before) => [...before, literal]);
    if (!selected.has(filterValueKey(literal))) toggle(literal);
    setQuery("");
  };
  const changeMode = (next: "include" | "exclude") => {
    setMode(next);
    if (current.length) onChange({ ...filter, values: { mode: next, values: current } });
  };
  return { mode, changeMode, query, setQuery, units, valueUnit, setValueUnit, options, selected, label, toggle, addTyped,
    candidateType, truncated: facets.truncated };
}

export function ColumnEditor({ column, filter, objects, context, revision, accept, onChange, onClear, onClose }: {
  column: ColumnDef; filter: ColumnFilter; objects: ReadonlyMap<string, KubeObject>; context: CellContext;
  revision: number; accept: (obj: KubeObject) => boolean; onChange: (filter: ColumnFilter) => void; onClear: () => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"values" | "condition">(filter.condition || column.filter?.type === "age" ? "condition" : "values");
  const [error, setError] = useState<string | null>(null);
  const values = useColumnValues(column, filter, { objects, context, revision, accept }, onChange, setError, t);
  const { type, draft, setDraft } = useConditionDraft(column, filter.condition, values.candidateType);
  const applyCondition = () => {
    const condition = draftCondition(draft, column, type);
    if (!condition) { setError(t("filters:invalidValue")); return; }
    onChange({ ...filter, condition }); onClose();
  };
  return <>
    <header className="tf-popup-heading"><strong>{columnLabel(column, t)}</strong>
      <Button iconOnly icon="close" label={t("filters:close")} size="compact" onClick={onClose} /></header>
    <Tabs label={t("filters:editColumn", { column: columnLabel(column, t) })} selected={tab} onSelect={setTab}
      tabs={FILTER_TABS.map((id) => ({ id, label: t(`filters:${id}`) }))}>
      {tab === "values" ? <ValuesTab mode={values.mode} onModeChange={values.changeMode}>
        <ValueSearch query={values.query} onQueryChange={values.setQuery} onAdd={() => values.addTyped(type)} units={values.units} unit={values.valueUnit} onUnitChange={values.setValueUnit} />
        <ValueOptions options={values.options} selected={values.selected} label={values.label} onToggle={values.toggle} truncated={values.truncated} />
      </ValuesTab> : <ConditionTab column={column} type={type} draft={draft} onChange={setDraft} onApply={applyCondition} onClose={onClose} />}
    </Tabs>
    {error && <p className="tf-error" role="alert">{error}</p>}
    <footer className="tf-popup-footer"><Button size="compact" onClick={onClear}>{t("filters:clearColumn")}</Button></footer>
  </>;
}
