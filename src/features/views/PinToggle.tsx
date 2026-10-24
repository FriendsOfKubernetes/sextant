// The details panel's header (#274): an icon-only toggle next to the object's name that pins it to the favourites
// strip or unpins it. The state is the button's `aria-pressed` and its icon (a filled pin while pinned); the
// accessible name stays "Pin to favourites" (ADR-0034), the tooltip says what a click does.
import { useTranslation } from "react-i18next";
import { useSettings } from "../../api";
import { updateSettings } from "../../api/settings";
import { Button } from "../../components";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { isPinned, objectPinOf, togglePin } from "./model";

export function PinToggle({ clusterId, objectRef }: DetailsSectionProps) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const pin = objectPinOf(clusterId, objectRef);
  const pinned = isPinned(settings, pin);
  return (
    <Button
      iconOnly
      size="compact"
      icon="pin"
      className={`views-pin-toggle${pinned ? " views-pin-toggle--on" : ""}`}
      label={t("views:pin.action")}
      title={pinned ? t("views:pin.unpinAction") : t("views:pin.action")}
      aria-pressed={pinned}
      disabled={!settings}
      onClick={() => void updateSettings((s) => togglePin(s, pin)).catch(() => undefined)}
    />
  );
}
