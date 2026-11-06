// Computed columns of extensions (`contributes.columns` with `paths`, sextantApi 4, ADR-0153): field paths read by the
// window, the first with a value giving the cell, shown by `format`, toned by `tones`, replaced by the first `cases`
// text whose condition holds. No extension code runs; Rust checked the paths read no secret.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ColumnCase, ColumnContribution, ColumnTone, KubeObject } from "../api";
import { Age, ageParts } from "../components";
import type { ColumnDef } from "../resources/registry";
import { StatusText } from "../resources/columns";
import type { Tone } from "../resources/status";
import { evaluate, numberOf, valueAt } from "./problemRules";

/** Longest text a computed cell shows. */
export const MAX_CELL_CHARS = 200;

const TONES: Record<ColumnTone, Tone> = { ok: "success", warning: "warning", error: "danger", neutral: "neutral" };

/** The first value of `paths` that is there (not `null`). */
export function firstValue(obj: KubeObject, paths: readonly string[] | undefined): unknown {
  for (const path of paths ?? []) {
    const value = valueAt(obj, path);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** A scalar as text, clipped; anything else is no value. */
function textOf(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return undefined;
  const chars = Array.from(String(value));
  return chars.length > MAX_CELL_CHARS ? `${chars.slice(0, MAX_CELL_CHARS).join("")}…` : chars.join("");
}



function timeOf(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

/** Whether a case's condition holds at `now` (a condition holding only from or until a time counts within it). */
function holdsNow(c: ColumnCase, obj: KubeObject, now: number): boolean {
  const verdict = evaluate(c.when, obj);
  if (!verdict.holds) return false;
  if (verdict.activeFrom !== undefined && verdict.activeFrom > now) return false;
  return verdict.until === undefined || verdict.until > now;
}

/** The case that replaces the value, if one holds. */
function caseOf(column: ColumnContribution, obj: KubeObject, now: number): ColumnCase | undefined {
  for (const c of column.cases ?? []) if (holdsNow(c, obj, now)) return c;
  return undefined;
}

/** What a cell is: its sort value, its text for search and copying, and how it draws. */
interface Cell {
  sort: string | number | undefined;
  text: string | undefined;
  draw: ReactNode;
}

function cellOf(column: ColumnContribution, obj: KubeObject, now: number): Cell {
  const replaced = caseOf(column, obj, now);
  const tone = (value: string | undefined): Tone | undefined => {
    const named = value !== undefined ? column.tones?.[value] : undefined;
    return named ? TONES[named] : undefined;
  };
  if (replaced !== undefined) {
    const { text } = replaced;
    // A case's own tone (it is translated, so `tones` cannot name it), else the tone `tones` gives its text.
    const toned = replaced.tone ? TONES[replaced.tone] : tone(text);
    return { sort: text, text, draw: toned || column.tones ? <StatusText value={text} tone={toned ?? "neutral"} /> : text };
  }
  const value = firstValue(obj, column.paths);
  switch (column.format ?? "text") {
    case "number": {
      const n = numberOf(value);
      return { sort: n, text: n === undefined ? undefined : String(n), draw: n === undefined ? null : String(n) };
    }
    case "age": {
      const t = timeOf(value);
      if (t === undefined) return { sort: undefined, text: undefined, draw: null };
      return { sort: -t, text: undefined, draw: <Age timestamp={value as string} now={now} /> };
    }
    case "duration": {
      const start = timeOf(value);
      const end = timeOf(firstValue(obj, column.endPaths)) ?? now;
      if (start === undefined) return { sort: undefined, text: undefined, draw: null };
      const ms = Math.max(0, end - start);
      return { sort: ms, text: undefined, draw: <DurationText ms={ms} /> };
    }
    case "ratio": {
      const part = numberOf(value);
      const whole = numberOf(firstValue(obj, column.totalPaths));
      if (part === undefined || whole === undefined) return { sort: undefined, text: undefined, draw: null };
      const text = `${part}/${whole}`;
      return { sort: whole === 0 ? 0 : part / whole, text, draw: text };
    }
    case "text": {
      const text = textOf(value);
      if (text === undefined) return { sort: undefined, text: undefined, draw: null };
      return { sort: text, text, draw: column.tones ? <StatusText value={text} tone={tone(text) ?? "neutral"} /> : text };
    }
  }
}

/** A duration in the age units of the UI language, as an age is shown. */
function DurationText({ ms }: { ms: number }) {
  const { t } = useTranslation();
  const { unit, count } = ageParts(ms);
  return <>{t(`common:age.${unit}`, { count })}</>;
}

/**
 * Where a column goes: after the column with the id `afterColumn` (one of the extension's own ids is its registry id,
 * `ext:<extension>:<id>`), else after the title `after`.
 */
export function placement(column: Pick<ColumnContribution, "after" | "afterColumn">, ownIds?: (id: string) => string | undefined): Pick<ColumnDef, "after" | "afterTitle"> {
  if (column.afterColumn !== undefined) return { after: ownIds?.(column.afterColumn) ?? column.afterColumn };
  return column.after !== undefined ? { afterTitle: column.after } : {};
}

/** The table column of a computed contribution, under the registry id `id`. */
export function computedColumn(id: string, column: ColumnContribution, ownIds?: (id: string) => string | undefined): ColumnDef {
  const format = column.format ?? "text";
  const timed = format === "age" || format === "duration" || (column.cases ?? []).length > 0;
  const tooltip = (obj: KubeObject) => textOf(firstValue(obj, column.tooltipPaths));
  return {
    id,
    title: column.title,
    ...placement(column, ownIds),
    fallback: "end",
    // Sorting and the default text; a time-dependent cell sorts as of now.
    value: (obj) => cellOf(column, obj, Date.now()).sort,
    render: (obj, ctx) => {
      const cell = cellOf(column, obj, ctx.now);
      const title = tooltip(obj);
      return title === undefined ? cell.draw : <span title={title}>{cell.draw}</span>;
    },
    searchText: (obj, ctx) => {
      const cell = cellOf(column, obj, ctx.now);
      if (cell.text !== undefined) return cell.text;
      // An age sorts by the negated time (its age is now + sort), a duration by its length.
      const ms = format === "age" ? ageMs(cell.sort, ctx.now) : format === "duration" ? numericSort(cell.sort) : undefined;
      if (ms === undefined) return undefined;
      const { unit, count } = ageParts(ms);
      return ctx.t(`common:age.${unit}`, { count });
    },
    searchTextTimed: timed,
    filter:
      format === "number" || format === "ratio"
        ? { type: "number", value: (obj, ctx) => numericSort(cellOf(column, obj, ctx.now).sort) }
        : format === "age"
          ? { type: "age", value: (obj, ctx) => ageMs(cellOf(column, obj, ctx.now).sort, ctx.now) }
          : format === "duration"
            ? { type: "number", value: (obj, ctx) => numericSort(cellOf(column, obj, ctx.now).sort) }
            : { type: "string", value: (obj, ctx) => cellOf(column, obj, ctx.now).text },
  };
}

function numericSort(sort: string | number | undefined): number | undefined {
  return typeof sort === "number" ? sort : undefined;
}

/** An age cell sorts by the negated time; its filter value is the age in ms. */
function ageMs(sort: string | number | undefined, now: number): number | undefined {
  return typeof sort === "number" ? Math.max(0, now + sort) : undefined;
}
