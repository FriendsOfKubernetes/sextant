// Sextant's details building blocks for an extension's frame (#355, ADR-0160): the same structure, classes and theme
// tokens as Sextant's own details panel (`src/features/details/details.css`), so a view moved out of the core looks
// like it did. Plain DOM: no framework. `addUiStyles()` puts the styles in once (`fields`, `block` and the rest call
// it themselves); the extension's own styles come later and win.
import type { ObjectRef } from "./generated/ObjectRef";

/** The tone of a status word, as Sextant's tables and details colour it. */
export type UiTone = "success" | "warning" | "danger" | "muted" | "neutral";

const STYLE_ID = "sextant-ui-styles";

const UI_STYLES = `
.sx-block { margin: 12px 0; min-width: 0; }
.sx-block .sx-block { margin: 8px 0; }
.sx-block__head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.sx-block__actions { display: flex; gap: 6px; margin-left: auto; }
.sx-block__title { margin: 0; font-size: 0.8125rem; font-weight: 600; flex: 1; min-width: 0; }
.sx-block__toggle { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; font: inherit; font-weight: 600; font-size: 0.8125rem; }
.sx-block__toggle::before { content: "▾"; display: inline-block; width: 1em; color: var(--color-text-muted); }
.sx-block__toggle[aria-expanded="false"]::before { content: "▸"; }
.sx-block__toggle:focus-visible { outline: 2px solid var(--color-focus, var(--color-accent)); outline-offset: 1px; border-radius: 2px; }
.sx-block__body[hidden] { display: none; }
.sx-fields { display: grid; grid-template-columns: minmax(110px, 30%) 1fr; gap: 4px 12px; margin: 0; }
.sx-fields__label { color: var(--color-text-muted); }
.sx-fields__value { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.sx-muted { color: var(--color-text-muted); }
.sx-chips { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.sx-chip { background: var(--color-hover); border-radius: 3px; padding: 0 6px; font-size: 0.75rem; overflow-wrap: anywhere; }
.sx-links { display: inline-flex; flex-wrap: wrap; gap: 4px 12px; }
.sx-table-wrap { max-width: 100%; overflow-x: auto; }
.sx-table { width: 100%; border-collapse: collapse; font-size: 0.75rem; }
.sx-table th, .sx-table td { text-align: left; padding: 4px 8px 4px 0; height: auto; border-bottom: 1px solid var(--color-border); vertical-align: top; overflow-wrap: anywhere; }
.sx-table th { color: var(--color-text-muted); font-weight: 500; }
.sx-table tr:hover td { background: transparent; }
.sx-status--success { color: var(--color-success); }
.sx-status--warning { color: var(--color-warning); }
.sx-status--danger { color: var(--color-danger); }
.sx-status--muted { color: var(--color-text-muted); }
.sx-link { border: none; background: transparent; padding: 0; height: auto; color: var(--color-accent); cursor: pointer; text-align: left; overflow-wrap: anywhere; }
.sx-link:hover:not(:disabled) { background: transparent; text-decoration: underline; }
.sx-pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.75rem; }
.sx-empty { color: var(--color-text-muted); margin: 8px 0; }
.sx-error { color: var(--color-danger); margin: 8px 0; overflow-wrap: anywhere; }
.sx-field { display: inline-flex; flex-direction: column; gap: 4px; min-width: 0; }
.sx-field__label { color: var(--color-text-muted); font-size: 0.75rem; }
.sx-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--color-border); margin-bottom: 8px; overflow-x: auto; }
.sx-tab { border: none; border-bottom: 2px solid transparent; border-radius: 0; background: transparent; color: var(--color-text-muted); }
.sx-tab[aria-selected="true"] { color: var(--color-text); border-bottom-color: var(--color-accent); }
.sx-loading { color: var(--color-text-muted); margin: 8px 0; }
.sx-search { min-width: 12em; }
`;

/** Puts the kit's styles into the document once (first in `<head>`, so the extension's own come later and win). */
export function addUiStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = UI_STYLES;
  doc.head.prepend(style);
}

/** What a builder takes as content: nodes, text, or nothing (`null`, `undefined`, `false` are left out). */
export type UiContent = Node | string | number | null | undefined | false | readonly UiContent[];

function append(parent: Node, content: UiContent): void {
  if (content === null || content === undefined || content === false) return;
  if (Array.isArray(content)) {
    for (const item of content as readonly UiContent[]) append(parent, item);
    return;
  }
  parent.appendChild(typeof content === "string" || typeof content === "number" ? document.createTextNode(String(content)) : (content as Node));
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, content?: UiContent): HTMLElementTagNameMap[K] {
  addUiStyles();
  const node = document.createElement(tag);
  node.className = className;
  append(node, content);
  return node;
}

/**
 * Whether a details frame's block is open by Sextant's memory (`context.blocks`, since Sextant 0.30): its own choice,
 * else the panel's "Expand all"/"Collapse all", else `defaultOpen`. Pair it with `block`'s `onToggle` calling
 * `sextant.ui.setBlockOpen(id, open)`.
 */
