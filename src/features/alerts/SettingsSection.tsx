// "Alerts" section of the cluster settings (Metrics tab): how the Alertmanager is found — automatically by its usual
// Service names, at a Service address (`namespace/service:port` and a path prefix, reached through the API server's
// service proxy; never a URL), or not at all — and what each alert source gave. Prometheus' own alerts follow the
// "Metrics" section's Prometheus-compatible source.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toApiError, type AlertmanagerMode, type AlertmanagerTarget, type ApiError } from "../../api";
import { Button, ErrorState, Radio } from "../../components";
import { updateClusterSettings } from "../clusters/clusterSettings";
import type { ClusterSettingsSectionProps } from "../clusters/settingsRegistry";
import { useMetricsSettings } from "../metrics";
import { useAlerts, refreshAlerts } from "./store";
import "../metrics/metrics.css";

const MODES = ["auto", "manual", "off"] as const;
type Mode = (typeof MODES)[number];
const EXAMPLE = "monitoring/alertmanager-operated:9093";
type Which = "prometheus" | "alertmanager";
const PROMETHEUS: Which = "prometheus";
const ALERTMANAGER: Which = "alertmanager";

/** `namespace/service:port` and a path prefix → a target; `null` unless both have the form the core accepts. */
export function parseAlertmanagerAddress(text: string, pathPrefix: string): AlertmanagerTarget | null {
  const match = /^\s*([a-z0-9]([-a-z0-9]*[a-z0-9])?)\/([a-z]([-a-z0-9]*[a-z0-9])?):(\d{1,5})\s*$/.exec(text);
  if (!match) return null;
  const port = Number(match[5]);
  if (port < 1 || port > 65535 || match[1]!.length > 63 || match[3]!.length > 63) return null;
  const prefix = pathPrefix.trim();
  const segments = prefix.split("/").filter(Boolean);
  const plain = segments.every((s) => s !== "." && s !== ".." && /^[A-Za-z0-9._~-]+$/.test(s));
  if (prefix.length > 200 || !plain || (prefix !== "" && !prefix.startsWith("/"))) return null;
  return { namespace: match[1]!, service: match[3]!, port, pathPrefix: prefix };
}

export function AlertsSettingsSection({ clusterId }: ClusterSettingsSectionProps) {
  const { t } = useTranslation();
  const settings = useMetricsSettings(clusterId);
  const saved: AlertmanagerMode = settings?.alertmanager ?? { mode: "auto" };
  const savedKey = JSON.stringify(saved);
  const [mode, setMode] = useState<Mode>(saved.mode);
  const [address, setAddress] = useState("");
  const [prefix, setPrefix] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const { report } = useAlerts(clusterId);

  useEffect(() => {
    // The saved settings arrived (or changed elsewhere): show them.
    const current = JSON.parse(savedKey) as AlertmanagerMode;
    setMode(current.mode);
    if (current.mode === "manual") {
      const { namespace, service, port, pathPrefix } = current.target;
      setAddress(`${namespace}/${service}:${port}`);
      setPrefix(pathPrefix);
    }
  }, [savedKey]);

  const save = async (next: AlertmanagerMode) => {
    try {
      await updateClusterSettings(clusterId, { alertmanager: next });
      setError(null);
      refreshAlerts(clusterId);
    } catch (err) {
      setError(toApiError(err));
    }
  };

  const chooseMode = (next: Mode) => {
    setMode(next);
    setInvalid(false);
    if (next !== "manual") void save({ mode: next });
  };

  const saveManual = () => {
    const target = parseAlertmanagerAddress(address, prefix);
    setInvalid(target === null);
    if (target) void save({ mode: "manual", target });
  };

  const found = (which: Which) => {
    const source = report?.[which];
    if (!source) return t("alerts:settings.checking");
    if (source.status === "ok") return source.target ?? t("alerts:settings.found");
    if (source.status === "notAvailable") return t("alerts:settings.vmalertMissing");
    if (source.status === "failed") return t("alerts:settings.failed");
    return t(`alerts:settings.status.${source.status}`);
  };

  return (
    <div className="mx-settings">
      <fieldset className="mx-settings__group">
        <legend>{t("alerts:settings.alertmanager")}</legend>
        {MODES.map((m) => (
          <label key={m} className="mx-settings__radio">
            <Radio name={`alertmanager-${clusterId}`} checked={mode === m} onChange={() => chooseMode(m)} />
            {t(`alerts:settings.mode.${m}`)}
          </label>
        ))}
        {mode === "manual" && (
          <div className="mx-settings__manual">
            <label className="mx-settings__field">
              <span>{t("alerts:settings.service")}</span>
              <input
                type="text"
                value={address}
                placeholder={EXAMPLE}
                onChange={(e) => setAddress(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveManual()}
              />
            </label>
            <label className="mx-settings__field">
              <span>{t("alerts:settings.pathPrefix")}</span>
              <input
                type="text"
                value={prefix}
                placeholder="/"
                onChange={(e) => setPrefix(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveManual()}
              />
            </label>
            {invalid && (
              <div className="mx-settings__invalid" role="alert">
                {t("alerts:settings.invalid")}
              </div>
            )}
            <Button onClick={saveManual}>{t("alerts:settings.save")}</Button>
          </div>
        )}
      </fieldset>
      <p className="mx-note">{t("alerts:settings.prometheusHint")}</p>
      <dl className="mx-detected" aria-label={t("alerts:settings.detected")}>
        <dt>{t("alerts:settings.prometheusSource")}</dt>
        <dd>{found(PROMETHEUS)}</dd>
        <dt>{t("alerts:settings.alertmanager")}</dt>
        <dd>{found(ALERTMANAGER)}</dd>
      </dl>
      {error && <ErrorState error={error} />}
    </div>
  );
}
