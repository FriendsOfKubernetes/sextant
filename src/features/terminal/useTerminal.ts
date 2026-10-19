// Connects an xterm.js terminal to a backend terminal session (container shell or local shell).
//
// Protocol (interfaces.md §1): `openStream` chooses the session id and creates the channel of its output before the
// session starts (`exec_start` / `terminal_start` with that id and channel), so the first prompt is never lost; once
// the start answered, keystrokes go to `term_input` (those typed before it are kept and sent first) and size changes to
// `term_resize`. The session is stopped when the component unmounts (the dock tab is closed) or reconnects.
//
// Output is flow-controlled (#122): once xterm has written a chunk (its write callback), its bytes are acknowledged
// with `term_ack`, in batches; the backend stops reading a shell whose output the terminal is too far behind on, so a
// command that prints without a pause (`yes`) cannot pile up output in the web view.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { api, openStream, toApiError, type ApiError, type StreamChannel, type TermPayload } from "../../api";
import { i18n } from "../../i18n";
import { isControl, isInvisible } from "./text";

/** Starts a session of `cols`×`rows` under `streamId`, its output sent through `onEvent` (created before the start). */
export type TerminalSessionFactory = (
  cols: number,
  rows: number,
  streamId: string,
  onEvent: StreamChannel<TermPayload>,
) => Promise<unknown>;

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
  /**
   * Types `data` into the running session as if it was typed (a snippet, broadcast input). Before the start answered
   * it waits like early keystrokes; once the session ended it is dropped.
   */
  send: (data: string) => void;
}

export interface UseTerminalOptions {
  /**
   * Sees every keystroke typed into this terminal first; `true` takes it (it is not sent to this session), e.g.
   * broadcast input, which sends it to every target pane itself.
   */
  interceptInput?: (data: string) => boolean;
  /** Sees key events in the terminal first; `false` takes the key (xterm ignores it), e.g. moving between panes. */
  onKey?: (e: KeyboardEvent) => boolean;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** The initial input is typed once the shell has been quiet this long after printing (its prompt is up). */
const INPUT_QUIET_MS = 300;
/** …or this long after the session started, if the shell prints nothing. */
const INPUT_FALLBACK_MS = 2000;
/** Written output is acknowledged once this many bytes are written… */
export const ACK_BYTES = 64 * 1024;
/** …or this long after the first write not acknowledged yet. */
export const ACK_DELAY_MS = 50;

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
  options: UseTerminalOptions = {},
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
  const optionsRef = useRef(options);
  optionsRef.current = options;
  /** Sends to the current session (set while one runs). */
  const sendRef = useRef<(data: string) => void>(() => undefined);

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
    term.attachCustomKeyEventHandler((e) => {
      // The one key the terminal never takes: it moves the focus out (a shell gets everything else, Tab included).
      if (isLeaveTerminalKey(e)) {
        e.preventDefault();
        leaveTerminal(el);
        return false;
      }
      const onKey = optionsRef.current.onKey;
      if (onKey && !onKey(e)) return false;
      return clipboardKeys(term, e);
    });
    term.open(el);
    const hint = describeLeaveKey(el, term.textarea);
    fitRef.current = fit;
    setTerminal(term);

    // Follow the app theme (`<html data-theme>`).
    const themeObserver = new MutationObserver(() => {
      term.options.theme = themeFromCss(el);
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      themeObserver.disconnect();
      hint();
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
    // The id the session was started under (known before its first output) and its output written, not acknowledged.
    let streamId: string | null = null;
    let written = 0;
    let ackTimer: ReturnType<typeof setTimeout> | undefined;
    const sendAck = () => {
      clearTimeout(ackTimer);
      ackTimer = undefined;
      if (cancelled || !streamId || written === 0) return;
      const bytes = written;
      written = 0;
      api.terminal.ack(streamId, bytes).catch(() => undefined);
    };
    const wrote = (bytes: number) => {
      if (cancelled) return;
      written += bytes;
      if (written >= ACK_BYTES) sendAck();
      else ackTimer ??= setTimeout(sendAck, ACK_DELAY_MS);
    };
    let lastSize = "";
    // Never Enter, nor any other control character: the command is shown, not run.
    let pendingInput = printable(initialInputRef.current ?? "") || null;
    let inputTimer: ReturnType<typeof setTimeout> | undefined;
    let sawOutput = false;
    // The session exited or failed: nothing more is sent to it.
    let ended = false;
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
      ended = true;
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
        case "data": {
          const bytes = decodeBase64(payload.data);
          terminal.write(bytes, () => wrote(bytes.length));
          sawOutput = true;
          scheduleInput(INPUT_QUIET_MS);
          break;
        }
        case "exit":
          ended = true;
          setExitCode(payload.code);
          setStatus("ended");
          break;
        case "error":
          ended = true;
          setError(toApiError(payload.error));
          setStatus("error");
          break;
      }
    };

