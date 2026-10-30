// The memory measurement (e2e/memory/memory.bench.ts, started by scripts/memory.sh inside a nested X server): the e2e
// setup — app build, sandboxed profile, test cluster fixtures — with the measurement instead of the tests, and a
// profile without the update check (no network call to measure).
import { writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { config as e2e } from "./wdio.conf";

type Prepare = (config: WebdriverIO.Config, capabilities: WebdriverIO.Capabilities[]) => void;

export const config: WebdriverIO.Config = {
  ...e2e,
  specs: ["./memory/memory.bench.ts"],
  bail: 1,
  // Each step settles for minutes; the details step opens a hundred pods.
  mochaOpts: { ui: "bdd", timeout: 60 * 60_000 },

  onPrepare(cfg: WebdriverIO.Config, capabilities: WebdriverIO.Capabilities[]) {
    (e2e.onPrepare as Prepare)(cfg, capabilities);
    const home = process.env.SEXTANT_E2E_HOME;
    if (!home) throw new Error("SEXTANT_E2E_HOME is not set");
    // Tauri's app_config_dir on Linux: $XDG_CONFIG_HOME/<identifier> (created by the e2e setup).
    const settings = { language: "en", settingsVersion: 1, checkForUpdates: false };
    writeFileSync(path.join(home, "config", "dev.sextant.app", "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
  },
};
