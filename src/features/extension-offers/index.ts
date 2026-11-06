// Sextant's own extensions offered where the active cluster runs their tool (ADR-0162): above the sidebar's sections,
// before the saved views.
import { registerSlot } from "../../layout/slots";
import { ExtensionOffers } from "./ExtensionOffers";

registerSlot("sidebarTop", ExtensionOffers, -1);
