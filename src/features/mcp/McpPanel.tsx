// The "AI agents (MCP)" section of Settings: the switch, the port, the status, the token and the configuration
// snippets for Claude Code, Cursor and Claude Desktop. The real token is read from the backend only when the user
// shows or copies it, and is forgotten when hidden again.
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, type AppSettings, type McpStatus } from "../../api";
import { Button, Checkbox, ConfirmDialog, Tabs } from "../../components";
import "./mcp.css";
import { mcpUrl, parsePort, SNIPPET_KINDS, snippet, snippetHasToken, type SnippetKind } from "./snippets";
import { useMcpUi } from "./store";
import { useMcpStatus } from "./useMcpStatus";

export interface McpPanelProps {
  settings: AppSettings | null;
  /** Saves a settings change; resolves to `false` when it failed (Settings shows the error). */
  save: (change: (current: AppSettings) => AppSettings) => Promise<boolean>;
}

export function McpPanel({ settings, save }: McpPanelProps) {
  const { t } = useTranslation();
  const openActivity = useMcpUi((s) => s.openActivity);
  const enabled = settings?.mcp.enabled ?? false;
  const status = useMcpStatus(enabled);

  return (
    <div className="mcp">
      <label className="mcp__switch">
        <Checkbox
          checked={enabled}
          disabled={!settings}
          onChange={(e) => {
            const next = e.target.checked;
            void save((s) => ({ ...s, mcp: { ...s.mcp, enabled: next } }));
          }}
        />
        {t("mcp:enable")}
      </label>
      <StatusLine enabled={enabled} status={status} />
      <PortField settings={settings} save={save} />
      {enabled && <TokenAndSnippets port={settings?.mcp.port ?? 0} />}
      <div className="settings__row">
        <Button icon="agent" onClick={openActivity}>
          {t("mcp:activity.openLog")}
        </Button>
      </div>
    </div>
  );
}

function PortField({ settings, save }: McpPanelProps) {
  const { t } = useTranslation();
  const inputId = useId();
  const hintId = useId();
  const saved = settings?.mcp.port ?? null;
  const [text, setText] = useState(saved === null ? "" : String(saved));
  useEffect(() => {
    if (saved !== null) setText(String(saved));
  }, [saved]);

  const port = parsePort(text);
  const invalid = text.trim() !== "" && port === null;
  const submit = () => {
    if (port !== null && port !== saved) void save((s) => ({ ...s, mcp: { ...s.mcp, port } }));
  };

  return (
    <form
      className="mcp__port"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="settings__label" htmlFor={inputId}>
        {t("mcp:port.label")}
      </label>
      <div className="settings__row">
        <input
          id={inputId}
          className="settings__input mcp__port-input"
          type="text"
          inputMode="numeric"
          spellCheck={false}
          autoComplete="off"
          value={text}
          disabled={!settings}
          aria-invalid={invalid}
          aria-describedby={hintId}
          onChange={(e) => setText(e.target.value)}
        />
        <Button type="submit" variant="primary" disabled={!settings || port === null || port === saved}>
          {t("mcp:port.apply")}
        </Button>
      </div>
      <p id={hintId} className="settings__hint" data-invalid={invalid || undefined}>
        {t(invalid ? "mcp:port.invalid" : "mcp:port.hint")}
      </p>
    </form>
  );
}

function StatusLine({ enabled, status }: { enabled: boolean; status: McpStatus | null }) {
  const { t } = useTranslation();
  let text: string;
  let state: string;
  if (!enabled) {
    text = t("mcp:status.off");
    state = "off";
  } else if (status?.state === "running") {
    text = t("mcp:status.running", { url: status.url ?? "" });
    state = "running";
  } else if (status?.state === "error") {
    text = status.error || t("mcp:status.error");
    state = "error";
  } else {
    text = t("mcp:status.starting");
    state = "starting";
  }
  return (
    <p className="settings__status mcp__status" role="status" data-state={state}>
      {text}
    </p>
  );
}

