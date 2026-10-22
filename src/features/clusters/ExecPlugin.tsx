// An exec plugin (the login program a kubeconfig user runs: a cloud CLI, kubelogin…) that cannot be found on this
// computer (#253). The backend checks every context offline when the kubeconfig sources are read
// (`ClusterInfo.execProblem`, never run) and names the command as written when a start fails (the message begins
// with `EXEC_PLUGIN_NOT_FOUND`); the window shows the reason and the usual causes: a kubeconfig generated on another
// computer or in WSL, or a tool installed after Sextant (or the desktop session) started.
import { useTranslation } from "react-i18next";
import type { CoreError, ExecProblem } from "../../api";

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
