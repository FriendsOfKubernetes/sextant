// The window-wide dialog for what an AI agent or an extension asks to do (`mcp-confirm`, `request.source`), mounted
// once by the window shell (`AppShell`). Requests of both wait in one queue and are shown one at a time, naming who
// asks (`request.principal`). Each one is refused by the backend after 120 s without an answer, so it also leaves the
// queue here then; nothing runs without a click on "Allow".
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, events, type ConfirmRequest } from "../../api";
import { Button } from "../../components";
import "./mcp.css";

/** How long the backend waits for an answer (`confirm.rs`). */
export const CONFIRM_TIMEOUT_MS = 120_000;
/** Tools (of agents) and methods (of extensions) whose confirmation button is drawn as dangerous. */
const DANGEROUS_TOOLS: ReadonlySet<string> = new Set([
  "delete_resource",
  "drain_node",
  "helm_uninstall",
  "resources.delete",
]);

interface Pending {
  request: ConfirmRequest;
  /** When the backend stops waiting. */
  deadline: number;
}

export function ConfirmHost() {
  const { t } = useTranslation();
  const [queue, setQueue] = useState<Pending[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const answered = useRef(new Set<string>());

  useEffect(() => {
    let live = true;
    const unsubscribe = events.onMcpConfirm((request) => {
      if (!live) return;
      setNow(Date.now());
      setQueue((current) =>
        current.some((p) => p.request.id === request.id)
          ? current
          : [...current, { request, deadline: Date.now() + CONFIRM_TIMEOUT_MS }],
      );
    });
    return () => {
      live = false;
      void unsubscribe.then((off) => off(), () => undefined);
    };
  }, []);

  const waiting = queue.length > 0;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      const time = Date.now();
      setNow(time);
      setQueue((current) => (current.some((p) => p.deadline <= time) ? current.filter((p) => p.deadline > time) : current));
    }, 1000);
    return () => clearInterval(timer);
  }, [waiting]);

  const first = queue[0];
  if (!first) return null;
  const { request } = first;

  const answer = (approved: boolean) => {
    if (answered.current.has(request.id)) return;
    answered.current.add(request.id);
    setQueue((current) => current.filter((p) => p.request.id !== request.id));
    // `notFound` means it timed out or the server stopped meanwhile: nothing left to answer.
    api.mcp.confirmAnswer(request.id, approved).catch(() => undefined);
  };

  const left = Math.max(0, Math.ceil((first.deadline - now) / 1000));
  const time = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  const more = queue.length - 1;
  const extension = request.source === "extension";
  // Agents call tools (`delete_resource`), extensions methods (`resources.delete`).
  const action = t(extension ? `mcp:methods.${request.tool}` : `mcp:tools.${request.tool}`, {
    defaultValue: request.tool,
  });
  const who = extension ? request.principal : request.client;

  return (
    <div className="dialog-backdrop mcp-confirm" key={request.id}>
      <div
        className="dialog mcp-confirm__dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="mcp-confirm-title"
        aria-describedby="mcp-confirm-intro"
        onKeyDown={(e) => {
          if (e.key === "Escape") answer(false);
        }}
      >
        <header className="dialog__header">
          <h2 id="mcp-confirm-title">{t(extension ? "mcp:confirm.extensionTitle" : "mcp:confirm.title")}</h2>
        </header>
        <div className="dialog__body">
          <p id="mcp-confirm-intro" className="mcp-confirm__intro">
            {t("mcp:confirm.intro", { client: who, cluster: request.clusterName })}
          </p>
          <dl className="mcp-confirm__facts">
            <dt>{t(extension ? "mcp:confirm.extension" : "mcp:confirm.client")}</dt>
            <dd>{who}</dd>
            <dt>{t("mcp:confirm.cluster")}</dt>
            <dd>{request.clusterName}</dd>
            <dt>{t("mcp:confirm.action")}</dt>
            <dd>
              {action}
              {action !== request.tool && <code className="mcp-confirm__tool">{request.tool}</code>}
            </dd>
            <dt>{t("mcp:confirm.target")}</dt>
            <dd className="mcp-confirm__target">{request.target}</dd>
          </dl>
          {request.details && (
            <>
              <h3 className="mcp-confirm__details-title">{t("mcp:confirm.details")}</h3>
              <pre className="mcp-confirm__details" tabIndex={0}>
                {request.details}
              </pre>
            </>
          )}
          {more > 0 && <p className="settings__hint">{t("mcp:confirm.waiting", { count: more })}</p>}
        </div>
        <footer className="dialog__footer mcp-confirm__footer">
          <span className="mcp-confirm__countdown" role="timer">
            {t("mcp:confirm.countdown", { time })}
          </span>
          <Button autoFocus onClick={() => answer(false)}>
            {t("mcp:confirm.deny")}
          </Button>
          <Button variant={DANGEROUS_TOOLS.has(request.tool) ? "danger" : "primary"} onClick={() => answer(true)}>
            {t("mcp:confirm.allow")}
          </Button>
        </footer>
      </div>
    </div>
  );
}
