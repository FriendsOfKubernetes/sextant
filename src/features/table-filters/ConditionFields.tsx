import { useTranslation } from "react-i18next";
import type { FilterCondition } from "../../api/generated/FilterCondition";
import type { FilterOperator } from "../../api/generated/FilterOperator";
import { currentLanguage } from "../../i18n/format";
import type { ColumnDef } from "../../resources/registry";
import { operatorLabel } from "./labels";
import { filterUnits, parseFilterNumber } from "./units";
import { FILTER_LIMITS } from "./validation";

export interface ConditionDraft { operator: FilterOperator; value: string; upper: string; unit: string; factor: number }
const BOOLEAN_VALUES = ["true", "false"] as const;
const NUMERIC_OPERATORS: FilterOperator[] = ["gt", "gte", "lt", "lte", "between"];
const TEXT_OPERATORS: FilterOperator[] = ["contains", "notContains", "startsWith", "endsWith"];

function numericCondition(type: string, operator: FilterOperator): boolean {
  return type === "number" || type === "age" || NUMERIC_OPERATORS.includes(operator);
}

function booleanDraftCondition({ operator, value }: ConditionDraft): FilterCondition | null {
  if (operator !== "eq" && operator !== "neq") return null;
  return BOOLEAN_VALUES.includes(value as "true" | "false") ? { operator, value: value === "true" } : null;
}

function numberDraftCondition(draft: ConditionDraft, column: ColumnDef): FilterCondition | null {
  const { operator } = draft;
  if (TEXT_OPERATORS.includes(operator)) return null;
  const factor = filterUnits(column).find((unit) => unit.id === draft.unit)?.factor ?? draft.factor;
  const value = parseFilterNumber(draft.value, factor);
  if (value === null) return null;
  if (operator !== "between") return { operator, value };
  const upper = parseFilterNumber(draft.upper, factor);
  return upper === null || upper < value ? null : { operator, value, upper };
}

export function conditionDraft(column: ColumnDef, condition?: FilterCondition | null): ConditionDraft {
  const units = filterUnits(column);
  const amount = typeof condition?.value === "number" ? condition.value : null;
  const unit = [...units].reverse().find((u) => amount !== null && amount >= u.factor && amount % u.factor === 0)
    ?? (column.filter?.type === "age" ? units[1] : units[0])!;
  const text = (value: unknown) => typeof value === "number"
    ? new Intl.NumberFormat(currentLanguage(), { useGrouping: false, maximumFractionDigits: 12 }).format(value / unit.factor)
    : typeof value === "boolean" ? String(value) : typeof value === "string" ? value : "";
  return { operator: condition?.operator ?? (column.filter?.type === "age" ? "gt" : "eq"),
    value: condition ? text(condition.value) : column.filter?.type === "boolean" ? "true" : "", upper: text(condition?.upper), unit: unit.id, factor: unit.factor };
}

export function draftCondition(draft: ConditionDraft, column: ColumnDef, type: string): FilterCondition | null {
  const { operator } = draft;
  if (operator === "empty" || operator === "notEmpty") return { operator };
  if (type === "boolean") return booleanDraftCondition(draft);
  if (numericCondition(type, operator)) return numberDraftCondition(draft, column);
  return [...draft.value].length <= FILTER_LIMITS.text ? { operator, value: draft.value } : null;
}

export function ConditionFields({ column, type, draft, onChange }: {
  column: ColumnDef; type: string; draft: ConditionDraft; onChange: (draft: ConditionDraft) => void;
}) {
  const { t } = useTranslation();
  const operations: FilterOperator[] = type === "boolean" ? ["eq", "neq", "empty", "notEmpty"]
    // An age is never exactly equal to a typed duration: ages compare only by older/younger and ranges.
    : type === "age" ? ["gt", "gte", "lt", "lte", "between", "empty", "notEmpty"]
    : type === "number" ? ["eq", "neq", "gt", "gte", "lt", "lte", "between", "empty", "notEmpty"]
    : ["eq", "neq", "contains", "notContains", "startsWith", "endsWith", "gt", "gte", "lt", "lte", "between", "empty", "notEmpty"];
  const numeric = numericCondition(type, draft.operator);
  const operands = draft.operator !== "empty" && draft.operator !== "notEmpty";
  const units = filterUnits(column);
  const chooseUnit = (id: string) => {
    const previous = units.find((unit) => unit.id === draft.unit)?.factor ?? 1;
    const next = units.find((unit) => unit.id === id)?.factor ?? 1;
    const convert = (text: string) => { const value = parseFilterNumber(text, previous); return value === null ? text : String(value / next); };
    onChange({ ...draft, unit: id, factor: next, value: convert(draft.value), upper: convert(draft.upper) });
  };
  return <div className="tf-condition-fields">
    <label><span className="tf-label">{t("filters:operator")}</span>
      <select className="tf-control" value={draft.operator} onChange={(e) => onChange({ ...draft, operator: e.target.value as FilterOperator })}>
        {operations.map((operator) => <option key={operator} value={operator}>{operatorLabel({ operator }, column, t)}</option>)}
      </select>
    </label>
    {operands && <div className="tf-operands">
      {type === "boolean" ? <label><span className="tf-label">{t("filters:value")}</span>
        <select className="tf-control" value={draft.value} onChange={(e) => onChange({ ...draft, value: e.target.value })}>
          {BOOLEAN_VALUES.map((value) => <option key={value} value={value}>{t(value === "true" ? "filters:yes" : "filters:no")}</option>)}
        </select></label>
        : <label><span className="tf-label">{t("filters:value")}</span>
          <input className="tf-control" data-autofocus inputMode={numeric ? "decimal" : undefined} value={draft.value}
            onChange={(e) => onChange({ ...draft, value: e.target.value })} maxLength={2000} /></label>}
      {draft.operator === "between" && <label><span className="tf-label">{t("filters:upper")}</span>
        <input className="tf-control" inputMode="decimal" value={draft.upper} onChange={(e) => onChange({ ...draft, upper: e.target.value })} /></label>}
      {numeric && units.length > 1 && <label className="tf-unit"><span className="tf-label">{t("filters:unit")}</span>
        <select className="tf-control" value={draft.unit} onChange={(e) => chooseUnit(e.target.value)}>
          {units.map((unit) => <option key={unit.id} value={unit.id}>{t(`filters:units.${unit.id}`)}</option>)}
        </select></label>}
    </div>}
  </div>;
}
