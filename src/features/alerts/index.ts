// Alerts on objects (#264, ADR-0119): the firing and pending alerts of the cluster's Prometheus-compatible source and
// its Alertmanager's alerts and silences, read-only. An "Alerts" page in the Cluster section (grouped by severity and
// alert name, filters, a silences tab), an "Alerts" section in the details of the objects the alerts' labels name, an
// "Alerts" block in the cluster settings (how the Alertmanager is found), and the opt-in problems category `alerts`.
// The backend (`alerts_list`) reads both through the API server's service proxy with fixed requests; agents and
// extensions get nothing new.
import { registerDetailsSection } from "../../layout/details/registry";
import { registerPage } from "../../layout/pages";
import { registerClusterSettingsSection } from "../clusters/settingsRegistry";
import { AlertsPage } from "./AlertsPage";
import { AlertsDetailsSection, alertsApplies } from "./DetailsSection";
import { ALERTS_PAGE_ID, ALERTS_SETTINGS_ID } from "./ids";
import { AlertsSettingsSection } from "./SettingsSection";
import "./provider";

// Right after the problems (10).
registerPage({
  id: ALERTS_PAGE_ID,
  section: "cluster",
  order: 12,
  labelKey: "alerts:sidebar",
  icon: "alert",
  Component: AlertsPage,
});

// After the conditions (30), before the metrics (50).
registerDetailsSection({ id: "alerts", order: 40, appliesTo: alertsApplies, Component: AlertsDetailsSection });

// Right after the metrics source (20) in the Metrics tab.
registerClusterSettingsSection({
  id: ALERTS_SETTINGS_ID,
  order: 25,
  tab: "metrics",
  titleKey: "alerts:settings.title",
  Component: AlertsSettingsSection,
});

export { ALERTS_PAGE_ID } from "./ids";
