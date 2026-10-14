import { connect } from "@sextant/extension-sdk";
import { startHello } from "./hello";

// Connect to Sextant (it applies Sextant's theme), then draw the page.
const sextant = await connect();
startHello(sextant, document.getElementById("app")!);
