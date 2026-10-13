// The cluster settings dialog: registered sections (general here; metrics adds its own) for one cluster.
import { useTranslation } from "react-i18next";
import { useSettings } from "../../api";
import { Button, Dialog } from "../../components";
import { displayNameOf } from "./clusterSettings";
import { openClusterSettings, useClustersStore } from "./clustersStore";
import { getClusterSettingsSections } from "./settingsRegistry";

export function ClusterSettingsDialog() {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const clusterId = useClustersStore((s) => s.settingsFor);
  const cluster = useClustersStore((s) => s.clusters.find((c) => c.id === clusterId));
  const close = () => openClusterSettings(null);
  if (!clusterId || !cluster) return null;

  return (
    <Dialog
      open
      title={t("clusters:settings.title", { name: displayNameOf(cluster, settings) })}
      onClose={close}
      footer={
        <Button onClick={close}>{t("common:actions.close")}</Button>
      }
    >
      <div className="cluster-settings">
        {getClusterSettingsSections().map(({ id, titleKey, Component }) => (
          <section key={id} className="cluster-settings__section" aria-label={titleKey ? t(titleKey) : undefined}>
            {titleKey && <h3 className="clusters-subtitle">{t(titleKey)}</h3>}
            <Component clusterId={clusterId} cluster={cluster} />
          </section>
        ))}
      </div>
    </Dialog>
  );
}
