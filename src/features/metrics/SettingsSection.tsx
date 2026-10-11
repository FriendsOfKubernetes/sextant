// "Metrics" section of the cluster settings: how Prometheus is found (auto / manual address / off), where current
// CPU/memory values come from, and what was found.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toApiError, type ApiError, type ClusterId, type PrometheusMode, type PrometheusTarget, type UsageSource } from "../../api";
import { ErrorState } from "../../components";
import { updateClusterSettings } from "../clusters/clusterSettings";
import type { ClusterSettingsSectionProps } from "../clusters/settingsRegistry";
import { useMetricsSettings, useMetricsStatus } from "./hooks";
import "./metrics.css";

const MODES = ["auto", "manual", "off"] as const;
type Mode = (typeof MODES)[number];
const SOURCES: UsageSource[] = ["auto", "metricsServer", "prometheus", "off"];

/** `namespace/service:port` → a service target; `null` if it does not have that form. */
export function parseServiceAddress(text: string, pathPrefix = ""): PrometheusTarget | null {
  const match = /^\s*([a-z0-9]([-a-z0-9]*[a-z0-9])?)\/((https?:)?[a-z0-9]([-a-z0-9]*[a-z0-9])?):(\d{1,5})\s*$/.exec(text);
  if (!match) return null;
  const port = Number(match[6]);
  if (port < 1 || port > 65535) return null;
  return { type: "service", namespace: match[1]!, service: match[3]!, port, pathPrefix: pathPrefix.trim() };
}

/** `http(s)://…` → a URL target; `null` otherwise. */
export function parseUrlAddress(text: string): PrometheusTarget | null {
  const url = text.trim();
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? { type: "url", url } : null;
  } catch {
    // Not a URL at all.
    return null;
  }
}

export function describeTarget(target: PrometheusTarget): string {
  if (target.type === "url") return target.url;
  return `${target.namespace}/${target.service}:${target.port}${target.pathPrefix}`;
}

