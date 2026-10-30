import { connect } from "@sextant/extension-sdk";
import { startDaemons } from "./daemons";
import { startMetrics } from "./metrics";
import { startPage } from "./page";
import { startStatus } from "./status";
import { startStorage } from "./storageView";

// One page serves every view; the context's view and contribution (the manifest id) say which one this frame is.
const sextant = await connect();
const root = document.getElementById("app")!;
const { view, contribution } = sextant.context;
if (view === "details") document.body.classList.add("compact");
if (view === "page") startPage(sextant, root);
else if (view === "details" && contribution === "status") startStatus(sextant, root);
else if (view === "details" && contribution === "daemons") startDaemons(sextant, root);
else if (view === "details" && contribution === "metrics") startMetrics(sextant, root);
else if (view === "details" && contribution === "storage") startStorage(sextant, root);
else root.textContent = `Nothing to show in the ${view} view.`;
