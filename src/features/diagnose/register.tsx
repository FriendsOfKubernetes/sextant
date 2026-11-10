// The entry points: a "Diagnose" action on Services, Ingresses, HTTPRoutes and GRPCRoutes (the dialog), and a
// "Diagnosis" tab in their details. Read-only: nothing is written to the cluster and no traffic is sent.
//
// Contour's HTTPProxy and OpenShift's Route are route kinds registered here (`routeKinds.ts`): their views are Sextant's
// own extensions `extensions/contour` and `extensions/openshift` since 0.30 (ADR-0162 amendment), but the diagnosis
// stays Sextant's own, for the window and agents' `diagnose_service`, offered whether the extension is installed or not.
import { registerDetailsSection } from "../../layout/details/registry";
import { extendActions } from "../../resources/registry";
import { registerAction } from "../actions/registry";
import { GRPC_ROUTE, HTTP_ROUTE } from "../gateway-api/model";
import { contourDiagnoser } from "./contour";
import { HTTP_PROXY } from "./contourModel";
import { DiagnoseDialog, DiagnosisTab } from "./DiagnosisPanel";
import { isDiagnosable } from "./engine";
import { INGRESS, SERVICE } from "./objects";
import { openshiftDiagnoser } from "./openshift";
import { ROUTE as OPENSHIFT_ROUTE } from "./openshiftModel";
import { registerRouteDiagnoser } from "./routeKinds";

export const DIAGNOSED_KINDS = [SERVICE, INGRESS, HTTP_ROUTE, GRPC_ROUTE];

registerRouteDiagnoser(contourDiagnoser);
registerRouteDiagnoser(openshiftDiagnoser);

registerAction("diagnose", {
  placement: "primary",
  labelKey: "diagnose:action",
  icon: "connectivity",
  appliesTo: (obj, kind) => isDiagnosable(kind) && Boolean(obj.metadata?.namespace),
  run: ({ clusterId, kind, objects, openDialog }) => {
    const obj = objects[0];
    const namespace = obj?.metadata?.namespace;
    if (!obj || !namespace) return;
    openDialog((close) => (
      <DiagnoseDialog clusterId={clusterId} kind={kind} namespace={namespace} name={obj.metadata?.name ?? ""} obj={obj} close={close} />
    ));
  },
});

for (const kind of [...DIAGNOSED_KINDS, HTTP_PROXY, OPENSHIFT_ROUTE]) extendActions(kind, ["diagnose"]);

// A tab of its own: its watches open only while it is shown.
registerDetailsSection({
  id: "diagnosis",
  order: 45,
  placement: "tab",
  labelKey: "diagnose:tab",
  appliesTo: isDiagnosable,
  Component: DiagnosisTab,
});
