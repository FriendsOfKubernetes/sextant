import { connect } from "@sextant/extension-sdk";
import { startAction } from "./actions";
import { startFields } from "./fields";
import { setLanguage, t } from "./i18n";
import { startInventory, startResources, startUsedBy } from "./related";

// One page serves every view; the context's view and contribution (the manifest id) say which one this frame is.
// A change of Sextant's language starts a details view again in the new one; an action runs once.
const sextant = await connect();
const root = document.getElementById("app")!;
const { view, contribution } = sextant.context;
// Every details view is a section: it sits inside the Overview's own padding.
if (view === "details") document.body.classList.add("compact");

const DETAILS: Record<string, (s: typeof sextant, r: HTMLElement) => () => void> = {
  fields: startFields,
  inventory: startInventory,
  resources: startResources,
  "used-by": startUsedBy,
};

function start(): () => void {
  setLanguage(sextant.context.language);
  document.documentElement.lang = sextant.context.language;
  const details = DETAILS[contribution];
  if (view === "details" && details) return details(sextant, root);
  if (view === "action") return startAction(sextant, root, contribution);
  root.textContent = t("common.nothingToShow", { view });
  return () => undefined;
}

let stop = start();
let language = sextant.context.language;
sextant.onContextChange((context) => {
  if (context.language === language || view === "action") return;
  language = context.language;
  stop();
  stop = start();
});
