// Small DOM helpers the views share; the blocks, fields, tables, status words and links are the SDK's UI kit (`ui`,
// ADR-0160). The paragraphs keep the built-in view's look (its cert-manager classes, copied as `xp-*` in style.css):
// an explanation with a bar on its left (red when it failed), Crossplane's message, and muted remarks.
import { isSextantError, ui, type ObjectRef, type Sextant, type UiContent } from "@sextant/extension-sdk";
import { t } from "./i18n";
import { conditionTone, type KindRef } from "./model";

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

const paragraph = (className: string, text: string): HTMLElement => element("p", { className, textContent: text });

/** What a state means: an amber bar on its left, red with `danger`. */
export const explain = (text: string, danger = false): HTMLElement => paragraph(danger ? "xp-explain xp-explain--danger" : "xp-explain", text);

/** Crossplane's own message. */
export const message = (text: string): HTMLElement => paragraph("xp-message", text);

/** A muted remark. */
export const remark = (text: string): HTMLElement => paragraph("xp-muted", text);

/** A condition's value in its colour (True green, False red, Unknown amber); nothing without one. */
export const conditionText = (value: string | undefined): HTMLElement | null => (value ? ui.status(value, conditionTone(value)) : null);

/** Names joined with the UI language's list separator, as Sextant's `formatList`. */
export const formatList = (items: readonly string[]): string => items.join(t("listSeparator"));

/** A link to an object's details in Sextant's panel, showing `text` (its name by default); nothing without a name. */
export function link(sextant: Sextant, kind: KindRef, name: string | undefined, namespace: string | null = null, text?: string): HTMLElement | null {
  if (!name) return null;
  const button = ui.objectLink(sextant, { kind, namespace, name }, text ?? name);
  button.setAttribute("aria-label", t("openObject", { kind: kind.kind, name }));
  return button;
}

/** A link named `<Kind>/<name>`, as the built-in chain and owner links were. */
export const objectLink = (sextant: Sextant, ref: ObjectRef): HTMLElement | null => link(sextant, ref.kind, ref.name, ref.namespace, `${ref.kind.kind}/${ref.name}`);

/** `ui.fields` labelled from `fields.<key>`; nothing when no row has a value. */
export function fieldsOf(rows: readonly (readonly [string, UiContent])[]): HTMLElement | null {
  const list = ui.fields(rows.map(([key, value]) => [t(`fields.${key}`), value] as const));
  return list.childElementCount > 0 ? list : null;
}

export function errorText(err: unknown): string {
  if (isSextantError(err, "denied")) return t("error.denied", { message: err.message });
  if (isSextantError(err, "forbidden")) return t("error.forbidden", { message: err.message });
  return err instanceof Error ? err.message : String(err);
}

/**
 * Which blocks are open, and where a toggle goes: Sextant's own memory of details sections (`context.blocks`, written
 * by `ui.setBlockOpen`), kept as Settings → Appearance says, with the panel's "Expand all" and "Collapse all" — where
 * the built-in section's blocks were kept. A toggle counts at once, until Sextant tells it back.
 */
export class BlockMemory {
  private readonly toggled = new Map<string, boolean>();
  /** How each block was last drawn. */
  private readonly shown = new Map<string, boolean>();
  private every: boolean | undefined;

  constructor(
    private readonly sextant: Sextant,
    private readonly changed: () => void,
  ) {
    this.every = sextant.context.blocks?.["*"];
  }

  /** Whether `id` is open now, without counting it as drawn. */
  peek(id: string): boolean {
    return this.toggled.get(id) ?? ui.blockOpen(this.sextant.context.blocks, id, true);
  }

  /** Whether `id` is open, as it is drawn now. */
  isOpen(id: string): boolean {
    const open = this.peek(id);
    this.shown.set(id, open);
    return open;
  }

  setOpen(id: string, open: boolean): void {
    this.toggled.set(id, open);
    void this.sextant.ui.setBlockOpen(id, open).catch(() => undefined);
    this.changed();
  }

  /** After a context change: "Expand all"/"Collapse all" overrides the toggles; whether a drawn block now differs. */
  follow(): boolean {
    const blocks = this.sextant.context.blocks ?? {};
    if (blocks["*"] !== this.every) {
      this.every = blocks["*"];
      this.toggled.clear();
    }
    for (const [id, open] of this.toggled) if (blocks[id] === open) this.toggled.delete(id);
    return [...this.shown].some(([id, open]) => this.peek(id) !== open);
  }

  /** Another object: its blocks as Sextant remembers them. */
  reset(): void {
    this.toggled.clear();
    this.shown.clear();
  }
}

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

/** `root` drawn again with `nodes`, the focus kept on the toggle of the block that had it. */
export function redraw(root: HTMLElement, nodes: readonly Node[]): void {
  const focused = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement.closest<HTMLElement>("[data-block]")?.dataset.block : undefined;
  root.replaceChildren(...nodes);
  if (focused !== undefined) root.querySelector<HTMLElement>(`[data-block="${focused}"] .sx-block__toggle`)?.focus();
}
