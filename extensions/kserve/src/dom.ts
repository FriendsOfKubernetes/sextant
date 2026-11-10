// Small DOM and formatting helpers the views share; the blocks, fields, tables, status words and links are the SDK's
// UI kit (`ui`, ADR-0160).
import { isSextantError, ui, type Sextant, type UiContent } from "@sextant/extension-sdk";
import { i18n, t } from "./i18n";
import type { KindRef } from "./model";
import { safeUri } from "./uri";

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

/** The date and time in the UI language's default style, as Sextant's `formatDateTime` (`toLocaleString`). */
export const DATE_TIME: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
};

/** An RFC 3339 time as a date and time; nothing for no time. */
export function dateTime(time: string | undefined): HTMLElement | null {
  if (!time) return null;
  const ms = Date.parse(time);
  if (Number.isNaN(ms)) return element("time", { dateTime: time, textContent: time });
  return element("time", { dateTime: time, textContent: i18n().formatDateTime(ms, DATE_TIME) });
}

/** Text from the cluster longer than this is cut in a details view (the YAML section has all of it). */
export const MAX_TEXT = 20_000;
export const clip = (text: string): string => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);

/** A remark in KServe's words that needs attention (a coloured bar on its left). */
export const note = (text: string, tone: "warning" | "danger"): HTMLElement => element("p", { className: `ks-note ks-note--${tone}`, textContent: clip(text) });

/** A muted remark. */
export const remark = (text: string): HTMLElement => element("p", { className: "ks-muted", textContent: text });

/** A URI without userinfo, query and fragment, and a word when something was left out; nothing for no value. */
export function uri(value: string | undefined): HTMLElement | null {
  const safe = value ? safeUri(value) : undefined;
  if (!safe) return null;
  return element(
    "span",
    { className: "ks-uri" },
    element("code", { textContent: safe.text }),
    safe.hidden && element("span", { className: "ks-hint", textContent: t("uriHidden") }),
  );
}

/** Names joined with the UI language's list separator, as Sextant's `formatList`. */
export const formatList = (items: readonly string[]): string => items.join(t("listSeparator"));

/** A link to an object's details in Sextant's panel, named by its name; nothing without a name. */
export function link(sextant: Sextant, kind: KindRef, name: string | undefined, namespace: string | null = null): HTMLElement | null {
  if (!name) return null;
  const button = ui.objectLink(sextant, { kind, namespace, name }, name);
  button.setAttribute("aria-label", t("openObject", { kind: kind.kind, name }));
  return button;
}

/** Several links in a wrapping row; nothing when there are none. */
export const links = (nodes: (HTMLElement | null)[]): HTMLElement | null => {
  const shown = nodes.filter((n): n is HTMLElement => n !== null);
  return shown.length > 0 ? ui.inline(shown) : null;
};

/** `ui.fields` labelled from `<prefix><key>`, or nothing when no row has a value. */
export function fieldsOf(rows: readonly (readonly [string, UiContent])[], prefix = "fields."): HTMLElement | null {
  const list = ui.fields(rows.map(([key, value]) => [t(`${prefix}${key}`), value] as const));
  return list.childElementCount > 0 ? list : null;
}

/**
 * A table, or nothing without rows (as the built-in details' `table`): words kept whole, the columns `nowrap` marks on
 * one line; its columns resize and Sextant keeps their widths under `id` (by position, as the built-in
 * `details:kserve<Id>` kept them).
 */
export function tableOf(
  sextant: Sextant,
  id: string,
  headers: string[],
  rows: UiContent[][],
  label: string,
  nowrap: readonly boolean[],
): HTMLElement | null {
  return rows.length > 0 ? ui.table(headers, rows, { label, id, sextant, nowrap }) : null;
}

/**
 * Which blocks are open, and where a toggle goes: Sextant's own memory of details sections (`context.blocks`, written
 * by `ui.setBlockOpen`), kept per kind as Settings → Appearance says, with the panel's "Expand all" and "Collapse
 * all" — where the built-in section's blocks were kept.
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

export function errorText(err: unknown): string {
  if (isSextantError(err, "denied")) return t("error.denied", { message: err.message });
  if (isSextantError(err, "forbidden")) return t("error.forbidden", { message: err.message });
  return err instanceof Error ? err.message : String(err);
}

