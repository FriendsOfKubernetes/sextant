// A banner across the window when `settings.json` could not be used at start (`settings_status`): a damaged file
// was copied aside (its path is shown), or a file that cannot be read or is read-only is not written this session.
// Rendered into <body> from the rail footer, so it shows whatever the main area holds.
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { api, type SettingsStatus } from "../../api";

export function SettingsFileBanner() {
  const { t } = useTranslation();
  const titleId = useId();
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let alive = true;
    api.settings.status().then(
      (next) => {
        if (alive) setStatus(next);
      },
      () => undefined, // No status, no banner: the settings themselves still load.
    );
    return () => {
      alive = false;
    };
  }, []);

  if (!status || dismissed || (status.writable && !status.error)) return null;
  return createPortal(
    <div className="settings-banner" role="alert" aria-labelledby={titleId}>
      <div className="settings-banner__text">
        <strong id={titleId}>{t("settings:file.label")}</strong>
        {status.backupPath && <p>{t("settings:file.backup", { path: status.backupPath })}</p>}
        {!status.writable && <p>{t("settings:file.unwritable")}</p>}
        {status.error && (
          <p className="settings-banner__details">{t("common:error.details", { message: status.error.message })}</p>
        )}
      </div>
      <button
        type="button"
        className="icon-btn"
        aria-label={t("settings:file.dismiss")}
        title={t("settings:file.dismiss")}
        onClick={() => setDismissed(true)}
      >
        ×
      </button>
    </div>,
    document.body,
  );
}
