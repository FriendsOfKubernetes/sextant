// Registers the "Logs" action and the dock tab that shows the stream.
import { registerDockTab } from "../../layout/dock/registry";
import { registerAction } from "../actions/registry";
import "./logs.css";
import { LogsTab } from "./LogsTab";
import { openLogsTab } from "./logsTab";
import { PodPicker } from "./PodPicker";
import { labelSelectorOf } from "./selector";

registerDockTab("logs", LogsTab);

/** Workloads whose pods can be chosen: `apps` Deployment, StatefulSet, DaemonSet and `batch` Job. */
const WORKLOADS: Record<string, string[]> = { apps: ["Deployment", "StatefulSet", "DaemonSet"], batch: ["Job"] };

registerAction("logs", {
  labelKey: "logs:action.label",
  icon: "≡",
  appliesTo: (obj, kind) => {
    if (kind.group === "" && kind.kind === "Pod") return true;
    return (WORKLOADS[kind.group]?.includes(kind.kind) ?? false) && labelSelectorOf(obj) !== null;
  },
  run: ({ clusterId, kind, objects, openDialog }) => {
    const obj = objects[0];
    if (!obj) return;
    if (kind.kind === "Pod") openLogsTab(clusterId, obj);
    else openDialog((close) => <PodPicker clusterId={clusterId} workload={obj} close={close} />);
  },
});

