// Registers the Prometheus Operator kinds in the sidebar section `prometheusOperator` (shown only for kinds the
// cluster serves) and their details. Read-only: the kinds offer the generic Edit and Delete only.
import type { KubeObject } from "../../api";
import type { IconName } from "../../components";
import { registerDetailsSection } from "../../layout/details/registry";
import { registerResource, type ColumnDef } from "../../resources";
import { podMonitorColumns, probeColumns, ruleColumns, serverColumns, serviceMonitorColumns } from "./columns";
import { appliesTo, PrometheusOperatorSection } from "./details";
import {
  ALERTMANAGER,
  isKind,
  isServerProblem,
  MONITORING_KINDS,
  POD_MONITOR,
  PROBE,
  PROMETHEUS,
  PROMETHEUS_RULE,
  SERVICE_MONITOR,
  type MonitoringKind,
} from "./model";
import { selectsNothing } from "./store";

const ICONS: Record<string, IconName> = {
  serviceMonitors: "serviceMonitor",
  podMonitors: "podMonitor",
  probes: "probe",
  prometheusRules: "prometheusRule",
  prometheuses: "prometheus",
  alertmanagers: "alertmanager",
};

function columnsOf({ kind }: MonitoringKind): ColumnDef[] {
  if (isKind(kind, SERVICE_MONITOR)) return serviceMonitorColumns;
  if (isKind(kind, POD_MONITOR)) return podMonitorColumns;
  if (isKind(kind, PROBE)) return probeColumns;
  if (isKind(kind, PROMETHEUS_RULE)) return ruleColumns;
  return serverColumns;
}

function problemOf({ kind }: MonitoringKind): ((obj: KubeObject) => boolean) | undefined {
  if (isKind(kind, PROMETHEUS, ALERTMANAGER)) return isServerProblem;
  // Known while the problems source holds the monitors (the screen, the counter or the notifications look at them).
  if (isKind(kind, SERVICE_MONITOR, POD_MONITOR)) return selectsNothing;
  return undefined;
}

for (const def of MONITORING_KINDS) {
  registerResource({
    kind: def.kind,
    sidebar: {
      section: "prometheusOperator",
      order: def.order,
      labelKey: `prometheusoperator:sidebar.${def.label}`,
      icon: ICONS[def.label],
    },
    columns: columnsOf(def),
    actions: ["edit", "delete"],
    namespaced: true,
    problem: problemOf(def),
  });
}

registerDetailsSection({
  id: "prometheusOperator",
  order: 20,
  appliesTo,
  Component: PrometheusOperatorSection,
});
