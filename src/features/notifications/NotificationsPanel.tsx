// Settings → General → Notifications: the global switch, "Mute for 1 hour", which kinds of problems notify and which
// clusters never do. Everything is saved at once (`AppSettings.notifications`).
import { useTranslation } from "react-i18next";
import type { AppSettings } from "../../api";
import { Button, Checkbox } from "../../components";
import { displayNameOf } from "../clusters/clusterSettings";
import { useClusters } from "../clusters/hooks";
import { useNow } from "../problems/hooks";
import { NOTIFY_CATEGORIES } from "../problems/model";
import { categoryOn, muteForHour, mutedNow, prefsOf, setCategory, setClusterMuted, setEnabled, unmute } from "./prefs";
import { CertExpiryField } from "./CertExpiryField";
import { formatTime } from "../../i18n";

type Save = (change: (current: AppSettings) => AppSettings) => Promise<boolean>;

export function NotificationsPanel({ settings, save }: { settings: AppSettings | null; save: Save }) {
  const { t } = useTranslation();
  const { clusters } = useClusters();
  const now = useNow(10_000);
  const prefs = prefsOf(settings);
  const on = prefs?.enabled ?? false;
  const muted = prefs ? mutedNow(prefs, now) : false;

  return (
    <div className="notif-settings">
      <label className="settings__choice">
        <Checkbox checked={on} disabled={!prefs} onChange={(e) => void save(setEnabled(e.target.checked))} />
        {t("notifications:settings.enabled")}
      </label>
      <p className="settings__hint">{t("notifications:settings.enabledHint")}</p>

      <div className="notif-settings__mute">
        {muted && prefs?.mutedUntil ? (
          <>
            <span role="status">
              {t("notifications:settings.mutedUntil", { time: formatTime(prefs.mutedUntil) })}
            </span>
            <Button size="compact" onClick={() => void save(unmute())}>
              {t("notifications:unmute")}
            </Button>
          </>
        ) : (
          <Button size="compact" disabled={!on} onClick={() => void save(muteForHour(Date.now()))}>
            {t("notifications:muteHour")}
          </Button>
        )}
      </div>

      <fieldset className="notif-settings__group" disabled={!on}>
        <legend className="settings__label">{t("notifications:settings.categories")}</legend>
        <div className="settings__choices settings__choices--column">
          {NOTIFY_CATEGORIES.map((category) => (
            <label key={category} className="settings__choice">
              <Checkbox
                checked={prefs ? categoryOn(prefs, category) : false}
                disabled={!on}
                onChange={(e) => void save(setCategory(category, e.target.checked))}
              />
              {t(`problems:categories.${category}`)}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="notif-settings__group">
        <legend className="settings__label">{t("notifications:settings.certificates")}</legend>
        <CertExpiryField className="notif-settings__cert-expiry" />
        <p className="settings__hint">{t("notifications:settings.certExpiryHint")}</p>
      </fieldset>

      <fieldset className="notif-settings__group" disabled={!on}>
        <legend className="settings__label">{t("notifications:settings.clusters")}</legend>
        <p className="settings__hint">{t("notifications:settings.clustersHint")}</p>
        {clusters.length === 0 ? (
          <p className="settings__hint">{t("notifications:settings.noClusters")}</p>
        ) : (
          <div className="settings__choices settings__choices--column">
            {clusters.map((cluster) => (
              <label key={cluster.id} className="settings__choice">
                <Checkbox
                  checked={!prefs?.mutedClusters.has(cluster.id)}
                  disabled={!on}
                  onChange={(e) => void save(setClusterMuted(cluster.id, !e.target.checked))}
                />
                {displayNameOf(cluster, settings)}
              </label>
            ))}
          </div>
        )}
      </fieldset>
    </div>
  );
}
