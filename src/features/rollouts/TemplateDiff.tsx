// Two pod templates side by side as read-only YAML, the differences highlighted (CodeMirror merge view, in the
// editor's colour scheme).
import { yaml } from "@codemirror/lang-yaml";
import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { basicSetup, EditorView } from "codemirror";
import { useEffect, useRef } from "react";
import { useEditorTheme } from "../editor/editorTheme";

export interface TemplateDiffProps {
  /** Left side (the older or the live template), already as YAML. */
  left: string;
  right: string;
  /** Column headings, already translated. */
  leftTitle: string;
  rightTitle: string;
}

export function TemplateDiff({ left, right, leftTitle, rightTitle }: TemplateDiffProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewA = useRef<EditorView | null>(null);
  const viewB = useRef<EditorView | null>(null);
  const themeA = useEditorTheme(viewA);
  const themeB = useEditorTheme(viewB);
  const { initial: initialA } = themeA;
  const { initial: initialB } = themeB;

  useEffect(() => {
    if (!host.current) return;
    const side = (doc: string, theme: typeof initialA, name: string) => ({
      doc,
      extensions: [
        basicSetup,
        yaml(),
        theme(),
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
        EditorView.contentAttributes.of({ "aria-label": name }),
      ],
    });
    const merge = new MergeView({
      a: side(left, initialA, leftTitle),
      b: side(right, initialB, rightTitle),
      parent: host.current,
      collapseUnchanged: { margin: 3, minSize: 6 },
      gutter: true,
    });
    viewA.current = merge.a;
    viewB.current = merge.b;
    return () => {
      merge.destroy();
      viewA.current = null;
      viewB.current = null;
    };
  }, [left, right, leftTitle, rightTitle, initialA, initialB]);

  return (
    <div className="rollouts-diff">
      <div className="rollouts-diff__heads">
        <span>{leftTitle}</span>
        <span>{rightTitle}</span>
      </div>
      <div className="rollouts-diff__merge" data-editor-theme={themeA.scheme} ref={host} />
    </div>
  );
}
