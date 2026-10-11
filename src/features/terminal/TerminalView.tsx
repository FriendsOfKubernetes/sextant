import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { errorKey } from "../../api";
import { useTerminal, type TerminalSessionFactory, type UseTerminal } from "./useTerminal";

export interface TerminalViewProps {
  factory: TerminalSessionFactory;
  /** The terminal is visible (selected tab of an open dock). */
  active: boolean;
  /** Accessible name of the terminal area. Already translated. */
  label: string;
}

/** An xterm.js terminal bound to one backend session, with a status bar and "Reconnect" once it ends. */
export function TerminalView({ factory, active, label }: TerminalViewProps) {
  const container = useRef<HTMLDivElement | null>(null);
  const session = useTerminal(container, factory, active);
  return (
    <div className="terminal">
      <div ref={container} className="terminal__screen" role="region" aria-label={label} />
      <StatusBar session={session} />
    </div>
  );
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
        <button type="button" className="btn btn--primary" onClick={reconnect}>
          {t("terminal:reconnect")}
        </button>
      )}
    </div>
  );
}
