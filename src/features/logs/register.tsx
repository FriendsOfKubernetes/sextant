// Registers the "Logs" action, the dock tab that shows the stream, and the "Logs" block of workload details.
import { registerDockTab } from "../../layout/dock/registry";
import { registerDetailsSection } from "../../layout/details/registry";
import { extendActions } from "../../resources/registry";
import { registerAction } from "../actions/registry";
import { registerClusterSettingsSection } from "../clusters/settingsRegistry";
import "./logs.css";
import { LogsTab } from "./LogsTab";
import { LOKI_WORKLOAD_KINDS, PreviousPodsSection } from "./loki/PreviousPodsSection";
import { LokiSettingsSection } from "./loki/SettingsSection";
import "./loki/loki.css";
import { openPodsLogsTab, openSelectorLogsTab } from "./multi/open";
import { WorkloadLogsSection } from "./multi/WorkloadLogsSection";
import { openLogsTab } from "./openLogsTab";
import { PodPicker, selectorTabTitle } from "./PodPicker";
import { podSelectorOf, POD_OWNERS, selectsPods } from "./selector";

registerDockTab("logs", LogsTab);

// ReplicaSets and Services do not list "logs" among their own actions.
extendActions({ group: "apps", kind: "ReplicaSet" }, ["logs"]);
extendActions({ group: "", kind: "Service" }, ["logs"]);

registerAction("logs", {
  placement: "primary",
  labelKey: "logs:action.label",
  icon: "logs",
  // Several pods selected in a table: their logs merged in one tab; several workloads: a merged tab for each.
  multiple: true,
  appliesTo: (obj, kind) => {
    if (kind.group === "" && kind.kind === "Pod") return true;
    return selectsPods(kind) && podSelectorOf(obj, kind) !== null;
  },
  run: ({ clusterId, kind, objects, refs, openDialog }) => {
    const obj = objects[0];
    if (!obj) return;
    if (kind.group === "" && kind.kind === "Pod") {
      if (objects.length === 1) openLogsTab(clusterId, obj);
      else openPodsLogsTab(clusterId, refs);
      return;
    }
    if (objects.length === 1) {
      openDialog((close) => <PodPicker clusterId={clusterId} kind={kind} workload={obj} close={close} />);
      return;
    }
    for (const o of objects) {
      const selector = podSelectorOf(o, kind);
      const namespace = o.metadata?.namespace;
      if (selector && namespace) openSelectorLogsTab(clusterId, namespace, selector, selectorTabTitle(kind, o));
    }
  },
});

// After the kind's fields (20), before the conditions (30).
registerDetailsSection({
  id: "workloadLogs",
  order: 24,
  appliesTo: (kind) => POD_OWNERS[kind.group]?.includes(kind.kind) ?? false,
  Component: WorkloadLogsSection,
});

// Right after the live logs block: the pods a workload had, read from Loki (#265).
registerDetailsSection({
  id: "previousPodsLoki",
  order: 25,
  appliesTo: (kind) => LOKI_WORKLOAD_KINDS[kind.group]?.includes(kind.kind) ?? false,
  Component: PreviousPodsSection,
});

// Where Loki is (#265): in the Metrics tab of the cluster settings, after Prometheus.
registerClusterSettingsSection({
  id: "loki",
  order: 30,
  tab: "metrics",
  titleKey: "loki:settings.title",
  Component: LokiSettingsSection,
});
