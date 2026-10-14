// Extensions in Settings: the section (`ExtensionsPanel`, mounted by features/settings), the window of consent for
// installing and for reviewing permissions, the activity log, and the notice that an extension is paused.
import { registerSlot } from "../../layout/slots";
import { ConsentNotice } from "./ConsentNotice";

/** After the Settings (0) and agent activity (10) buttons; the notice itself is drawn over the window. */
const RAIL_FOOTER_ORDER = 20;

registerSlot("railFooter", ConsentNotice, RAIL_FOOTER_ORDER);

export { ConsentDialog, type ConsentDialogProps } from "./ConsentDialog";
export { ConsentNotice } from "./ConsentNotice";
export { ExtensionActivityDialog } from "./ExtensionActivityDialog";
export { ExtensionsPanel } from "./ExtensionsPanel";
export { isReleaseUrl } from "./install";
export { PermissionsView } from "./PermissionsView";
