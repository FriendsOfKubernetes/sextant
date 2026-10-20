// Registers the Kyverno kinds in the discovered sidebar section `kyverno` (shown only for kinds the cluster serves):
// policies, wgpolicyk8s.io reports and Kyverno's reports.kyverno.io ephemeral reports, with their columns and the
// "Only problems" filter; their details; and the "Policy results" section of every other kind. Read-only: the kinds
// offer the generic Edit and Delete only.
import type { IconName } from "../../components";
import { registerDetailsSection } from "../../layout/details/registry";
import { registerResource } from "../../resources";
import { policyColumns, reportColumns } from "./columns";
import { appliesToObjectResults, KyvernoSection, PolicyResultsSection } from "./details";
import { isPolicyKind, isPolicyProblem, isReportProblem, KYVERNO_KINDS, kyvernoKind } from "./model";

for (const def of KYVERNO_KINDS) {
  const policy = isPolicyKind(def.kind);
  const icon: IconName = policy ? "kyvernoPolicy" : "kyvernoReport";
  registerResource({
    kind: def.kind,
    sidebar: { section: "kyverno", order: def.order, labelKey: `kyverno:sidebar.${def.label}`, icon },
    columns: policy ? policyColumns(def.namespaced) : reportColumns(def.kind, def.namespaced),
    actions: ["edit", "delete"],
    namespaced: def.namespaced,
    problem: policy ? isPolicyProblem : isReportProblem(def.kind),
  });
}

// In place of the generic fields (20), before the conditions (30).
registerDetailsSection({ id: "kyverno", order: 20, appliesTo: (kind) => kyvernoKind(kind) !== undefined, Component: KyvernoSection });

// After the kind's own fields and the conditions, before the YAML.
registerDetailsSection({ id: "kyvernoResults", order: 34, appliesTo: appliesToObjectResults, Component: PolicyResultsSection });
