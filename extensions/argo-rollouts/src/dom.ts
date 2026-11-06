// Small DOM and formatting helpers the views share.
import { isSextantError, type RefInput, type Sextant } from "@sextant/extension-sdk";
import { i18n, t } from "./i18n";
import type { Tone } from "./model";

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

/** A status word with its tone's colour (and the word itself, so colour is never the only sign). */
export function badge(text: string, tone: Tone, title?: string): HTMLElement {
  const node = element("span", { className: `badge ${tone}`, textContent: text });
  if (title) node.title = title;
  return node;
}

/** A link-styled button that opens an object's details in Sextant; nothing without a name. */
export function objectLink(sextant: Sextant, ref: RefInput, text = ref.name): HTMLButtonElement {
  const button = element("button", { className: "link", type: "button", textContent: text });
  button.addEventListener("click", () => void sextant.ui.openDetails(ref).catch(() => undefined));
  return button;
}

/** Labelled fields as a definition list; rows without a value are left out. */
export function fields(rows: [label: string, value: Node | string | undefined | null][]): HTMLElement {
  const list = element("dl", {});
  for (const [label, value] of rows) {
    if (value === undefined || value === null || value === "") continue;
    list.append(element("dt", { textContent: label }), element("dd", {}, value));
  }
  return list;
}

/** A table with a header row; `null` without rows. */
export function table(headers: string[], rows: (Node | string | null | undefined)[][], label: string): HTMLTableElement | null {
  if (rows.length === 0) return null;
  const head = element("tr", {}, ...headers.map((h) => element("th", { scope: "col", textContent: h })));
  const body = rows.map((row) => element("tr", {}, ...row.map((cell) => element("td", {}, cell ?? ""))));
  const node = element("table", {}, element("thead", {}, head), element("tbody", {}, ...body));
  node.setAttribute("aria-label", label);
  return node;
}

/** A titled block of a details section. */
export function block(title: string, ...children: Child[]): HTMLElement {
  return element("section", {}, element("h4", { textContent: title }), ...children);
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

export function errorBox(err: unknown): HTMLElement {
  return element("p", { className: "error", textContent: errorText(err) });
}
