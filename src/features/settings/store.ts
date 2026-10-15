// Which tab of Settings is open, and whether Settings is shown as a dialog (no cluster open). Kept in memory for the
// window's session: reopening Settings shows the tab left last; a fresh start opens General. Not written to
// settings.json on purpose (a UI position, not a preference).
//
//   openSettings({ tab: "agents" })  // the MCP server section: the page of the active cluster, or the dialog
import { create } from "zustand";
import { useAppStore } from "../../app/store";
import { SETTINGS_PAGE_ID } from "./constants";

/** The tabs in their order: General, Clusters, AI agents, Extensions, Updates & About. */
export const SETTINGS_TABS = ["general", "clusters", "agents", "extensions", "about"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

interface SettingsUiState {
  tab: SettingsTab;
  /** Settings shown in a dialog: there is no open cluster to show the page in. */
  dialogOpen: boolean;
  selectTab: (tab: SettingsTab) => void;
  closeDialog: () => void;
}

export const useSettingsUi = create<SettingsUiState>((set) => ({
  tab: "general",
  dialogOpen: false,
  selectTab: (tab) => set({ tab }),
  closeDialog: () => set({ dialogOpen: false }),
}));

/** Opens Settings, at `tab` if given (else at the tab left last): the page of the active cluster, or the dialog. */
export function openSettings(options: { tab?: SettingsTab } = {}): void {
  if (options.tab) selectSettingsTab(options.tab);
  const { activeClusterId, setView, closeDetails } = useAppStore.getState();
  if (activeClusterId) {
    closeDetails();
    setView(activeClusterId, SETTINGS_PAGE_ID);
  } else {
    useSettingsUi.setState({ dialogOpen: true });
  }
}

/** Makes `tab` the tab Settings shows (now, if open, or when it opens next) without opening anything. */
export function selectSettingsTab(tab: SettingsTab): void {
  useSettingsUi.getState().selectTab(tab);
}

/** Back to a fresh start (tests). */
export function resetSettingsUi(): void {
  useSettingsUi.setState({ tab: "general", dialogOpen: false });
}
