// The demo recordings (e2e/demo/<name>.demo.ts, SEXTANT_DEMO picks one: readme or mcp): the e2e setup — app build,
// sandboxed profile, test cluster fixtures — with a demo scenario instead of the tests, and a profile written in
// advance (dark theme, no update check, the MCP server on for the mcp demo). Started by scripts/demo-gif.sh inside a
// nested X server.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { MCP_PORT } from "./demo/helpers";
import { config as e2e } from "./wdio.conf";

const demo = process.env.SEXTANT_DEMO ?? "readme";
if (!["readme", "mcp"].includes(demo)) throw new Error(`SEXTANT_DEMO must be readme or mcp, not ${demo}`);

type Prepare = (config: WebdriverIO.Config, capabilities: WebdriverIO.Capabilities[]) => void;

export const config: WebdriverIO.Config = {
  ...e2e,
  specs: [`./demo/${demo}.demo.ts`],
  bail: 1,
  afterTest: undefined,

  onPrepare(cfg: WebdriverIO.Config, capabilities: WebdriverIO.Capabilities[]) {
    (e2e.onPrepare as Prepare)(cfg, capabilities);
    const home = process.env.SEXTANT_E2E_HOME;
    if (!home) throw new Error("SEXTANT_E2E_HOME is not set");
    // Tauri's app_config_dir on Linux: $XDG_CONFIG_HOME/<identifier>.
    const dir = path.join(home, "config", "dev.sextant.app");
    mkdirSync(dir, { recursive: true });
    const settings = { theme: "dark", checkForUpdates: false, mcp: { enabled: demo === "mcp", port: MCP_PORT } };
    writeFileSync(path.join(dir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
  },
};
