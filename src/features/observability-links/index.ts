// Links to Grafana dashboards and traces (#266, ADR-0117): per cluster, a Grafana base URL, dashboard URL templates
// per object kind and a trace URL template, checked before they are saved; the details of workloads, pods, nodes and
// namespaces and the traffic graph's edge panel get "Open in Grafana" and "Find traces". A link is opened in the
// system browser on a click; Sextant itself requests nothing.
import { registerClusterSettingsSection, registerClusterSettingsTab } from "../clusters/settingsRegistry";
import { registerDetailsSection } from "../../layout/details/registry";
import { LinksSection, linksApply } from "./LinksSection";
import { ObservabilitySettingsSection } from "./SettingsSection";
import "./observability.css";

// After "Metrics" (20), before "Agent access" (30).
registerClusterSettingsTab({ id: "observabilityLinks", order: 25, labelKey: "observability:tab" });
registerClusterSettingsSection({
  id: "observabilityLinks",
  order: 0,
  tab: "observabilityLinks",
  titleKey: "observability:settings.title",
  Component: ObservabilitySettingsSection,
});

// After the metrics (50), before the request metrics (52).
registerDetailsSection({ id: "observabilityLinks", order: 51, appliesTo: linksApply, Component: LinksSection });
