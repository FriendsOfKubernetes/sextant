// Shared pieces of the demo recordings (scripts/demo-gif.sh): the ffmpeg recorder and a drawn cursor that glides to
// every control before it is clicked (WebDriver clicks do not move the real pointer).
import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";
import { $, browser } from "@wdio/globals";
import { typeText } from "../app";

type Element = ReturnType<typeof $>;

export const WIDTH = 1280;
export const HEIGHT = 800;
/** The MCP server's port in the demo profile: not the default 47391, so a Sextant the developer runs does not clash. */
export const MCP_PORT = 47491;
const GLIDE_MS = 650;

let recorder: ChildProcess | null = null;

export function startRecording(): void {
  const out = process.env.SEXTANT_DEMO_VIDEO;
  const display = process.env.DISPLAY;
  if (!out || !display) throw new Error("SEXTANT_DEMO_VIDEO and DISPLAY must be set (run scripts/demo-gif.sh)");
  recorder = spawn(
    "ffmpeg",
    [
      ...["-loglevel", "error", "-y", "-f", "x11grab", "-draw_mouse", "0", "-framerate", "30"],
      ...["-video_size", `${WIDTH}x${HEIGHT}`, "-i", display],
      ...["-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", out],
    ],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
}

export function stopRecording(): Promise<void> {
  const proc = recorder;
  recorder = null;
  if (!proc) return Promise.resolve();
  return new Promise((resolve) => {
    proc.once("exit", () => resolve());
    // "q" lets ffmpeg finish the file properly.
    proc.stdin?.end("q");
  });
}

/** Draws the cursor (once per document) and glides it to the centre of `el`. */
export async function pointAt(el: Element): Promise<void> {
  await el.waitForDisplayed();
  await browser.execute(
    (node: HTMLElement, ms: number) => {
      let cursor = document.getElementById("sextant-demo-cursor");
      if (!cursor) {
        cursor = document.createElement("div");
        cursor.id = "sextant-demo-cursor";
        Object.assign(cursor.style, {
          position: "fixed",
          left: "0",
          top: "0",
          zIndex: "2147483647",
          pointerEvents: "none",
          transform: `translate(${window.innerWidth / 2}px, ${window.innerHeight / 2}px)`,
        });
        cursor.innerHTML =
          '<svg width="22" height="22" viewBox="0 0 24 24" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))">' +
          '<path d="M3 2 L3 19 L8 14.5 L11.5 22 L14.5 20.6 L11 13.4 L17.5 13.4 Z" fill="#111" stroke="#fff" ' +
          'stroke-width="1.6" stroke-linejoin="round"/></svg>';
        document.body.appendChild(cursor);
        // Commit the start position before the transition is set.
        cursor.getBoundingClientRect();
      }
      const r = node.getBoundingClientRect();
      cursor.style.transition = `transform ${ms}ms cubic-bezier(.45,.05,.25,1)`;
      cursor.style.transform = `translate(${Math.round(r.left + r.width / 2) - 3}px, ${Math.round(r.top + r.height / 2) - 2}px)`;
    },
    await el.getElement(),
    GLIDE_MS,
  );
  await browser.pause(GLIDE_MS + 80);
}

/** A ring that spreads from the cursor tip: where the click lands. */
export async function ripple(): Promise<void> {
  await browser.execute(() => {
    const cursor = document.getElementById("sextant-demo-cursor");
    if (!cursor) return;
    const ring = document.createElement("div");
    Object.assign(ring.style, {
      position: "absolute",
      left: "-11px",
      top: "-10px",
      width: "28px",
      height: "28px",
      borderRadius: "50%",
      border: "3px solid rgba(59,130,246,.85)",
    });
    cursor.prepend(ring);
    ring
      .animate(
        [
          { transform: "scale(.3)", opacity: 1 },
          { transform: "scale(1.4)", opacity: 0 },
        ],
        { duration: 450, easing: "ease-out" },
      )
      .finished.then(() => ring.remove());
  });
}

export interface DemoClickOptions {
  button?: "left" | "right";
  /**
   * Moves WebDriver's pointer off the control after the click, so its hover tooltip does not cover what opens. The
   * drawn cursor stays where it clicked.
   */
  leave?: boolean;
}

export async function demoClick(el: Element, { button = "left", leave = false }: DemoClickOptions = {}): Promise<void> {
  await pointAt(el);
  await el.waitForClickable();
  await ripple();
  await el.click({ button });
  if (leave) await browser.action("pointer").move({ x: Math.round(WIDTH * 0.55), y: HEIGHT - 40 }).perform();
}

/** Types like a person: one key at a time with a short gap. */
export async function typeSlowly(text: string): Promise<void> {
  for (const key of text) {
    await typeText(key);
    await browser.pause(70);
  }
}

export async function openSection(entry: string, group?: string): Promise<void> {
  const sidebar = $('nav[aria-label="Sections"]');
  await sidebar.waitForDisplayed();
  if (group) {
    const groupButton = sidebar.$(`button[aria-expanded]=${group}`);
    if ((await groupButton.isExisting()) && (await groupButton.getAttribute("aria-expanded")) === "false") {
      await demoClick(groupButton);
    }
  }
  await demoClick(sidebar.$(`button=${entry}`));
}
