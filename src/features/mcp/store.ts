// UI state shared by the places that open the agent activity log: the button in the cluster rail and the MCP section
// of Settings. The dialog itself is mounted once, by the rail footer (RailFooter.tsx).
import { create } from "zustand";

interface McpUiState {
  activityOpen: boolean;
  openActivity: () => void;
  closeActivity: () => void;
}

export const useMcpUi = create<McpUiState>((set) => ({
  activityOpen: false,
  openActivity: () => set({ activityOpen: true }),
  closeActivity: () => set({ activityOpen: false }),
}));

export function resetMcpUi(): void {
  useMcpUi.setState({ activityOpen: false });
}
