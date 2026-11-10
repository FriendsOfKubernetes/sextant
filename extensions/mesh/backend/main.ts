// The extension's backend (ADR-0131): only its problem judges (ADR-0168). Sextant sends the Istio objects each judge
// reads (the declared fields only, a `partial` read with where it was read) and turns the facts it answers into the
// manifest's rules' problems; while a judge runs, the backend can reach neither the cluster nor the network. The
// checks are the built-in view's, unchanged (`src/judges.ts` over `src/engine/problems.ts`).
import { defineBackend, isRead } from "@sextant/extension-sdk/backend";
import { judge, JUDGE_IDS } from "../src/judges";

export const handle = defineBackend(
  {},
  {
    problemJudges: Object.fromEntries(
      JUDGE_IDS.map((id) => [id, (objects, input) => judge(id, objects, (kind, namespace) => isRead(input, kind, namespace))]),
    ),
  },
);
