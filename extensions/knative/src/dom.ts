// Small DOM helpers the views share; the blocks, fields, tables, status words and links are the SDK's UI kit (`ui`,
// ADR-0160).
import { isSextantError, ui, type Sextant, type UiContent } from "@sextant/extension-sdk";
import { t } from "./i18n";
import { HEALTH_TONE, healthOf, kindOfApiVersion, type KindRef } from "./model";
import type { KubeObject } from "@sextant/extension-sdk";

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

/** Items joined with the UI language's list separator (", ", "、"), as Sextant's `formatList`. */
export const formatList = (items: readonly string[]): string => items.join(t("listSeparator"));

/** Parts of one line joined with the UI language's " · ", as Sextant's `formatParts`. */
export const formatParts = (items: readonly string[]): string => items.join(t("listDot"));

/** A link to an object's details in Sextant's panel, named by its name; nothing without a name. */
export function link(sextant: Sextant, kind: KindRef, name: string | undefined, namespace: string | null = null): HTMLElement | null {
  if (!name) return null;
  const button = ui.objectLink(sextant, { kind, namespace, name }, name);
  button.setAttribute("aria-label", t("openObject", { kind: kind.kind, name }));
  return button;
}

/** A link to an object named by `apiVersion` and kind (a reference in a spec), as the built-in `link` took them. */
export function refLink(
  sextant: Sextant,
  type: { apiVersion: string; kind: string },
  name: string | undefined,
  namespace: string | null = null,
): HTMLElement | null {
  return link(sextant, kindOfApiVersion(type.apiVersion, type.kind), name, namespace);
}

/** `ui.fields` labelled from `<prefix>.<key>`, or nothing when no row has a value. */
export function fieldsOf(prefix: string, rows: readonly (readonly [string, UiContent])[]): HTMLElement | null {
  const list = ui.fields(rows.map(([key, value]) => [t(`${prefix}.${key}`), value] as const));
  return list.childElementCount > 0 ? list : null;
}

/** The state in words, coloured as the built-in tables colour it. */
export function health(obj: KubeObject): HTMLElement {
  const state = healthOf(obj);
  return ui.status(t(`health.${state}`), HEALTH_TONE[state]);
}

/** Why the object is (not) ready, in plain words: a bar on the left, red for a failure. */
export const explanation = (text: string, danger: boolean): HTMLElement =>
  element("p", { className: danger ? "kn-explain kn-explain--danger" : "kn-explain", textContent: text });

/** The failing condition's message as Knative wrote it; nothing without one. */
export const message = (text: string | undefined): HTMLElement | null => (text ? element("p", { className: "kn-message", textContent: text }) : null);

/** A muted remark. */
export const remark = (text: string): HTMLElement => element("p", { className: "kn-muted", textContent: text });
