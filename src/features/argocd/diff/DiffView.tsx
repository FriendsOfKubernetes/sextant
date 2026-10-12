// Desired ↔ live of an Application's resources: the list of resources on the left, two read-only YAML columns with
// the differences highlighted (CodeMirror merge view, in the editor's colour scheme) on the right.
import { yaml } from "@codemirror/lang-yaml";
import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { basicSetup, EditorView } from "codemirror";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ManagedResource } from "../../../api";
import { useEditorTheme } from "../../editor/editorTheme";
import { describe, isSecret, sidesOf, stateOf, yamlOf, type DiffState } from "./model";

const ORDER: Record<DiffState, number> = { changed: 0, missingLive: 1, missingTarget: 2, inSync: 3 };

export function DiffView({ items }: { items: ManagedResource[] }) {
  const { t } = useTranslation();
  const rows = useMemo(
    () =>
      items
        .map((resource) => ({ resource, state: stateOf(resource), key: describe(resource) }))
        .sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.key.localeCompare(b.key)),
    [items],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const current = rows.find((r) => r.key === selected) ?? rows[0];
  if (!current) return <p className="argo-diff__empty">{t("argocd:diff.empty")}</p>;
  const changed = rows.filter((r) => r.state !== "inSync").length;
  const { desired, live } = sidesOf(current.resource);

  return (
    <div className="argo-diff">
      <div className="argo-diff__list">
        <p className="argo-diff__summary">{t("argocd:diff.summary", { count: changed, changed, total: rows.length })}</p>
        <ul aria-label={t("argocd:diff.resources")}>
          {rows.map((row) => (
            <li key={row.key}>
              <button
                type="button"
                className={`argo-diff__item argo-diff__item--${row.state}`}
                aria-current={row === current ? "true" : undefined}
                onClick={() => setSelected(row.key)}
              >
                <span className="argo-diff__name">{row.key}</span>
                <span className="argo-diff__state">{t(`argocd:diff.state.${row.state}`)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="argo-diff__view">
        <div className="argo-diff__heads">
          <span>{t("argocd:diff.desired")}</span>
          <span>{t("argocd:diff.live")}</span>
        </div>
        {isSecret(current.resource) && <p className="argo-diff__note">{t("argocd:diff.secretHidden")}</p>}
        {desired === null && <p className="argo-diff__note">{t("argocd:diff.state.missingTarget")}</p>}
        {live === null && <p className="argo-diff__note">{t("argocd:diff.state.missingLive")}</p>}
        <MergeDiff
          desired={yamlOf(desired)}
          live={yamlOf(live)}
          desiredLabel={t("argocd:diff.desiredLabel", { resource: current.key })}
          liveLabel={t("argocd:diff.liveLabel", { resource: current.key })}
        />
      </div>
    </div>
  );
}

/** Two read-only YAML editors side by side; recreated when the texts change. */
function MergeDiff({
  desired,
  live,
  desiredLabel,
  liveLabel,
}: {
  desired: string;
  live: string;
  desiredLabel: string;
  liveLabel: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewA = useRef<EditorView | null>(null);
  const viewB = useRef<EditorView | null>(null);
  const themeA = useEditorTheme(viewA);
  const themeB = useEditorTheme(viewB);
  const { initial: initialA } = themeA;
  const { initial: initialB } = themeB;

  useEffect(() => {
    if (!host.current) return;
    const side = (doc: string, theme: () => ReturnType<typeof initialA>, name: string) => ({
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
      a: side(desired, initialA, desiredLabel),
      b: side(live, initialB, liveLabel),
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
  }, [desired, live, desiredLabel, liveLabel, initialA, initialB]);

  return <div className="argo-diff__merge" data-editor-theme={themeA.scheme} ref={host} />;
}
