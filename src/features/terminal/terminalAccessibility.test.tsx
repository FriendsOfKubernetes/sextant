// The terminal follows the accessibility settings of Settings -> Appearance (ADR-0092, #186): xterm's screen reader
// mode, no blinking cursor while motion is reduced, and its font size scaled with the interface text size.
import { act, renderHook, waitFor } from "@testing-library/react";
import { FitAddon } from "@xterm/addon-fit";
import { useRef } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api, mockBackend, type MockBackend } from "../../api";
import { applyAccessibility } from "../../app/accessibility";
import { useTerminal } from "./useTerminal";

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
  applyAccessibility(null);
});

function renderTerminal() {
  return renderHook(() => {
    const ref = useRef<HTMLElement | null>(el);
    return useTerminal(ref, (cols, rows, id, onEvent) => api.terminal.local(null, cols, rows, id, onEvent));
  });
}

describe("the terminal and the accessibility settings", () => {
  it("starts without the screen reader mode, with a blinking cursor at the default size", async () => {
    const { result } = renderTerminal();
    await waitFor(() => expect(result.current.terminal).not.toBeNull(), SLOW);
    const options = result.current.terminal!.options;
    expect(options.screenReaderMode).toBe(false);
    expect(options.cursorBlink).toBe(true);
    expect(options.fontSize).toBe(13);
  });

  it("follows a change live: screen reader mode on, no blinking with reduced motion, a larger font refitted", async () => {
    const { result } = renderTerminal();
    await waitFor(() => expect(result.current.terminal).not.toBeNull(), SLOW);
    const term = result.current.terminal!;
    const fit = vi.spyOn(FitAddon.prototype, "fit");

    act(() => applyAccessibility({ terminalScreenReader: true, reduceMotion: "on", textSize: 150 }));
    expect(term.options.screenReaderMode).toBe(true);
    expect(term.options.cursorBlink).toBe(false);
    expect(term.options.fontSize).toBe(20);
    expect(fit).toHaveBeenCalled();

    act(() => applyAccessibility({ terminalScreenReader: false, reduceMotion: "off", textSize: 90 }));
    expect(term.options.screenReaderMode).toBe(false);
    expect(term.options.cursorBlink).toBe(true);
    expect(term.options.fontSize).toBe(12);
    fit.mockRestore();
  });

  it("a new terminal is created with the settings in effect", async () => {
    applyAccessibility({ terminalScreenReader: true, reduceMotion: "on", textSize: 125 });
    const { result } = renderTerminal();
    await waitFor(() => expect(result.current.terminal).not.toBeNull(), SLOW);
    const options = result.current.terminal!.options;
    expect(options.screenReaderMode).toBe(true);
    expect(options.cursorBlink).toBe(false);
    expect(options.fontSize).toBe(16);
    // xterm's accessibility tree is there for the screen reader.
    expect(el.querySelector(".xterm-accessibility")).not.toBeNull();
  });
});
