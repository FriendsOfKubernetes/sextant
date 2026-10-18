// WebdriverIO + tauri-driver against the debug build of Sextant and the kind cluster `sextant-test`.
//
//   scripts/test-cluster.sh up --prometheus   # once
//   npm run e2e
//
// Needs `tauri-driver` (`cargo install tauri-driver --locked`) and, on Linux, WebKitWebDriver (package
// `webkit2gtk-driver`). The app runs with its own temporary config/data/cache directories (XDG_*), so the
// developer's settings are not touched, and with KUBECONFIG pointing at the test cluster only.
// SEXTANT_E2E_SKIP_BUILD=1 reuses target/debug/sextant if e2e built it last (see build.ts), otherwise rebuilds it.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { browser } from "@wdio/globals";
import { APP, ensureApp } from "./build";
import { ROOT, setUpCluster, tearDownCluster, testKubeconfig, toolPath } from "./cluster";

const DRIVER_PORT = 4444;
let driver: ChildProcess | null = null;

function sandbox(): string {
  const dir = process.env.SEXTANT_E2E_HOME;
  if (!dir) throw new Error("SEXTANT_E2E_HOME is not set (onPrepare did not run)");
  return dir;
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`tauri-driver did not listen on ${port}`));
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

export const config: WebdriverIO.Config = {
  runner: "local",
  // The main scenarios first (they take the README screenshot on a fresh profile), then the rest.
  specs: ["./specs/sextant.e2e.ts", "./specs/**/*.e2e.ts"],
  maxInstances: 1,
  hostname: "127.0.0.1",
  port: DRIVER_PORT,
  capabilities: [
    {
      // tauri-driver starts the app itself; the browser name is ignored.
      "tauri:options": { application: APP },
    } as WebdriverIO.Capabilities,
  ],
  logLevel: "warn",
  bail: 0,
  waitforTimeout: 20_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 180_000 },

  onPrepare() {
    const home = mkdtempSync(path.join(tmpdir(), "sextant-e2e-"));
    for (const dir of ["config", "data", "cache", "helm"]) mkdirSync(path.join(home, dir));
    // Selectors are English texts: the interface is pinned to English whatever the machine's language (a new profile
    // would follow the system). `settingsVersion` 1 marks "en" as a choice, not the old default (settings.rs `migrate`).
    const config = path.join(home, "config", "dev.sextant.app");
    mkdirSync(config, { recursive: true });
    writeFileSync(path.join(config, "settings.json"), `${JSON.stringify({ language: "en", settingsVersion: 1 }, null, 2)}\n`);
    process.env.SEXTANT_E2E_HOME = home;
    process.env.SEXTANT_TEST_KUBECONFIG = testKubeconfig();

    ensureApp();
    setUpCluster(path.join(home, "helm"));
  },

  async beforeSession() {
    const home = sandbox();
    driver = spawn("tauri-driver", ["--port", String(DRIVER_PORT)], {
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        PATH: toolPath(),
        // What the app sees: only the test cluster, and settings in a throwaway directory.
        KUBECONFIG: process.env.SEXTANT_TEST_KUBECONFIG,
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_CACHE_HOME: path.join(home, "cache"),
        HELM_CONFIG_HOME: path.join(home, "helm", "config"),
        HELM_CACHE_HOME: path.join(home, "helm", "cache"),
        HELM_DATA_HOME: path.join(home, "helm", "data"),
      },
    });
    await waitForPort(DRIVER_PORT, 20_000);
  },

  /** A failed scenario leaves a screenshot in target/e2e/. */
  async afterTest(test, _context, { passed }) {
    if (passed) return;
    const dir = path.join(ROOT, "target", "e2e");
    mkdirSync(dir, { recursive: true });
    const name = test.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    await browser.saveScreenshot(path.join(dir, `${name}.png`));
  },

  afterSession() {
    driver?.kill();
    driver = null;
  },

  onComplete() {
    const home = process.env.SEXTANT_E2E_HOME;
    if (!home) return;
    try {
      tearDownCluster(path.join(home, "helm"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
};
