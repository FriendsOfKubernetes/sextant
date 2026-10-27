// Registers the OpenShift kinds in the discovered sidebar section `openshift` (shown only for kinds the cluster
// serves), their columns (Routes, DeploymentConfigs, Builds and ImageStreams with the "Only problems" filter), their
// details section, the traffic diagnosis of a Route (src/features/diagnose/openshift.ts: the "Diagnose" action and the
// "Diagnosis" tab) and the two actions (actions.tsx). Otherwise read-only: the generic Edit and Delete.
import type { IconName } from "../../components";
import { registerDetailsSection } from "../../layout/details/registry";
import { registerResource, type ColumnDef } from "../../resources";
import { extendActions } from "../../resources/registry";
import { openshiftDiagnoser } from "../diagnose/openshift";
import { registerRouteDiagnoser } from "../diagnose/routeKinds";
import "./actions";
import { bcColumns, buildColumns, dcColumns, imageStreamColumns, projectColumns, routeColumns } from "./columns";
import { appliesTo, OpenShiftSection } from "./details";
import { BUILD_CONFIG, DEPLOYMENT_CONFIG, isProblem, isProblemKind, OPENSHIFT_KINDS, ROUTE } from "./model";

const ICONS: Record<string, IconName> = {
  routes: "openshiftRoute",
  deploymentConfigs: "openshiftDeploymentConfig",
  buildConfigs: "openshiftBuildConfig",
  builds: "openshiftBuild",
  imageStreams: "openshiftImageStream",
  projects: "openshiftProject",
};

const COLUMNS: Record<string, ColumnDef[]> = {
  routes: routeColumns,
  deploymentConfigs: dcColumns,
  buildConfigs: bcColumns,
  builds: buildColumns,
  imageStreams: imageStreamColumns,
  projects: projectColumns,
};

for (const def of OPENSHIFT_KINDS) {
  registerResource({
    kind: def.kind,
    sidebar: { section: "openshift", order: def.order, labelKey: `openshift:sidebar.${def.label}`, icon: ICONS[def.label] },
    columns: COLUMNS[def.label] ?? [],
    actions: ["edit", "delete"],
    namespaced: def.namespaced,
    ...(isProblemKind(def.kind) ? { problem: (obj) => isProblem(obj, def.kind) } : {}),
  });
}

// In place of the generic fields (20), before the conditions (30).
registerDetailsSection({ id: "openshift", order: 20, appliesTo, Component: OpenShiftSection });

registerRouteDiagnoser(openshiftDiagnoser);
extendActions(ROUTE, ["diagnose"]);
extendActions(DEPLOYMENT_CONFIG, ["openshiftRolloutLatest"]);
extendActions(BUILD_CONFIG, ["openshiftStartBuild"]);
