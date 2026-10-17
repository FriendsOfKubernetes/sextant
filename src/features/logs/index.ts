// Pod logs: the "Logs" action (pods; for workloads and Services all pods merged or a pod picker) and the dock tab
// that shows the stream.
import "./register";

export { LogsTab, type LogContainer, type LogsPayload } from "./LogsTab";
export { openLogsTab } from "./openLogsTab";
export { openPodsLogsTab, openSelectorLogsTab, type MultiLogsPayload } from "./multi/open";
export { LOG_BUFFER_LIMIT } from "./buffer";
