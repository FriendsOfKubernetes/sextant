// CodeMirror 6 with YAML highlighting. Controlled: `value` replaces the text when it differs from what is shown
// (load, reload, save result); every edit reports the whole text through `onChange`.
import { yaml } from "@codemirror/lang-yaml";
import { Annotation } from "@codemirror/state";
import { basicSetup, EditorView } from "codemirror";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useEditorTheme } from "./editorTheme";

/** Marks a change made by this component from `value`, so it is not reported back as an edit. */
const fromProp = Annotation.define<boolean>();

export interface YamlEditorProps {
  value: string;
  onChange: (text: string) => void;
  /** Accessible name of the text area (already translated). */
  label: string;
}

export function YamlEditor({ value, onChange, label }: YamlEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const { scheme, initial } = useEditorTheme(view);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Layout effects: the shown text is in step with `value` in the same commit, so whatever the parent renders next to
  // the editor ("Saved.") never appears before the text it refers to.
  useLayoutEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      doc: value,
      extensions: [
        basicSetup,
        yaml(),
        initial(),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-label": label }),
        EditorView.updateListener.of((update) => {
          const edited = update.docChanged && !update.transactions.some((tr) => tr.annotation(fromProp));
          if (edited) onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // Created once per mount; later `value` changes are applied by the effect below.
  }, []);

  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const shown = editor.state.doc.toString();
    if (shown !== value) editor.dispatch({ changes: { from: 0, to: shown.length, insert: value }, annotations: fromProp.of(true) });
  }, [value]);

  return <div className="yaml-editor" data-editor-theme={scheme} ref={host} />;
}
