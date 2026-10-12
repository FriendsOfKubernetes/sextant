// The gear at the bottom of the cluster rail. With an open cluster it opens the Settings page in the main area;
// without one (nothing to show the page in) the same settings open in a dialog. Also mounts the settings file banner
// and the check for updates at start with its dialog (the rail is always there, also in a narrow window).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../app/store";
import { Dialog } from "../../components";
import { UpdateNotice } from "../updates";
import { SETTINGS_PAGE_ID } from "./constants";
import { SettingsFileBanner } from "./SettingsFileBanner";
import { SettingsContent } from "./SettingsPage";

export function SettingsButton() {
  const { t } = useTranslation();
  const [dialogOpen, setDialogOpen] = useState(false);
  const activeClusterId = useAppStore((s) => s.activeClusterId);

  const open = () => {
    if (activeClusterId) {
      const { setView, closeDetails } = useAppStore.getState();
      closeDetails();
      setView(activeClusterId, SETTINGS_PAGE_ID);
    } else {
      setDialogOpen(true);
    }
  };

  return (
    <>
      <button
        type="button"
        className="icon-btn settings-button"
        aria-label={t("settings:page.open")}
        title={t("settings:page.open")}
        onClick={open}
      >
        ⚙
      </button>
      <SettingsFileBanner />
      <UpdateNotice />
      <Dialog open={dialogOpen} title={t("settings:page.title")} onClose={() => setDialogOpen(false)}>
        <SettingsContent />
      </Dialog>
    </>
  );
}