export function MetricsSettingsSection({ clusterId }: ClusterSettingsSectionProps) {
  const { t } = useTranslation();
  const settings = useMetricsSettings(clusterId);
  const saved: PrometheusMode = settings?.prometheus ?? { mode: "auto" };
  const savedTarget = saved.mode === "manual" ? saved.target : null;
  const [mode, setMode] = useState<Mode>(saved.mode);
  const [kind, setKind] = useState<"service" | "url">(savedTarget?.type ?? "service");
  const [service, setService] = useState(savedTarget?.type === "service" ? describeService(savedTarget) : "");
  const [prefix, setPrefix] = useState(savedTarget?.type === "service" ? savedTarget.pathPrefix : "");
  const [url, setUrl] = useState(savedTarget?.type === "url" ? savedTarget.url : "");
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const savedKey = JSON.stringify(saved);
  useEffect(() => {
    // The saved settings arrived (or changed elsewhere): show them.
    const current = JSON.parse(savedKey) as PrometheusMode;
    setMode(current.mode);
    if (current.mode === "manual") {
      setKind(current.target.type);
      if (current.target.type === "service") {
        setService(describeService(current.target));
        setPrefix(current.target.pathPrefix);
      } else setUrl(current.target.url);
    }
  }, [savedKey]);

  const save = async (patch: Parameters<typeof updateClusterSettings>[1]) => {
    try {
      await updateClusterSettings(clusterId, patch);
      setError(null);
    } catch (err) {
      setError(toApiError(err));
    }
  };

  const chooseMode = (next: Mode) => {
    setMode(next);
    setInvalid(false);
    if (next !== "manual") void save({ prometheus: { mode: next } });
  };

  const saveManual = () => {
    const target = kind === "service" ? parseServiceAddress(service, prefix) : parseUrlAddress(url);
    setInvalid(target === null);
    if (target) void save({ prometheus: { mode: "manual", target } });
  };

  return (
    <div className="mx-settings">
      <fieldset className="mx-settings__group">
        <legend>{t("metrics:settings.prometheus")}</legend>
        {MODES.map((m) => (
          <label key={m} className="mx-settings__radio">
            <input type="radio" name={`prometheus-${clusterId}`} checked={mode === m} onChange={() => chooseMode(m)} />
            {t(`metrics:settings.mode.${m}`)}
          </label>
        ))}
        {mode === "manual" && (
          <div className="mx-settings__manual">
            <label className="mx-settings__radio">
              <input type="radio" name={`target-${clusterId}`} checked={kind === "service"} onChange={() => setKind("service")} />
              {t("metrics:settings.serviceKind")}
            </label>
            <label className="mx-settings__radio">
              <input type="radio" name={`target-${clusterId}`} checked={kind === "url"} onChange={() => setKind("url")} />
              {t("metrics:settings.urlKind")}
            </label>
            {kind === "service" ? (
              <>
                <label className="mx-settings__field">
                  <span>{t("metrics:settings.service")}</span>
                  <input
                    type="text"
                    value={service}
                    placeholder={t("metrics:settings.servicePlaceholder")}
                    onChange={(e) => setService(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && saveManual()}
                  />
                </label>
                <label className="mx-settings__field">
                  <span>{t("metrics:settings.pathPrefix")}</span>
                  <input type="text" value={prefix} placeholder="/" onChange={(e) => setPrefix(e.target.value)} />
                </label>
              </>
            ) : (
              <label className="mx-settings__field">
                <span>{t("metrics:settings.url")}</span>
                <input
                  type="text"
                  value={url}
                  placeholder={t("metrics:settings.urlPlaceholder")}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && saveManual()}
                />
              </label>
            )}
            {invalid && (
              <div className="mx-settings__invalid" role="alert">
                {t(kind === "service" ? "metrics:settings.invalidService" : "metrics:settings.invalidUrl")}
              </div>
            )}
            <button type="button" className="btn" onClick={saveManual}>
              {t("metrics:settings.save")}
            </button>
          </div>
        )}
      </fieldset>

      <label className="mx-settings__field">
        <span>{t("metrics:settings.usageSource")}</span>
        <select
          value={settings?.usageSource ?? SOURCES[0]}
          onChange={(e) => void save({ usageSource: e.target.value as UsageSource })}
        >
          {SOURCES.map((s) => (
            <option key={s} value={s}>
              {t(`metrics:settings.source.${s}`)}
            </option>
          ))}
        </select>
      </label>

      <Detected clusterId={clusterId} />
      {error && <ErrorState error={error} />}
    </div>
  );
}

function describeService(target: Extract<PrometheusTarget, { type: "service" }>): string {
  return `${target.namespace}/${target.service}:${target.port}`;
}

/** What the backend found with the saved settings. */
function Detected({ clusterId }: { clusterId: ClusterId }) {
  const { t } = useTranslation();
  const status = useMetricsStatus(clusterId);
  if (status.error) return <ErrorState error={status.error} />;
  const data = status.data;
  if (!data) return <div className="mx-note">{t("metrics:settings.checking")}</div>;
  const prometheus = data.prometheus
    ? t(data.mode.mode === "auto" ? "metrics:settings.foundAuto" : "metrics:settings.foundManual", {
        target: describeTarget(data.prometheus),
      })
    : t(
        data.mode.mode === "off"
          ? "metrics:settings.prometheusOff"
          : data.mode.mode === "manual"
            ? "metrics:settings.manualNoAnswer"
            : "metrics:settings.notFound",
      );
  const source = data.effectiveUsageSource
    ? t(`metrics:settings.source.${data.effectiveUsageSource}`)
    : t("metrics:settings.noSource");
  return (
    <dl className="mx-detected" aria-label={t("metrics:settings.detected")}>
      <dt>{t("metrics:settings.metricsServer")}</dt>
      <dd>{t(data.metricsServer ? "metrics:settings.available" : "metrics:settings.notAvailable")}</dd>
      <dt>{t("metrics:settings.prometheus")}</dt>
      <dd>{prometheus}</dd>
      <dt>{t("metrics:settings.currentFrom")}</dt>
      <dd>{source}</dd>
    </dl>
  );
}
