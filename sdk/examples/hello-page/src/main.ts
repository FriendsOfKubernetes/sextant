import { connect } from "@sextant/extension-sdk";
import { startPodsPage } from "./pods";

const sextant = await connect();
startPodsPage(sextant, document.getElementById("app")!);
