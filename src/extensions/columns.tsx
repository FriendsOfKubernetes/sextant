// Computed columns of extensions (`contributes.columns` with `paths`, sextantApi 4, ADR-0153): field paths read by the
// window, the first with a value giving the cell, shown by `format`, toned by `tones`, replaced by the first `cases`
// text whose condition holds. No extension code runs; Rust checked the paths read no secret.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ColumnCase, ColumnContribution, ColumnLookup, ColumnTone, KubeObject, ProblemCondition } from "../api";
import { Age, ageParts } from "../components";
import type { CellContext, ColumnDef } from "../resources/registry";
import { StatusText } from "../resources/columns";
import type { Tone } from "../resources/status";
import { evaluate, fillTemplate, numberOf, sumOf, valueAt, type RuleContext } from "./problemRules";
import { rowProblemStateNow, useRowProblemState } from "./rowProblems";
import { judgedFactAnywhere } from "./problemJudges";
import { extensionCategories } from "../features/problems/extensionCategories";
import { cleanText } from "../resources/uri";
import { currentLanguage, formatDateTime, formatList } from "../i18n/format";
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

/**
 * An item's text by the first of `cases` that holds on it, its placeholders filled from the item (#404): an object
 * item's paths, or a text item as `{{.}}` (ADR-0167 amendment); `$…` reads `root`, the column's object.
 */
function itemText(
  cases: readonly { when: ColumnCase["when"]; text: string; value?: string }[],
  item: unknown,
  now: number,
  root: KubeObject,
  siblings: readonly unknown[],
): string | undefined {
  return itemWritten(cases, item, now, root, siblings)?.text;
}

/**
 * An item's text and what it gives the column's value (ADR-0172): its case's `value` filled from the item, else its
 * text; `undefined` when no case holds.
 */
function itemWritten(
  cases: readonly { when: ColumnCase["when"]; text: string; value?: string }[],
  item: unknown,
  now: number,
  root: KubeObject,
  siblings: readonly unknown[],
): { text: string; value: string } | undefined {
  const scalar = typeof item === "string" || typeof item === "number" || typeof item === "boolean";
  if (!scalar && (item === null || typeof item !== "object" || Array.isArray(item))) return undefined;
  const obj = item as KubeObject;
  for (const c of cases) {
    if (!holdsNow(c, obj, now)) continue;
    const filled = c.text.includes("{{") ? fillTemplate(c.text, item, { root, siblings }) : c.text;
    if (filled === null) continue;
    const value = c.value === undefined ? filled : c.value.includes("{{") ? fillTemplate(c.value, item, { root, siblings }) : c.value;
    return { text: filled, value: value ?? filled };
  }
  return undefined;
}

/** A case's text by the CLDR plural form of its `pluralBy` in the UI language (#404), else its `text`. */
function caseText(c: ColumnCase, obj: KubeObject): string {
  if (c.pluralBy === undefined || c.textForms === undefined) return c.text;
  const n = numberOf(valueAt(obj, c.pluralBy));
  if (n === undefined) return c.text;
  let form = "other";
  try {
    form = new Intl.PluralRules(currentLanguage()).select(n);
  } catch {
    // An odd language tag: `other`.
  }
  return (c.textForms as Record<string, string | undefined>)[form] ?? c.text;
}

/** Whether a case's condition holds at `now` (a condition holding only from or until a time counts within it). */
function holdsNow(c: Pick<ColumnCase, "when">, obj: KubeObject, now: number, ctx: RuleContext = {}): boolean {
  const verdict = evaluate(c.when, obj, ctx);
  if (!verdict.holds) return false;
  if (verdict.activeFrom !== undefined && verdict.activeFrom > now) return false;
  return verdict.until === undefined || verdict.until > now;
}

/**
 * The case that replaces the value, if one holds, with its text filled from the object (#368): a case whose
 * placeholder has no value does not hold.
 */
