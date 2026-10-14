// "AI agent access" in the cluster settings: which agents' calls through the MCP server this cluster allows.
// A set (Off by default, Read-only, Read + write, Full) or Custom rules; the core reads the saved value on every
// agent call. Changes are saved at once, each applied to the latest saved value. A value the core could not read
// arrives as `agentAccessUnrecognised` beside a closed access; it is sent back untouched until the user resets it or
// chooses a set.
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
import { Button, ErrorState, Radio } from "../../components";
import { clusterSettingsOf } from "../clusters/clusterSettings";
import type { ClusterSettingsSectionProps } from "../clusters/settingsRegistry";
import { RulesEditor } from "./RulesEditor";
import { makeAccess, PRESETS } from "./rules";
import "./access.css";

export function AgentAccessSection({ clusterId }: ClusterSettingsSectionProps) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const cluster = clusterSettingsOf(settings, clusterId);
  const access = cluster.agentAccess;
  const unrecognised = cluster.agentAccessUnrecognised !== undefined && cluster.agentAccessUnrecognised !== null;
  const [error, setError] = useState<ApiError | null>(null);

  /** Saves what `change` makes of the latest saved access. */
  const save = async (change: (current: ClusterAccess) => ClusterAccess) => {
    try {
      await updateSettings((current) => {
        const stored = clusterSettingsOf(current, clusterId);
        // Saving any access also decides what happens to a value that could not be read: it is replaced.
        const next = { ...stored, agentAccess: change(stored.agentAccess) };
        delete next.agentAccessUnrecognised;
        return { ...current, clusters: { ...current.clusters, [clusterId]: next } };
      });
      setError(null);
    } catch (err) {
      setError(toApiError(err));
    }
  };

  const choose = async (preset: AccessPreset) => {
    // Off beside a value that could not be read is the same as "Reset to Off".
    if (preset === access.preset && !unrecognised) return;
    if (preset !== "custom") {
      await save((current) => makeAccess(preset, current.rules));
      return;
    }
    // The user's own rules are kept while another set is chosen, and come back with Custom. Only when there are
    // none does Custom start from the rules of the set that was chosen, so they can be edited.
    if (access.rules.length > 0) {
      await save((current) => makeAccess("custom", current.rules));
      return;
    }
    let rules: AccessRule[];
    try {
      rules = await api.access.presetRules(access.preset);
    } catch (err) {
      setError(toApiError(err));
      return;
    }
    await save((current) => makeAccess("custom", current.rules.length > 0 ? current.rules : rules));
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
      {unrecognised && (
        <div className="aa-unrecognised" role="status">
          <p>{t("access:unrecognised.notice")}</p>
          <Button onClick={() => void choose("off")}>{t("access:unrecognised.reset")}</Button>
        </div>
      )}
      <p className="aa-description" aria-live="polite">
        {t(`access:description.${access.preset}`)}
      </p>
      {access.preset !== "off" && access.preset !== "custom" && <p className="aa-note">{t("access:customizeHint")}</p>}
      {access.preset === "custom" && <RulesEditor clusterId={clusterId} rules={access.rules} edit={editRules} />}
      {error && <ErrorState error={error} />}
    </div>
  );
}
