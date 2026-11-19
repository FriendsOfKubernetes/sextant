// The extension's backend (ADR-0131): only the judge the Trigger table's Filter column asks (ADR-0172). Sextant sends
// each Trigger's `spec.filters` and `spec.filter` and shows the text it answers; while it runs, the backend can reach
// neither the cluster nor the network. The text is the built-in column's, unchanged (`src/judges.ts`).
import { defineBackend } from "@sextant/extension-sdk/backend";
import { filterFacts, FILTERS_JUDGE } from "../src/judges";

export const handle = defineBackend({}, { problemJudges: { [FILTERS_JUDGE]: (objects) => filterFacts(objects) } });
