// "Dashboards and traces" in the cluster settings (#266): Grafana's base URL, a dashboard URL template per object
// kind, and a trace URL template (Tempo through Grafana, or Jaeger's UI). Everything is checked before it is saved
// (template.ts); Sextant never requests these URLs.
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { toApiError, useSettings, type ApiError } from "../../api";
import type { ObservabilityLinks } from "../../api/generated/ObservabilityLinks";
import { Button, ErrorState } from "../../components";
import { formatList } from "../../i18n/format";
import { updateClusterSettings } from "../clusters/clusterSettings";
import type { ClusterSettingsSectionProps } from "../clusters/settingsRegistry";
import { linksOf } from "./model";
import { presetsFor } from "./presets";
import {
  DASHBOARD_TARGETS,
  TARGET_VARIABLES,
  checkBaseUrl,
  checkTemplate,
  type BaseUrlError,
  type Target,
  type TemplateError,
} from "./template";

const GRAFANA_FIELD = "grafanaUrl";
const TRACES_FIELD = "tracesUrl";
const EXAMPLE_URL = "https://grafana.example.com";

interface Form {
  grafanaUrl: string;
  dashboards: Record<string, string>;
  tracesUrl: string;
  traces: string;
}

function formOf(links: ObservabilityLinks | null): Form {
  return {
    grafanaUrl: links?.grafanaUrl ?? "",
    dashboards: { ...links?.dashboards },
    tracesUrl: links?.tracesUrl ?? "",
    traces: links?.traces ?? "",
  };
}

type Checked = { links: ObservabilityLinks | null; errors: Record<string, BaseUrlError | TemplateError> };

/** The links to save, or the field errors. An empty base URL or template is "not set". */
export function checkForm(form: Form): Checked {
  const errors: Checked["errors"] = {};
  const base = (field: "grafanaUrl" | "tracesUrl"): string | null => {
    if (!form[field].trim()) return null;
    const checked = checkBaseUrl(form[field]);
    if ("error" in checked) {
      errors[field] = checked.error;
      return null;
    }
    return checked.url;
  };
  const grafanaUrl = base("grafanaUrl");
  const tracesUrl = base("tracesUrl");
  const template = (key: string, text: string, target: Target, against: string | null): string | null => {
    if (!text.trim()) return null;
    const error = checkTemplate(against, text, target);
    if (error) errors[key] = error;
    return text.trim();
  };
  const dashboards: Record<string, string> = {};
  for (const target of DASHBOARD_TARGETS) {
    const kept = template(target, form.dashboards[target] ?? "", target, grafanaUrl);
    if (kept) dashboards[target] = kept;
  }
  const traces = template("traces", form.traces, "traces", tracesUrl ?? grafanaUrl);
  if (Object.keys(errors).length > 0) return { links: null, errors };
  const empty = !grafanaUrl && !tracesUrl && !traces && Object.keys(dashboards).length === 0;
  return { links: empty ? null : { grafanaUrl, dashboards, tracesUrl, traces }, errors };
}

function variablesText(target: Target): string {
  return formatList(TARGET_VARIABLES[target].map((v) => `{${v}}`));
}

function TemplateField({
  target,
  value,
  error,
  onChange,
}: {
  target: Target;
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const presets = presetsFor(target);
  return (
    <div className="observability-settings__template">
      <label className="observability-settings__field" htmlFor={id}>
        <span>{t(`observability:settings.targets.${target}`)}</span>
      </label>
      <input
        id={id}
        type="text"
        className="observability-settings__input"
        value={value}
        spellCheck={false}
        aria-describedby={`${id}-hint`}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      <p id={`${id}-hint`} className="observability-settings__hint">
        {t("observability:settings.variables", { variables: variablesText(target) })}
      </p>
      {presets.length > 0 && (
        <select
          className="observability-settings__preset"
          aria-label={t("observability:settings.presetFor", { target: t(`observability:settings.targets.${target}`) })}
          value=""
          onChange={(e) => {
            const preset = presets.find((p) => p.id === e.target.value);
            if (preset) onChange(preset.template);
          }}
        >
          <option value="">{t("observability:settings.choosePreset")}</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {t(`observability:presets.${p.id}`)}
            </option>
          ))}
        </select>
      )}
      {error && (
        <p className="observability-settings__invalid" role="alert">
          {t(`observability:templateError.${error}`)}
        </p>
      )}
    </div>
  );
}

