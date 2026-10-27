import type { TFunction } from "i18next";
import type { FilterCondition } from "../../api/generated/FilterCondition";
import type { FilterExpression } from "../../api/generated/FilterExpression";
import type { FilterValue } from "../../api/generated/FilterValue";
import { ageParts } from "../../components/Age";
import { formatList, formatNumber } from "../../i18n/format";
import type { ColumnDef } from "../../resources/registry";
import { formatBytes, formatCpu } from "../metrics/format";

export function columnLabel(column: ColumnDef, t: TFunction): string {
  return column.titleKey ? t(column.titleKey) : column.title ?? column.id;
}
export function valueLabel(value: FilterValue | undefined, column: ColumnDef, t: TFunction): string {
  if (value === undefined || value === null || value === "") return t("filters:empty");
  if (typeof value === "boolean") return t(value ? "filters:yes" : "filters:no");
  if (typeof value !== "number") return value;
  if (column.filter?.type === "age") {
    const { unit, count } = ageParts(value);
    return t(`common:age.${unit}`, { count });
  }
  if (column.filter?.unit === "cpu") return formatCpu(value);
  if (column.filter?.unit === "bytes") return formatBytes(value);
  return formatNumber(value, Number.isInteger(value) ? 0 : 3);
}
export function operatorLabel(condition: FilterCondition, column: ColumnDef, t: TFunction): string {
  const op = column.filter?.type === "age" && condition.operator === "gt" ? "older"
    : column.filter?.type === "age" && condition.operator === "lt" ? "younger" : condition.operator;
  return t(`filters:operators.${op}`);
}
export function conditionLabel(condition: FilterCondition, column: ColumnDef, t: TFunction): string {
  const label = columnLabel(column, t);
  if (condition.operator === "empty" || condition.operator === "notEmpty")
    return t("filters:emptySummary", { column: label, operator: operatorLabel(condition, column, t) });
  if (condition.operator === "between") return t("filters:rangeSummary", { column: label,
    lower: valueLabel(condition.value, column, t), upper: valueLabel(condition.upper, column, t) });
  return t("filters:conditionSummary", { column: label, operator: operatorLabel(condition, column, t), value: valueLabel(condition.value, column, t) });
}
export function selectionLabel(mode: "include" | "exclude", values: readonly FilterValue[], column: ColumnDef, t: TFunction): string {
  return t(mode === "include" ? "filters:includeSummary" : "filters:excludeSummary", {
    column: columnLabel(column, t), values: formatList(values.map((value) => valueLabel(value, column, t))),
  });
}
export function expressionLabel(expression: FilterExpression, columns: readonly ColumnDef[], t: TFunction): string {
  if (expression.type === "rule") return conditionLabel(expression.condition,
    columns.find((column) => column.id === expression.column) ?? { id: expression.column, value: () => undefined }, t);
  return `(${expression.children.map((child) => expressionLabel(child, columns, t)).join(` ${t(`filters:${expression.operator}`)} `)})`;
}
