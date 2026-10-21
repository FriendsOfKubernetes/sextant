// Registers the Knative Eventing kinds (#234) in the discovered sidebar section `knativeEventing` (shown only for the
// kinds the cluster serves), their columns with the "Only problems" filter, and their details section. Read-only: the
// kinds offer the generic Edit and Delete only.
import { registerDetailsSection } from "../../layout/details/registry";
import { registerResource } from "../../resources";
import { EVENTING_KINDS, eventingKind, isEventingProblem } from "./eventing";
import { eventingColumns } from "./eventingColumns";
import { EventingSection } from "./eventingDetails";

for (const def of EVENTING_KINDS) {
  registerResource({
    kind: def.kind,
    sidebar: { section: "knativeEventing", order: def.order, labelKey: `knative:eventing.sidebar.${def.label}`, icon: def.icon },
    columns: eventingColumns(def),
    actions: ["edit", "delete"],
    namespaced: true,
    problem: isEventingProblem,
  });
}

// In place of the generic fields (20), before the conditions (30).
registerDetailsSection({
  id: "knativeEventing",
  order: 20,
  appliesTo: (kind) => eventingKind(kind) !== undefined,
  Component: EventingSection,
});
