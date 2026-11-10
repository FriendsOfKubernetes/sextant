import { connect } from "@sextant/extension-sdk";
import { startDetails } from "./details";
import { setLanguage, t } from "./i18n";
import { startPage } from "./page";

// One page serves every view: the details sections of the helm-controller and k3s kinds and of Nodes (the context's
// contribution, the manifest id, names it) and the "Distribution" page. A change of Sextant's language, or of the
// page's cluster, starts the view again.
const sextant = await connect();
const root = document.getElementById("app")!;
const { view, contribution } = sextant.context;
if (view === "details") document.body.classList.add("compact");

function start(): () => void {
  setLanguage(sextant.context.language);
  document.documentElement.lang = sextant.context.language;
  if (view === "details") return startDetails(sextant, root, contribution);
  if (view === "page") return startPage(sextant, root);
  root.textContent = t("common.nothingToShow", { view });
  return () => undefined;
}

let stop = start();
let language = sextant.context.language;
let cluster = sextant.context.clusterId;
sextant.onContextChange((context) => {
  if (context.language === language && (view !== "page" || context.clusterId === cluster)) return;
  language = context.language;
  cluster = context.clusterId;
  stop();
  stop = start();
});
