// Settings -> Appearance: reduced motion (System / On / Off), the interface text size and screen reader support in the
// terminal (ADR-0092). The window applies them itself (`useApplyAccessibility` in App, src/app/accessibility.ts).
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { defaultAppSettings, type AppearanceSettings, type AppSettings, type ReduceMotion } from "../../api";
import { parseAccessibility, TEXT_SIZES } from "../../app/accessibility";
import { Checkbox, Radio } from "../../components";

type Save = (change: (current: AppSettings) => AppSettings) => Promise<boolean>;

const MOTION: ReduceMotion[] = ["system", "on", "off"];

export function AccessibilitySettings({ settings, save }: { settings: AppSettings | null; save: Save }) {
  const { t } = useTranslation();
  const motionId = useId();
  const sizeId = useId();
  const readerHintId = useId();
  const current = parseAccessibility(settings?.appearance);
  const change = (patch: Partial<AppearanceSettings>) =>
    void save((s) => ({ ...s, appearance: { ...(s.appearance ?? defaultAppSettings().appearance), ...patch } }));

  return (
    <>
      <div className="settings__field">
        <span className="settings__label" id={motionId}>
          {t("settings:accessibility.reduceMotion")}
        </span>
        <div className="settings__choices" role="radiogroup" aria-labelledby={motionId}>
          {MOTION.map((value) => (
            <label key={value} className="settings__choice">
              <Radio
                name="settings-reduce-motion"
                value={value}
                checked={current.reduceMotion === value}
                disabled={!settings}
                onChange={() => change({ reduceMotion: value })}
              />
              {t(`settings:accessibility.reduceMotionChoices.${value}`)}
            </label>
          ))}
        </div>
        <p className="settings__hint">{t("settings:accessibility.reduceMotionHint")}</p>
      </div>
      <div className="settings__field">
        <span className="settings__label" id={sizeId}>
          {t("settings:accessibility.textSize")}
        </span>
        <div className="settings__choices" role="radiogroup" aria-labelledby={sizeId}>
          {TEXT_SIZES.map((value) => (
            <label key={value} className="settings__choice">
              <Radio
                name="settings-text-size"
                value={String(value)}
                checked={current.textSize === value}
                disabled={!settings}
                onChange={() => change({ textSize: value })}
              />
              {t("settings:accessibility.percent", { value })}
            </label>
          ))}
        </div>
        <p className="settings__hint">{t("settings:accessibility.textSizeHint")}</p>
      </div>
      <div className="settings__field">
        <label className="settings__choice">
          <Checkbox
            checked={current.terminalScreenReader}
            disabled={!settings}
            aria-describedby={readerHintId}
            onChange={(e) => change({ terminalScreenReader: e.target.checked })}
          />
          {t("settings:accessibility.terminalScreenReader")}
        </label>
        <p className="settings__hint" id={readerHintId}>
          {t("settings:accessibility.terminalScreenReaderHint")}
        </p>
      </div>
    </>
  );
}
