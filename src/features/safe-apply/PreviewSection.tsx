// "Change preview" in the cluster settings: whether the editor's Save, Apply YAML and Helm upgrades and installs show
// the server's dry run before the change is sent. Until the user chooses, it follows the cluster's name.
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { toApiError, useSettings, type ApiError } from "../../api";
import { Button, Checkbox, ErrorState } from "../../components";
import { updateClusterSettings } from "../clusters/clusterSettings";
import type { ClusterSettingsSectionProps } from "../clusters/settingsRegistry";
import { namesOf, previewByDefault, previewsChanges } from "./policy";

export function PreviewSection({ clusterId, cluster }: ClusterSettingsSectionProps) {
  const { t } = useTranslation();
  const id = useId();
  const { settings } = useSettings();
  const [error, setError] = useState<ApiError | null>(null);
  const on = previewsChanges(clusterId, cluster, settings);
  const chosen = settings?.clusters[clusterId]?.previewChanges;
  const byName = previewByDefault(namesOf(cluster, settings));

  const save = async (previewChanges: boolean | null) => {
    try {
      await updateClusterSettings(clusterId, { previewChanges });
      setError(null);
    } catch (err) {
      setError(toApiError(err));
    }
  };

  return (
    <div className="safe-apply-section">
      <label className="safe-apply-section__toggle" htmlFor={id}>
        <Checkbox id={id} checked={on} onChange={(e) => void save(e.target.checked)} />
        {t("safeapply:section.label")}
      </label>
      <p className="safe-apply-section__hint">{t("safeapply:section.hint")}</p>
      <p className="safe-apply-section__hint">
        {byName ? t("safeapply:section.defaultOn") : t("safeapply:section.defaultOff")}
      </p>
      {typeof chosen === "boolean" && (
        <Button onClick={() => void save(null)}>{t("safeapply:section.useDefault")}</Button>
      )}
      {error && <ErrorState error={error} />}
    </div>
  );
}
