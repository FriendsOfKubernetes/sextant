// Small DOM and formatting helpers the views share; the blocks, fields, tables, status words and links are the SDK's
// UI kit (`ui`, ADR-0160).
import { isSextantError, ui, type Sextant, type UiContent } from "@sextant/extension-sdk";
import { i18n, t } from "./i18n";
import type { KindOf } from "./model";

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

/** The scheduler's or the driver's words that need attention (a red bar on their left). */
export const message = (text: string): HTMLElement => element("p", { className: "dra-message", textContent: text });

/** A remark in plain words (a yellow bar on its left). */
export const note = (text: string): HTMLElement => element("p", { className: "dra-note", textContent: text });

/** A muted remark. */
export const remark = (text: string): HTMLElement => element("p", { className: "dra-muted", textContent: text });

/** A link to an object's details in Sextant's panel, as the built-in links: "Open <Kind> <name>"; nothing without a name. */
export function link(sextant: Sextant, kind: KindOf, name: string | undefined, namespace: string | null = null, text: string = name ?? ""): HTMLElement | null {
  if (!name) return null;
  const button = ui.objectLink(sextant, { kind, namespace, name }, text);
  button.setAttribute("aria-label", t("openObject", { kind: kind.kind, name }));
  return button;
}

/** A table of the UI kit whose columns `nowrap` (by position, from 1) do not wrap, as the built-in tables. */
export function table(className: string, headers: readonly string[], rows: readonly (readonly UiContent[])[], label: string): HTMLElement {
  const node = ui.table(headers, rows, { label });
  node.classList.add(className);
  return node;
}

export function errorText(err: unknown): string {
  if (isSextantError(err, "denied")) return t("error.denied", { message: err.message });
  if (isSextantError(err, "forbidden")) return t("error.forbidden", { message: err.message });
  return err instanceof Error ? err.message : String(err);
}

/** Content of the UI kit as nodes, for `replaceChildren`. */
export function flat(content: readonly UiContent[]): Node[] {
  const holder = document.createElement("div");
  const add = (item: UiContent) => {
    if (item === null || item === undefined || item === false) return;
    if (Array.isArray(item)) for (const inner of item as readonly UiContent[]) add(inner);
    else holder.append(typeof item === "string" || typeof item === "number" ? String(item) : (item as Node));
  };
  for (const item of content) add(item);
  return [...holder.childNodes];
}
