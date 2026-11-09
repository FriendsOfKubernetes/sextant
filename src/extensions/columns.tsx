// Computed columns of extensions (`contributes.columns` with `paths`, sextantApi 4, ADR-0153): field paths read by the
// window, the first with a value giving the cell, shown by `format`, toned by `tones`, replaced by the first `cases`
// text whose condition holds. No extension code runs; Rust checked the paths read no secret.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ColumnCase, ColumnContribution, ColumnLookup, ColumnTone, KubeObject } from "../api";
import { Age, ageParts } from "../components";
import type { ColumnDef } from "../resources/registry";
import { StatusText } from "../resources/columns";
import type { Tone } from "../resources/status";
import { evaluate, fillTemplate, numberOf, valueAt } from "./problemRules";
import { cleanText } from "../resources/uri";
import { formatList } from "../i18n/format";

/** Longest text a computed cell shows. */
export const MAX_CELL_CHARS = 200;

const TONES: Record<ColumnTone, Tone> = { ok: "success", warning: "warning", error: "danger", neutral: "neutral", muted: "muted" };

/**
 * A column's `lookup` (#387): `field` of the item of `list` that `index` names (an index the object leaves out is 0);
 * with `nearestBefore`, else the nearest earlier item's; else `orElse`. `undefined` without the list or past its end.
 */
export function lookupValue(obj: KubeObject, lookup: ColumnLookup): unknown {
  const list = valueAt(obj, lookup.list);
  if (!Array.isArray(list)) return undefined;
  const raw = valueAt(obj, lookup.index);
  const index = raw === undefined || raw === null ? 0 : numberOf(raw);
  if (index === undefined || !Number.isInteger(index) || index < 0 || index >= list.length) return undefined;
  for (let i = index; i >= 0; i--) {
    const value = valueAt(list[i], lookup.field);
    if (value !== undefined && value !== null) return value;
    if (!lookup.nearestBefore) break;
  }
  return lookup.orElse;
}

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

/**
 * The case that replaces the value, if one holds, with its text filled from the object (#368): a case whose
 * placeholder has no value does not hold.
 */
function caseOf(column: ColumnContribution, obj: KubeObject, now: number): ColumnCase | undefined {
  for (const c of column.cases ?? []) {
    if (!holdsNow(c, obj, now)) continue;
    const filled = c.text.includes("{{") ? fillTemplate(c.text, obj) : c.text;
    if (filled === null) continue;
    // A tooltip whose placeholder has no value leaves the column's own tooltip (#380).
    const tooltip = c.tooltip === undefined ? undefined : fillTemplate(c.tooltip, obj);
    return {
      ...c,
      text: filled === c.text ? c.text : (textOf(cleanText(filled) ?? "") ?? ""),
      tooltip: tooltip === null || tooltip === undefined ? undefined : (textOf(cleanText(tooltip) ?? "") ?? undefined),
    };
  }
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
    // A case's own number sorts and filters a number column (#390); its text is what shows.
    const sort = replaced.value ?? text;
    return { sort, text, draw: toned || column.tones ? <StatusText value={text} tone={toned ?? "neutral"} /> : text };
  }
  const looked = column.lookup === undefined ? undefined : lookupValue(obj, column.lookup);
  const value = looked !== undefined && looked !== null ? looked : firstValue(obj, column.paths);
  // `valueText` writes a text or number value (#387): "{{value}}%".
  const written = (text: string) => (column.valueText === undefined ? text : column.valueText.replace(/\{\{\s*value\s*\}\}/g, text));
  switch (column.format ?? "text") {
    case "number": {
      const n = numberOf(value);
      return { sort: n, text: n === undefined ? undefined : written(String(n)), draw: n === undefined ? null : written(String(n)) };
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
      // Kubernetes leaves a zero count out (`readyReplicas`, Argo Rollouts' `currentStepIndex`): with the whole there,
      // a missing part is 0, as the controllers read it.
      const whole = numberOf(firstValue(obj, column.totalPaths));
      const part = value === undefined && whole !== undefined ? 0 : numberOf(value);
      if (part === undefined || whole === undefined) return { sort: undefined, text: undefined, draw: null };
      const text = `${part}/${whole}`;
      return { sort: whole === 0 ? 0 : part / whole, text, draw: text };
    }
    case "list": {
      // A list of scalars joined in the UI language (#395); anything else in it is left out.
      if (!Array.isArray(value)) return { sort: undefined, text: undefined, draw: null };
      const items = value
        .filter((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
        .map((v) => cleanText(String(v)) ?? "")
        .filter((v) => v !== "");
      if (items.length === 0) return { sort: undefined, text: undefined, draw: null };
      const text = textOf(formatList(items)) ?? "";
      return { sort: text, text, draw: text };
    }
    case "count": {
      // How many items a list, or entries a map, has (#404).
      const n = Array.isArray(value) ? value.length : value !== null && typeof value === "object" ? Object.keys(value).length : undefined;
      return { sort: n, text: n === undefined ? undefined : written(String(n)), draw: n === undefined ? null : written(String(n)) };
    }
    case "sum": {
      // The sum of a list's numbers, numeric text included (#404); none without one.
      const numbers = Array.isArray(value) ? value.map(numberOf).filter((n): n is number => n !== undefined) : [];
      if (numbers.length === 0) return { sort: undefined, text: undefined, draw: null };
      const n = numbers.reduce((a, b) => a + b, 0);
      return { sort: n, text: written(String(n)), draw: written(String(n)) };
    }
    case "entries": {
      // A map's `key=value` entries in key order (#404), joined in the UI language.
      if (value === null || typeof value !== "object" || Array.isArray(value)) return { sort: undefined, text: undefined, draw: null };
      const map = value as Record<string, unknown>;
      const items = Object.keys(map)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .filter((k) => typeof map[k] === "string" || typeof map[k] === "number" || typeof map[k] === "boolean")
        .map((k) => cleanText(`${k}=${String(map[k])}`) ?? "");
      if (items.length === 0) return { sort: undefined, text: undefined, draw: null };
      const text = textOf(formatList(items)) ?? "";
      return { sort: text, text, draw: text };
    }
    case "text": {
      const plain = textOf(cleanText(textOf(value)));
      if (plain === undefined) return { sort: undefined, text: undefined, draw: null };
      const text = written(plain);
      return { sort: plain, text, draw: column.tones ? <StatusText value={text} tone={tone(plain) ?? "neutral"} /> : text };
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
  // Cluster text is cleaned wherever it shows, as case texts are: no credentials of a URI in a hover.
  const tooltip = (obj: KubeObject) => textOf(cleanText(textOf(firstValue(obj, column.tooltipPaths))));
  return {
    id,
    title: column.title,
    ...placement(column, ownIds),
    // As Sextant's own columns give theirs (#403); Rust and the SDK checked its shape.
    ...(column.width !== undefined ? { width: column.width } : {}),
    fallback: "end",
    // Sorting and the default text; a time-dependent cell sorts as of now.
    value: (obj) => cellOf(column, obj, Date.now()).sort,
    render: (obj, ctx) => {
      const cell = cellOf(column, obj, ctx.now);
      const title = caseOf(column, obj, ctx.now)?.tooltip ?? tooltip(obj);
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
