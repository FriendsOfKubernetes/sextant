// Small DOM and formatting helpers the views share; the building blocks themselves are the SDK's UI kit (`ui`,
// ADR-0160), so the views look like Sextant's own details.
import { isSextantError, ui, type UiTone } from "@sextant/extension-sdk";
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

const UI_TONES: Record<Tone, UiTone> = { ok: "success", warning: "warning", error: "danger", neutral: "muted" };

/** A status word in its tone's colour (the word itself is shown, so colour is never the only sign). */
export function badge(text: string, tone: Tone): HTMLElement {
  return ui.status(text, UI_TONES[tone]);
}

/** A status word, or nothing without one. */
export function statusWord(value: string | undefined, tone: (value: string) => Tone): HTMLElement | null {
  return value ? badge(value, tone(value)) : null;
}

/** A status word followed by a muted explanation. */
export function withMessage(word: Node | null, message: string | undefined): HTMLElement | null {
  if (!word && !message) return null;
  return ui.inline([word, message ? ui.muted(message) : null]);
}

/** "3 minutes ago" next to the time itself. */
export function when(timestamp: string | undefined, now = Date.now()): HTMLElement | null {
  if (!timestamp) return null;
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return element("span", { textContent: timestamp });
  return element("span", { className: "when" }, formatAgo(ms, now), " ", ui.muted(timestamp));
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

/** A failed call, announced as it appears. */
export function errorBox(err: unknown): HTMLElement {
  return ui.errorState(errorText(err));
}

/** A row of buttons. */
export function buttons(...nodes: (HTMLElement | null)[]): HTMLElement {
  return element("div", { className: "buttons" }, ...nodes);
}
