// "What's new" after an update (ADR-0166): mounted in the rail's footer slot so it lives as long as the window.
import { registerSlot } from "../../layout/slots";
import { WhatsNewHost } from "./WhatsNewHost";

registerSlot("railFooter", WhatsNewHost);
