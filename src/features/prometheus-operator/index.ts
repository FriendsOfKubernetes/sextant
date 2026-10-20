// Prometheus Operator (#213): the discovered sidebar section "Prometheus Operator" — ServiceMonitors, PodMonitors,
// Probes, PrometheusRules, Prometheuses and Alertmanagers. A monitor's details list the Services (Pods) its selector
// and namespaces select right now (the selector goes to the API server, in a bounded set of namespaces), whether the
// port names exist on them and which Prometheus picks it up; PrometheusRules count their groups and rules; Prometheus
// and Alertmanager show their readiness. A monitor that selects nothing and a Prometheus or Alertmanager not available
// feed the problems screen (category `prometheusOperator`, the monitors through `provider.ts`) and the section
// counter; "not picked up by any Prometheus" is a warning. Read-only (ADR-0100).
import { registerSectionBadge } from "../../layout/sectionBadges";
import { usePrometheusOperatorProblemCount } from "./problems";
import "./prometheus-operator.css";
import "./provider";
import "./register";

registerSectionBadge("prometheusOperator", usePrometheusOperatorProblemCount, {
  tone: "danger",
  labelKey: "prometheusoperator:badge",
});

export * from "./model";
