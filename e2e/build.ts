// The app binary e2e runs, and whether it can be reused. `npm run check` (cargo clippy/test) rebuilds
// target/debug/sextant without the embedded frontend, so a binary is trusted only if e2e built it itself: after its
// own build (`tauri build --debug --no-bundle`, which runs `npm run build` and embeds dist/), e2e writes a stamp next
// to the binary with the binary's size and mtime. SEXTANT_E2E_SKIP_BUILD reuses the binary only while the stamp still
// matches; otherwise it rebuilds and says why.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { ROOT, toolPath } from "./cluster";

export const APP = path.join(ROOT, "target", "debug", process.platform === "win32" ? "sextant.exe" : "sextant");
export const STAMP = `${APP}.e2e-stamp`;

interface Stamp {
  size: number;
  mtimeMs: number;
}

function stampOf(app: string): Stamp {
  const { size, mtimeMs } = statSync(app);
  return { size, mtimeMs };
}

/** Why the binary cannot be reused, or `null` when the stamp matches it. */
export function staleReason(app = APP, stamp = STAMP): string | null {
  if (!existsSync(app)) return `${path.relative(ROOT, app)} does not exist`;
  if (!existsSync(stamp)) return `${path.relative(ROOT, app)} was not built by e2e (no ${path.basename(stamp)})`;
  let saved: Partial<Stamp>;
  try {
    saved = JSON.parse(readFileSync(stamp, "utf8")) as Partial<Stamp>;
  } catch {
    return `${path.basename(stamp)} is unreadable`;
  }
  const now = stampOf(app);
  if (saved.size !== now.size || saved.mtimeMs !== now.mtimeMs) {
    return `${path.relative(ROOT, app)} changed since e2e built it (e.g. by npm run check, which builds it without the frontend)`;
  }
  return null;
}

/** Builds the debug binary with the embedded frontend and stamps it. */
export function buildApp(app = APP, stamp = STAMP): void {
  rmSync(stamp, { force: true });
  const build = spawnSync("npm", ["run", "tauri", "--", "build", "--debug", "--no-bundle"], {
    cwd: ROOT,
    stdio: "inherit",
    // The bundle users get: WebdriverIO sets NODE_ENV=test, and Vite builds React's development bundle for any
    // NODE_ENV but production (dev checks, a stack trace per element), which changes both speed and memory.
    env: { ...process.env, PATH: toolPath(), NODE_ENV: "production" },
    shell: process.platform === "win32",
  });
  if (build.status !== 0) throw new Error("building the app failed");
  writeFileSync(stamp, `${JSON.stringify(stampOf(app))}\n`);
}

/** Builds unless SEXTANT_E2E_SKIP_BUILD is set and the binary is the one e2e built last. */
export function ensureApp(): void {
  if (!process.env.SEXTANT_E2E_SKIP_BUILD) {
    buildApp();
    return;
  }
  const reason = staleReason();
  if (reason === null) return;
  console.warn(`[e2e] SEXTANT_E2E_SKIP_BUILD is set, but ${reason}: rebuilding it with the frontend`);
  buildApp();
}
