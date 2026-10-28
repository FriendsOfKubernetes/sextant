import { useTranslation } from "react-i18next";
import { useAppStore } from "../app/store";
import logoUrl from "../assets/sextant.svg";
import { Icon } from "../components";
import { getSlot, useSlotsVersion } from "./slots";

/**
 * Leftmost column: app logo, the cluster list (filled by features/clusters via the "clusterRail" slot) and, at the
 * bottom, the button that expands the rail (icons with names) or folds it back to icons, above the "railFooter" slot
 * (the Settings button, the agent activity button). The view is `useAppStore().railExpanded`, saved in `settings.window.railExpanded`.
 */
export function ClusterRail() {
  const { t } = useTranslation();
  useSlotsVersion();
  const Content = getSlot("clusterRail");
  const Footer = getSlot("railFooter");
  const expanded = useAppStore((s) => s.railExpanded);
  const setExpanded = useAppStore((s) => s.setRailExpanded);
  const toggleLabel = t(expanded ? "clusters:rail.collapse" : "clusters:rail.expand");
  return (
    <nav className={expanded ? "rail rail--expanded" : "rail"} aria-label={t("common:layout.clusters")}>
      <div className="rail__brand">
        {/* Expanded, the name next to it says what the logo would: the image is then decoration. */}
        <img className="rail__logo" src={logoUrl} alt={expanded ? "" : t("common:app.logo")} width={32} height={32} />
        {expanded && <span className="rail__brand-name">{t("common:app.name")}</span>}
      </div>
      <div className="rail__content">{Content && <Content />}</div>
      <div className="rail__footer">
        <button
          type="button"
          className="icon-btn rail__toggle"
          aria-label={toggleLabel}
          title={toggleLabel}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <Icon name={expanded ? "collapseRail" : "expandRail"} />
        </button>
        {Footer && <Footer />}
      </div>
    </nav>
  );
}
