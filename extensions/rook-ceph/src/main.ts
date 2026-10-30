import { connect } from "@sextant/extension-sdk";
import { startDaemons } from "./daemons";
import { setLanguage, t } from "./i18n";
import { startMetrics } from "./metrics";
import { startPage } from "./page";
import { startStatus } from "./status";
import { startStorage } from "./storageView";

// One page serves every view; the context's view and contribution (the manifest id) say which one this frame is.
// A change of Sextant's language starts the view again in the new one.
const sextant = await connect();
const root = document.getElementById("app")!;
const { view, contribution } = sextant.context;
if (view === "details") document.body.classList.add("compact");

function start(): () => void {
  setLanguage(sextant.context.language);
  document.documentElement.lang = sextant.context.language;
  if (view === "page") return startPage(sextant, root);
  if (view === "details" && contribution === "status") return startStatus(sextant, root);
  if (view === "details" && contribution === "daemons") return startDaemons(sextant, root);
  if (view === "details" && contribution === "metrics") return startMetrics(sextant, root);
  if (view === "details" && contribution === "storage") return startStorage(sextant, root);
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
