// "All clusters" at the top of the cluster rail: opens the overview of several clusters in the main area; while it is
// open, the same button goes back to the welcome area.
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../app/store";
import { Icon } from "../../components";
import { FLEET_VIEW } from "./constants";
import { toggleFleet } from "./store";

export function FleetRailButton() {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.homeView === FLEET_VIEW && s.activeClusterId === null);
  const expanded = useAppStore((s) => s.railExpanded);
  const label = t("fleet:rail");
  return (
    <button
      type="button"
      className={`fleet-rail${open ? " fleet-rail--active" : ""}${expanded ? " fleet-rail--expanded" : ""}`}
      aria-label={label}
      title={label}
      aria-current={open ? "page" : undefined}
      aria-pressed={open}
      onClick={toggleFleet}
    >
      <Icon name="fleet" size={20} />
      {expanded && (
        <span className="fleet-rail__name" aria-hidden="true">
          {label}
        </span>
      )}
    </button>
  );
}
