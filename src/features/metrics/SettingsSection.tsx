// "Metrics" section of the cluster settings: how the Prometheus-compatible source (Prometheus or VictoriaMetrics) is
// found (auto / manual address / off), where current CPU/memory values come from, and what was found.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  toApiError,
  type ApiError,
  type ClusterId,
  type MetricsSourceKind,
  type PrometheusMode,
  type PrometheusTarget,
  type UsageSource,
} from "../../api";
import { Button, ErrorState, Radio } from "../../components";
import { updateClusterSettings } from "../clusters/clusterSettings";
import type { ClusterSettingsSectionProps } from "../clusters/settingsRegistry";
import { useMetricsSettings, useMetricsStatus } from "./hooks";
import "./metrics.css";

const MODES = ["auto", "manual", "off"] as const;
const TARGET_KINDS = ["service", "url"] as const;
type Mode = (typeof MODES)[number];
const SOURCES: UsageSource[] = ["auto", "metricsServer", "prometheus", "off"];

/** What a manual service address is: a known kind fills in its usual port and path prefix (ADR-0102). */
export type Preset = MetricsSourceKind | "custom";
const PRESETS: Preset[] = ["prometheus", "victoriaMetricsSingle", "victoriaMetricsCluster", "custom"];
/** The port, path prefix and an example address of each kind's usual Service. VictoriaMetrics single-node answers on
 * 8428 from the Helm chart and from the operator (8429 there, with 8428 as an alias); a cluster's vmselect on 8481
 * under `/select/<tenant>/prometheus`. */
const PRESET_ADDRESS: Record<MetricsSourceKind, { port: number; example: string }> = {
  prometheus: { port: 9090, example: "monitoring/prometheus-operated:9090" },
  victoriaMetricsSingle: { port: 8428, example: "vm/vmsingle-vm:8428" },
  victoriaMetricsCluster: { port: 8481, example: "vm/vmselect-vm:8481" },
};
const DEFAULT_TENANT = "0";
const VMSELECT_PATH = /^\/select\/([^/]*)\/prometheus\/?$/;

/** vmselect's Prometheus API of `tenant` (`accountID` or `accountID:projectID`). */
export function vmselectPrefix(tenant: string): string {
  return `/select/${tenant.trim()}/prometheus`;
}

/** The tenant of a vmselect path prefix; `null` for another prefix. */
export function tenantOf(prefix: string): string | null {
  return VMSELECT_PATH.exec(prefix.trim())?.[1] ?? null;
}

/** A VictoriaMetrics tenant: `accountID` or `accountID:projectID`, both unsigned 32-bit numbers. */
export function isTenant(text: string): boolean {
  const match = /^(\d{1,10})(?::(\d{1,10}))?$/.exec(text.trim());
  return match !== null && match.slice(1).every((id) => id === undefined || Number(id) <= 0xffffffff);
}

/** The preset a saved port and path prefix match; `custom` when none does. */
export function presetOf(port: number | null, prefix: string): Preset {
  if (port === PRESET_ADDRESS.victoriaMetricsCluster.port && tenantOf(prefix) !== null) return "victoriaMetricsCluster";
  if (prefix.trim() !== "" && prefix.trim() !== "/") return "custom";
  // 80: the prometheus-community chart's `prometheus-server`.
  if (port === PRESET_ADDRESS.prometheus.port || port === 80) return "prometheus";
  if (port === PRESET_ADDRESS.victoriaMetricsSingle.port || port === 8429) return "victoriaMetricsSingle";
  return "custom";
}

/** `namespace/service[:port]` with its port replaced by (or completed with) `port`; empty text stays empty. */
export function withPort(text: string, port: number): string {
  const trimmed = text.trim();
  if (trimmed === "") return text;
  return `${trimmed.replace(/:\d*$/, "")}:${port}`;
}

function presetPort(preset: Preset): number | null {
  return preset === "custom" ? null : PRESET_ADDRESS[preset].port;
}

