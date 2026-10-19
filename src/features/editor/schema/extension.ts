// The cluster's schema in the YAML editor (#151): completion of fields and values, problems underlined while typing
// (debounced), documentation on hover, and an Explain panel (F1, or "Explain" in the hover) like `kubectl explain`.
// Each document of the text is checked against the schema of its own apiVersion/kind.
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { linter, type Diagnostic } from "@codemirror/lint";
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, hoverTooltip, keymap, showPanel, type Panel } from "@codemirror/view";
import { i18n } from "../../../i18n";
import { formatList, formatParts } from "../../../i18n/format";
import { explain, explainAt, suggest, type Explanation, type Suggestion } from "./complete";
import { documentAt, documentsOf } from "./context";
import type { PathSeg } from "./model";
import type { SchemaSource } from "./source";
import { validate, type Problem } from "./validate";

/** How long typing pauses before the text is checked. */
export const LINT_DELAY_MS = 400;
/** Enum values named in a message at most. */
const MAX_ALLOWED_SHOWN = 12;
/** A description in a hover is cut here; the Explain panel shows it whole. */
const HOVER_DESCRIPTION = 600;

const t = (key: string, options?: Record<string, unknown>) => i18n.t(`editorschema:${key}`, options);

/** The text of a problem in the interface's language. */
export function problemMessage(problem: Problem): string {
  const allowed = problem.allowed
    ? formatList(
        problem.allowed.length > MAX_ALLOWED_SHOWN ? [...problem.allowed.slice(0, MAX_ALLOWED_SHOWN), "…"] : problem.allowed,
      )
    : "";
  return t(`problem.${problem.code}`, { ...problem.params, allowed });
}

function toCompletion(item: Suggestion): Completion {
  return {
    label: item.label,
    apply: item.apply,
    type: item.kind === "field" ? "property" : "enum",
    detail: item.required ? formatParts([item.type, t("required")]) : item.type,
    info: item.description,
    boost: item.required ? 1 : 0,
  };
}

function completionSource(source: SchemaSource) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const text = ctx.state.doc.toString();
    const doc = documentAt(text, ctx.pos);
    if (!doc?.apiVersion || !doc.kind) return null;
    const schema = await source.load(doc.apiVersion, doc.kind);
    if (!schema || ctx.aborted) return null;
    const found = suggest(text, ctx.pos, schema);
    if (!found || found.items.length === 0) return null;
    // Typing a key opens the list only once something is typed (not on every indentation); values open at once.
    const typed = ctx.pos > found.from;
    if (!ctx.explicit && !typed && found.items[0]?.kind === "field") return null;
    return { from: found.from, options: found.items.map(toCompletion), validFor: /^[\w./-]*$/ };
  };
}

