// Small DOM and formatting helpers the views share.
import { isSextantError, type RefInput, type Sextant } from "@sextant/extension-sdk";
import type { Tone } from "./fields";
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

/** A status word with its tone's colour (and the word itself, so colour is never the only sign). */
export function badge(text: string, tone: Tone): HTMLElement {
  return element("span", { className: `badge ${tone}`, textContent: text });
}

/** A status word, or nothing without one. */
export function statusWord(value: string | undefined, tone: (value: string) => Tone): HTMLElement | null {
  return value ? badge(value, tone(value)) : null;
}

/** A status word followed by a muted explanation. */
export function withMessage(word: Node | null, message: string | undefined): HTMLElement | null {
  if (!word && !message) return null;
  return element("span", { className: "with-message" }, word, message ? element("span", { className: "muted", textContent: message }) : null);
}

/** A link-styled button that opens an object's details in Sextant. */
export function objectLink(sextant: Sextant, ref: RefInput, text = ref.name): HTMLButtonElement {
  const button = element("button", { className: "link", type: "button", textContent: text });
  button.addEventListener("click", () => void sextant.ui.openDetails(ref).catch(() => undefined));
  return button;
}

/** Chips of short values; nothing when there are none. */
export function chips(values: readonly (string | undefined)[]): HTMLElement | null {
  const shown = values.filter((v): v is string => typeof v === "string" && v !== "");
  if (shown.length === 0) return null;
  return element("span", { className: "chips" }, ...shown.map((v) => element("span", { className: "chip", textContent: v })));
}

/** Several nodes in a wrapping row; nothing when there are none. */
export function inlineList(nodes: readonly (Node | string | null)[]): HTMLElement | null {
  const shown = nodes.filter((n): n is Node | string => n !== null && n !== "");
  return shown.length > 0 ? element("span", { className: "links" }, ...shown) : null;
}

/** "3 minutes ago" next to the time itself. */
export function when(timestamp: string | undefined, now = Date.now()): HTMLElement | null {
  if (!timestamp) return null;
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return element("span", { textContent: timestamp });
  return element("span", { className: "when" }, formatAgo(ms, now), " ", element("span", { className: "muted", textContent: timestamp }));
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

/** A table with a header row; cells are text or nodes. */
export function table(headers: readonly string[], rows: readonly (readonly (Node | string | null | undefined)[])[], label?: string): HTMLTableElement {
  const node = element(
    "table",
    { className: "grid" },
    element("thead", {}, element("tr", {}, ...headers.map((h) => element("th", { textContent: h })))),
    element("tbody", {}, ...rows.map((row) => element("tr", {}, ...row.map((cell) => element("td", {}, cell ?? null))))),
  );
  if (label) node.setAttribute("aria-label", label);
  return node;
}

/** What a failed call says to the user. */
export function errorText(err: unknown): string {
  if (isSextantError(err, "denied")) return t("error.denied", { message: err.message });
  if (isSextantError(err, "forbidden")) return t("error.forbidden", { message: err.message });
  return err instanceof Error ? err.message : String(err);
}

export function errorBox(err: unknown): HTMLElement {
  const box = element("p", { className: "error", textContent: errorText(err) });
  box.setAttribute("role", "alert");
  return box;
}

export function button(label: string, onClick: () => void, className = ""): HTMLButtonElement {
  const node = element("button", { type: "button", textContent: label, className });
  node.addEventListener("click", onClick);
  return node;
}
