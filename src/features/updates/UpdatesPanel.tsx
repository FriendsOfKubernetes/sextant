// The "Updates" section of Settings: the app version, the check at start on/off, "Check for updates" and the
// update found. Without an update signing key in the build everything is off and the section says why.
import { useTranslation } from "react-i18next";
import { api, useSettings, type AppSettings } from "../../api";
import { Checkbox } from "../../components";
import { checkForUpdates, useAppInfo, useUpdates } from "./store";
import { ReleasePageButton, UpdateDetails, UpdateError } from "./UpdateDetails";
import "./updates.css";

export interface UpdatesPanelProps {
  /** Saves a settings change; resolves to `false` when it failed (Settings shows the error). */
  save: (change: (current: AppSettings) => AppSettings) => Promise<boolean>;
}

export function UpdatesPanel({ save }: UpdatesPanelProps) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const info = useAppInfo();
  const state = useUpdates();
  const configured = api.updates.configured();
  const busy = state.phase === "checking" || state.phase === "installing" || state.phase === "restarting";

  return (
    <div className="updates">
      <p className="updates__version">
        {info ? t("updates:version", { version: info.version }) : t("updates:versionUnknown")}
      </p>
      {!configured && (
        <>
          <p className="updates__hint">{t("updates:notConfigured")}</p>
          <ReleasePageButton />
        </>
      )}
      <label className="updates__choice">
        <Checkbox
          checked={settings?.checkForUpdates ?? true}
          disabled={!settings || !configured}
          onChange={(e) => {
            const checkForUpdates = e.target.checked;
            void save((s) => ({ ...s, checkForUpdates }));
          }}
        />
        {t("updates:auto")}
      </label>
      <div className="updates__row">
        <button type="button" className="btn" disabled={!configured || busy} onClick={() => void checkForUpdates()}>
          {t("updates:check")}
        </button>
        {state.phase === "checking" && (
          <span className="updates__status" role="status">
            {t("updates:checking")}
          </span>
        )}
        {state.phase === "upToDate" && (
          <span className="updates__status" role="status">
            {t("updates:upToDate")}
          </span>
        )}
      </div>
      {state.failure?.during === "check" && <UpdateError failure={state.failure} />}
      {state.update && <UpdateDetails update={state.update} info={info} state={state} />}
    </div>
  );
}