function TokenAndSnippets({ port }: { port: number }) {
  const { t } = useTranslation();
  const [shown, setShown] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);

  const fail = (err: unknown) => setNotice({ kind: "error", text: t("mcp:token.failed", { message: toApiError(err).message }) });

  const toggle = async () => {
    if (shown !== null) {
      setShown(null);
      return;
    }
    try {
      setShown(await api.mcp.token());
      setNotice(null);
    } catch (err) {
      fail(err);
    }
  };

  const copy = async () => {
    try {
      const token = await api.mcp.token();
      await writeClipboard(token);
      setNotice({ kind: "ok", text: t("mcp:token.copied") });
    } catch (err) {
      fail(err);
    }
  };

  const regenerate = async () => {
    setConfirming(false);
    try {
      const fresh = await api.mcp.regenerateToken();
      setShown((current) => (current === null ? null : fresh));
      setNotice({ kind: "ok", text: t("mcp:token.regenerated") });
    } catch (err) {
      fail(err);
    }
  };

  return (
    <>
      <div className="settings__field">
        <span className="settings__label">{t("mcp:token.label")}</span>
        <div className="settings__row">
          <code className="mcp__token" data-testid="mcp-token">
            {shown ?? t("mcp:token.masked")}
          </code>
          <Button icon={shown === null ? "eye" : "eyeOff"} aria-pressed={shown !== null} onClick={() => void toggle()}>
            {t(shown === null ? "mcp:token.show" : "mcp:token.hide")}
          </Button>
          <Button icon="copy" onClick={() => void copy()}>
            {t("mcp:token.copy")}
          </Button>
          <Button icon="reset" onClick={() => setConfirming(true)}>
            {t("mcp:token.regenerate")}
          </Button>
        </div>
        <p className="settings__hint">{t("mcp:token.hint")}</p>
        {notice && (
          <p className="settings__status mcp__notice" role={notice.kind === "error" ? "alert" : "status"} data-kind={notice.kind}>
            {notice.text}
          </p>
        )}
      </div>
      <Snippets port={port} token={shown} />
      <ConfirmDialog
        open={confirming}
        title={t("mcp:token.confirmTitle")}
        confirmLabel={t("mcp:token.regenerate")}
        danger
        onCancel={() => setConfirming(false)}
        onConfirm={() => void regenerate()}
      >
        <p>{t("mcp:token.confirmBody")}</p>
      </ConfirmDialog>
    </>
  );
}

function Snippets({ port, token }: { port: number; token: string | null }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<SnippetKind>("claudeCode");
  const [binary, setBinary] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const url = mcpUrl(port);

  useEffect(() => {
    let live = true;
    api.mcp.binaryPath().then(
      (path) => live && setBinary(path),
      () => undefined,
    );
    return () => {
      live = false;
      clearTimeout(timer.current);
    };
  }, []);

  const select = (next: SnippetKind) => {
    setKind(next);
    setFeedback(null);
  };

  const copy = async () => {
    clearTimeout(timer.current);
    try {
      const real = snippetHasToken(kind) ? await api.mcp.token() : "";
      await writeClipboard(snippet(kind, { url, token: real, binary }));
      setFeedback({ kind: "ok", text: t("mcp:snippets.copied") });
      timer.current = setTimeout(() => setFeedback(null), 3000);
    } catch (err) {
      setFeedback({ kind: "error", text: t("mcp:snippets.copyFailed", { message: toApiError(err).message }) });
    }
  };

  const shownToken = token ?? t("mcp:token.masked");
  return (
    <div className="settings__field">
      <span className="settings__label">{t("mcp:snippets.title")}</span>
      <Tabs
        label={t("mcp:snippets.tabs")}
        tabs={SNIPPET_KINDS.map((id) => ({ id, label: t(`mcp:snippets.${id}`) }))}
        selected={kind}
        onSelect={select}
      >
        <p className="settings__hint">{t(`mcp:snippets.${kind}Hint`)}</p>
        <pre className="mcp__snippet" data-testid="mcp-snippet">
          {snippet(kind, { url, token: shownToken, binary })}
        </pre>
        {snippetHasToken(kind) && token === null && <p className="settings__hint">{t("mcp:snippets.tokenHidden")}</p>}
        <div className="settings__row">
          <Button
            icon="copy"
            aria-label={t("mcp:snippets.copyFor", { name: t(`mcp:snippets.${kind}`) })}
            onClick={() => void copy()}
          >
            {t("mcp:snippets.copy")}
          </Button>
          {feedback && (
            <span className="mcp__feedback" role={feedback.kind === "error" ? "alert" : "status"} data-kind={feedback.kind}>
              {feedback.text}
            </span>
          )}
        </div>
      </Tabs>
    </div>
  );
}

async function writeClipboard(text: string): Promise<void> {
  if (!navigator.clipboard) throw new Error("the clipboard is not available");
  await navigator.clipboard.writeText(text);
}
