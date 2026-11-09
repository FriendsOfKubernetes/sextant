// The extension's backend (ADR-0131): only the tools it gives AI agents (ADR-0159, #402). A sync reads the Application
// first (its sync options and retry policy go into the operation); each tool sends one merge patch through `host`,
// which Sextant decides as the extension's call and the agent's both, asking the user when either asks.
import { defineBackend, host } from "@sextant/extension-sdk/backend";
import { appRef, ARGO_TOOL_IDS, doneText, readArgs, toolPatch } from "../src/agentTools";

export const handle = defineBackend(
  Object.fromEntries(
    ARGO_TOOL_IDS.map((tool) => [
      `agentTool:${tool}`,
      (params) => {
        const args = readArgs(tool, params);
        const app = tool === "sync" ? host.resources.get({ clusterId: args.cluster, ref: appRef(args) }) : null;
        host.resources.patch(toolPatch(tool, args, app));
        return doneText(tool, args);
      },
    ]),
  ),
);
