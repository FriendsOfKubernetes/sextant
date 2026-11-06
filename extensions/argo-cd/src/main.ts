import { connect } from "@sextant/extension-sdk";
import { startAction } from "./actions";
import { startFields } from "./details";
import { startHistory } from "./history";
import { setLanguage, t } from "./i18n";
import { startTree } from "./tree";

// One page serves every view; the context's view and contribution (the manifest id) say which one this frame is.
// A change of Sextant's language starts the view again in the new one.
const sextant = await connect();
const root = document.getElementById("app")!;
const { view, contribution } = sextant.context;
if (view === "details") document.body.classList.add("compact");

function start(): () => void {
  setLanguage(sextant.context.language);
  document.documentElement.lang = sextant.context.language;
  if (view === "details" && contribution === "fields") return startFields(sextant, root);
  if (view === "details" && contribution === "resources") return startTree(sextant, root);
  if (view === "details" && contribution === "history") return startHistory(sextant, root);
  if (view === "action") return startAction(sextant, root, contribution);
  root.textContent = t("common.nothingToShow");
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
