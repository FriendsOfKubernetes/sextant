// Small DOM and formatting helpers the views share; the blocks, fields, tables, status words and links are the SDK's
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

/** "40 seconds ago", "12 minutes ago", "3 hours ago", "2 days ago", in the UI language. */
export function formatAgo(ms: number, now: number): string {
  const seconds = Math.round((now - ms) / 1000);
  const words = new Intl.RelativeTimeFormat(i18n().language, { numeric: "always" });
  if (Math.abs(seconds) < 90) return words.format(-seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 90) return words.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 36) return words.format(-hours, "hour");
  return words.format(-Math.round(hours / 24), "day");
}

/** An RFC 3339 time as an age with the exact time on hover; nothing for no time. */
export function ago(time: string | undefined, now: number): HTMLElement | null {
  const ms = time ? Date.parse(time) : Number.NaN;
  if (Number.isNaN(ms)) return null;
  return element("time", {
    dateTime: time!,
    textContent: formatAgo(ms, now),
    title: i18n().formatDateTime(ms, { dateStyle: "medium", timeStyle: "medium" }),
  });
}

export function errorText(err: unknown): string {
  if (isSextantError(err, "denied")) return t("error.denied", { message: err.message });
  if (isSextantError(err, "forbidden")) return t("error.forbidden", { message: err.message });
  return err instanceof Error ? err.message : String(err);
}
