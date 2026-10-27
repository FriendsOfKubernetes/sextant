import type { ColumnDef } from "../../resources/registry";

export interface FilterUnit { id: string; factor: number }
const plain: FilterUnit[] = [{ id: "number", factor: 1 }];
const cpu: FilterUnit[] = [{ id: "millicores", factor: 1 }, { id: "cores", factor: 1000 }];
const bytes: FilterUnit[] = ["B", "KiB", "MiB", "GiB", "TiB"].map((id, i) => ({ id, factor: 1024 ** i }));
const age: FilterUnit[] = [{ id: "seconds", factor: 1000 }, { id: "minutes", factor: 60_000 },
  { id: "hours", factor: 3_600_000 }, { id: "days", factor: 86_400_000 }];

export function filterUnits(column: ColumnDef): readonly FilterUnit[] {
  return column.filter?.type === "age" ? age : column.filter?.unit === "cpu" ? cpu : column.filter?.unit === "bytes" ? bytes : plain;
}

/** Input accepts either decimal sign, never an ambiguous thousands separator or a non-finite value. */
export function parseFilterNumber(text: string, factor = 1): number | null {
  if (!/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?$/i.test(text.trim())) return null;
  const value = Number(text.trim().replace(",", ".")) * factor;
  return Number.isFinite(value) ? value : null;
}
