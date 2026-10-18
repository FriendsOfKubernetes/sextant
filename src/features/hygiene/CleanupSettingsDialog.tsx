// Settings of the "Cleanup" page (`AppSettings.cleanup`, written by the frontend): whether ConfigMaps and Secrets are
// offered at all (off by default: Sextant cannot see every reference), the namespaces never checked besides the
// system ones, and the minimum age per rule in days.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toApiError, useSettings, type ApiError } from "../../api";
import { Button, Checkbox, Dialog, ErrorState } from "../../components";
import { clampDays, useCleanupSettings } from "./hooks";
import { SYSTEM_NAMESPACES, type CleanupAges } from "./rules";

const AGE_KEYS: (keyof CleanupAges)[] = ["configs", "services", "pods", "jobs", "claims", "volumes", "namespaces"];

/** The lines of the text as namespace names: trimmed, no empty ones, no system namespaces, each once. */
export function parseNamespaces(text: string): string[] {
  const names = text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !SYSTEM_NAMESPACES.includes(s));
  return [...new Set(names)];
}

export function CleanupSettingsDialog({ close }: { close: () => void }) {
  const { t } = useTranslation();
  const { update } = useSettings();
  const current = useCleanupSettings();
  const [text, setText] = useState(() => current.excluded.join("\n"));
  const [ages, setAges] = useState<Record<keyof CleanupAges, string>>(
    () => Object.fromEntries(AGE_KEYS.map((k) => [k, String(current.ages[k])])) as Record<keyof CleanupAges, string>,
  );
  const [configMaps, setConfigMaps] = useState(current.rules.configMaps);
  const [secrets, setSecrets] = useState(current.rules.secrets);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    const minAgeDays = Object.fromEntries(AGE_KEYS.map((k) => [k, clampDays(Number(ages[k]))])) as unknown as CleanupAges;
    try {
      await update((s) => ({
        ...s,
        cleanup: { excludedNamespaces: parseNamespaces(text), minAgeDays, checkConfigMaps: configMaps, checkSecrets: secrets },
      }));
      close();
    } catch (err) {
      setError(toApiError(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={t("hygiene:settings.title")}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>{t("common:actions.cancel")}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {t("hygiene:settings.save")}
          </Button>
        </>
      }
    >
      <div className="cln-field">
        <label className="cln-check">
          <Checkbox checked={configMaps} onChange={(e) => setConfigMaps(e.target.checked)} />
          {t("hygiene:settings.checkConfigMaps")}
        </label>
        <label className="cln-check">
          <Checkbox checked={secrets} onChange={(e) => setSecrets(e.target.checked)} />
          {t("hygiene:settings.checkSecrets")}
        </label>
        <span className="cln-note cln-note--warning">{t("hygiene:configsWarning")}</span>
      </div>
      <label className="cln-field">
        <span>{t("hygiene:settings.excluded")}</span>
        <textarea className="cln-field__text" rows={6} value={text} onChange={(e) => setText(e.target.value)} />
        <span className="cln-muted">{t("hygiene:settings.excludedHint")}</span>
      </label>
      <fieldset className="cln-ages">
        <legend>{t("hygiene:settings.days")}</legend>
        {AGE_KEYS.map((key) => (
          <label key={key} className="cln-ages__row">
            <span>{t(`hygiene:settings.ages.${key}`)}</span>
            <input
              className="cln-ages__input"
              type="number"
              min={0}
              max={3650}
              value={ages[key]}
              onChange={(e) => setAges((prev) => ({ ...prev, [key]: e.target.value }))}
            />
          </label>
        ))}
      </fieldset>
      {error && <ErrorState error={error} title={t("hygiene:settings.saveFailed")} />}
    </Dialog>
  );
}
