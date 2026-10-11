// Dock tab "edit": the object as YAML (managedFields already stripped by the backend), saved with PUT.
// A failed save — broken YAML, a validation error, a missing permission, a conflict — is shown above the editor and
// the text stays as typed. A conflict is never overwritten: "Reload" loads the cluster's version, and drops unsaved
// edits only after the user confirms.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, type ApiError, type ClusterId, type ObjectRef } from "../../api";
import { ConfirmDialog, ErrorState } from "../../components";
import type { DockTabProps } from "../../layout/dock/registry";
import { openActionDialog } from "../actions/registry";
import { YamlEditor } from "./YamlEditor";
import { toYaml } from "../details/yaml";

export interface EditTabPayload {
  clusterId: ClusterId;
  ref: ObjectRef;
}

type Phase = "loading" | "ready" | "saving";

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

  const load = useCallback(async () => {
    setPhase("loading");
    try {
      const yaml = toYaml(await api.resources.get(clusterId, ref));
      setBase(yaml);
      setText(yaml);
      setLoadError(null);
      setSaveError(null);
      setSaved(false);
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

  const save = async () => {
    setPhase("saving");
    setSaved(false);
    try {
      const yaml = toYaml(await api.resources.replace(clusterId, text));
      setBase(yaml);
      setText(yaml);
      setSaveError(null);
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
        <button
          type="button"
          className="btn btn--primary"
          disabled={phase !== "ready" || loadError !== null}
          onClick={() => void save()}
        >
          {phase === "saving" ? t("actions:editor.saving") : t("actions:editor.save")}
        </button>
        <button type="button" className="btn" disabled={phase !== "ready"} onClick={reload}>
          {t("actions:editor.reload")}
        </button>
        <span className="editor-tab__status" aria-live="polite">
          {phase === "loading" && t("actions:editor.loading")}
          {phase !== "loading" && dirty && t("actions:editor.unsaved")}
          {phase !== "loading" && !dirty && saved && t("actions:editor.saved")}
        </span>
      </div>
      {loadError && <ErrorState error={loadError} onRetry={() => void load()} />}
      {saveError &&
        (saveError.code === "conflict" ? (
          <ErrorState
            error={saveError}
            title={t("actions:editor.conflict", names)}
            actions={
              <button type="button" className="btn" onClick={reload}>
                {t("actions:editor.reload")}
              </button>
            }
          />
        ) : (
          <ErrorState error={saveError} />
        ))}
      {loaded && !loadError && (
        <YamlEditor value={text} onChange={onChange} label={t("actions:editor.editorLabel", names)} />
      )}
    </div>
  );
}
