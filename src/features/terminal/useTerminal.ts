// Connects an xterm.js terminal to a backend terminal session (container shell or local shell).
//
// Protocol (interfaces.md §1): `openStream` chooses the session id and subscribes to `term:<id>` before the session
// starts (`exec_start` / `terminal_start` with that id), so the first prompt is never lost; once the start answered,
// keystrokes go to `term_input` (those typed before it are kept and sent first) and size changes to `term_resize`. The session is stopped when the component
// unmounts (the dock tab is closed) or reconnects.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { api, events, openStream, toApiError, type ApiError, type TermPayload } from "../../api";

/** Starts a session of `cols`×`rows` under `streamId` (its output is already listened to). */
export type TerminalSessionFactory = (cols: number, rows: number, streamId: string) => Promise<unknown>;

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
/** The initial input is typed once the shell has been quiet this long after printing (its prompt is up). */
const INPUT_QUIET_MS = 300;
/** …or this long after the session started, if the shell prints nothing. */
const INPUT_FALLBACK_MS = 2000;

/**
 * Renders a terminal into `container` and runs a session from `factory` in it. `active` tells that the terminal is
 * visible (the dock tab is selected and the dock open): it is refitted and focused then. `initialInput` is typed into
 * a new session once its shell is ready, on one line and without Enter: the user reads it and runs it.
 */
export function useTerminal(
  container: RefObject<HTMLElement | null>,
  factory: TerminalSessionFactory,
  active = true,
  initialInput?: string,
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
  const initialInputRef = useRef(initialInput);
  initialInputRef.current = initialInput;

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
    let lastSize = "";
    // Never Enter, nor any other control character: the command is shown, not run.
    let pendingInput = printable(initialInputRef.current ?? "") || null;
    let inputTimer: ReturnType<typeof setTimeout> | undefined;
    let sawOutput = false;
    const typeInitialInput = () => {
      const id = sessionId;
      if (!pendingInput || !id || cancelled) return;
      const text = pendingInput;
      pendingInput = null;
      api.terminal.input(id, text).catch(() => undefined);
    };
    const scheduleInput = (delay: number) => {
      if (!pendingInput) return;
      clearTimeout(inputTimer);
      inputTimer = setTimeout(typeInitialInput, delay);
    };
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
      switch (payload.type) {
        case "data":
          terminal.write(decodeBase64(payload.data));
          sawOutput = true;
          scheduleInput(INPUT_QUIET_MS);
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

    // Keys typed before the start answered (the prompt may already be on screen) wait here and go first (#107).
    let typedEarly = "";
    const input = terminal.onData((data) => {
      if (sessionId) api.terminal.input(sessionId, data).catch(() => undefined);
      else typedEarly += data;
    });
    const resize = terminal.onResize(() => sendSize());

    safeFit(fitRef.current);
    const cols = terminal.cols || DEFAULT_COLS;
    const rows = terminal.rows || DEFAULT_ROWS;
    const close = openStream<TermPayload>({
      start: (id) => factoryRef.current(cols, rows, id),
      listen: events.onTerm,
      stop: api.terminal.stop,
      onEvent: onPayload,
      onListening: (id) => {
        sessionId = id;
        sessionRef.current = id;
        if (typedEarly) {
          // One call keeps the keys in the order they were typed.
          api.terminal.input(id, typedEarly).catch(() => undefined);
          typedEarly = "";
        }
        setStatus((s) => (s === "connecting" ? "running" : s));
        // The terminal may have been fitted while the session started.
        lastSize = `${terminal.cols}x${terminal.rows}`;
        api.terminal.resize(id, terminal.cols, terminal.rows).catch(fail);
        // The prompt may have come before the start answered; otherwise wait for it (or give up waiting).
        scheduleInput(sawOutput ? INPUT_QUIET_MS : INPUT_FALLBACK_MS);
      },
      onStartError: fail,
    });

    return () => {
      cancelled = true;
      clearTimeout(inputTimer);
      input.dispose();
      resize.dispose();
      close();
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

/**
 * `text` on one line without control characters (C0 including ESC, DEL, C1): each run of them becomes a space, so a
 * command typed into a shell can neither run itself (Enter, Ctrl+J) nor send key sequences.
 */
export function printable(text: string): string {
  let out = "";
  let gap = false;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      gap = true;
      continue;
    }
    if (gap && out) out += " ";
    gap = false;
    out += ch;
  }
  return out.trim();
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
