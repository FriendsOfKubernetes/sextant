// The entry points: a "Diagnose" action on Services, Ingresses, HTTPRoutes and GRPCRoutes (the dialog), and a
// "Diagnosis" tab in their details. Read-only: nothing is written to the cluster and no traffic is sent.
import { registerDetailsSection } from "../../layout/details/registry";
import { extendActions } from "../../resources/registry";
import { registerAction } from "../actions/registry";
import { GRPC_ROUTE, HTTP_ROUTE } from "../gateway-api/model";
import { DiagnoseDialog, DiagnosisTab } from "./DiagnosisPanel";
import { isDiagnosable } from "./engine";
import { INGRESS, SERVICE } from "./objects";

export const DIAGNOSED_KINDS = [SERVICE, INGRESS, HTTP_ROUTE, GRPC_ROUTE];

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

for (const kind of DIAGNOSED_KINDS) extendActions(kind, ["diagnose"]);

// A tab of its own: its watches open only while it is shown.
registerDetailsSection({
  id: "diagnosis",
  order: 45,
  placement: "tab",
  labelKey: "diagnose:tab",
  appliesTo: isDiagnosable,
  Component: DiagnosisTab,
});