function caseOf(column: ColumnContribution, obj: KubeObject, now: number, ctx: RuleContext = {}): ColumnCase | undefined {
  for (const c of column.cases ?? []) {
    if (!holdsNow(c, obj, now, ctx)) continue;
    const template = caseText(c, obj);
    // The texts of the facts its `judged` conditions name (ADR-0172), put in last.
    const facts = caseFacts(c.when, obj, ctx);
    const filled = template.includes("{{") ? withFactTexts(template, facts, (piece) => fillCaseText(piece, column, obj, now)) : template;
    if (filled === null) continue;
    // A tooltip whose placeholder has no value leaves the column's own tooltip (#380); with `tooltipOr` (#403) an empty
    // value skips to the next one.
    const tooltip =
      c.tooltip === undefined
        ? undefined
        : c.tooltipOr === undefined
          ? withFactTexts(c.tooltip, facts, (piece) => fillTemplate(piece, obj))
          : ([c.tooltip, ...c.tooltipOr].map((t) => fillTemplate(t, obj, { emptyIsMissing: true })).find((t) => t !== null) ?? null);
    return {
      ...c,
      text: filled === template ? template : (textOf(cleanText(filled) ?? "") ?? ""),
      tooltip: tooltip === null || tooltip === undefined ? undefined : (textOf(cleanText(tooltip) ?? "", MAX_TOOLTIP_CHARS) ?? undefined),
    };
  }
  return undefined;
}

/** The `judged` conditions of a case's `when` (ADR-0172), as `[judge, fact]`, nested ones included. */
export function judgedPairs(condition: ProblemCondition): [string, string][] {
  if (condition.type === "judged") return [[condition.judge, condition.fact]];
  if (condition.type === "all" || condition.type === "any") return condition.of.flatMap(judgedPairs);
  return condition.type === "not" ? judgedPairs(condition.of) : [];
}

/** The texts of the facts a case's `judged` conditions give the row (ADR-0172), merged in their order. */
function caseFacts(when: ProblemCondition, obj: KubeObject, ctx: RuleContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [judge, fact] of judgedPairs(when)) {
    const values = ctx.judged?.(obj, judge, fact);
    if (values) for (const [name, text] of Object.entries(values)) out[name] ??= text;
  }
  return out;
}

/** `{{fact:<name>}}` in a case's text (ADR-0172), with or without spaces inside. */
const FACT_TEXT = /\{\{\s*fact:([^}]*?)\s*\}\}/g;

/**
 * A text whose `{{fact:<name>}}` placeholders take the fact's texts last (ADR-0172), so that cluster text in them is
 * never read as a placeholder; the rest filled by `fill`. `null` when a piece or a fact has no value.
 */
function withFactTexts(template: string, facts: Record<string, string>, fill: (piece: string) => string | null): string | null {
  if (!template.includes("fact:")) return fill(template);
  const out: string[] = [];
  let last = 0;
  for (const m of template.matchAll(FACT_TEXT)) {
    const piece = template.slice(last, m.index);
    const filled = piece.includes("{{") ? fill(piece) : piece;
    const fact = facts[m[1]!.trim()];
    if (filled === null || fact === undefined) return null;
    out.push(filled, fact);
    last = m.index + m[0].length;
  }
  const tail = template.slice(last);
  const filled = tail.includes("{{") ? fill(tail) : tail;
  if (filled === null) return null;
  out.push(filled);
  return out.join("");
}

/** `{{value}}` in a case's text (ADR-0169), with or without spaces inside. */
const OWN_TEXT = /\{\{\s*value\s*\}\}/;

/**
 * A case's text filled from the object; `{{value}}` (ADR-0169) is the text the cell shows when no case holds, put in
 * after the rest is filled so that cluster text in it is never read as a placeholder. `null` when a placeholder (or the
 * cell's own text) has no value.
 */
function fillCaseText(template: string, column: ColumnContribution, obj: KubeObject, now: number): string | null {
  if (!OWN_TEXT.test(template)) return fillTemplate(template, obj);
  const pieces = template.split(new RegExp(OWN_TEXT.source, "g")).map((piece) => (piece.includes("{{") ? fillTemplate(piece, obj) : piece));
  if (pieces.some((piece) => piece === null)) return null;
  const own = plainCell(column, obj, now).text;
  return own === undefined ? null : pieces.join(own);
}

