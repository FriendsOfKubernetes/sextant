// CodeMirror 6 with YAML highlighting. Controlled: `value` replaces the text when it differs from what is shown
// (load, reload, save result); every edit reports the whole text through `onChange`.
import { yaml } from "@codemirror/lang-yaml";
import { basicSetup, EditorView } from "codemirror";
import { useEffect, useRef } from "react";
import { useEditorTheme } from "./editorTheme";

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

  useEffect(() => {
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
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
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

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const shown = editor.state.doc.toString();
    if (shown !== value) editor.dispatch({ changes: { from: 0, to: shown.length, insert: value } });
  }, [value]);

  return <div className="yaml-editor" data-editor-theme={scheme} ref={host} />;
}
