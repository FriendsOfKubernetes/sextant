// Metrics (task 08): CPU/Memory columns of the Pods and Nodes tables, the "Metrics" section of the details panel
// (pods, nodes, Deployments, StatefulSets, DaemonSets) and the "Metrics" section of the cluster settings.
// Values come from metrics-server or Prometheus, as chosen in the cluster settings; see hooks.ts.
import { registerDetailsSection } from "../../layout/details/registry";
import { extendColumns } from "../../resources";
import { registerClusterSettingsSection } from "../clusters/settingsRegistry";
import { nodeColumns, podColumns } from "./columns";
import { metricsApplyTo, MetricsDetailsSection } from "./DetailsSection";
import { MetricsSettingsSection } from "./SettingsSection";

extendColumns({ group: "", kind: "Pod" }, podColumns);
extendColumns({ group: "", kind: "Node" }, nodeColumns);

// Between conditions (30) and events (80).
registerDetailsSection({ id: "metrics", order: 50, appliesTo: metricsApplyTo, Component: MetricsDetailsSection });

registerClusterSettingsSection({
  id: "metrics",
  order: 20,
  tab: "metrics",
  titleKey: "metrics:settings.title",
  Component: MetricsSettingsSection,
});

export { Chart, type ChartProps } from "./Chart";
export { nodeAllocatable } from "./columns";
export {
  ChartGrid,
  MetricsUnavailable,
  nothingAvailable,
  UsageBar,
  usageUnavailable,
  type MetricName,
} from "./components";
export { formatBytes, formatCores, formatCount, formatCpu, parseQuantity, percentKey, percentOf } from "./format";
export {
  CHART_RANGE_SECS,
  POLL_INTERVAL_MS,
  resetMetricsCache,
  useCharts,
  useMetricsSettings,
  useMetricsStatus,
  useNodeUsage,
  usePodUsage,
  type Polled,
} from "./hooks";
export { describeTarget, parseServiceAddress, parseUrlAddress } from "./SettingsSection";