export function blockOpen(blocks: Readonly<Record<string, boolean>> | undefined, id: string, defaultOpen = true): boolean {
  return blocks?.[id] ?? blocks?.["*"] ?? defaultOpen;
}

let blockCounter = 0;

/**
 * A titled block, as a section of Sextant's details: with `collapsible`, a disclosure button (keyboard and screen
 * readers included) that shows and hides the body; `collapsed` starts it closed, and `onToggle` hears each change (to
 * remember it in `storage`, or to watch only while the block is open; since Sextant 0.30). `actions` go in its head,
 * after the title (a "Logs" button of the block's pods).
 */
export function block(
  title: string,
  content: UiContent,
  options: { collapsible?: boolean; collapsed?: boolean; onToggle?: (open: boolean) => void; actions?: readonly HTMLElement[] } = {},
): HTMLElement {
  const section = el("section", "sx-block");
  const head = el("div", "sx-block__head");
  const body = el("div", "sx-block__body", content);
  const heading = el("h3", "sx-block__title");
  if (options.collapsible) {
    const id = `sx-block-${++blockCounter}`;
    body.id = id;
    const toggle = el("button", "sx-block__toggle", title);
    toggle.type = "button";
    toggle.setAttribute("aria-controls", id);
    const set = (open: boolean) => {
      toggle.setAttribute("aria-expanded", String(open));
      body.hidden = !open;
    };
    set(!options.collapsed);
    toggle.addEventListener("click", () => {
      const open = body.hidden === true;
      set(open);
      options.onToggle?.(open);
    });
    heading.append(toggle);
  } else {
    heading.textContent = title;
  }
  head.append(heading);
  if (options.actions && options.actions.length > 0) head.append(el("div", "sx-block__actions", [...options.actions]));
  section.append(head, body);
  section.setAttribute("aria-label", title);
  return section;
}

/** A row of `fields`: a label and its value; a row whose value is nothing is left out. */
export type FieldRow = readonly [label: string, value: UiContent];

/** A list of labelled values, as the fields of Sextant's details. */
export function fields(rows: readonly FieldRow[]): HTMLElement {
  const list = el("dl", "sx-fields");
  for (const [label, value] of rows) {
    if (value === null || value === undefined || value === false || value === "") continue;
    list.append(el("dt", "sx-fields__label", label), el("dd", "sx-fields__value", value));
  }
  return list;
}

/** A table with a header row; `rows` hold one cell per header. */
export function table(headers: readonly string[], rows: readonly (readonly UiContent[])[], options: { label?: string } = {}): HTMLElement {
  const wrap = el("div", "sx-table-wrap");
  const tableEl = el("table", "sx-table");
  if (options.label) tableEl.setAttribute("aria-label", options.label);
  const head = el("thead", "");
  const headRow = el("tr", "");
  for (const header of headers) {
    const th = el("th", "", header);
    th.scope = "col";
    headRow.append(th);
  }
  head.append(headRow);
  const body = el("tbody", "");
  for (const row of rows) {
    const tr = el("tr", "");
    for (const cell of row) tr.append(el("td", "", cell));
    body.append(tr);
  }
  tableEl.append(head, body);
  wrap.append(tableEl);
  return wrap;
}

/** A status word in its tone's colour; the word itself is shown, so colour is never the only sign. */
export function status(text: string, tone: UiTone = "neutral"): HTMLElement {
  return el("span", tone === "neutral" ? "sx-status" : `sx-status sx-status--${tone}`, text);
}

/** Small chips for a list of values (labels, flags); nothing for an empty list. */
export function chips(values: readonly (string | null | undefined)[]): HTMLElement | null {
  const shown = values.filter((v): v is string => typeof v === "string" && v !== "");
  if (shown.length === 0) return null;
  const list = el("span", "sx-chips");
  for (const value of shown) list.append(el("span", "sx-chip", value));
  return list;
}

/** Muted text. */
export function muted(text: string): HTMLElement {
  return el("span", "sx-muted", text);
}

/** Preformatted text (a message, a manifest). */
export function pre(text: string): HTMLElement {
  return el("pre", "sx-pre", text);
}

/** Links (or anything inline) side by side. */
export function inline(items: readonly UiContent[]): HTMLElement {
  return el("span", "sx-links", items);
}

/** What `objectLink` needs of the client: `sextant.ui.openDetails`. */
export interface DetailsOpener {
  ui: { openDetails(ref: ObjectRef): Promise<void> };
}

/** A link-styled button that opens an object's details in Sextant's panel. */
export function objectLink(sextant: DetailsOpener, ref: ObjectRef, text: string = ref.name): HTMLButtonElement {
  const button = el("button", "sx-link", text);
  button.type = "button";
  button.addEventListener("click", () => void sextant.ui.openDetails(ref).catch(() => undefined));
  return button;
}

/** A button in Sextant's style: `primary` for the main action, `danger` for one that removes or stops something. */
export function button(
  label: string,
  onClick: () => void,
  options: { variant?: "default" | "primary" | "danger"; disabled?: boolean; title?: string } = {},
): HTMLButtonElement {
  const node = el("button", options.variant && options.variant !== "default" ? options.variant : "", label);
  node.type = "button";
  node.disabled = options.disabled === true;
  if (options.title) node.title = options.title;
  node.addEventListener("click", onClick);
  return node;
}

