// Small DOM and formatting helpers the views share; the blocks, fields, tables, status words and links are the SDK's
// UI kit (`ui`, ADR-0160).
import { isSextantError } from "@sextant/extension-sdk";
import { i18n, t } from "./i18n";
import { durationParts } from "./model";

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

/** A duration in the largest whole unit, as Sextant writes ages ("45s", "3m", "2h" in English). */
export function durationText(ms: number): string {
  const { unit, count } = durationParts(ms);
  return t(`age.${unit}`, { count });
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
  const ms = time ? Date.parse(time) : Number.NaN;
  if (Number.isNaN(ms)) return null;
  return element("time", { dateTime: time!, textContent: i18n().formatDateTime(ms, DATE_TIME) });
}

/** An RFC 3339 time as an age ("7h"), the time itself on hover; nothing for no time. */
export function age(time: string | undefined, now: number): HTMLElement | null {
  const ms = time ? Date.parse(time) : Number.NaN;
  if (Number.isNaN(ms)) return null;
  return element("time", { dateTime: time!, textContent: durationText(now - ms), title: time! });
}

export function errorText(err: unknown): string {
  if (isSextantError(err, "denied")) return t("error.denied", { message: err.message });
  if (isSextantError(err, "forbidden")) return t("error.forbidden", { message: err.message });
  return err instanceof Error ? err.message : String(err);
}
