import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type CloudProblem } from "../../api";
import { Button } from "../../components";
import { openCommandTerminalTab } from "../terminal/tabs";

async function writeClipboard(text: string): Promise<void> {
  if (!navigator.clipboard) throw new Error("the clipboard is not available");
  await navigator.clipboard.writeText(text);
}

/**
 * A command for the user to run, with "Copy command" and "Open terminal" (a local terminal in the dock with the
 * command typed in; the user presses Enter). `onTerminalOpened` lets a window that would cover the dock close itself.
 */
export function CommandLine({ command, onTerminalOpened }: { command: string; onTerminalOpened?: () => void }) {
  const { t } = useTranslation();
  const [feedback, setFeedback] = useState<"copied" | "copyFailed" | "opened" | null>(null);
  const copy = async () => {
    try {
      await writeClipboard(command);
      setFeedback("copied");
    } catch {
      setFeedback("copyFailed");
    }
  };
  const openTerminal = () => {
    openCommandTerminalTab(command);
    setFeedback("opened");
    onTerminalOpened?.();
  };
  const feedbackKey = {
    copied: "clusters:cloud.copied",
    copyFailed: "clusters:cloud.copyFailed",
    opened: "terminal:local.openedWithCommand",
  } as const;
  return (
    <div className="cloud-command">
      <code className="cloud-command__text">{command}</code>
      <Button size="compact" onClick={() => void copy()}>
        {t("clusters:cloud.copyCommand")}
      </Button>
      <Button size="compact" onClick={openTerminal}>
        {t("terminal:local.openWithCommand")}
      </Button>
      {feedback && (
        <span className="cloud-command__feedback" role="status">
          {t(feedbackKey[feedback])}
        </span>
      )}
    </div>
  );
}

/** What went wrong with a cloud CLI and what to do about it. */
export function CloudProblemView({ problem, onTerminalOpened }: { problem: CloudProblem; onTerminalOpened?: () => void }) {
  const { t } = useTranslation();
  const cli = t(`clusters:cloud.cli.${problem.provider}`);
  return (
    <div className="cloud-problem" role="note" data-kind={problem.kind}>
      <p className="cloud-problem__title">
        {problem.scope
          ? t(`clusters:cloud.problemIn.${problem.kind}`, { cli, scope: problem.scope })
          : t(`clusters:cloud.problem.${problem.kind}`, { cli })}
      </p>
      {problem.command && (
        <>
          <p className="clusters-hint">{t(`clusters:cloud.problemHint.${problem.kind}`)}</p>
          <CommandLine command={problem.command} onTerminalOpened={onTerminalOpened} />
        </>
      )}
      {problem.url && (
        <Button size="compact" onClick={() => void api.shell.openUrl(problem.url!)}>
          {t("clusters:cloud.installGuide")}
        </Button>
      )}
      {problem.message && problem.kind !== "cliMissing" && problem.kind !== "pluginMissing" && (
        <p className="clusters-error__details">{t("common:error.details", { message: problem.message })}</p>
      )}
    </div>
  );
}
