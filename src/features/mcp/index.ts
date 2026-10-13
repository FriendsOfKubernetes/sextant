// AI agents (MCP): the Settings section (`McpPanel`, mounted by features/settings), the confirmation dialog for what
// an agent asks to do, and the agent activity log with its button in the cluster rail. The rail footer is a single
// slot, so this feature takes it over and draws the Settings button inside its own footer.
import { registerSlot } from "../../layout/slots";
import { McpRailFooter } from "./RailFooter";

registerSlot("railFooter", McpRailFooter);

export { ActivityDialog } from "./ActivityDialog";
export { ConfirmHost, CONFIRM_TIMEOUT_MS } from "./ConfirmHost";
export { McpPanel, type McpPanelProps } from "./McpPanel";
export { ACTIVITY_DOT_MS, McpRailFooter } from "./RailFooter";
export { resetMcpUi, useMcpUi } from "./store";
