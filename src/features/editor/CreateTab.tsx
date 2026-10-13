// Dock tab "create": YAML with one or more documents (`---`), applied with server-side apply. Shows the objects
// that were created or changed, or the error naming the failing document; the text is kept either way.
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError, toApiError, type ClusterId, type ObjectRef } from "../../api";
import { Button, ErrorState } from "../../components";
import type { DockTabProps } from "../../layout/dock/registry";
import { hasHiddenValues } from "../details/secrets";
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
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<ObjectRef[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const apply = async () => {
    setApplied(null);
    // Text copied from a Secret shown without its values would replace every value with an empty string.
    if (hasHiddenValues(text)) {
      setError(new ApiError("invalid", t("details:secret.reloadBeforeSave")));
      return;
    }
    setApplying(true);
    setError(null);
    try {
      setApplied(await api.resources.apply(clusterId, text));
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setApplying(false);
    }
  };

  const onChange = useCallback((value: string) => setText(value), []);
  const empty = text.trim() === "";

  return (
    <div className="editor-tab">
      <div className="editor-tab__toolbar">
        <Button
          variant="primary"
          disabled={applying || empty}
          title={empty ? t("actions:create.empty") : undefined}
          onClick={() => void apply()}
        >
          {applying ? t("actions:create.applying") : t("actions:create.apply")}
        </Button>
        <span className="editor-tab__hint">{t("actions:create.placeholder")}</span>
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
      <YamlEditor value={text} onChange={onChange} label={t("actions:create.editorLabel")} />
    </div>
  );
}
