// The gear at the bottom of the cluster rail. With an open cluster it opens the Settings page in the main area;
// without one (nothing to show the page in) the same settings open in a dialog (`openSettings`, store.ts, which also
// serves links to a tab from elsewhere). Also mounts the settings file banner and the check for updates at start with
// its dialog (the rail is always there, also in a narrow window).
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, Icon } from "../../components";
import { UpdateNotice } from "../updates";
import { SettingsFileBanner } from "./SettingsFileBanner";
import { SettingsContent } from "./SettingsPage";
import { openSettings, useSettingsUi } from "./store";

export function SettingsButton() {
  const { t } = useTranslation();
  const dialogOpen = useSettingsUi((s) => s.dialogOpen);
  const closeDialog = useSettingsUi((s) => s.closeDialog);
  // The dialog belongs to the rail: gone with it (as when it was local state of this button).
  useEffect(() => closeDialog, [closeDialog]);

  return (
    <>
      <button
        type="button"
        className="icon-btn"
        aria-label={t("settings:page.open")}
        title={t("settings:page.open")}
        onClick={() => openSettings()}
      >
        <Icon name="settings" />
      </button>
      <SettingsFileBanner />
      <UpdateNotice />
      <Dialog open={dialogOpen} title={t("settings:page.title")} onClose={closeDialog}>
        <SettingsContent />
      </Dialog>
    </>
  );
}
