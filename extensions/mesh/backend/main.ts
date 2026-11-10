// The extension's backend (ADR-0131): only its problem judges (ADR-0168). Sextant sends the Istio objects each judge
// reads (the declared fields only) and turns the facts it answers into the manifest's rules' problems; while a judge
// runs, the backend can reach neither the cluster nor the network. The checks are the built-in view's, unchanged
// (`src/judges.ts` over `src/engine/problems.ts`).
import { defineBackend } from "@sextant/extension-sdk/backend";
import { judge, JUDGE_IDS } from "../src/judges";

export const handle = defineBackend(
  {},
  { problemJudges: Object.fromEntries(JUDGE_IDS.map((id) => [id, (objects) => judge(id, objects)])) },
);
