// The "Logs" block of a workload's details: follow the logs of all its pods in one merged tab.
import { useTranslation } from "react-i18next";
import { Button } from "../../../components";
import type { DetailsSectionProps } from "../../../layout/details/registry";
import { Block } from "../../details";
import { selectorTabTitle } from "../PodPicker";
import { podSelectorOf } from "../selector";
import { openSelectorLogsTab } from "./open";

export function WorkloadLogsSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const selector = obj ? podSelectorOf(obj, objectRef.kind) : null;
  const namespace = objectRef.namespace;
  if (!obj || !selector || !namespace) return null;
  return (
    <Block title={t("logs:details.title")}>
      <p className="logs-details">
        <Button icon="logs" onClick={() => openSelectorLogsTab(clusterId, namespace, selector, selectorTabTitle(objectRef.kind, obj))}>
          {t("logs:details.allPods")}
        </Button>
        <span className="logs-picker__hint">{t("logs:details.hint", { selector })}</span>
      </p>
    </Block>
  );
}
