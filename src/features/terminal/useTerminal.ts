// Connects an xterm.js terminal to a backend terminal session (container shell or local shell).
//
// Protocol (interfaces.md, «Правило для стримов»): start the session (`exec_start` / `terminal_start`), subscribe to
// `term:<id>`, then send the first `term_resize` — the backend holds the session's output until that resize, so
// nothing printed before the subscription is lost. Keystrokes go to `term_input`; the session is stopped when the
// component unmounts (the dock tab is closed) or reconnects.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { api, events, toApiError, type ApiError, type TermPayload, type Unsubscribe } from "../../api";

/** Starts a session of `cols`×`rows`; resolves to its id. */
export type TerminalSessionFactory = (cols: number, rows: number) => Promise<string>;

export type TerminalStatus = "connecting" | "running" | "ended" | "error";

export interface UseTerminal {
  status: TerminalStatus;
  /** Exit code of an ended session, when the backend knows it. */
  exitCode: number | null;
  error: ApiError | null;
  /** Starts a new session in the same terminal. */
  reconnect: () => void;
  /** The xterm instance (null before mount). */
  terminal: Terminal | null;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * Renders a terminal into `container` and runs a session from `factory` in it. `active` tells that the terminal is
 * visible (the dock tab is selected and the dock open): it is refitted and focused then.
 */
export function useTerminal(
  container: RefObject<HTMLElement | null>,
  factory: TerminalSessionFactory,
  active = true,
): UseTerminal {
  const [terminal, setTerminal] = useState<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const factoryRef = useRef(factory);
  factoryRef.current = factory;

  // The xterm instance lives as long as the component.
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      scrollback: 10_000,
      allowProposedApi: false,
      theme: themeFromCss(el),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.attachCustomKeyEventHandler((e) => clipboardKeys(term, e));
    term.open(el);
    fitRef.current = fit;
    setTerminal(term);

    // Follow the app theme (`<html data-theme>`).
    const themeObserver = new MutationObserver(() => {
      term.options.theme = themeFromCss(el);
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      themeObserver.disconnect();
      fitRef.current = null;
      setTerminal(null);
      term.dispose();
    };
  }, [container]);

  // One session per attempt.
  useEffect(() => {
    if (!terminal) return;
    let cancelled = false;
    let sessionId: string | null = null;
    let unsubscribe: Unsubscribe | null = null;
    let lastSize = "";
    setStatus("connecting");
    setExitCode(null);
    setError(null);

    const fail = (err: unknown) => {
      if (cancelled) return;
      setError(toApiError(err));
      setStatus("error");
    };

    const sendSize = () => {
      const id = sessionId;
      if (!id) return;
      const size = `${terminal.cols}x${terminal.rows}`;
      if (size === lastSize) return;
      lastSize = size;
      api.terminal.resize(id, terminal.cols, terminal.rows).catch(() => undefined);
    };

    const onPayload = (payload: TermPayload) => {
      if (cancelled) return;
      switch (payload.type) {
        case "data":
          terminal.write(decodeBase64(payload.data));
          break;
        case "exit":
          setExitCode(payload.code);
          setStatus("ended");
          break;
        case "error":
          setError(toApiError(payload.error));
          setStatus("error");
          break;
      }
    };

    const input = terminal.onData((data) => {
      if (sessionId) api.terminal.input(sessionId, data).catch(() => undefined);
    });
    const resize = terminal.onResize(() => sendSize());

    void (async () => {
      safeFit(fitRef.current);
      const cols = terminal.cols || DEFAULT_COLS;
      const rows = terminal.rows || DEFAULT_ROWS;
      let id: string;
      try {
        id = await factoryRef.current(cols, rows);
      } catch (err) {
        fail(err);
        return;
      }
      if (cancelled) {
        api.terminal.stop(id).catch(() => undefined);
        return;
      }
      const off = await events.onTerm(id, onPayload);
      if (cancelled) {
        off();
        api.terminal.stop(id).catch(() => undefined);
        return;
      }
      unsubscribe = off;
      sessionId = id;
      sessionRef.current = id;
      setStatus((s) => (s === "connecting" ? "running" : s));
      // We listen now: the first resize releases the output the backend held back.
      try {
        lastSize = `${terminal.cols}x${terminal.rows}`;
        await api.terminal.resize(id, terminal.cols, terminal.rows);
      } catch (err) {
        fail(err);
      }
    })();

    return () => {
      cancelled = true;
      input.dispose();
      resize.dispose();
      unsubscribe?.();
      if (sessionId) api.terminal.stop(sessionId).catch(() => undefined);
      sessionRef.current = null;
    };
  }, [terminal, attempt]);

  // Fit to the container whenever it changes size (dock resized, window resized, tab shown).
  useEffect(() => {
    const el = container.current;
    if (!el || !terminal || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => safeFit(fitRef.current));
    observer.observe(el);
    return () => observer.disconnect();
  }, [container, terminal]);

  useEffect(() => {
    if (!active || !terminal) return;
    safeFit(fitRef.current);
    terminal.focus();
  }, [active, terminal]);

  const reconnect = useCallback(() => {
    terminal?.reset();
    setAttempt((n) => n + 1);
  }, [terminal]);

  return { status, exitCode, error, reconnect, terminal };
}

/** Ctrl+Shift+C copies the selection, Ctrl+Shift+V pastes (the browser's own paste, handled by xterm). */
function clipboardKeys(term: Terminal, e: KeyboardEvent): boolean {
  if (e.type !== "keydown" || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return true;
  const key = e.key.toLowerCase();
  if (key === "c") {
    const selection = term.getSelection();
    if (selection) void navigator.clipboard?.writeText(selection).catch(() => undefined);
    e.preventDefault();
    return false;
  }
  if (key === "v") {
    // Not sent to the shell; the paste event that follows inserts the clipboard text.
    return false;
  }
  return true;
}

function safeFit(fit: FitAddon | null): void {
  try {
    fit?.fit();
  } catch {
    // Not laid out yet (hidden tab): the next resize fits it.
  }
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Terminal colors from the app's theme tokens; xterm's defaults where a token is missing. */
function themeFromCss(el: HTMLElement): ITheme {
  const style = getComputedStyle(el);
  const token = (name: string) => style.getPropertyValue(name).trim() || undefined;
  return {
    background: token("--color-dock"),
    foreground: token("--color-text"),
    cursor: token("--color-accent"),
    cursorAccent: token("--color-dock"),
    selectionBackground: token("--color-selected"),
  };
}
