// The terminal measures its cell on the monospace font, so it waits for it (ADR-0093).
import { act, renderHook, waitFor } from "@testing-library/react";
import { FitAddon } from "@xterm/addon-fit";
import { useRef } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api, mockBackend, type MockBackend } from "../../api";
import { applyFonts, BUILTIN_MONO_STACK, SYSTEM_MONO_STACK } from "../../app/fonts";
import { FONT_WAIT_MS, useTerminal } from "./useTerminal";

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { value: () => null, configurable: true });
});

/** `document.fonts` whose loads wait until `release(stack)` (or resolve at once for stacks in `ready`). */
function fakeFonts(ready: string[] = []) {
  const waiting = new Map<string, Array<() => void>>();
  const load = vi.fn((font: string) => {
    const stack = font.replace(/^(bold )?13px /, "");
    if (ready.includes(stack)) return Promise.resolve([]);
    return new Promise<FontFace[]>((resolve) => {
      waiting.set(stack, [...(waiting.get(stack) ?? []), () => resolve([])]);
    });
  });
  Object.defineProperty(document, "fonts", { value: { load }, configurable: true });
  return {
    load,
    release(stack: string) {
      for (const done of waiting.get(stack) ?? []) done();
      waiting.delete(stack);
    },
  };
}

/** xterm is slow to build on a loaded machine. */
const SLOW = { timeout: 5000 };

let backend: MockBackend;
let el: HTMLDivElement;

beforeEach(() => {
  backend = mockBackend({
    terminal_start: () => undefined,
    term_input: () => undefined,
    term_resize: () => undefined,
    term_stop: () => undefined,
  });
  el = document.createElement("div");
  document.body.appendChild(el);
});

afterEach(() => {
  backend.restore();
  el.remove();
  applyFonts(null);
  vi.useRealTimers();
  Reflect.deleteProperty(document, "fonts");
});

function renderTerminal() {
  return renderHook(() => {
    const ref = useRef<HTMLElement | null>(el);
    return useTerminal(ref, (cols, rows, id, onEvent) => api.terminal.local(null, cols, rows, id, onEvent));
  });
}

const starts = () => backend.calls.filter((c) => c.cmd === "terminal_start");

describe("the terminal's font", () => {
  it("is loaded before the terminal is created and its session started", async () => {
    const fonts = fakeFonts();
    const { result } = renderTerminal();
    await act(async () => {
      await Promise.resolve();
    });
    expect(fonts.load).toHaveBeenCalledWith(`13px ${BUILTIN_MONO_STACK}`);
    expect(fonts.load).toHaveBeenCalledWith(`bold 13px ${BUILTIN_MONO_STACK}`);
    expect(result.current.terminal).toBeNull();
    expect(starts()).toHaveLength(0);

    act(() => fonts.release(BUILTIN_MONO_STACK));
    await waitFor(() => expect(result.current.terminal).not.toBeNull(), SLOW);
    expect(result.current.terminal?.options.fontFamily).toBe(BUILTIN_MONO_STACK);
    await waitFor(() => expect(starts()).toHaveLength(1), SLOW);
  });

  it("starts on the system stack when the font is slow, and switches and refits once it arrives", async () => {
    const family = '"Slow Mono", ' + BUILTIN_MONO_STACK;
    applyFonts({ monoFont: { kind: "custom", family: "Slow Mono" } });
    const fonts = fakeFonts();
    const fit = vi.spyOn(FitAddon.prototype, "fit");
    vi.useFakeTimers();
    const { result } = renderTerminal();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FONT_WAIT_MS);
    });
    vi.useRealTimers();
    const term = result.current.terminal;
    if (!term) throw new Error("no terminal after the wait");
    expect(term.options.fontFamily).toBe(SYSTEM_MONO_STACK);

    fit.mockClear();
    act(() => fonts.release(family));
    await waitFor(() => expect(term.options.fontFamily).toBe(family), SLOW);
    expect(fit).toHaveBeenCalled();
    fit.mockRestore();
  });

  it("follows a change of the monospace setting: the new font, measured again and refitted", async () => {
    const custom = '"JetBrains Mono", ' + BUILTIN_MONO_STACK;
    fakeFonts([BUILTIN_MONO_STACK, custom, SYSTEM_MONO_STACK]);
    const { result } = renderTerminal();
    await waitFor(() => expect(result.current.terminal).not.toBeNull(), SLOW);
    const term = result.current.terminal;
    if (!term) throw new Error("no terminal");
    const fit = vi.spyOn(FitAddon.prototype, "fit");

    act(() => applyFonts({ monoFont: { kind: "custom", family: "JetBrains Mono" } }));
    await waitFor(() => expect(term.options.fontFamily).toBe(custom), SLOW);
    expect(fit).toHaveBeenCalled();

    act(() => applyFonts({ monoFont: { kind: "system" } }));
    await waitFor(() => expect(term.options.fontFamily).toBe(SYSTEM_MONO_STACK), SLOW);
    fit.mockRestore();
  });
});
