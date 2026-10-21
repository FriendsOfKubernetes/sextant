// Registers SealedSecrets in the sidebar section `sealedSecrets` (shown only where the cluster serves the kind) and
// their details. Read-only: the kind offers the generic Edit and Delete only, under their usual confirmations.
import { registerDetailsSection } from "../../layout/details/registry";
import { registerResource } from "../../resources";
import { sealedSecretColumns } from "./columns";
import { appliesTo, SealedSecretsSection } from "./details";
import { isProblem, SEALED_SECRET } from "./model";

registerResource({
  kind: SEALED_SECRET,
  sidebar: { section: "sealedSecrets", order: 10, labelKey: "sealedsecrets:sidebar.sealedSecrets", icon: "sealedSecret" },
  columns: sealedSecretColumns,
  actions: ["edit", "delete"],
  namespaced: true,
  problem: isProblem,
});

// In place of the generic fields (20), before the conditions (30).
registerDetailsSection({ id: "sealedSecrets", order: 20, appliesTo, Component: SealedSecretsSection });
