// An exec plugin (the login program a kubeconfig user runs: a cloud CLI, kubelogin…) that cannot be found on this
// computer (#253). The backend checks every context offline when the kubeconfig sources are read
// (`ClusterInfo.execProblem`, never run) and names the command as written when a start fails (the message begins
// with `EXEC_PLUGIN_NOT_FOUND`); the window shows the reason and the usual causes: a kubeconfig generated on another
// computer or in WSL, or a tool installed after Sextant (or the desktop session) started.
//
// A login program that ran and failed (#256): the backend puts its stderr, last lines only and with secrets masked,
// into `CoreError.pluginOutput` of the connection error (never stdout, never in logs, the activity log, notifications,
// agents or extensions); the window shows it with a Copy button and the usual fix — sign in again in a terminal.
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CoreError, ExecProblem } from "../../api";
import { Button } from "../../components";

/** How the backend's `authPlugin` message begins when the plugin's file or folder is missing (`error.rs`). */
export const EXEC_PLUGIN_NOT_FOUND = "the auth plugin was not found";

/** Whether `error` is an exec plugin that was not found on this computer. */
export function isExecPluginNotFound(error: Pick<CoreError, "code" | "message">): boolean {
  return error.code === "authPlugin" && error.message.startsWith(EXEC_PLUGIN_NOT_FOUND);
}

type T = (key: string, values?: Record<string, unknown>) => string;

/** One sentence: which login program is missing and what of it. */
export function execProblemText(t: T, problem: ExecProblem): string {
  return t(`clusters:exec.${problem.missing}`, { command: problem.command });
}

/** The usual causes of a missing login program and what to do about them. */
export function ExecPluginHint() {
  const { t } = useTranslation();
  return (
    <div className="exec-hint" data-testid="exec-plugin-hint">
      <p>{t("clusters:exec.hintElsewhere")}</p>
      <p>{t("clusters:exec.hintRestart")}</p>
    </div>
  );
}

/** A mark on a cluster in the rail whose login program cannot be found; its tooltip says which and why. */
export function ExecProblemBadge({ problem }: { problem: ExecProblem }) {
  const { t } = useTranslation();
  return (
    <span
      className="cluster-icon__exec"
      role="img"
      aria-label={t("clusters:exec.badge")}
      title={execProblemText(t, problem)}
    />
  );
}

/** Whether `error` is a login program that was found but failed (not signed in, an expired session…). */
export function isExecPluginFailed(error: Pick<CoreError, "code" | "message">): boolean {
  return error.code === "authPlugin" && !isExecPluginNotFound(error);
}

/** What usually fixes a failed login program: signing in again in a terminal, then trying again. */
export function ExecLoginHint() {
  const { t } = useTranslation();
  return (
    <div className="exec-hint" data-testid="exec-login-hint">
      <p>{t("clusters:exec.loginHint")}</p>
    </div>
  );
}

/** What the failed login program printed on stderr, as the backend masked it, in a scrollable block with Copy. */
export function PluginOutput({ output }: { output: string }) {
  const { t } = useTranslation();
  const titleId = useId();
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(output);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopy("idle"), 2000);
  };
  return (
    <section className="exec-output" aria-labelledby={titleId} data-testid="exec-plugin-output">
      <div className="exec-output__header">
        <span id={titleId} className="exec-output__title">
          {t("clusters:exec.output.title")}
        </span>
        <Button size="compact" icon="copy" onClick={() => void onCopy()}>
          {t("clusters:exec.output.copy")}
        </Button>
        <span className="exec-output__state" role="status">
          {copy === "copied" && t("clusters:exec.output.copied")}
          {copy === "failed" && t("clusters:exec.output.copyFailed")}
        </span>
      </div>
      <pre className="exec-output__text" tabIndex={0} aria-labelledby={titleId}>
        {output}
      </pre>
    </section>
  );
}
