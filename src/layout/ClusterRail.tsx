import { useTranslation } from "react-i18next";
import logoUrl from "../assets/sextant.svg";
import { getSlot } from "./slots";

/**
 * Leftmost column: app logo, the cluster list (filled by features/clusters via the "clusterRail" slot) and, at the
 * bottom, the "railFooter" slot (the Settings button).
 */
export function ClusterRail() {
  const { t } = useTranslation();
  const Content = getSlot("clusterRail");
  const Footer = getSlot("railFooter");
  return (
    <nav className="rail" aria-label={t("common:layout.clusters")}>
      <img className="rail__logo" src={logoUrl} alt={t("common:app.logo")} width={32} height={32} />
      <div className="rail__content">{Content && <Content />}</div>
      {Footer && (
        <div className="rail__footer">
          <Footer />
        </div>
      )}
    </nav>
  );
}
