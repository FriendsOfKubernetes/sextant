// "Loki" in the cluster settings (Metrics tab): how Loki is found (automatically / this Service / off), the tenant
// sent as X-Scope-OrgID, and what was found.
import { useEffect, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { toApiError, type ApiError, type ClusterId, type LokiMode, type LokiSettings } from "../../../api";
import { Button, ErrorState, Radio } from "../../../components";
import { updateClusterSettings } from "../../clusters/clusterSettings";
import type { ClusterSettingsSectionProps } from "../../clusters/settingsRegistry";
import { resetLokiStatuses, useLokiSettings, useLokiStatus } from "./hooks";
import { lokiUnavailableKey } from "./LokiBar";

const MODES = ["auto", "manual", "off"] as const;
/** The grafana/loki chart's gateway, as an example of the address. */
const EXAMPLE_SERVICE = "loki/loki-gateway:80";
type Mode = (typeof MODES)[number];

/** `namespace/service:port` → its parts; `null` if it does not have that form. */
export function parseLokiService(text: string): { namespace: string; service: string; port: number } | null {
  const match = /^\s*([a-z0-9]([-a-z0-9]*[a-z0-9])?)\/([a-z0-9]([-a-z0-9]*[a-z0-9])?):(\d{1,5})\s*$/.exec(text);
  if (!match) return null;
  const port = Number(match[5]);
  return port >= 1 && port <= 65535 ? { namespace: match[1]!, service: match[3]!, port } : null;
}

/** A path prefix as the backend accepts it: empty, or `/segment` parts of unreserved characters. */
export function isPathPrefix(text: string): boolean {
  const prefix = text.trim().replace(/\/+$/, "");
  return prefix === "" || (/^(\/[A-Za-z0-9._~-]+)+$/.test(prefix) && !/\/\.{1,2}(\/|$)/.test(prefix) && prefix.length <= 200);
}

/** A Loki tenant ID (or several joined by `|`). */
export function isTenant(text: string): boolean {
  return text.length <= 150 && text.split("|").every((id) => /^[A-Za-z0-9!_.*'()-]+$/.test(id) && id !== "." && id !== "..");
}

function describe(mode: LokiMode): string {
  return mode.mode === "manual" ? `${mode.namespace}/${mode.service}:${mode.port}` : "";
}

export function LokiSettingsSection({ clusterId }: ClusterSettingsSectionProps) {
  const { t } = useTranslation();
  const saved: LokiSettings = useLokiSettings(clusterId) ?? { mode: { mode: "auto" }, tenant: null };
  const [mode, setMode] = useState<Mode>(saved.mode.mode);
  const [service, setService] = useState(describe(saved.mode));
  const [prefix, setPrefix] = useState(saved.mode.mode === "manual" ? saved.mode.pathPrefix : "");
  const [tenant, setTenant] = useState(saved.tenant ?? "");
  const [invalid, setInvalid] = useState<"service" | "prefix" | "tenant" | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const savedKey = JSON.stringify(saved);
  useEffect(() => {
    // The saved settings arrived (or changed elsewhere): show them.
    const current = JSON.parse(savedKey) as LokiSettings;
    setMode(current.mode.mode);
    setService(describe(current.mode));
    setPrefix(current.mode.mode === "manual" ? current.mode.pathPrefix : "");
    setTenant(current.tenant ?? "");
  }, [savedKey]);

  const save = async (next: LokiSettings) => {
    try {
      await updateClusterSettings(clusterId, { loki: next });
      resetLokiStatuses();
      setError(null);
    } catch (err) {
      setError(toApiError(err));
    }
  };

  /** The settings as typed; `null` (and the field marked) when something does not read. */
  const typed = (m: Mode): LokiSettings | null => {
    const tenantText = tenant.trim();
    if (tenantText !== "" && !isTenant(tenantText)) {
      setInvalid("tenant");
      return null;
    }
    let next: LokiMode = { mode: m === "manual" ? "auto" : m };
    if (m === "manual") {
      const address = parseLokiService(service);
      if (!address) {
        setInvalid("service");
        return null;
      }
      if (!isPathPrefix(prefix)) {
        setInvalid("prefix");
        return null;
      }
      next = { mode: "manual", ...address, pathPrefix: prefix.trim().replace(/\/+$/, "") };
    }
    setInvalid(null);
    return { mode: next, tenant: tenantText === "" ? null : tenantText };
  };

  const chooseMode = (next: Mode) => {
    setMode(next);
    setInvalid(null);
    if (next === "manual") return;
    const settings = typed(next);
    if (settings) void save(settings);
  };
  const apply = () => {
    const settings = typed(mode);
    if (settings) void save(settings);
  };
  const onEnter = (e: KeyboardEvent) => e.key === "Enter" && apply();

  return (
    <div className="mx-settings">
      <fieldset className="mx-settings__group">
        <legend>{t("loki:settings.legend")}</legend>
        {MODES.map((m) => (
          <label key={m} className="mx-settings__radio">
            <Radio name={`loki-${clusterId}`} checked={mode === m} onChange={() => chooseMode(m)} />
            {t(`loki:settings.mode.${m}`)}
          </label>
        ))}
        {mode === "manual" && (
          <>
            <label className="mx-settings__field">
              <span>{t("loki:settings.service")}</span>
              <input type="text" value={service} placeholder={EXAMPLE_SERVICE} onChange={(e) => setService(e.target.value)} onKeyDown={onEnter} />
            </label>
            <label className="mx-settings__field">
              <span>{t("loki:settings.pathPrefix")}</span>
              <input type="text" value={prefix} placeholder="/" onChange={(e) => setPrefix(e.target.value)} onKeyDown={onEnter} />
            </label>
          </>
        )}
        {mode !== "off" && (
          <label className="mx-settings__field">
            <span>{t("loki:settings.tenant")}</span>
            <input type="text" value={tenant} placeholder={t("loki:settings.tenantPlaceholder")} onChange={(e) => setTenant(e.target.value)} onKeyDown={onEnter} />
          </label>
        )}
        {invalid && (
          <div className="mx-settings__invalid" role="alert">
            {t(`loki:settings.invalid.${invalid}`)}
          </div>
        )}
        {mode !== "off" && <Button onClick={apply}>{t("loki:settings.save")}</Button>}
      </fieldset>
      <LokiDetected clusterId={clusterId} />
      {error && <ErrorState error={error} />}
    </div>
  );
}

/** What the backend found with the saved settings. */
function LokiDetected({ clusterId }: { clusterId: ClusterId }) {
  const { t } = useTranslation();
  const loki = useLokiStatus(clusterId);
  if (loki.loading) return <div className="mx-note">{t("loki:settings.checking")}</div>;
  if (loki.error) return <ErrorState error={loki.error} title={t("loki:statusFailed")} />;
  const status = loki.status!;
  const unavailable = lokiUnavailableKey(status);
  return (
    <div className="mx-note" role="status" data-testid="loki-detected">
      {unavailable
        ? t(unavailable)
        : t(status.manual ? "loki:settings.foundManual" : "loki:settings.foundAuto", {
            target: `${status.source!.namespace}/${status.source!.service}:${status.source!.port}${status.source!.pathPrefix}`,
            labels: t(`loki:settings.scheme.${status.scheme!}`),
          })}
    </div>
  );
}
