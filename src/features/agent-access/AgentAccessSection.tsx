// "AI agent access" in the cluster settings: which agents' calls through the MCP server this cluster allows.
// A set (Off by default, Read-only, Read + write, Full) or Custom rules; the core reads the saved value on every
// agent call. Changes are saved at once, each applied to the latest saved value.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  api,
  toApiError,
  updateSettings,
  useSettings,
  type AccessPreset,
  type AccessRule,
  type ApiError,
  type ClusterAccess,
} from "../../api";
import { ErrorState, Radio } from "../../components";
import { clusterSettingsOf } from "../clusters/clusterSettings";
import type { ClusterSettingsSectionProps } from "../clusters/settingsRegistry";
import { RulesEditor } from "./RulesEditor";
import { makeAccess, PRESETS } from "./rules";
import "./access.css";

export function AgentAccessSection({ clusterId }: ClusterSettingsSectionProps) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const access = clusterSettingsOf(settings, clusterId).agentAccess;
  const [error, setError] = useState<ApiError | null>(null);

  /** Saves what `change` makes of the latest saved access. */
  const save = async (change: (current: ClusterAccess) => ClusterAccess) => {
    try {
      await updateSettings((current) => {
        const cluster = clusterSettingsOf(current, clusterId);
        return { ...current, clusters: { ...current.clusters, [clusterId]: { ...cluster, agentAccess: change(cluster.agentAccess) } } };
      });
      setError(null);
    } catch (err) {
      setError(toApiError(err));
    }
  };

  const choose = async (preset: AccessPreset) => {
    if (preset === access.preset) return;
    if (preset !== "custom") {
      await save((current) => makeAccess(preset, current.rules));
      return;
    }
    // Custom starts from the rules of the set that was chosen, so they can be edited.
    let rules: AccessRule[];
    try {
      rules = await api.access.presetRules(access.preset);
    } catch (err) {
      setError(toApiError(err));
      return;
    }
    await save(() => makeAccess("custom", rules));
  };

  const editRules = (change: (rules: AccessRule[]) => AccessRule[]) =>
    void save((current) => makeAccess(current.preset, change(current.rules)));

  return (
    <div className="aa">
      <p className="aa-note">{t("access:intro")}</p>
      <fieldset className="aa-group">
        <legend>{t("access:preset.legend")}</legend>
        {PRESETS.map((preset) => (
          <label key={preset} className="aa-choice">
            <Radio
              name={`agent-access-${clusterId}`}
              checked={access.preset === preset}
              onChange={() => void choose(preset)}
            />
            {t(`access:preset.${preset}`)}
          </label>
        ))}
      </fieldset>
      <p className="aa-description" aria-live="polite">
        {t(`access:description.${access.preset}`)}
      </p>
      {access.preset !== "off" && access.preset !== "custom" && <p className="aa-note">{t("access:customizeHint")}</p>}
      {access.preset === "custom" && <RulesEditor clusterId={clusterId} rules={access.rules} edit={editRules} />}
      {error && <ErrorState error={error} />}
    </div>
  );
}
