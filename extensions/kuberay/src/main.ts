import { connect } from "@sextant/extension-sdk";
import { startDetails } from "./details";
import { setLanguage, t } from "./i18n";

// One page serves every view: the details sections of the three KubeRay kinds (the context's contribution, the manifest
// id, says which one). A change of Sextant's language starts the view again in the new one.
const sextant = await connect();
const root = document.getElementById("app")!;
const { view, contribution } = sextant.context;
if (view === "details") document.body.classList.add("compact");

function start(): () => void {
  setLanguage(sextant.context.language);
  document.documentElement.lang = sextant.context.language;
  if (view === "details") return startDetails(sextant, root, contribution);
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
