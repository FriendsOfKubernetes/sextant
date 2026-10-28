import { connect } from "@sextant/extension-sdk";
import { startReleasesPage } from "./releases";

const sextant = await connect();
startReleasesPage(sextant, document.getElementById("app")!);
