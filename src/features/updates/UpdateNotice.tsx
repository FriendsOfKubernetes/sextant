// The check at start and the dialog that offers what it found. Mounted once by the Settings button (the rail is
// always there). It checks when the "Check for updates when Sextant starts" setting is on, the build has an update
// signing key and the app was installed from a release package (not `tauri dev` or a bare binary; a Vite dev build
// never checks at start).
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { api, useSettings } from "../../api";
import { Button, Dialog } from "../../components";
import { checkAtStart, closeUpdateDialog, useAppInfo, useUpdates } from "./store";
import { UpdateDetails } from "./UpdateDetails";
import "./updates.css";

export function UpdateNotice() {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const info = useAppInfo();
  const state = useUpdates();
  const enabled = settings?.checkForUpdates ?? false;
  const installed = info !== null && !info.devBuild && info.bundleKind !== null;

  useEffect(() => {
    if (enabled && installed && api.updates.configured()) checkAtStart();
  }, [enabled, installed]);

  const busy = state.phase === "installing" || state.phase === "restarting";
  return (
    <Dialog
      open={state.dialogOpen && state.update !== null}
      title={t("updates:dialogTitle")}
      onClose={() => !busy && closeUpdateDialog()}
      footer={
        <Button disabled={busy} onClick={closeUpdateDialog}>
          {t("updates:later")}
        </Button>
      }
    >
      {state.update && <UpdateDetails update={state.update} info={info} state={state} />}
    </Dialog>
  );
}
