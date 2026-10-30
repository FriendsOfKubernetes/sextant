// Small DOM and formatting helpers the views share.
import { isSextantError, type ObjectRef, type Sextant } from "@sextant/extension-sdk";
import { i18n, t } from "./i18n";
import type { Tone } from "./rook";

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

/** Text in which `…` spans are code. */
export function richText(text: string): Node[] {
  return text.split(/(`[^`]+`)/).flatMap((part): Node[] => {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) return [element("code", { textContent: part.slice(1, -1) })];
    return part ? [document.createTextNode(part)] : [];
  });
}

/** The mark a translated sentence holds where links go (`t("…", { pod: LINK_MARK })`). */
export const LINK_MARK = "\u0000";

/** `text` with the links in place of its `LINK_MARK`, separated by commas: links inside a translated sentence. */
export function withLinks(text: string, links: readonly Node[]): Node[] {
  const at = text.indexOf(LINK_MARK);
  if (at < 0) return [document.createTextNode(text)];
  const middle = links.flatMap((link, i) => (i ? [document.createTextNode(", "), link] : [link]));
  return [document.createTextNode(text.slice(0, at)), ...middle, document.createTextNode(text.slice(at + LINK_MARK.length))];
}

/** A status word with its tone's colour (and the word itself, so colour is never the only sign). */
export function badge(text: string, tone: Tone): HTMLElement {
  return element("span", { className: `badge ${tone}`, textContent: text });
}

/** A link-styled button that opens an object's details in Sextant. */
export function objectLink(sextant: Sextant, ref: ObjectRef, text = ref.name): HTMLButtonElement {
  const button = element("button", { className: "link", type: "button", textContent: text });
  button.addEventListener("click", () => void sextant.ui.openDetails(ref).catch(() => undefined));
  return button;
}

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];

/** Bytes in binary units with three significant digits: 1.21 TiB, 512 MiB (the unit symbols are not translated). */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${i18n().formatNumber(value, { maximumFractionDigits: digits })} ${UNITS[unit]}`;
}

export function formatPercent(fraction: number): string {
  return i18n().formatNumber(fraction, { style: "percent", maximumFractionDigits: 1 });
}

export function formatTime(ms: number): string {
  return i18n().formatDateTime(ms, { dateStyle: "medium", timeStyle: "medium" });
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

/** What a failed call says to the user. */
export function errorText(err: unknown): string {
  if (isSextantError(err, "denied")) return t("error.denied", { message: err.message });
  if (isSextantError(err, "forbidden")) return t("error.forbidden", { message: err.message });
  return err instanceof Error ? err.message : String(err);
}

export function errorBox(err: unknown): HTMLElement {
  return element("p", { className: "error", textContent: errorText(err) });
}
