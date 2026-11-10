// Small DOM helpers the views share; the blocks, fields, tables, status words and links are the SDK's UI kit (`ui`,
// ADR-0160). The phrases, notes and stacked lines are drawn in the built-in autoscaling view's own styles (`style.css`).
import { isSextantError, ui, type Sextant, type UiContent } from "@sextant/extension-sdk";
import { i18n, t } from "./i18n";
import type { KindRef, Phrase } from "./model";

type Child = Node | string | null | undefined | false;

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

/** A phrase in its tone: a bar on its left, as the built-in view's `PhraseLine`. */
export const phraseLine = (p: Phrase): HTMLElement => element("p", { className: `as-phrase as-phrase--${p.tone ?? "neutral"}`, textContent: t(p.key, p.params ?? {}) });

/** Phrases one under the other. */
export const phraseLines = (phrases: readonly Phrase[]): HTMLElement[] => phrases.map(phraseLine);

/** Lines one under the other in one field (a NodePool's budgets). */
export const lines = (texts: readonly string[]): HTMLElement => element("span", { className: "as-lines" }, ...texts.map((text) => element("span", { textContent: text })));

/** Names joined with the UI language's list separator, as Sextant's `formatList`. */
export const formatList = (items: readonly string[]): string => items.join(t("list.separator"));

/** The date and time in the UI language's default style, as Sextant's `formatDateTime` (`toLocaleString`). */
export const DATE_TIME: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
};

/** An RFC 3339 time as a date and time in the UI language; the text itself when it is no time. */
export function dateTimeText(time: string): string {
  const ms = Date.parse(time);
  return Number.isNaN(ms) ? time : i18n().formatDateTime(ms, DATE_TIME);
}

export type AgeUnit = "seconds" | "minutes" | "hours" | "days" | "years";

/** The largest whole unit of a duration, as Sextant's ages are written ("5m", "3h", "2d"). */
export function ageParts(ms: number): { unit: AgeUnit; count: number } {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return { unit: "seconds", count: s };
  const m = Math.floor(s / 60);
  if (m < 60) return { unit: "minutes", count: m };
  const h = Math.floor(m / 60);
  if (h < 24) return { unit: "hours", count: h };
  const d = Math.floor(h / 24);
  if (d < 365) return { unit: "days", count: d };
  return { unit: "years", count: Math.floor(d / 365) };
}

/** An RFC 3339 time as an age ("5m"), the time itself on hover, as Sextant's `Age`; nothing for no time. */
export function age(time: string | undefined, now = Date.now()): HTMLElement | null {
  if (!time) return null;
  const ms = Date.parse(time);
  if (Number.isNaN(ms)) return null;
  const { unit, count } = ageParts(now - ms);
  return element("time", { dateTime: time, title: time, textContent: t(`age.${unit}`, { count }) });
}

/** A muted note under a block. */
export const note = (text: string): HTMLElement => element("p", { className: "as-note", textContent: text });

/** Text in the warning colour (an event's reason, a metric without a value). */
export const warning = (text: string): HTMLElement => element("span", { className: "as-warning", textContent: text });

/** A link to an object's details in Sextant's panel; nothing without a name. */
export function link(sextant: Sextant, kind: KindRef, name: string | undefined, namespace: string | null = null, text?: string): HTMLElement | null {
  if (!name) return null;
  const button = ui.objectLink(sextant, { kind, namespace, name }, text ?? name);
  button.setAttribute("aria-label", t("openObject", { kind: kind.kind, name }));
  return button;
}

/** `ui.fields` labelled from `fields.<key>`, or nothing when no row has a value. */
export function fieldsOf(rows: readonly (readonly [string, UiContent])[]): HTMLElement | null {
  const list = ui.fields(rows.map(([key, value]) => [t(`fields.${key}`), value] as const));
  return list.childElementCount > 0 ? list : null;
}

/**
 * A table whose columns marked `true` stay on one line and the others wrap between words, its column widths resized and
 * remembered under `id` (the built-in table's own word); nothing without rows (as the built-in `table`).
 */
export function tableOf(
  sextant: Sextant,
  id: string,
  headers: readonly string[],
  rows: readonly (readonly UiContent[])[],
  nowrap: readonly boolean[],
): HTMLElement | null {
  if (rows.length === 0) return null;
  return ui.table(headers, rows, { id, sextant, nowrap });
}

/**
 * Which blocks are open, and where a toggle goes: Sextant's own memory of details sections (`context.blocks`, written
 * by `ui.setBlockOpen`), with the panel's "Expand all" and "Collapse all" — where the built-in blocks were kept.
 */
export interface BlockMemory {
  isOpen(block: string): boolean;
  setOpen(block: string, open: boolean): void;
}

/** Blocks that are all open and remember nothing. */
export const OPEN_BLOCKS: BlockMemory = { isOpen: () => true, setOpen: () => undefined };

/**
 * A titled block as the built-in view's: open unless Sextant remembers it closed, and closable with its title. Its
 * content is drawn only while it is open, as the built-in block's was (the section draws again on each toggle).
 */
export function block(memory: BlockMemory, id: string, title: string, content: () => UiContent): HTMLElement {
  const open = memory.isOpen(id);
  const node = ui.block(title, open ? content() : null, { collapsible: true, collapsed: !open, onToggle: (now) => memory.setOpen(id, now) });
  node.dataset.block = id;
  return node;
}

/** The error codes Sextant names in their own words (`error.code.<code>`); `other` is "Something went wrong.". */
export const ERROR_CODES = ["unreachable", "unauthorized", "forbidden", "notFound", "conflict", "invalid", "authPlugin", "helmMissing", "portInUse", "kubeconfig", "timeout"] as const;

/**
 * Why a list could not be read, as the built-in block's error state showed it: what the error's code means, then
 * "Details: <message>" — "Something went wrong." alone where nothing says why (a namespace refused, the watch
 * reconnecting). A refusal of Sextant's own (`denied`) says so with its message.
 */
export function codedError(err: { code?: string; message?: string } | undefined): HTMLElement {
  if (isSextantError(err, "denied")) return ui.errorState(t("error.denied", { message: err.message }));
  const code = err?.code ?? "other";
  const known = (ERROR_CODES as readonly string[]).includes(code);
  const node = element(
    "div",
    { className: "as-error" },
    element("p", { className: "sx-error", textContent: known ? t(`error.code.${code}`) : t("error.unknown") }),
    err?.message ? note(t("error.details", { message: err.message })) : null,
  );
  node.setAttribute("role", "alert");
  node.dataset.code = code;
  return node;
}

export function errorText(err: unknown): string {
  if (isSextantError(err, "denied")) return t("error.denied", { message: err.message });
  if (isSextantError(err, "forbidden")) return t("error.forbidden", { message: err.message });
  return err instanceof Error ? err.message : String(err);
}
