// AI agents (MCP): the Settings section (`McpPanel`, mounted by features/settings), the confirmation dialog for what
// an agent or an extension asks to do (`ConfirmHost`, mounted once by `AppShell`), and the agent activity log with its
// button in the cluster rail, after the Settings button.
import { registerSlot } from "../../layout/slots";
import { McpRailFooter } from "./RailFooter";

/** Position of the activity button in the rail footer (the Settings button is at 0). */
const RAIL_FOOTER_ORDER = 10;

registerSlot("railFooter", McpRailFooter, RAIL_FOOTER_ORDER);

export { ActivityDialog } from "./ActivityDialog";
export { ConfirmHost, CONFIRM_TIMEOUT_MS } from "./ConfirmHost";
export { McpPanel, type McpPanelProps } from "./McpPanel";
export { ACTIVITY_DOT_MS, McpRailFooter } from "./RailFooter";
export { resetMcpUi, useMcpUi } from "./store";
