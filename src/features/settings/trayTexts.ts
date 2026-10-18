// The tray menu is native and cannot use i18next: whenever the UI language changes, the window sends the menu's
// texts (namespace `tray`) to the backend, which relabels the menu at once. Until then the menu is English.
import { api } from "../../api";
import type { TrayTexts } from "../../api/generated/TrayTexts";
import { i18n } from "../../i18n";

/** The tray menu's texts in the language i18next renders now (English for a key the language lacks). */
export function trayTexts(): TrayTexts {
  return {
    show: i18n.t("tray:show"),
    hide: i18n.t("tray:hide"),
    about: i18n.t("tray:about"),
    quit: i18n.t("tray:quit"),
    tooltip: i18n.t("tray:tooltip"),
  };
}

function sendTrayTexts(): void {
  // No tray, an old backend: the menu keeps its texts, nothing to tell the user.
  api.settings.traySetTexts(trayTexts()).catch(() => undefined);
}

let following = false;

/** Sends the tray texts on every language change (once per page). */
export function followLanguageInTray(): void {
  if (following) return;
  following = true;
  i18n.on("languageChanged", sendTrayTexts);
}
