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

/** A remark that needs attention: why a queue admits nothing or a Workload waits (a coloured bar on its left). */
export const note = (text: string, tone: "warning" | "danger"): HTMLElement => element("p", { className: `kueue-note kueue-note--${tone}`, textContent: text });

/** A muted remark. */
export const remark = (text: string): HTMLElement => element("p", { className: "kueue-muted", textContent: text });

/** `reason: message`, either may be missing. */
export const reasonText = (reason: string | undefined, message: string | undefined): string => [reason, message].filter(Boolean).join(": ");

export function errorText(err: unknown): string {
  if (isSextantError(err, "denied")) return t("error.denied", { message: err.message });
  if (isSextantError(err, "forbidden")) return t("error.forbidden", { message: err.message });
  return err instanceof Error ? err.message : String(err);
}
