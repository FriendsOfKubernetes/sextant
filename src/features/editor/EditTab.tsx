// Dock tab "edit": the object as YAML (managedFields already stripped by the backend), saved with PUT.
// A Secret is the one kind loaded with `resource_get_full`: everywhere else it comes without its values, and text that
// still carries the hidden-values marker is never sent (it would replace every value with an empty string).
// A failed save — broken YAML, a validation error, a missing permission, a conflict — is shown above the editor and
// the text stays as typed. A conflict is never overwritten: "Reload" loads the cluster's version, and drops unsaved
// edits only after the user confirms.
// "Preview changes" (#141) sends the same PUT as a server-side dry run and shows the live object against what the
// server would store (Secrets without values); a refusal (validation, an admission webhook, a conflict) shows up there
// before anything is saved, and "Save" from the preview saves exactly the previewed text. On a cluster that asks for
// a preview ("Preview changes before applying"), "Save" opens the preview first.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError, toApiError, type ClusterId, type DryRunResult, type ObjectRef } from "../../api";
import { Button, ConfirmDialog, ErrorState } from "../../components";
import type { DockTabProps } from "../../layout/dock/registry";
import { openActionDialog } from "../actions/registry";
import { YamlEditor } from "./YamlEditor";
import { hasHiddenValues } from "../details/secrets";
import { toYaml } from "../details/yaml";
import { ChangePreview, useAlwaysPreview } from "../safe-apply";

export interface EditTabPayload {
  clusterId: ClusterId;
  ref: ObjectRef;
}

type Phase = "loading" | "ready" | "saving" | "checking";

/** A dry run of `text`, shown instead of the editor until it is saved or left. */
interface Preview {
  text: string;
  result: DryRunResult;
}

function isSecret(ref: ObjectRef): boolean {
  return ref.kind.group === "" && ref.kind.kind === "Secret";
}

/** The object to edit: a Secret with its values, any other kind as `resource_get` returns it. */
function loadObject(clusterId: ClusterId, ref: ObjectRef) {
  return isSecret(ref) ? api.resources.getFull(clusterId, ref) : api.resources.get(clusterId, ref);
}

export function EditTab({ tab }: DockTabProps) {
  const { t } = useTranslation();
  const { clusterId, ref } = tab.payload as EditTabPayload;
  const names = { kind: ref.kind.kind, name: ref.name };
  const [phase, setPhase] = useState<Phase>("loading");
  /** The text as last loaded or saved; differs from `text` while there are unsaved edits. */
  const [base, setBase] = useState("");
  const [text, setText] = useState("");
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  /** The editor appears once the object has been loaded, so nothing typed before that can be lost. */
  const [loaded, setLoaded] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const alwaysPreview = useAlwaysPreview(clusterId);

  const load = useCallback(async () => {
    setPhase("loading");
    try {
      const yaml = toYaml(await loadObject(clusterId, ref));
      setBase(yaml);
      setText(yaml);
      setLoadError(null);
      setSaveError(null);
      setSaved(false);
      setPreview(null);
      setLoaded(true);
    } catch (err) {
      setLoadError(toApiError(err));
    } finally {
      setPhase("ready");
    }
  }, [clusterId, ref]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Text copied from a Secret shown without its values would replace every value with an empty string. */
  const refuseHidden = (yaml: string): boolean => {
    if (!hasHiddenValues(yaml)) return false;
    setSaveError(new ApiError("invalid", t("details:secret.reloadBeforeSave")));
    return true;
  };

  const runPreview = async () => {
    setSaved(false);
    if (refuseHidden(text)) return;
    const asked = text;
    setPhase("checking");
    try {
      const result = await api.resources.dryRun(clusterId, asked, "replace");
      setPreview({ text: asked, result });
      setSaveError(null);
    } catch (err) {
      setSaveError(toApiError(err));
    } finally {
      setPhase("ready");
    }
  };

  const save = async (yaml: string) => {
    setSaved(false);
    if (refuseHidden(yaml)) return;
    setPhase("saving");
    try {
      const stored = await api.resources.replace(clusterId, yaml);
      // The reply of a Secret comes without its values; the editor needs them for the next save.
      const reloaded = toYaml(isSecret(ref) ? await loadObject(clusterId, ref) : stored);
      setBase(reloaded);
      setText(reloaded);
      setSaveError(null);
      setPreview(null);
      setSaved(true);
    } catch (err) {
      setSaveError(toApiError(err));
    } finally {
      setPhase("ready");
    }
  };

  const dirty = text !== base;
  const reload = () => {
    if (!dirty) {
      void load();
      return;
    }
    openActionDialog((close) => (
      <ConfirmDialog
        open
        danger
        title={t("actions:editor.reloadTitle")}
        confirmLabel={t("actions:editor.reloadConfirm")}
        onCancel={close}
        onConfirm={() => {
          close();
          void load();
        }}
      >
        <p>{t("actions:editor.reloadText")}</p>
      </ConfirmDialog>
    ));
  };

  const onChange = useCallback((value: string) => {
    setText(value);
    setSaved(false);
  }, []);

  return (
    <div className="editor-tab">
      <div className="editor-tab__toolbar">
        {preview ? (
          <>
            <Button variant="primary" disabled={phase !== "ready"} onClick={() => void save(preview.text)}>
              {phase === "saving" ? t("actions:editor.saving") : t("actions:editor.save")}
            </Button>
            <Button disabled={phase !== "ready"} onClick={() => setPreview(null)}>
              {t("safeapply:actions.back")}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="primary"
              disabled={phase !== "ready" || loadError !== null}
              onClick={() => void (alwaysPreview ? runPreview() : save(text))}
            >
              {phase === "saving"
                ? t("actions:editor.saving")
                : phase === "checking"
                  ? t("safeapply:actions.checking")
                  : alwaysPreview
                    ? t("safeapply:actions.previewAndSave")
                    : t("actions:editor.save")}
            </Button>
            {!alwaysPreview && (
              <Button disabled={phase !== "ready" || loadError !== null} onClick={() => void runPreview()}>
                {phase === "checking" ? t("safeapply:actions.checking") : t("safeapply:actions.preview")}
              </Button>
            )}
            <Button disabled={phase !== "ready"} onClick={reload}>
              {t("actions:editor.reload")}
            </Button>
          </>
        )}
        <span className="editor-tab__status" aria-live="polite">
          {phase === "loading" && t("actions:editor.loading")}
          {phase !== "loading" && preview && t("safeapply:actions.ready")}
          {phase !== "loading" && !preview && dirty && t("actions:editor.unsaved")}
          {phase !== "loading" && !preview && !dirty && saved && t("actions:editor.saved")}
        </span>
      </div>
      {loadError && <ErrorState error={loadError} onRetry={() => void load()} />}
      {saveError &&
        (saveError.code === "conflict" ? (
          <ErrorState
            error={saveError}
            title={t("actions:editor.conflict", names)}
            actions={
              <Button onClick={reload}>
                {t("actions:editor.reload")}
              </Button>
            }
          />
        ) : (
          <ErrorState error={saveError} />
        ))}
      {preview && <ChangePreview result={preview.result} />}
      {loaded && !loadError && (
        // Kept while the preview is shown, so the undo history survives "Back to editing".
        <div className="editor-tab__editor" hidden={preview !== null}>
          <YamlEditor
            value={text}
            onChange={onChange}
            label={t("actions:editor.editorLabel", names)}
            schemaCluster={clusterId}
          />
        </div>
      )}
    </div>
  );
}