function portOf(text: string): number | null {
  const match = /:(\d{1,5})\s*$/.exec(text);
  return match ? Number(match[1]) : null;
}

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
  const [preset, setPreset] = useState<Preset>(
    savedTarget?.type === "service" ? presetOf(savedTarget.port, savedTarget.pathPrefix) : "prometheus",
  );
  // The tenant as typed: the path prefix is built from it, and it is checked on saving.
  const [tenant, setTenant] = useState(
    (savedTarget?.type === "service" ? tenantOf(savedTarget.pathPrefix) : null) ?? DEFAULT_TENANT,
  );
  const [invalid, setInvalid] = useState<"address" | "tenant" | null>(null);
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
        setPreset(presetOf(current.target.port, current.target.pathPrefix));
        setTenant(tenantOf(current.target.pathPrefix) ?? DEFAULT_TENANT);
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
    setInvalid(null);
    if (next !== "manual") void save({ prometheus: { mode: next } });
  };

  const choosePreset = (next: Preset) => {
    setPreset(next);
    if (next === "custom") return;
    setService(withPort(service, PRESET_ADDRESS[next].port));
    if (next === "victoriaMetricsCluster") {
      const kept = isTenant(tenant) ? tenant.trim() : DEFAULT_TENANT;
      setTenant(kept);
      setPrefix(vmselectPrefix(kept));
    } else setPrefix("");
  };

  /** The kind the address and prefix now match, asked when a field is left, not on every keystroke. A typed port
   * that is still vmselect's keeps the VictoriaMetrics cluster kind, whose prefix is checked on saving. */
  const rederive = (address: string, pathPrefix: string) => {
    const port = portOf(address) ?? presetPort(preset);
    if (preset === "victoriaMetricsCluster" && port === PRESET_ADDRESS.victoriaMetricsCluster.port) return;
    const next = presetOf(port, pathPrefix);
    setPreset(next);
    if (next === "victoriaMetricsCluster") setTenant(tenantOf(pathPrefix) ?? DEFAULT_TENANT);
  };

  const saveManual = () => {
    if (kind === "service" && preset === "victoriaMetricsCluster") {
      const inPrefix = tenantOf(prefix);
      if (inPrefix === null || !isTenant(inPrefix) || inPrefix !== tenant.trim()) {
        setInvalid("tenant");
        return;
      }
    }
    const target = kind === "service" ? parseServiceAddress(service, prefix) : parseUrlAddress(url);
    setInvalid(target === null ? "address" : null);
    if (!target) return;
    if (target.type === "service") rederive(service, prefix);
    void save({ prometheus: { mode: "manual", target } });
  };

  const example = PRESET_ADDRESS[preset === "custom" ? "prometheus" : preset].example;

  return (
    <div className="mx-settings">
      <fieldset className="mx-settings__group">
        <legend>{t("metrics:settings.prometheus")}</legend>
        {MODES.map((m) => (
          <label key={m} className="mx-settings__radio">
            <Radio name={`prometheus-${clusterId}`} checked={mode === m} onChange={() => chooseMode(m)} />
            {t(`metrics:settings.mode.${m}`)}
          </label>
        ))}
        {mode === "manual" && (
          <div className="mx-settings__manual">
            {TARGET_KINDS.map((k) => (
              <label key={k} className="mx-settings__radio">
                <Radio name={`target-${clusterId}`} checked={kind === k} onChange={() => setKind(k)} />
                {t(`metrics:settings.${k}Kind`)}
              </label>
            ))}
            {kind === "service" ? (
              <>
                <label className="mx-settings__field">
                  <span>{t("metrics:settings.preset")}</span>
                  <select value={preset} onChange={(e) => choosePreset(e.target.value as Preset)}>
                    {PRESETS.map((p) => (
                      <option key={p} value={p}>
                        {t(p === "custom" ? "metrics:settings.presetCustom" : `metrics:settings.kind.${p}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="mx-settings__field">
                  <span>{t("metrics:settings.service")}</span>
                  <input
                    type="text"
                    value={service}
                    placeholder={example}
                    onChange={(e) => setService(e.target.value)}
                    onBlur={(e) => rederive(e.target.value, prefix)}
                    onKeyDown={(e) => e.key === "Enter" && saveManual()}
                  />
                </label>
                {preset === "victoriaMetricsCluster" && (
                  <label className="mx-settings__field">
                    <span>{t("metrics:settings.tenant")}</span>
                    <input
                      type="text"
                      value={tenant}
                      placeholder={DEFAULT_TENANT}
                      onChange={(e) => {
                        setTenant(e.target.value);
                        setPrefix(vmselectPrefix(e.target.value));
                      }}
                      onKeyDown={(e) => e.key === "Enter" && saveManual()}
                    />
                  </label>
                )}
                <label className="mx-settings__field">
                  <span>{t("metrics:settings.pathPrefix")}</span>
                  <input
                    type="text"
                    value={prefix}
                    placeholder="/"
                    onChange={(e) => {
                      setPrefix(e.target.value);
                      const typed = tenantOf(e.target.value);
                      if (preset === "victoriaMetricsCluster" && typed !== null) setTenant(typed);
                    }}
                    onBlur={(e) => rederive(service, e.target.value)}
                  />
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
                {t(
                  invalid === "tenant"
                    ? "metrics:settings.invalidTenant"
                    : kind === "service"
                      ? "metrics:settings.invalidService"
                      : "metrics:settings.invalidUrl",
                )}
              </div>
            )}
            <Button onClick={saveManual}>
              {t("metrics:settings.save")}
            </Button>
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
      {data.prometheus && (
        <>
          <dt>{t("metrics:settings.kindLabel")}</dt>
          <dd>{t(`metrics:settings.kind.${data.prometheusKind ?? "unknown"}`)}</dd>
        </>
      )}
      <dt>{t("metrics:settings.currentFrom")}</dt>
      <dd>{source}</dd>
    </dl>
  );
}
