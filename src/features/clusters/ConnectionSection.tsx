// The "Connection" tab of the cluster settings (#230): where the context comes from — context, cluster, server, user
// and the kubeconfig file. Other features add sections about the connection to the same tab (`tab: "connection"`).
import { useTranslation } from "react-i18next";
import { useClustersStore } from "./clustersStore";
import type { ClusterSettingsSectionProps } from "./settingsRegistry";

export function ConnectionSection({ cluster }: ClusterSettingsSectionProps) {
  const { t } = useTranslation();
  const source = useClustersStore((s) => s.sources.find((src) => src.id === cluster.sourceId));
  return (
    <dl className="clusters-facts">
      <dt>{t("clusters:info.context")}</dt>
      <dd>{cluster.context}</dd>
      <dt>{t("clusters:info.cluster")}</dt>
      <dd>{cluster.clusterName}</dd>
      <dt>{t("clusters:info.server")}</dt>
      <dd>{cluster.server}</dd>
      <dt>{t("clusters:info.user")}</dt>
      <dd>{cluster.user}</dd>
      {source && (
        <>
          <dt>{t("clusters:info.source")}</dt>
          <dd>{source.path}</dd>
        </>
      )}
    </dl>
  );
}
