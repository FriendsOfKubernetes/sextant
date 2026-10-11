// "General" cluster settings: display name and color label in the rail, plus where the context comes from.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toApiError, useSettings, type ApiError } from "../../api";
import { SourceError } from "./AddClusterDialog";
import { CLUSTER_COLORS, clusterSettingsOf, updateClusterSettings } from "./clusterSettings";
import { useClustersStore } from "./clustersStore";
import type { ClusterSettingsSectionProps } from "./settingsRegistry";

export function GeneralSection({ clusterId, cluster }: ClusterSettingsSectionProps) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const current = clusterSettingsOf(settings, clusterId);
  const source = useClustersStore((s) => s.sources.find((src) => src.id === cluster.sourceId));
  const [name, setName] = useState(current.displayName ?? "");
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => setName(current.displayName ?? ""), [current.displayName]);

  const save = async (patch: Parameters<typeof updateClusterSettings>[1]) => {
    try {
      await updateClusterSettings(clusterId, patch);
      setError(null);
    } catch (err) {
      setError(toApiError(err));
    }
  };
  const saveName = () => {
    const next = name.trim() || null;
    if (next !== (current.displayName ?? null)) void save({ displayName: next });
  };

  return (
    <div className="cluster-settings__general">
      <label className="clusters-field">
        <span>{t("clusters:settings.displayName")}</span>
        <input
          type="text"
          value={name}
          placeholder={cluster.context}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => e.key === "Enter" && saveName()}
        />
      </label>
      <div className="clusters-field">
        <span id={`color-${clusterId}`}>{t("clusters:settings.color")}</span>
        <div className="clusters-colors" role="radiogroup" aria-labelledby={`color-${clusterId}`}>
          <button
            type="button"
            role="radio"
            aria-checked={current.color === null}
            className="clusters-colors__none"
            onClick={() => void save({ color: null })}
          >
            {t("clusters:settings.autoColor")}
          </button>
          {CLUSTER_COLORS.map((color, index) => (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={current.color === color}
              aria-label={t("clusters:settings.colorOption", { index: index + 1 })}
              className="clusters-colors__swatch"
              style={{ background: color }}
              onClick={() => void save({ color })}
            />
          ))}
        </div>
      </div>
      <dl className="clusters-facts">
        <dt>{t("clusters:info.context")}</dt>
        <dd>{cluster.context}</dd>
        <dt>{t("clusters:info.cluster")}</dt>
        <dd>{cluster.clusterName}</dd>
        <dt>{t("clusters:info.server")}</dt>
        <dd>{cluster.server}</dd>
        <dt>{t("clusters:info.user")}</dt>
        <dd>{cluster.user}</dd>
        {source && (
          <>
            <dt>{t("clusters:info.source")}</dt>
            <dd>{source.path}</dd>
          </>
        )}
      </dl>
      {error && <SourceError error={error} />}
    </div>
  );
}