function BaseField({
  field,
  value,
  error,
  onChange,
}: {
  field: "grafanaUrl" | "tracesUrl";
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="observability-settings__template">
      <label className="observability-settings__field" htmlFor={id}>
        <span>{t(`observability:settings.${field}`)}</span>
      </label>
      <input
        id={id}
        type="text"
        className="observability-settings__input"
        value={value}
        spellCheck={false}
        placeholder={field === GRAFANA_FIELD ? EXAMPLE_URL : undefined}
        aria-describedby={`${id}-hint`}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      <p id={`${id}-hint`} className="observability-settings__hint">
        {t(`observability:settings.${field}Hint`)}
      </p>
      {error && (
        <p className="observability-settings__invalid" role="alert">
          {t(`observability:baseError.${error}`)}
        </p>
      )}
    </div>
  );
}

export function ObservabilitySettingsSection({ clusterId }: ClusterSettingsSectionProps) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const saved = linksOf(settings, clusterId);
  const [form, setForm] = useState<Form>(() => formOf(saved));
  const [errors, setErrors] = useState<Checked["errors"]>({});
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [done, setDone] = useState(false);
  const [touched, setTouched] = useState(false);
  // Settings that arrive after the dialog opened fill the form until the user types.
  const savedText = JSON.stringify(saved);
  useEffect(() => {
    if (!touched) setForm(formOf(JSON.parse(savedText) as ObservabilityLinks | null));
  }, [savedText, touched]);

  const change = (patch: Partial<Form>) => {
    setForm((f) => ({ ...f, ...patch }));
    setTouched(true);
    setDone(false);
  };
  const save = async (links: ObservabilityLinks | null) => {
    try {
      await updateClusterSettings(clusterId, { observabilityLinks: links });
      setFailure(null);
      setDone(true);
    } catch (err) {
      setFailure(toApiError(err));
    }
  };
  const submit = () => {
    const checked = checkForm(form);
    setErrors(checked.errors);
    if (Object.keys(checked.errors).length === 0) void save(checked.links);
  };
  const clear = () => {
    setForm(formOf(null));
    setErrors({});
    void save(null);
  };

  return (
    <div className="observability-settings">
      <p className="observability-settings__hint">{t("observability:settings.intro")}</p>
      <BaseField
        field={GRAFANA_FIELD}
        value={form.grafanaUrl}
        error={errors.grafanaUrl}
        onChange={(grafanaUrl) => change({ grafanaUrl })}
      />
      <fieldset className="observability-settings__group">
        <legend>{t("observability:settings.dashboards")}</legend>
        <p className="observability-settings__hint">{t("observability:settings.templateHint")}</p>
        {DASHBOARD_TARGETS.map((target) => (
          <TemplateField
            key={target}
            target={target}
            value={form.dashboards[target] ?? ""}
            error={errors[target]}
            onChange={(value) => change({ dashboards: { ...form.dashboards, [target]: value } })}
          />
        ))}
      </fieldset>
      <fieldset className="observability-settings__group">
        <legend>{t("observability:settings.tracesGroup")}</legend>
        <BaseField
          field={TRACES_FIELD}
          value={form.tracesUrl}
          error={errors.tracesUrl}
          onChange={(tracesUrl) => change({ tracesUrl })}
        />
        <TemplateField
          target="traces"
          value={form.traces}
          error={errors.traces}
          onChange={(traces) => change({ traces })}
        />
      </fieldset>
      <div className="observability-settings__buttons">
        <Button variant="primary" onClick={submit}>
          {t("observability:settings.save")}
        </Button>
        {saved && <Button onClick={clear}>{t("observability:settings.remove")}</Button>}
        {done && (
          <span className="observability-settings__hint" role="status">
            {t("observability:settings.saved")}
          </span>
        )}
      </div>
      {failure && <ErrorState error={failure} />}
    </div>
  );
}
