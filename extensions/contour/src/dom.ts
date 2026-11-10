// Small DOM helpers the views share; the blocks, fields, tables, status words and links are the SDK's UI kit (`ui`,
// ADR-0160).
import { isSextantError, ui, type Sextant, type UiContent } from "@sextant/extension-sdk";
import { i18n, t } from "./i18n";
import type { KindRef } from "./model";

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

export function errorText(err: unknown): string {
  if (isSextantError(err, "denied")) return t("error.denied", { message: err.message });
  if (isSextantError(err, "forbidden")) return t("error.forbidden", { message: err.message });
  return err instanceof Error ? err.message : String(err);
}

/** A whole number in the UI language without grouping, as Sextant's `formatNumber`. */
export const formatNumber = (value: number): string =>
  i18n().formatNumber(value, { minimumFractionDigits: 0, maximumFractionDigits: 0, useGrouping: false });

/**
 * A link to an object's details in Sextant's panel, showing `text` (its name by default) and named by its kind and
 * name for screen readers, as the built-in links were; nothing without a name.
 */
export function link(sextant: Sextant, kind: KindRef, name: string | undefined, namespace: string | null = null, text?: string): HTMLElement | null {
  if (!name) return null;
  const button = ui.objectLink(sextant, { kind, namespace, name }, text ?? name);
  button.setAttribute("aria-label", t("openObject", { kind: kind.kind, name }));
  return button;
}

/** `ui.fields` labelled from `fields.<key>`, or nothing when no row has a value. */
export function fieldsOf(rows: readonly (readonly [string, UiContent])[]): HTMLElement | null {
  const list = ui.fields(rows.map(([key, value]) => [t(`fields.${key}`), value] as const));
  return list.childElementCount > 0 ? list : null;
}

/**
 * A table of the built-in view's (`table` of Sextant's details): nothing without rows, and the columns `nowrap` names
 * kept on one line.
 */
export function table(id: string, headers: readonly string[], rows: readonly (readonly UiContent[])[], nowrap: readonly number[] = []): HTMLElement | null {
  if (rows.length === 0) return null;
  const node = ui.table(headers, rows);
  node.dataset.table = id;
  for (const row of node.querySelectorAll("tr")) {
    for (const i of nowrap) row.children[i]?.classList.add("ct-nowrap");
  }
  return node;
}

/** Why the object is (not) accepted, in plain words: a bar on the left, red for a failure. */
export const explanation = (text: string, danger: boolean): HTMLElement =>
  element("p", { className: danger ? "ct-explain ct-explain--danger" : "ct-explain", textContent: text });

/** Text Contour wrote, muted. */
export const message = (text: string): HTMLElement => element("p", { className: "ct-message", textContent: text });

/** A muted remark. */
export const remark = (text: string): HTMLElement => element("p", { className: "ct-muted", textContent: text });
