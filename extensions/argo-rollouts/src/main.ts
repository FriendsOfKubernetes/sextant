import { connect } from "@sextant/extension-sdk";
import { startAction } from "./actions";
import { startDetails } from "./details";
import { setLanguage, t } from "./i18n";
import { startWorkload } from "./workload";

// One page serves every view; the context's view and contribution (the manifest id) say which one this frame is.
// A change of Sextant's language starts the view again in the new one.
const sextant = await connect();
const root = document.getElementById("app")!;
const { view, contribution } = sextant.context;
if (view === "details") document.body.classList.add("compact");

function start(): () => void {
  setLanguage(sextant.context.language);
  document.documentElement.lang = sextant.context.language;
  if (view === "details" && contribution === "managed-by-rollout") return startWorkload(sextant, root);
  if (view === "details") return startDetails(sextant, root, contribution);
  if (view === "action") return startAction(sextant, root, contribution);
  root.textContent = t("common.nothingToShow", { view });
  return () => undefined;
}

let stop = start();
let language = sextant.context.language;
sextant.onContextChange((context) => {
  if (context.language === language) return;
  language = context.language;
  stop();
  stop = start();
});
