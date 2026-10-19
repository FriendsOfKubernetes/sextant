// Registers the Istio and Linkerd kinds in their discovered sidebar sections (`istio`, `linkerd`; shown only for kinds
// the cluster serves), with their columns, the details section of every mesh kind, and the "Service mesh" section of
// Pods and workloads.
import type { DetailsSectionProps } from "../../layout/details/registry";
import { registerDetailsSection } from "../../layout/details/registry";
import { registerResource } from "../../resources";
import { meshColumns, meshProblemOf } from "./columns";
import { IstioDetails } from "./istioDetails";
import { MESH_KINDS, meshKind } from "./kinds";
import { LinkerdDetails } from "./linkerdDetails";
import { hasMeshSection, MeshMembershipSection } from "./MembershipSection";

for (const { kind, section, order, label, icon } of MESH_KINDS) {
  registerResource({
    kind,
    sidebar: { section, order, labelKey: `mesh:sidebar.${label}`, icon },
    columns: meshColumns(kind),
    actions: ["edit", "delete"],
    namespaced: true,
    problem: meshProblemOf(kind),
  });
}

function MeshDetailsSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const def = meshKind(objectRef.kind);
  if (!obj || !def) return null;
  return def.section === "istio" ? (
    <IstioDetails clusterId={clusterId} obj={obj} kind={def.kind.kind} />
  ) : (
    <LinkerdDetails clusterId={clusterId} obj={obj} kind={def.kind} />
  );
}

// In place of the generic fields (20), before the conditions (30).
registerDetailsSection({
  id: "mesh",
  order: 20,
  appliesTo: (kind) => meshKind(kind) !== undefined,
  Component: MeshDetailsSection,
});

// After the kind's own fields, before the conditions.
registerDetailsSection({
  id: "meshMembership",
  order: 28,
  appliesTo: hasMeshSection,
  Component: MeshMembershipSection,
});