/** "Loading…" or any text, announced politely while something is read. */
export function loading(text: string): HTMLElement {
  const node = el("p", "sx-loading", text);
  node.setAttribute("role", "status");
  return node;
}

/** A search field, labelled for screen readers; `onInput` gets the text as typed. */
export function searchInput(label: string, onInput: (text: string) => void, options: { placeholder?: string; value?: string } = {}): HTMLInputElement {
  const input = el("input", "sx-search");
  input.type = "search";
  input.setAttribute("aria-label", label);
  input.placeholder = options.placeholder ?? label;
  input.value = options.value ?? "";
  input.addEventListener("input", () => onInput(input.value));
  return input;
}

/** One tab of `tabs`: its id, label and what it shows (drawn when chosen). */
export interface UiTab {
  id: string;
  label: string;
  render: () => UiContent;
}

/**
 * Tabs as Sextant's details have them: a tablist with arrow keys, Home and End, and one panel showing the chosen tab
 * (`render` runs again each time a tab is chosen). `onChange` hears the choice.
 */
export function tabs(items: readonly UiTab[], options: { selected?: string; label?: string; onChange?: (id: string) => void } = {}): HTMLElement {
  const root = el("div", "sx-tabs-root");
  const list = el("div", "sx-tabs");
  list.setAttribute("role", "tablist");
  if (options.label) list.setAttribute("aria-label", options.label);
  const panel = el("div", "sx-tab-panel");
  panel.setAttribute("role", "tabpanel");
  const prefix = `sx-tab-${++blockCounter}`;
  const buttons = items.map((item, i) => {
    const tab = el("button", "sx-tab", item.label);
    tab.type = "button";
    tab.id = `${prefix}-${i}`;
    tab.setAttribute("role", "tab");
    tab.addEventListener("click", () => choose(i));
    tab.addEventListener("keydown", (event) => {
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: items.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      const target = (next + items.length) % items.length;
      choose(target);
      buttons[target]!.focus();
    });
    return tab;
  });
  function choose(index: number): void {
    buttons.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
    });
    panel.setAttribute("aria-labelledby", buttons[index]!.id);
    panel.replaceChildren();
    append(panel, items[index]!.render());
    options.onChange?.(items[index]!.id);
  }
  list.append(...buttons);
  root.append(list, panel);
  if (items.length > 0) choose(Math.max(0, items.findIndex((t) => t.id === options.selected)));
  return root;
}

/** What `namespaceSelect` needs of the client. */
export interface NamespaceSource {
  context: { clusterId: string | null; namespaces: string[] | null };
  resources: {
    list(params: { clusterId?: string; kind: { kind: string } }): Promise<{ items: { metadata?: { name?: string } }[] }>;
  };
}

/**
 * A labelled namespace choice like Sextant's: the cluster's namespaces when the extension may list them, else the
 * ones the window's filter names (and `value`); `labels.all` adds "every namespace" (`null`). `onChange` hears the
 * choice. The list is read once; a failure leaves the names it already knows.
 */
export function namespaceSelect(
  sextant: NamespaceSource,
  options: {
    value?: string | null;
    onChange: (namespace: string | null) => void;
    labels: { label: string; all?: string };
    clusterId?: string;
  },
): HTMLElement {
  const wrap = el("label", "sx-field");
  const caption = el("span", "sx-field__label", options.labels.label);
  const select = el("select", "sx-namespace");
  wrap.append(caption, select);
  const fill = (names: readonly string[]) => {
    const current = select.value || (options.value ?? "");
    select.replaceChildren();
    if (options.labels.all) select.append(new Option(options.labels.all, ""));
    const all = [...new Set([...names, ...(options.value ? [options.value] : [])])].sort((a, b) => a.localeCompare(b));
    for (const name of all) select.append(new Option(name, name));
    select.value = all.includes(current) || (current === "" && options.labels.all) ? current : (all[0] ?? "");
  };
  fill(sextant.context.namespaces ?? []);
  select.addEventListener("change", () => options.onChange(select.value === "" ? null : select.value));
  const clusterId = options.clusterId ?? sextant.context.clusterId ?? undefined;
  sextant.resources
    .list({ ...(clusterId ? { clusterId } : {}), kind: { kind: "Namespace" } })
    .then((answer) => fill(answer.items.map((n) => n.metadata?.name).filter((n): n is string => typeof n === "string")))
    .catch(() => undefined);
  return wrap;
}

/** A line saying there is nothing to show. */
export function empty(text: string): HTMLElement {
  return el("p", "sx-empty", text);
}

/** An error, read by screen readers as it appears: its message (a `SextantError`'s, or any `Error`'s). */
export function errorState(error: unknown, title?: string): HTMLElement {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  const node = el("p", "sx-error", title ? `${title}: ${message}` : message);
  node.setAttribute("role", "alert");
  return node;
}
