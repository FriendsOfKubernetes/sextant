// Settings (task 11): theme, language, the `helm` binary and kubeconfig sources, and the other sections, in tabs
// (`openSettings({ tab })` opens one). A page of the sidebar and a button at the bottom of the cluster rail (without an
// open cluster it opens the same page in a dialog).
import { registerPage } from "../../layout/pages";
import { registerSlot } from "../../layout/slots";
import { SETTINGS_PAGE_ID, SETTINGS_SECTION } from "./constants";
import { SettingsButton } from "./SettingsButton";
import { SettingsPage } from "./SettingsPage";
import { followLanguageInTray } from "./trayTexts";

registerPage({
  id: SETTINGS_PAGE_ID,
  section: SETTINGS_SECTION,
  order: 0,
  labelKey: "settings:page.title",
  icon: "settings",
  Component: SettingsPage,
});
registerSlot("railFooter", SettingsButton);
followLanguageInTray();

export { SETTINGS_PAGE_ID, SETTINGS_SECTION } from "./constants";
export { languageName } from "./languages";
export { SettingsButton } from "./SettingsButton";
export { SettingsContent, SettingsPage } from "./SettingsPage";
export { SETTINGS_TABS, openSettings, resetSettingsUi, selectSettingsTab, type SettingsTab } from "./store";
