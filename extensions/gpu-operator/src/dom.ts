// Small DOM helpers the views share; the blocks, fields, tables, status words and links are the SDK's UI kit (`ui`,
// ADR-0160).
import { isSextantError } from "@sextant/extension-sdk";
import { t } from "./i18n";

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

/** The operator's message when it is not ready, or why a MIG configuration failed (a red bar on its left). */
export const message = (text: string): HTMLElement => element("p", { className: "gpu-message", textContent: text });

/** What a state means (an amber bar on its left). */
export const note = (text: string): HTMLElement => element("p", { className: "gpu-note", textContent: text });

/** A muted remark. */
export const remark = (text: string): HTMLElement => element("p", { className: "gpu-muted", textContent: text });

export function errorText(err: unknown): string {
  if (isSextantError(err, "denied")) return t("error.denied", { message: err.message });
  if (isSextantError(err, "forbidden")) return t("error.forbidden", { message: err.message });
  return err instanceof Error ? err.message : String(err);
}
