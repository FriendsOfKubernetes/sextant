// Dock tab "create": YAML with one or more documents (`---`), applied with server-side apply. Shows the objects
// that were created or changed, or the error naming the failing document; the text is kept either way.
// "Preview changes" (#141) applies the text as a server-side dry run first: per document the live object against what
// the server would store (Secrets without values), or why it would refuse it; "Apply" from the preview applies exactly
// the previewed text, and is unavailable while a document would be refused (see `refusalsOf`). On a cluster that asks for a preview, "Apply" opens the preview first.
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError, toApiError, type ClusterId, type DryRunResult, type ObjectRef } from "../../api";
import { Button, ErrorState } from "../../components";
import { useUnsavedChanges, type DockTabProps } from "../../layout/dock/registry";
import { hasHiddenValues } from "../details/secrets";
import { ChangePreview, refusalsOf, useAlwaysPreview } from "../safe-apply";
import { YamlEditor } from "./YamlEditor";

export interface CreateTabPayload {
  clusterId: ClusterId;
}

/** "Deployment demo/web", "Namespace demo". */
export function describeRef(r: ObjectRef): string {
  return r.namespace ? `${r.kind.kind} ${r.namespace}/${r.name}` : `${r.kind.kind} ${r.name}`;
}

export function CreateTab({ tab }: DockTabProps) {
  const { t } = useTranslation();
  const { clusterId } = tab.payload as CreateTabPayload;
  const [text, setText] = useState("");
  /** The text applied last: closing the tab asks first only while the text differs from it. */
  const [appliedText, setAppliedText] = useState("");
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<ObjectRef[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [checking, setChecking] = useState(false);
  /** A dry run of `text`, shown instead of the editor until it is applied or left. */
  const [preview, setPreview] = useState<{ text: string; result: DryRunResult } | null>(null);
  const alwaysPreview = useAlwaysPreview(clusterId);

  /** Text copied from a Secret shown without its values would replace every value with an empty string. */
  const refuseHidden = (yaml: string): boolean => {
    if (!hasHiddenValues(yaml)) return false;
    setError(new ApiError("invalid", t("details:secret.reloadBeforeSave")));
    return true;
  };

  const runPreview = async () => {
    setApplied(null);
    if (refuseHidden(text)) return;
    const asked = text;
    setChecking(true);
    setError(null);
    try {
      setPreview({ text: asked, result: await api.resources.dryRun(clusterId, asked, "apply") });
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setChecking(false);
    }
  };

  const apply = async (yaml: string) => {
    setApplied(null);
    if (refuseHidden(yaml)) return;
    setApplying(true);
    setError(null);
    try {
      setApplied(await api.resources.apply(clusterId, yaml));
      setAppliedText(yaml);
      setPreview(null);
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setApplying(false);
    }
  };

  /** A refused document stops the real apply part-way: nothing is applied until the text is fixed. */
  const blocked = preview !== null && refusalsOf(preview.result).blocking.length > 0;

  const onChange = useCallback((value: string) => setText(value), []);
  const empty = text.trim() === "";
  useUnsavedChanges(tab.id, !empty && text !== appliedText);

  return (
    <div className="editor-tab">
      <div className="editor-tab__toolbar">
        {preview ? (
          <>
            <Button
              variant="primary"
              disabled={applying || blocked}
              title={blocked ? t("safeapply:actions.blocked") : undefined}
              onClick={() => void apply(preview.text)}
            >
              {applying ? t("actions:create.applying") : t("actions:create.apply")}
            </Button>
            <Button disabled={applying} onClick={() => setPreview(null)}>
              {t("safeapply:actions.back")}
            </Button>
            <span className="editor-tab__status" aria-live="polite">
              {t("safeapply:actions.ready")}
            </span>
          </>
        ) : (
          <>
            <Button
              variant="primary"
              disabled={applying || checking || empty}
              title={empty ? t("actions:create.empty") : undefined}
              onClick={() => void (alwaysPreview ? runPreview() : apply(text))}
            >
              {applying
                ? t("actions:create.applying")
                : checking
                  ? t("safeapply:actions.checking")
                  : alwaysPreview
                    ? t("safeapply:actions.previewAndApply")
                    : t("actions:create.apply")}
            </Button>
            {!alwaysPreview && (
              <Button disabled={applying || checking || empty} onClick={() => void runPreview()}>
                {checking ? t("safeapply:actions.checking") : t("safeapply:actions.preview")}
              </Button>
            )}
            <span className="editor-tab__hint">{t("actions:create.placeholder")}</span>
          </>
        )}
      </div>
      {error && <ErrorState error={error} title={t("actions:create.failed")} />}
      {applied && (
        <div className="editor-tab__result" role="status">
          <div>{t("actions:create.applied", { count: applied.length })}</div>
          <ul>
            {applied.map((r) => (
              <li key={`${r.kind.group}/${r.kind.kind}/${r.namespace ?? ""}/${r.name}`}>{describeRef(r)}</li>
            ))}
          </ul>
        </div>
      )}
      {preview && <ChangePreview result={preview.result} />}
      {/* Kept while the preview is shown, so the undo history survives "Back to editing". */}
      <div className="editor-tab__editor" hidden={preview !== null}>
        <YamlEditor value={text} onChange={onChange} label={t("actions:create.editorLabel")} schemaCluster={clusterId} />
      </div>
    </div>
  );
}
