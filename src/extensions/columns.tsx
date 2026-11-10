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
import { evaluate, fillTemplate, numberOf, sumOf, valueAt } from "./problemRules";
import { cleanText } from "../resources/uri";
import { formatDateTime, formatList } from "../i18n/format";
import { formatBytes, formatCpu, parseQuantity } from "../features/metrics/format";

/** Cores as Kubernetes writes whole ones ("4"), anything else in millicores ("250m"), as Sextant's own columns do. */
function cpuText(cores: number): string {
  const milli = Math.round(cores * 1000);
  return milli % 1000 === 0 && milli > 0 ? String(milli / 1000) : formatCpu(milli);
}

/** Longest text a computed cell shows. */
export const MAX_CELL_CHARS = 200;
/** A hover holds more than a cell (#404): a condition's whole message, a URL. */
export const MAX_TOOLTIP_CHARS = 1000;

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

/** A scalar as text, clipped (to `max`, a cell's by default); anything else is no value. */
function textOf(value: unknown, max = MAX_CELL_CHARS): string | undefined {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return undefined;
  const chars = Array.from(String(value));
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}



function timeOf(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

/** An item's text by the first of `cases` that holds on it, its placeholders filled from the item (#404). */
function itemText(cases: readonly { when: ColumnCase["when"]; text: string }[], item: unknown, now: number): string | undefined {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return undefined;
  const obj = item as KubeObject;
  for (const c of cases) {
    if (!holdsNow(c, obj, now)) continue;
    const filled = c.text.includes("{{") ? fillTemplate(c.text, obj) : c.text;
    if (filled !== null) return filled;
  }
  return undefined;
}

/** Whether a case's condition holds at `now` (a condition holding only from or until a time counts within it). */
function holdsNow(c: Pick<ColumnCase, "when">, obj: KubeObject, now: number): boolean {
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
    // A tooltip whose placeholder has no value leaves the column's own tooltip (#380); with `tooltipOr` (#403) an empty
    // value skips to the next one.
    const tooltip =
      c.tooltip === undefined
        ? undefined
        : c.tooltipOr === undefined
          ? fillTemplate(c.tooltip, obj)
          : ([c.tooltip, ...c.tooltipOr].map((t) => fillTemplate(t, obj, { emptyIsMissing: true })).find((t) => t !== null) ?? null);
    return {
      ...c,
      text: filled === c.text ? c.text : (textOf(cleanText(filled) ?? "") ?? ""),
      tooltip: tooltip === null || tooltip === undefined ? undefined : (textOf(cleanText(tooltip) ?? "", MAX_TOOLTIP_CHARS) ?? undefined),
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
    // `"*"`: the tone of any other value (#403).
    const named = value !== undefined ? (column.tones?.[value] ?? column.tones?.["*"]) : undefined;
    return named ? TONES[named] : undefined;
  };
  if (replaced !== undefined) {
    const { text } = replaced;
    // A case's own tone (it is translated, so `tones` cannot name it), else the tone `tones` gives its text.
    const toned = replaced.tone ? TONES[replaced.tone] : tone(text);
    // A case's own number sorts and filters a number column (#390); a text column sorts by a number or a filled text
    // (#404); its text is what shows.
    // A text sort key whose placeholder has no value gives no sort value (#404): such rows sort last, as with no value.
    // On a number, count or sum column a text key is read as a number (#404): an error count coloured by its case.
    const numeric = column.format === "number" || column.format === "count" || column.format === "sum";
    const filled = typeof replaced.value === "string" ? (fillTemplate(replaced.value, obj) ?? undefined) : undefined;
    const sort = typeof replaced.value === "string" ? (numeric ? numberOf(filled) : filled) : (replaced.value ?? text);
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
      // A list of scalars joined in the UI language (#395); anything else in it is left out. `joinPaths` (#404): every
      // path's items in order, each once (a listener declared and one only in the status).
      const lists = column.joinPaths ? (column.paths ?? []).map((p) => valueAt(obj, p)).filter(Array.isArray) : [value];
      if (!lists.some(Array.isArray)) return { sort: undefined, text: undefined, draw: null };
      const all = lists.flatMap((list) => (Array.isArray(list) ? list : []));
      // `items` (#404): each item written by the first case holding on it; an item none holds for is left out.
      const texts = column.items
        ? all.map((item) => itemText(column.items!.cases, item, now))
        : all.filter((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean").map((v) => String(v));
      const cleaned = texts.map((v) => (v === undefined ? "" : (cleanText(v) ?? ""))).filter((v) => v !== "");
      // Joined lists name each item once (a listener declared and in the status); one list keeps its repeats (#404).
      const shown = column.joinPaths ? [...new Set(cleaned)] : cleaned;
      const separator = column.items?.separator ?? column.separator;
      if (shown.length === 0) return { sort: undefined, text: undefined, draw: null };
      const text = textOf(separator === undefined ? formatList(shown) : shown.join(separator)) ?? "";
      return { sort: text, text, draw: text };
    }
    case "count": {
      // How many items a list, or entries a map, has (#404).
      const n = Array.isArray(value) ? value.length : value !== null && typeof value === "object" ? Object.keys(value).length : undefined;
      return { sort: n, text: n === undefined ? undefined : written(String(n)), draw: n === undefined ? null : written(String(n)) };
    }
    case "sum": {
      // The sum of a list's numbers, numeric text included (#404); none without one.
      const n = sumOf(value);
      if (n === undefined) return { sort: undefined, text: undefined, draw: null };
      return { sort: n, text: written(String(n)), draw: written(String(n)) };
    }
    case "cpu":
    case "bytes": {
      // A quantity as Sextant writes its own (#404): "250m", "250MiB"; sorted and filtered by the amount.
      const amount = parseQuantity(value);
      if (amount === undefined) return { sort: undefined, text: undefined, draw: null };
      const text = column.format === "cpu" ? cpuText(amount) : formatBytes(amount);
      return { sort: amount, text, draw: text };
    }
    case "dateTime": {
      // A date and time in the UI language (#404), sorted by the time.
      const t = timeOf(value);
      if (t === undefined) return { sort: undefined, text: undefined, draw: null };
      const text = formatDateTime(t);
      return { sort: t, text, draw: <time dateTime={value as string}>{text}</time> };
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
      const text = textOf(column.separator === undefined ? formatList(items) : items.join(column.separator)) ?? "";
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
  const tooltip = (obj: KubeObject) => textOf(cleanText(textOf(firstValue(obj, column.tooltipPaths), MAX_TOOLTIP_CHARS)), MAX_TOOLTIP_CHARS);
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
      // A list's hover is its whole text when it has none of its own (#404): a cell may cut it.
      const title = caseOf(column, obj, ctx.now)?.tooltip ?? tooltip(obj) ?? (format === "list" && column.tooltipPaths === undefined ? cell.text : undefined);
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
      // A count, a sum or a quantity filters as a number (#404), as a number column does.
      format === "number" || format === "ratio" || format === "count" || format === "sum" || format === "cpu" || format === "bytes"
        ? { type: "number", value: (obj, ctx) => numericSort(cellOf(column, obj, ctx.now).sort) }
        : format === "age"
          ? { type: "age", value: (obj, ctx) => ageMs(cellOf(column, obj, ctx.now).sort, ctx.now) }
          : format === "duration"
            ? { type: "number", value: (obj, ctx) => numericSort(cellOf(column, obj, ctx.now).sort) }
            : column.filterBy === "value"
              ? // The cases' values, not the translated texts (#404): a state's name in every language.
                { type: "string", value: (obj, ctx) => filterValue(cellOf(column, obj, ctx.now)) }
              : { type: "string", value: (obj, ctx) => cellOf(column, obj, ctx.now).text },
  };
}

/** The sort key as text; a case whose key has no value leaves nothing to filter by (#404), as the built-in had. */
function filterValue(cell: Cell): string | undefined {
  return cell.sort === undefined ? undefined : String(cell.sort);
}

function numericSort(sort: string | number | undefined): number | undefined {
  return typeof sort === "number" ? sort : undefined;
}

/** An age cell sorts by the negated time; its filter value is the age in ms. */
function ageMs(sort: string | number | undefined, now: number): number | undefined {
  return typeof sort === "number" ? Math.max(0, now + sort) : undefined;
}
