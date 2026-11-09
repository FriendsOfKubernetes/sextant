// Small DOM and formatting helpers the details share; the blocks, fields, tables, status words and links are the SDK's
// UI kit (`ui`, ADR-0160).
import { isSextantError } from "@sextant/extension-sdk";
import { i18n, t } from "./i18n";

type Child = Node | string | null | undefined | false;

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const { dataset, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (dataset) Object.assign(node.dataset, dataset);
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

/** Items joined with the language's list separator (", " in English, "、" in Japanese), as Sextant's `formatList`. */
export const formatList = (items: readonly string[]): string => items.join(t("list.separator"));

/** Parts of one line joined with the language's " · ", as Sextant's `formatParts`. */
export const formatParts = (items: readonly string[]): string => items.join(t("list.dot"));

/** The date and time in the UI language's default style, as Sextant's `formatDateTime` (`toLocaleString`). */
export const DATE_TIME: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
};

/** An RFC 3339 time as a date and time; the text as it is when it is not one. */
export function dateTimeText(time: string): string {
  const ms = Date.parse(time);
  return Number.isNaN(ms) ? time : i18n().formatDateTime(ms, DATE_TIME);
}

export function errorText(err: unknown): string {
  if (isSextantError(err, "denied")) return t("error.denied", { message: err.message });
  if (isSextantError(err, "forbidden")) return t("error.forbidden", { message: err.message });
  return err instanceof Error ? err.message : String(err);
}