function schemaLinter(source: SchemaSource): Extension {
  return linter(
    async (view): Promise<Diagnostic[]> => {
      const text = view.state.doc.toString();
      const kinds = documentsOf(text).filter((d) => d.apiVersion && d.kind);
      await Promise.all(kinds.map((d) => source.load(d.apiVersion ?? "", d.kind ?? "")));
      return validate(text, (apiVersion, kind) => source.peek(apiVersion, kind)).map((p) => ({
        from: p.from,
        to: p.to,
        severity: p.severity,
        source: "schema",
        message: problemMessage(p),
      }));
    },
    { delay: LINT_DELAY_MS },
  );
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The head of a field's documentation: path, type, "required". */
function heading(found: Explanation): HTMLElement {
  const head = el("div", "schema-doc__head");
  head.append(el("code", "schema-doc__path", found.pathLabel), el("span", "schema-doc__type", found.type));
  if (found.required) head.append(el("span", "schema-doc__required", t("required")));
  return head;
}

/** Description, default and allowed values. */
function body(found: Explanation, limit?: number): HTMLElement[] {
  const out: HTMLElement[] = [];
  const description = found.description;
  if (description) {
    const clipped = limit && description.length > limit ? `${description.slice(0, limit)}…` : description;
    out.push(el("p", "schema-doc__description", clipped));
  }
  if (found.default !== undefined) out.push(el("div", "schema-doc__meta", t("default", { value: found.default })));
  if (found.enum?.length) out.push(el("div", "schema-doc__meta", t("allowed", { values: formatList(found.enum) })));
  if (found.open) out.push(el("div", "schema-doc__meta", t("anyField")));
  return out;
}

/** What the Explain panel shows: a path in the document of one apiVersion/kind. */
interface ExplainTarget {
  apiVersion: string;
  kind: string;
  path: PathSeg[];
}

const setExplain = StateEffect.define<ExplainTarget | null>();

function explainPanel(source: SchemaSource, target: ExplainTarget) {
  return (view: EditorView): Panel => {
    const dom = el("div", "schema-explain");
    dom.setAttribute("role", "region");
    dom.setAttribute("aria-label", t("explainTitle"));
    const go = (next: ExplainTarget | null) => view.dispatch({ effects: setExplain.of(next) });
    const bar = el("div", "schema-explain__bar");
    if (target.path.length > 0) {
      const up = el("button", "schema-explain__button", t("up"));
      up.type = "button";
      up.onclick = () => go({ ...target, path: target.path.slice(0, -1) });
      bar.append(up);
    }
    const close = el("button", "schema-explain__button", t("close"));
    close.type = "button";
    close.onclick = () => {
      go(null);
      view.focus();
    };
    bar.append(close);
    const schema = source.peek(target.apiVersion, target.kind);
    const found = schema ? explain(schema, target.path) : null;
    if (!found) {
      dom.append(bar, el("p", "schema-doc__meta", schema ? t("noField") : t("noSchema", { kind: target.kind })));
      return { dom, top: false };
    }
    dom.append(heading(found), bar, ...body(found));
    if (found.fields.length > 0) {
      dom.append(el("div", "schema-explain__fields-title", t("fields")));
      const list = el("ul", "schema-explain__fields");
      // The fields of a list are its items' fields.
      const base = found.type.startsWith("[]") ? [...target.path, -1] : target.path;
      for (const field of found.fields) {
        const row = el("li", "schema-explain__field");
        const name = el("button", "schema-explain__name", field.name);
        name.type = "button";
        name.onclick = () => go({ ...target, path: [...base, field.name] });
        row.append(name, el("span", "schema-doc__type", field.type));
        if (field.required) row.append(el("span", "schema-doc__required", t("required")));
        if (field.summary) row.append(el("span", "schema-explain__summary", field.summary));
        list.append(row);
      }
      dom.append(list);
    }
    return { dom, top: false };
  };
}

function explainField(source: SchemaSource) {
  return StateField.define<ExplainTarget | null>({
    create: () => null,
    update(value, tr) {
      for (const effect of tr.effects) if (effect.is(setExplain)) value = effect.value;
      return value;
    },
    provide: (field) => showPanel.from(field, (target) => (target ? explainPanel(source, target) : null)),
  });
}

/** Opens the Explain panel for the field at the cursor (the kind itself when the cursor is on no field). */
async function explainAtCursor(view: EditorView, source: SchemaSource): Promise<void> {
  const text = view.state.doc.toString();
  const pos = view.state.selection.main.head;
  const doc = documentAt(text, pos);
  if (!doc?.apiVersion || !doc.kind) return;
  const schema = await source.load(doc.apiVersion, doc.kind);
  const found = schema ? explainAt(text, pos, schema) : null;
  view.dispatch({ effects: setExplain.of({ apiVersion: doc.apiVersion, kind: doc.kind, path: found?.path ?? [] }) });
}

function schemaHover(source: SchemaSource): Extension {
  return hoverTooltip(async (view, pos) => {
    const text = view.state.doc.toString();
    const doc = documentAt(text, pos);
    if (!doc?.apiVersion || !doc.kind) return null;
    const { apiVersion, kind } = doc;
    const schema = await source.load(apiVersion, kind);
    const found = schema ? explainAt(text, pos, schema) : null;
    if (!found) return null;
    return {
      pos: found.from,
      end: found.to,
      above: true,
      create: () => {
        const dom = el("div", "schema-doc");
        const more = el("button", "schema-explain__button", t("explain"));
        more.type = "button";
        more.onclick = () => view.dispatch({ effects: setExplain.of({ apiVersion, kind, path: found.path }) });
        dom.append(heading(found), ...body(found, HOVER_DESCRIPTION), more);
        return { dom };
      },
    };
  });
}

/** Everything the schema adds to an editor whose documents are objects of the cluster `source` reads from. */
export function schemaExtension(source: SchemaSource): Extension {
  // One function for the editor's life: completion tells its sources apart by identity.
  const complete = [{ autocomplete: completionSource(source) }];
  return [
    EditorState.languageData.of(() => complete),
    schemaLinter(source),
    schemaHover(source),
    explainField(source),
    keymap.of([
      {
        key: "F1",
        run: (view) => {
          void explainAtCursor(view, source);
          return true;
        },
      },
    ]),
  ];
}
