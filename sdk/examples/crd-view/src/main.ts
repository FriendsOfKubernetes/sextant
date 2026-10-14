import { connect } from "@sextant/extension-sdk";
import { startScale } from "./scale";
import { startSettings } from "./settings";
import { startSummary } from "./summary";

// One page serves every view of the extension; the context says which one this frame is.
const sextant = await connect();
const root = document.getElementById("app")!;
switch (sextant.context.view) {
  case "details":
    document.body.classList.add("compact");
    startSummary(sextant, root);
    break;
  case "action":
    startScale(sextant, root);
    break;
  case "settings":
    startSettings(sextant, root);
    break;
  default:
    root.textContent = `Nothing to show in the ${sextant.context.view} view.`;
}
