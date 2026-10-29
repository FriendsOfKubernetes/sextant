import { useTranslation } from "react-i18next";

type Tone = "success" | "warning" | "danger" | "muted";
const STATES: Record<string, Tone> = {
  RUNNING: "success",
  PROVISIONING: "warning",
  RECONCILING: "warning",
  STARTING: "warning",
  STOPPING: "warning",
  DELETING: "warning",
  STOPPED: "muted",
  ERROR: "danger",
};

export function YandexClusterStatus({ status }: { status: string | null }) {
  const { t } = useTranslation();
  if (!status) return null;
  const tone = STATES[status] ?? "muted";
  const label = t("clusters:cloud.clusterStatus", { status });
  return <span className="cloud-clusters__status" data-tone={tone} role="img" aria-label={label} title={label} />;
}