    // Keys typed before the start answered (the prompt may already be on screen) wait here and go first (#107).
    let typedEarly = "";
    const sendToSession = (data: string) => {
      if (cancelled || ended || !data) return;
      if (sessionId) api.terminal.input(sessionId, data).catch(() => undefined);
      else typedEarly += data;
    };
    sendRef.current = sendToSession;
    const input = terminal.onData((data) => {
      if (optionsRef.current.interceptInput?.(data)) return;
      sendToSession(data);
    });
    const resize = terminal.onResize(() => sendSize());

    safeFit(fitRef.current);
    const cols = terminal.cols || DEFAULT_COLS;
    const rows = terminal.rows || DEFAULT_ROWS;
    const close = openStream<TermPayload>({
      start: (id, channel) => {
        streamId = id;
        return factoryRef.current(cols, rows, id, channel);
      },
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
      clearTimeout(ackTimer);
      input.dispose();
      resize.dispose();
      close();
      sessionRef.current = null;
      if (sendRef.current === sendToSession) sendRef.current = () => undefined;
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

  const send = useCallback((data: string) => sendRef.current(data), []);

  return { status, exitCode, error, reconnect, terminal, send };
}

/**
 * `text` on one line without control characters (C0 including ESC, DEL, C1) or invisible and text-direction
 * characters ([`isInvisible`]): each run of control characters becomes a space and invisible ones are dropped, so a
 * command typed into a shell can neither run itself (Enter, Ctrl+J) nor send key sequences, nor look different from
 * what it is.
 */
export function printable(text: string): string {
  let out = "";
  let gap = false;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // Invisible characters go without a trace; a run of control characters becomes one space.
    if (isInvisible(code)) continue;
    if (isControl(code)) {
      gap = true;
      continue;
    }
    if (gap && out) out += " ";
    gap = false;
    out += ch;
  }
  return out.trim();
}

/**
 * Ctrl+Shift+E leaves the terminal (#158): xterm takes every other key, Tab and Escape included, as the shell needs
 * them. A shell never sees Ctrl+Shift+E apart from Ctrl+E, which still reaches it. The key is matched by the letter it
 * types (Dvorak's E is elsewhere), and by the physical key only when the layout types no Latin letter there (Cyrillic).
 */
export function isLeaveTerminalKey(
  e: Pick<KeyboardEvent, "type" | "key" | "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">,
): boolean {
  if (e.type !== "keydown" || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return false;
  return /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() === "e" : e.code === "KeyE";
}

/** Moves the focus from the terminal in `el` to its dock tab (or, outside the dock, out of the terminal). */
function leaveTerminal(el: HTMLElement): void {
  const panel = el.closest('[role="tabpanel"]');
  const tabId = panel?.getAttribute("aria-labelledby");
  const tab = tabId ? document.getElementById(tabId) : null;
  if (tab) tab.focus();
  else (document.activeElement as HTMLElement | null)?.blur();
}

let hintIds = 0;

/** Tells screen readers about the leave key when the terminal's input is focused; returns the cleanup. */
function describeLeaveKey(el: HTMLElement, input: HTMLTextAreaElement | undefined): () => void {
  if (!input) return () => undefined;
  const hint = document.createElement("span");
  hint.id = `terminal-leave-hint-${++hintIds}`;
  hint.className = "visually-hidden";
  const update = () => {
    hint.textContent = i18n.t("a11y:terminal.leaveHint");
  };
  update();
  el.appendChild(hint);
  input.setAttribute("aria-describedby", hint.id);
  i18n.on("languageChanged", update);
  return () => {
    i18n.off("languageChanged", update);
    hint.remove();
  };
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
