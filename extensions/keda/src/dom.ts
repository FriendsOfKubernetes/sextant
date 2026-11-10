// Small DOM helpers the views share; the blocks, fields, tables, status words and links are the SDK's UI kit (`ui`,
// ADR-0160). The phrases, notes and summaries are drawn in the built-in autoscaling view's own styles (`style.css`).
import { isSextantError, ui, type Sextant, type UiContent } from "@sextant/extension-sdk";
import { t } from "./i18n";
import type { KindRef, Phrase } from "./model";

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

/** A phrase in its tone: a bar on its left, as the built-in view's `PhraseLine`. */
export const phraseLine = (p: Phrase): HTMLElement => element("p", { className: `as-phrase as-phrase--${p.tone ?? "neutral"}`, textContent: t(p.key, p.params ?? {}) });

/** Phrases one under the other. */
export const phraseLines = (phrases: readonly Phrase[]): HTMLElement[] => phrases.map(phraseLine);

/** A muted note under a block. */
export const note = (text: string): HTMLElement => element("p", { className: "as-note", textContent: text });

/** Text in the warning colour (an event's reason, a metric without a value). */
export const warning = (text: string): HTMLElement => element("span", { className: "as-warning", textContent: text });

/** A link to an object's details in Sextant's panel; nothing without a name. */
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

/** A table whose columns marked `true` stay on one line; nothing without rows (as the built-in `table`). */
export function tableOf(headers: readonly string[], rows: readonly (readonly UiContent[])[], nowrap: readonly boolean[]): HTMLElement | null {
  if (rows.length === 0) return null;
  const view = ui.table(headers, rows);
  for (const row of view.querySelectorAll("tr")) {
    [...row.children].forEach((cell, i) => {
      if (nowrap[i]) cell.classList.add("as-nowrap");
    });
  }
  return view;
}

/**
 * Which blocks are open, and where a toggle goes: Sextant's own memory of details sections (`context.blocks`, written
 * by `ui.setBlockOpen`), with the panel's "Expand all" and "Collapse all" — where the built-in blocks were kept.
 */
export interface BlockMemory {
  isOpen(block: string): boolean;
  setOpen(block: string, open: boolean): void;
}

/** Blocks that are all open and remember nothing. */
export const OPEN_BLOCKS: BlockMemory = { isOpen: () => true, setOpen: () => undefined };

/**
 * A titled block as the built-in view's: open unless Sextant remembers it closed, and closable with its title. Its
 * content is drawn only while it is open, as the built-in block's was (the section draws again on each toggle).
 */
export function block(memory: BlockMemory, id: string, title: string, content: () => UiContent): HTMLElement {
  const open = memory.isOpen(id);
  const node = ui.block(title, open ? content() : null, { collapsible: true, collapsed: !open, onToggle: (now) => memory.setOpen(id, now) });
  node.dataset.block = id;
  return node;
}

export function errorText(err: unknown): string {
  if (isSextantError(err, "denied")) return t("error.denied", { message: err.message });
  if (isSextantError(err, "forbidden")) return t("error.forbidden", { message: err.message });
  return err instanceof Error ? err.message : String(err);
}
