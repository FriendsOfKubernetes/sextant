// The object as YAML (without managedFields), highlighted by CodeMirror and read only; editing is the editor
// feature's job. Secret values are replaced by "<hidden>" here — the Data block shows them one by one on request.
import { yaml } from "@codemirror/lang-yaml";
import { basicSetup, EditorView } from "codemirror";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useEditorTheme } from "../editor/editorTheme";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { maskSecret } from "./secrets";
import { Block } from "./ui";
import { displayObject, toYaml } from "./yaml";

export function YamlSection({ obj, objectRef }: DetailsSectionProps) {
  const { t } = useTranslation();
  if (!obj) return null;
  return (
    <Block id="details:sections.yaml"
      title={t("details:sections.yaml")}
      defaultOpen={false}
    >
      <YamlContent obj={obj} objectRef={objectRef} />
    </Block>
  );
}

function YamlContent({ obj, objectRef }: Pick<DetailsSectionProps, "objectRef"> & { obj: NonNullable<DetailsSectionProps["obj"]> }) {
  const { t } = useTranslation();
  return <>
          {obj.kind === "Secret" && <div className="dt-muted">{t("details:yaml.secretMasked")}</div>}
          <YamlViewer
            text={toYaml(displayObject(maskSecret(obj)))}
            label={t("details:yaml.label", { kind: objectRef.kind.kind, name: objectRef.name })}
          />
        </>;
}

/** Read-only highlighted YAML; the text is replaced in place when the object changes. */
export function YamlViewer({ text, label }: { text: string; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const { scheme, initial } = useEditorTheme(view);
  const extensions = useMemo(
    () => [basicSetup, yaml(), initial(), EditorView.editable.of(false), EditorView.contentAttributes.of({ "aria-label": label })],
    [label, initial],
  );

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({ doc: "", extensions, parent: host.current });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, [extensions]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === text) return;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
  }, [text, extensions]);

  return <div className="dt-yaml" data-editor-theme={scheme} ref={host} />;
}
