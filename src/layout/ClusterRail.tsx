import { useTranslation } from "react-i18next";
import logoUrl from "../assets/sextant.svg";
import { getSlot } from "./slots";

/** Leftmost column: app logo and the cluster list (filled by features/clusters via the "clusterRail" slot). */
export function ClusterRail() {
  const { t } = useTranslation();
  const Content = getSlot("clusterRail");
  return (
    <nav className="rail" aria-label={t("common:layout.clusters")}>
      <img className="rail__logo" src={logoUrl} alt={t("common:app.logo")} width={32} height={32} />
      <div className="rail__content">{Content && <Content />}</div>
    </nav>
  );
}
