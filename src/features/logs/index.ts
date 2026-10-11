// Pod logs: the "Logs" action (pods, and a pod picker for workloads) and the dock tab that shows the stream.
import "./register";

export { LogsTab, type LogContainer, type LogsPayload } from "./LogsTab";
export { openLogsTab } from "./openLogsTab";
export { LOG_BUFFER_LIMIT } from "./buffer";
