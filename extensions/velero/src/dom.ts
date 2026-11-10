// Small DOM and formatting helpers the views share; blocks, fields, status words and links are the SDK's UI kit
// (`ui`, ADR-0160).
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

/** Items joined with the UI language's list separator, as Sextant's `formatList` ("a, b"; "a、b" in Japanese). */
export const formatList = (items: readonly string[]): string => items.join(t("list.separator"));

/** The largest whole unit of a duration, as Sextant writes ages. */
export function durationParts(ms: number): { unit: "seconds" | "minutes" | "hours" | "days" | "years"; count: number } {
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
  const { unit, count } = durationParts(now - ms);
  return element("time", { dateTime: time!, textContent: t(`age.${unit}`, { count }), title: time! });
}

export function errorText(err: unknown): string {
  if (isSextantError(err, "denied")) return t("error.denied", { message: err.message });
  if (isSextantError(err, "forbidden")) return t("error.forbidden", { message: err.message });
  return err instanceof Error ? err.message : String(err);
}
