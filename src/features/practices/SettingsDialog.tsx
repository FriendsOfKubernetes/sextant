// Settings of the best-practice checks (`AppSettings.practices`, written by the frontend): which checks are on, by
// area, and the namespaces never checked. The page, the details section and the problems category all follow them.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toApiError, useSettings, type ApiError } from "../../api";
import { Button, Checkbox, Dialog, ErrorState } from "../../components";
import { parseNamespaceList, savePractices, usePracticesConfig } from "./config";
import { AREAS, CHECKS, areaOf, type CheckId } from "./model";

export function PracticesSettingsDialog({ close }: { close: () => void }) {
  const { t } = useTranslation();
  const { update } = useSettings();
  const { config } = usePracticesConfig();
  const [on, setOn] = useState<ReadonlySet<CheckId>>(() => new Set(CHECKS.filter((c) => !config.disabled.has(c))));
  const [text, setText] = useState(() => [...config.excluded].join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const toggle = (check: CheckId, value: boolean) => {
    const next = new Set(on);
    if (value) next.add(check);
    else next.delete(check);
    setOn(next);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await update(savePractices(CHECKS.filter((c) => !on.has(c)), parseNamespaceList(text)));
      close();
    } catch (err) {
      setError(toApiError(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={t("practices:settings.title")}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>{t("common:actions.cancel")}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {t("practices:settings.save")}
          </Button>
        </>
      }
    >
      {AREAS.map((area) => (
        <fieldset key={area} className="bp-settings__group">
          <legend>{t(`practices:areas.${area}`)}</legend>
          {CHECKS.filter((c) => areaOf(c) === area).map((check) => (
            <label key={check} className="bp-settings__check">
              <Checkbox checked={on.has(check)} onChange={(e) => toggle(check, e.target.checked)} />
              {t(`practices:checks.${check}.title`)}
            </label>
          ))}
        </fieldset>
      ))}
      <label className="bp-settings__field">
        <span>{t("practices:settings.excluded")}</span>
        <textarea className="bp-settings__text" rows={5} value={text} onChange={(e) => setText(e.target.value)} />
        <span className="sec-muted">{t("practices:settings.excludedHint")}</span>
      </label>
      {error && <ErrorState error={error} title={t("practices:settings.saveFailed")} />}
    </Dialog>
  );
}
