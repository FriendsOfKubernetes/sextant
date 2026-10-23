// The check of a kubeconfig being added (a chosen file or pasted text), shown before it is added when the backend
// found problems: per context, in plain words; "Check connection" connects once on request (the usual timeouts);
// "Add anyway" adds it as it is. Nothing is run by the check itself (exec plugins are only looked up in PATH); a
// missing one gets the hint of `ExecPlugin.tsx`.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  api,
  toApiError,
  type ApiError,
  type KubeconfigInput,
  type KubeconfigValidation,
  type ValidationProblem,
} from "../../../api";
import { Button, Dialog, ErrorState } from "../../../components";
import { formatDateTime } from "../../../i18n";
import { ExecLoginHint, ExecPluginHint, PluginOutput, isExecPluginFailed, isExecPluginNotFound } from "../ExecPlugin";

/** The backend's check; `null` when it could not run (an older backend, a test without it): the add goes on. */
export async function checkKubeconfig(input: KubeconfigInput): Promise<KubeconfigValidation | null> {
  try {
    return await api.kubeconfig.validate(input);
  } catch {
    return null;
  }
}

export function hasProblems(v: KubeconfigValidation | null): v is KubeconfigValidation {
  return !!v && (v.problems.length > 0 || v.contexts.some((c) => c.problems.length > 0));
}

const DATED = new Set(["clientCertificateExpired", "tokenExpired"]);
/** An exec plugin that is not where the kubeconfig says: the usual causes are explained below the problems. */
const EXEC_MISSING = new Set(["execNotFound", "execFileMissing", "execFolderMissing"]);

export function problemText(t: (key: string, values?: Record<string, unknown>) => string, p: ValidationProblem): string {
  if (p.code === "notYaml" && p.line !== null) {
    return t("kubeconfig:validate.code.notYamlAt", { line: p.line, column: p.column ?? 0 });
  }
  const subject = p.subject && DATED.has(p.code) ? formatDateTime(p.subject) : (p.subject ?? "");
  return t(`kubeconfig:validate.code.${p.code}`, { subject });
}

function Problems({ problems }: { problems: ValidationProblem[] }) {
  const { t } = useTranslation();
  return (
    <ul className="kc-check__problems">
      {problems.map((p, i) => (
        <li key={`${p.code}-${i}`} data-warning={p.warning ? "true" : undefined}>
          {p.warning && <span className="kc-check__warning">{t("kubeconfig:validate.warning")}</span>}
          {problemText(t, p)}
        </li>
      ))}
    </ul>
  );
}

type Reach = { state: "checking" } | { state: "ok" } | { state: "error"; error: ApiError };

export function ValidationDialog({
  input,
  validation,
  onAdd,
  onClose,
}: {
  input: KubeconfigInput;
  validation: KubeconfigValidation;
  onAdd: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [reach, setReach] = useState<Record<string, Reach>>({});
  const check = async (context: string) => {
    setReach((r) => ({ ...r, [context]: { state: "checking" } }));
    try {
      await api.kubeconfig.checkConnection(input, context);
      setReach((r) => ({ ...r, [context]: { state: "ok" } }));
    } catch (err) {
      setReach((r) => ({ ...r, [context]: { state: "error", error: toApiError(err) } }));
    }
  };
  const fatal = validation.problems.some((p) => ["unreadable", "notYaml", "notKubeconfig", "noContexts"].includes(p.code));
  return (
    <Dialog
      open
      title={t("kubeconfig:validate.title")}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("common:actions.cancel")}</Button>
          {!fatal && (
            <Button variant="primary" onClick={onAdd}>
              {t(hasProblems(validation) ? "kubeconfig:validate.addAnyway" : "kubeconfig:validate.add")}
            </Button>
          )}
        </>
      }
    >
      <p className="clusters-hint">{t(hasProblems(validation) ? "kubeconfig:validate.hint" : "kubeconfig:validate.ok")}</p>
      {validation.problems.length > 0 && (
        <section className="kc-check__context">
          <h3 className="kc-check__name">{t("kubeconfig:validate.file")}</h3>
          <Problems problems={validation.problems} />
        </section>
      )}
      {validation.contexts.map((c) => {
        const r = reach[c.context];
        return (
          <section key={c.context} className="kc-check__context">
            <h3 className="kc-check__name">{c.context}</h3>
            {c.server && <p className="kc-check__server">{c.server}</p>}
            {c.problems.length > 0 && <Problems problems={c.problems} />}
            {(c.problems.some((p) => EXEC_MISSING.has(p.code)) ||
              (r?.state === "error" && isExecPluginNotFound(r.error))) && <ExecPluginHint />}
            <div className="kc-check__reach">
              <Button size="compact" disabled={r?.state === "checking"} onClick={() => void check(c.context)}>
                {r?.state === "checking" ? t("kubeconfig:validate.checking") : t("kubeconfig:validate.checkConnection")}
              </Button>
              {r?.state === "ok" && <span role="status">{t("kubeconfig:validate.reachable")}</span>}
              {r?.state === "error" && <ErrorState error={r.error} className="clusters-error" />}
            </div>
            {r?.state === "error" && r.error.pluginOutput && <PluginOutput output={r.error.pluginOutput} />}
            {r?.state === "error" && isExecPluginFailed(r.error) && <ExecLoginHint />}
          </section>
        );
      })}
    </Dialog>
  );
}
