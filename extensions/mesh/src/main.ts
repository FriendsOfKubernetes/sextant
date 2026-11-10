import { connect } from "@sextant/extension-sdk";
import { startDetails } from "./details";
import { setLanguage, t } from "./i18n";
import { startMembership } from "./membership";
import { startRequestCheck } from "./requestCheck";

// One page serves every view: the details section `mesh` of every Istio and Linkerd kind, the section `membership` of
// Pods and workloads (the context's contribution, the manifest id, names it) and the "Request routing" page. A change
// of Sextant's language, or of the page's cluster, starts the view again.
const sextant = await connect();
const root = document.getElementById("app")!;
const { view, contribution } = sextant.context;
if (view === "details") document.body.classList.add("compact");

function start(): () => void {
  setLanguage(sextant.context.language);
  document.documentElement.lang = sextant.context.language;
  if (view === "details" && contribution === "membership") return startMembership(sextant, root);
  if (view === "details") return startDetails(sextant, root);
  if (view === "page") return startRequestCheck(sextant, root);
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