/** What a cell is: its sort value, its text for search and copying, and how it draws. */
interface Cell {
  sort: string | number | undefined;
  text: string | undefined;
  draw: ReactNode;
}

/**
 * A `list` or `firstPlus` column's texts (#395, #404): a list of scalars, anything else in it left out; `undefined`
 * without a list or with no text. `joinPaths` (#404): every path's items in order, each once (a listener declared and
 * one only in the status), or every repeat with `"keep"`; `items` write each item by the first case holding on it.
 */
function listTexts(column: ColumnContribution, obj: KubeObject, value: unknown, now: number): string[] | undefined {
  return listItems(column, obj, value, now)?.map((item) => item.text);
}

/** A list column's items as {@link listTexts} gives them, each with what it gives the column's value (ADR-0172). */
function listItems(column: ColumnContribution, obj: KubeObject, value: unknown, now: number): { text: string; value: string }[] | undefined {
  // With `items`, a joined path holding one object is a list of it (ADR-0167 amendment): a Route's `spec.to` before
  // its `spec.alternateBackends`.
  const asList = (v: unknown): unknown => (column.items && v !== null && typeof v === "object" && !Array.isArray(v) ? [v] : v);
  const lists =
    column.joinPaths !== undefined && column.joinPaths !== false ? (column.paths ?? []).map((p) => asList(valueAt(obj, p))).filter(Array.isArray) : [value];
  if (!lists.some(Array.isArray)) return undefined;
  const all = lists.flatMap((list) => (Array.isArray(list) ? list : []));
  // `items` (#404): each item written by the first case holding on it; an item none holds for is left out.
  const texts: ({ text: string; value: string } | undefined)[] = column.items
    ? (() => {
        // `|share` reads the items the column writes (one a case holds for), as a Route's named backends.
        const written = all.filter((item) => column.items!.cases.some((c) => item !== null && typeof item === "object" && holdsNow(c, item as KubeObject, now)));
        return all.map((item) => itemWritten(column.items!.cases, item, now, obj, written));
      })()
    : all.filter((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean").map((v) => ({ text: String(v), value: String(v) }));
  const cleaned = texts
    .map((v) => (v === undefined ? undefined : { text: cleanText(v.text) ?? "", value: cleanText(v.value) ?? "" }))
    .filter((v): v is { text: string; value: string } => v !== undefined && v.text !== "");
  // Joined lists name each item once (a listener declared and in the status); one list keeps its repeats (#404), and
  // so does `"keep"` (an identity written both ways, as the built-in Linkerd view).
  const once = column.joinPaths === true ? cleaned.filter((v, i) => cleaned.findIndex((w) => w.text === v.text) === i) : cleaned;
  // `sorted` (#404): in the UI language's order, as a built-in view sorted a stream's tags.
  const collator = new Intl.Collator(currentLanguage());
  const shown = column.sorted ? [...once].sort((a, b) => collator.compare(a.text, b.text)) : once;
  return shown.length === 0 ? undefined : shown;
}

/** A `firstPlus` column's hover: every item on a line of its own, as Sextant's own hosts columns. */
function firstPlusTooltip(column: ColumnContribution, obj: KubeObject, now: number): string | undefined {
  const looked = column.lookup === undefined ? undefined : lookupValue(obj, column.lookup);
  const shown = listTexts(column, obj, looked !== undefined && looked !== null ? looked : firstValue(obj, column.paths), now);
  return shown && textOf(shown.join("\n"), MAX_TOOLTIP_CHARS);
}

/** The tone `tones` gives a shown value; `"*"` the tone of any other value (#403). */
function toneOf(column: ColumnContribution, value: string | undefined): Tone | undefined {
  const named = value !== undefined ? (column.tones?.[value] ?? column.tones?.["*"]) : undefined;
  return named ? TONES[named] : undefined;
}

function cellOf(column: ColumnContribution, obj: KubeObject, now: number, ctx: RuleContext = {}): Cell {
  const replaced = caseOf(column, obj, now, ctx);
  const tone = (value: string | undefined) => toneOf(column, value);
  // A blank case (ADR-0172): no value at all while it holds — nothing shown, sorted last, filtered as nothing.
  if (replaced?.blank === true) return { sort: undefined, text: undefined, draw: null };
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
  return plainCell(column, obj, now);
}

/** A cell as its value shows it, no case considered. */
function plainCell(column: ColumnContribution, obj: KubeObject, now: number): Cell {
  const tone = (value: string | undefined) => toneOf(column, value);
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
      // `sortAs: "time"` (ADR-0172): by the time itself, the oldest first, as a built-in column sorted its timestamp.
      return { sort: column.sortAs === "time" ? t : -t, text: undefined, draw: <Age timestamp={value as string} now={now} /> };
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
    case "list":
    case "firstPlus": {
      const shown = listTexts(column, obj, value, now);
      if (shown === undefined) return { sort: undefined, text: undefined, draw: null };
      // `firstPlus` (ADR-0167 amendment): the first and "+N" for the rest, as Sextant's own hosts columns; sorted and
      // searched by that text, every item on a line of the hover.
      if (column.format === "firstPlus") {
        const [first, ...rest] = shown;
        const text = textOf(rest.length > 0 ? `${first} +${rest.length}` : first) ?? "";
        return { sort: text, text, draw: text };
      }
      const separator = column.items?.separator ?? column.separator;
      const join = (parts: readonly string[]) => textOf(separator === undefined ? formatList(parts) : parts.join(separator)) ?? "";
      const text = join(shown);
      // What the items give the column's value (ADR-0172): its sort, and its filter and search by `"value"`.
      const valued = column.items?.cases.some((c) => c.value !== undefined) ? (listItems(column, obj, value, now) ?? []).map((item) => item.value) : undefined;
      return { sort: valued === undefined ? text : join(valued), text, draw: text };
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
      const keys = Object.keys(map).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const items = column.items
        ? entryTexts(column.items, obj, map, keys, now)
        : keys
            .filter((k) => typeof map[k] === "string" || typeof map[k] === "number" || typeof map[k] === "boolean")
            .map((k) => cleanText(`${k}=${String(map[k])}`) ?? "");
      if (items.length === 0) return { sort: undefined, text: undefined, draw: null };
      const separator = column.items?.separator ?? column.separator;
      const text = textOf(separator === undefined ? formatList(items) : items.join(separator)) ?? "";
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

/**
 * An entries column's item texts (ADR-0169): each entry, in key order, is the item `{key, value}` with the value of
 * every `with` map at the same key under its name, written by the first case holding on it; one none holds for is
 * left out.
 */
function entryTexts(
  items: NonNullable<ColumnContribution["items"]>,
  obj: KubeObject,
  map: Record<string, unknown>,
  keys: readonly string[],
  now: number,
): string[] {
  const others = Object.entries(items.with ?? {}).map(([name, path]) => [name, valueAt(obj, path)] as const);
  const entries = keys.map((key) => {
    const item: Record<string, unknown> = { key, value: map[key] };
    for (const [name, other] of others) {
      if (other !== null && typeof other === "object" && !Array.isArray(other) && Object.prototype.hasOwnProperty.call(other, key)) {
        item[name] = (other as Record<string, unknown>)[key];
      }
    }
    return item;
  });
  const written = entries.filter((item) => items.cases.some((c) => holdsNow(c, item as KubeObject, now)));
  return entries.map((item) => cleanText(itemText(items.cases, item, now, obj, written) ?? "") ?? "").filter((t) => t !== "");
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

/** Whether a condition asks what the extension's rules say of the row (`problem`, ADR-0169). */
function asksProblems(condition: ProblemCondition): boolean {
  if (condition.type === "problem") return true;
  if (condition.type === "all" || condition.type === "any") return condition.of.some(asksProblems);
  return condition.type === "not" && asksProblems(condition.of);
}

/**
 * The cell of a column whose cases ask a judge (ADR-0172): it holds the extension's problem sources while shown, which
 * feed the judge, and is drawn again when they change (an answer makes the store look again).
 */
function JudgedCaseCell({ column, obj, ctx, extensionId, ruleCtx }: { column: ColumnContribution; obj: KubeObject; ctx: CellContext; extensionId: string; ruleCtx: RuleContext }) {
  useRowProblemState(ctx.clusterId, extensionId, ctx.kind);
  return <>{drawCell(column, obj, ctx.now, ruleCtx)}</>;
}

/** A cell drawn with its hover. */
function drawCell(column: ColumnContribution, obj: KubeObject, now: number, ruleCtx: RuleContext = {}): ReactNode {
  const format = column.format ?? "text";
  const cell = cellOf(column, obj, now, ruleCtx);
  // Cluster text is cleaned wherever it shows, as case texts are: no credentials of a URI in a hover.
  const tooltip = textOf(cleanText(textOf(firstValue(obj, column.tooltipPaths), MAX_TOOLTIP_CHARS)), MAX_TOOLTIP_CHARS);
  // A list's hover is its whole text when it has none of its own (#404): a cell may cut it.
  const title =
    caseOf(column, obj, now, ruleCtx)?.tooltip ??
    tooltip ??
    (column.tooltipPaths !== undefined || column.listTooltip === false ? undefined : format === "list" ? cell.text : format === "firstPlus" && cell.text !== undefined ? firstPlusTooltip(column, obj, now) : undefined);
  return title === undefined ? cell.draw : <span title={title}>{cell.draw}</span>;
}

/** A cell of a column whose cases ask what the extension's rules say of the row (ADR-0169). */
function ProblemCaseCell({ column, obj, ctx, extensionId }: { column: ColumnContribution; obj: KubeObject; ctx: CellContext; extensionId: string }) {
  const problemState = useRowProblemState(ctx.clusterId, extensionId, ctx.kind);
  return <>{drawCell(column, obj, ctx.now, { problemState })}</>;
}

/** Holds the extension's problem sources while a filter needs a `problem` column's values (ADR-0169). */
function problemObserver(extensionId: string) {
  return function ProblemObserver({ context, onChange }: { context: CellContext; onChange: () => void }) {
    useRowProblemState(context.clusterId, extensionId, context.kind, onChange);
    return null;
  };
}

/**
 * The table column of a computed contribution, under the registry id `id`. A column whose cases ask what the
 * extension's rules say (`problem`, ADR-0169) reads the problems of the extension `extensionId`: it holds them while
 * shown, does not sort (as the built-in "References" column), and is searched by nothing.
 */
export function computedColumn(id: string, column: ColumnContribution, ownIds?: (id: string) => string | undefined, extensionId?: string): ColumnDef {
  const format = column.format ?? "text";
  const timed = format === "age" || format === "duration" || (column.cases ?? []).length > 0;
  // A judge's answer for the row (ADR-0172), read where any cluster's runner has it: a row's uid names one object.
  const judging = extensionId !== undefined && (column.cases ?? []).some((c) => judgedPairs(c.when).length > 0);
  const judgedCtx: RuleContext = judging
    ? { judged: (obj, judge, fact) => (obj.metadata?.uid ? judgedFactAnywhere(extensionId!, judge, fact, obj.metadata.uid) : null) }
    : {};
  if (extensionId !== undefined && (column.cases ?? []).some((c) => asksProblems(c.when))) {
    const ruleCtx = (ctx: CellContext): RuleContext => ({
      problemState: (obj) => rowProblemStateNow(ctx.clusterId, extensionId, extensionCategories(), ctx.kind, obj),
    });
    return {
      id,
      title: column.title,
      ...placement(column, ownIds),
      ...(column.width !== undefined ? { width: column.width } : {}),
      fallback: "end",
      sortable: false,
      value: () => undefined,
      render: (obj, ctx) => <ProblemCaseCell column={column} obj={obj} ctx={ctx} extensionId={extensionId} />,
      filter: {
        type: "string",
        value: (obj, ctx) => (column.filterBy === "value" ? filterValue(cellOf(column, obj, ctx.now, ruleCtx(ctx))) : cellOf(column, obj, ctx.now, ruleCtx(ctx)).text),
        observer: problemObserver(extensionId),
      },
    };
  }
  return {
    id,
    title: column.title,
    ...placement(column, ownIds),
    // As Sextant's own columns give theirs (#403); Rust and the SDK checked its shape.
    ...(column.width !== undefined ? { width: column.width } : {}),
    fallback: "end",
    // Sorting and the default text; a time-dependent cell sorts as of now.
    value: (obj) => cellOf(column, obj, Date.now(), judgedCtx).sort,
    render: (obj, ctx) =>
      judging ? <JudgedCaseCell column={column} obj={obj} ctx={ctx} extensionId={extensionId!} ruleCtx={judgedCtx} /> : drawCell(column, obj, ctx.now),
    searchText: (obj, ctx) => {
      const cell = cellOf(column, obj, ctx.now, judgedCtx);
      // A column searched by its cases' values is found by them, not the words shown (a state's name in every
      // language, as some built-in columns were).
      if (column.searchBy === "value") return filterValue(cell);
      if (cell.text !== undefined) return cell.text;
      // An age sorts by the negated time (its age is now + sort), a duration by its length.
      const ms = format === "age" ? ageMs(column, cell.sort, ctx.now) : format === "duration" ? numericSort(cell.sort) : undefined;
      if (ms === undefined) return undefined;
      const { unit, count } = ageParts(ms);
      return ctx.t(`common:age.${unit}`, { count });
    },
    searchTextTimed: timed,
    filter: withJudgeObserver(
      judging ? extensionId : undefined,
      // A count, a sum or a quantity filters as a number (#404), as a number column does.
      format === "number" || format === "ratio" || format === "count" || format === "sum" || format === "cpu" || format === "bytes"
        ? { type: "number", value: (obj, ctx) => numericSort(cellOf(column, obj, ctx.now, judgedCtx).sort) }
        : format === "age"
          ? { type: "age", value: (obj, ctx) => ageMs(column, cellOf(column, obj, ctx.now, judgedCtx).sort, ctx.now) }
          : format === "duration"
            ? { type: "number", value: (obj, ctx) => numericSort(cellOf(column, obj, ctx.now, judgedCtx).sort) }
            : column.filterBy === "value"
              ? // The cases' values, not the translated texts (#404): a state's name in every language.
                { type: "string", value: (obj, ctx) => filterValue(cellOf(column, obj, ctx.now, judgedCtx)) }
              : { type: "string", value: (obj, ctx) => cellOf(column, obj, ctx.now, judgedCtx).text },
    ),
  };
}

/** A filter of a column whose cases ask a judge holds the extension's problem sources while it needs values (ADR-0172). */
function withJudgeObserver(extensionId: string | undefined, filter: NonNullable<ColumnDef["filter"]>): NonNullable<ColumnDef["filter"]> {
  return extensionId === undefined ? filter : { ...filter, observer: problemObserver(extensionId) };
}

/** The sort key as text; a case whose key has no value leaves nothing to filter by (#404), as the built-in had. */
function filterValue(cell: Cell): string | undefined {
  return cell.sort === undefined ? undefined : String(cell.sort);
}

function numericSort(sort: string | number | undefined): number | undefined {
  return typeof sort === "number" ? sort : undefined;
}

/** An age cell sorts by the negated time (by the time with `sortAs: "time"`, ADR-0172); its filter value is the age in ms. */
function ageMs(column: ColumnContribution, sort: string | number | undefined, now: number): number | undefined {
  if (typeof sort !== "number") return undefined;
  return Math.max(0, column.sortAs === "time" ? now - sort : now + sort);
}
