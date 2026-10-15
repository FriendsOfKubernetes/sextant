// The choice of the Argo CD installation when several namespaces of a cluster look like one and the backend cannot
// tell the real one (ADR-0032). The user picks one of the namespaces the backend listed; the choice is saved in the
// cluster's settings (`clusters[id].argocdNamespace`), and the backend takes it only when it is one of the candidates
// it finds itself. Used by the diff dialog and by "Open Argo CD UI".
import { useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toApiError, type ApiError, type ClusterId } from "../../../api";
import { Button, Radio } from "../../../components";
import { ambiguousInstallationText, ambiguousNamespaces, chooseArgocdNamespace } from "../server";
import "./diff.css";

export interface NamespacePickerProps {
  clusterId: ClusterId;
  /** The backend's ambiguous-installation error (it names the candidate namespaces). */
  error: unknown;
  /** Runs after the choice is saved (read the diff again, open the UI); a rejection is shown here. */
  onChosen: () => void | Promise<void>;
}

export function NamespacePicker({ clusterId, error, onChosen }: NamespacePickerProps) {
  const { t } = useTranslation();
  const name = useId();
  const candidates = ambiguousNamespaces(error);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (chosen === null || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await chooseArgocdNamespace(clusterId, chosen);
      await onChosen();
    } catch (err) {
      setFailure(toApiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="argo-installation" onSubmit={submit} aria-label={t("argocd:installation.title")}>
      <p role="alert">{ambiguousInstallationText(error)}</p>
      {candidates.length > 0 && (
        <>
          <p>{t("argocd:installation.choose")}</p>
          <div className="argo-installation__choices" role="radiogroup" aria-label={t("argocd:installation.title")}>
            {candidates.map((namespace) => (
              <label key={namespace} className="argo-installation__choice">
                <Radio
                  name={name}
                  value={namespace}
                  checked={chosen === namespace}
                  onChange={() => setChosen(namespace)}
                />
                <span>{namespace}</span>
              </label>
            ))}
          </div>
          {failure && (
            <p className="argo-login__error" role="status">
              {failure.message}
            </p>
          )}
          <div className="argo-login__actions">
            <Button type="submit" variant="primary" disabled={chosen === null || busy}>
              {t(busy ? "argocd:installation.using" : "argocd:installation.use")}
            </Button>
          </div>
        </>
      )}
    </form>
  );
}
