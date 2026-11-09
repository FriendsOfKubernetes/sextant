// The extension's backend (ADR-0131): only the tools it gives AI agents (ADR-0159, #402). Each sends one merge patch
// through `host`, which Sextant decides as the extension's call and the agent's both, asking the user when either asks.
import { defineBackend, host } from "@sextant/extension-sdk/backend";
import { doneText, FLUX_TOOL_IDS, readArgs, toolPatch } from "../src/agentTools";

export const handle = defineBackend(
  Object.fromEntries(
    FLUX_TOOL_IDS.map((tool) => [
      `agentTool:${tool}`,
      (params) => {
        const args = readArgs(params);
        host.resources.patch(toolPatch(tool, args, new Date()));
        return doneText(tool, args);
      },
    ]),
  ),
);
