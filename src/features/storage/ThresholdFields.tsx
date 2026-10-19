// "Almost full from … %" and "Critically full from … %" (`notifications.volumeWarnPercent` / `volumeCriticalPercent`,
// 85 and 95 by default, 50–99, the critical one never below the warning; inodes count the same): the thresholds of
// the opt-in category "disk almost full" and of the Usage colours. Shown in Settings → Notifications; saved on blur
// or Enter, and the held problems follow at once.
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../../api";
import { thresholdsChanged } from "./problems";
import { clampPercent, DEFAULT_CRITICAL_PERCENT, DEFAULT_WARN_PERCENT, MAX_PERCENT, MIN_PERCENT, thresholdsOf } from "./usage";

type Which = "volumeWarnPercent" | "volumeCriticalPercent";
const WARN: Which = "volumeWarnPercent";
const CRITICAL: Which = "volumeCriticalPercent";

function PercentField({ which, label }: { which: Which; label: string }) {
  const { settings, update } = useSettings();
  const current = thresholdsOf(settings?.notifications);
  const value = which === "volumeWarnPercent" ? current.warn : current.critical;
  const [draft, setDraft] = useState<string | null>(null);
  const id = useId();
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    if (draft.trim() === "" || !Number.isFinite(Number(draft))) return;
    const next = clampPercent(Number(draft), which === "volumeWarnPercent" ? DEFAULT_WARN_PERCENT : DEFAULT_CRITICAL_PERCENT);
    if (next === value) return;
    void update((s) => {
      const n = { ...s.notifications, [which]: next };
      // Moving one past the other moves both.
      if (which === "volumeWarnPercent" && n.volumeCriticalPercent < next) n.volumeCriticalPercent = next;
      if (which === "volumeCriticalPercent" && n.volumeWarnPercent > next) n.volumeWarnPercent = next;
      return { ...s, notifications: n };
    })
      .then(thresholdsChanged)
      .catch(() => undefined);
  };
  return (
    <label className="st-threshold" htmlFor={id}>
      {label}
      <input
        id={id}
        type="number"
        min={MIN_PERCENT}
        max={MAX_PERCENT}
        step={1}
        disabled={!settings}
        value={draft ?? String(value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
    </label>
  );
}

export function ThresholdFields() {
  const { t } = useTranslation();
  return (
    <div className="st-thresholds">
      <PercentField which={WARN} label={t("storage:thresholds.warn")} />
      <PercentField which={CRITICAL} label={t("storage:thresholds.critical")} />
      <p className="settings__hint">{t("storage:thresholds.hint")}</p>
    </div>
  );
}
