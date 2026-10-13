import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorKey } from "../../api";
import { Button } from "../../components";
import { useTerminal, type TerminalSessionFactory, type UseTerminal } from "./useTerminal";

export interface TerminalViewProps {
  factory: TerminalSessionFactory;
  /** The terminal is visible (selected tab of an open dock). */
  active: boolean;
  /** Accessible name of the terminal area. Already translated. */
  label: string;
  /**
   * Show a notice when the backend says the shell's profile may override `KUBECONFIG` (a local terminal with a shell
   * Sextant cannot make keep the cluster's kubeconfig).
   */
  kubeconfigNotice?: boolean;
}

/**
 * The private OSC sequence a local terminal starts with when its shell's profile may still set `KUBECONFIG`:
 * `ESC ] 7719 ; kubeconfig-not-pinned BEL` (`KUBECONFIG_NOTICE_OSC` in `src-tauri/src/pty.rs`).
 */
const KUBECONFIG_NOTICE_OSC = 7719;
const KUBECONFIG_NOTICE = "kubeconfig-not-pinned";

/** An xterm.js terminal bound to one backend session, with a status bar and "Reconnect" once it ends. */
export function TerminalView({ factory, active, label, kubeconfigNotice = false }: TerminalViewProps) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement | null>(null);
  const session = useTerminal(container, factory, active);
  const notice = useKubeconfigNotice(session, kubeconfigNotice);
  return (
    <div className="terminal">
      {notice && (
        <div className="terminal__notice" role="note">
          {t("terminal:local.kubeconfigNotice")}
        </div>
      )}
      <div ref={container} className="terminal__screen" role="region" aria-label={label} />
      <StatusBar session={session} />
    </div>
  );
}

/**
 * Whether the session said its shell may override `KUBECONFIG`. The handler is registered when the terminal is
 * created, before any output is written to it; the sequence itself is consumed and never shown.
 */
function useKubeconfigNotice(session: UseTerminal, enabled: boolean): boolean {
  const [seen, setSeen] = useState(false);
  const { terminal } = session;
  useEffect(() => {
    if (!terminal || !enabled) return;
    const handler = terminal.parser.registerOscHandler(KUBECONFIG_NOTICE_OSC, (data) => {
      if (data === KUBECONFIG_NOTICE) setSeen(true);
      return true;
    });
    return () => handler.dispose();
  }, [terminal, enabled]);
  return enabled && seen;
}

function StatusBar({ session }: { session: UseTerminal }) {
  const { t } = useTranslation();
  const { status, exitCode, error, reconnect } = session;
  if (status === "running") return null;
  let text: string;
  if (status === "connecting") text = t("terminal:status.connecting");
  else if (status === "ended")
    text = exitCode === null ? t("terminal:status.ended") : t("terminal:status.endedWithCode", { code: exitCode });
  else {
    const parts = error ? [t(errorKey(error.code)), error.message] : [];
    text = t("terminal:status.failed", { message: parts.filter(Boolean).join(" — ") });
  }
  return (
    <div className={`terminal__status terminal__status--${status}`} role="status">
      <span className="terminal__status-text">{text}</span>
      {status !== "connecting" && (
        <Button variant="primary" onClick={reconnect}>
          {t("terminal:reconnect")}
        </Button>
      )}
    </div>
  );
}
