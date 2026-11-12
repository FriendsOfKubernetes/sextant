// The extension's backend (ADR-0131, #341): the tool it gives AI agents and its problem judges.
// - `agentTool:diagnose-rollout` reads one Rollout and what it depends on through `host`, where Sextant decides each read
//   for the extension and the agent both (ADR-0159); it changes nothing.
// - `problemJudge:traffic` and `problemJudge:safety` decide from the fields Sextant sends only (ADR-0168): every `host`
//   call fails while a judge runs.
import { defineBackend, host, isRead } from "@sextant/extension-sdk/backend";
import { answer, hostReader, readArgs, TOOL_ID } from "../src/agentTools";
import { judge, JUDGE_IDS } from "../src/judges";

export const handle = defineBackend(
  {
    [`agentTool:${TOOL_ID}`]: (params) => {
      const args = readArgs(params);
      return answer(hostReader(args.cluster, host.resources), args);
    },
  },
  {
    problemJudges: Object.fromEntries(
      JUDGE_IDS.map((id) => [id, (objects, input) => judge(id, objects, (kind, namespace) => isRead(input, kind, namespace))]),
    ),
  },
);
