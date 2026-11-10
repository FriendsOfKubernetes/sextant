// Small DOM and formatting helpers the views share; the blocks, fields, tables, status words and links are the SDK's
// UI kit (`ui`, ADR-0160).
import { isSextantError } from "@sextant/extension-sdk";
import { i18n, t } from "./i18n";

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

/** Names joined as Sextant's `formatList` joins them (`common:list.separator`: ", ", "、"). */
export const formatList = (items: readonly string[]): string => items.join(t("list.separator"));

/** A paragraph of the view's own kinds, as the built-in view drew them (vpa-message, vpa-note, vpa-muted, vpa-danger). */
export const paragraph = (kind: "message" | "note" | "muted" | "danger", content: Child): HTMLElement => element("p", { className: `vpa-${kind}` }, content);

export function errorText(err: unknown): string {
  if (isSextantError(err, "denied")) return t("error.denied", { message: err.message });
  if (isSextantError(err, "forbidden")) return t("error.forbidden", { message: err.message });
  return err instanceof Error ? err.message : String(err);
}
