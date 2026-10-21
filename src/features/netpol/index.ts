// Network connectivity (#148): "can pod A reach pod B?" from the cluster's policies — Kubernetes NetworkPolicies and,
// as far as they map to L3/L4 rules, Cilium and Calico policies. Read-only and frontend-only: a pure engine
// (`engine.ts` over the normalised policies of `kubernetes.ts`, `cilium.ts`, `calico.ts`) and bounded, shared watches
// (`hooks.ts`). Sextant reasons from objects, not live traffic; the CNI must enforce NetworkPolicy.
//
// Registered here:
//  - the page "Connectivity" in the Network section (`ConnectivityPage.tsx`): the check and the per-namespace map;
//  - the details section "In plain words" of NetworkPolicies and the Cilium / Calico policy kinds;
//  - the details section "Network policies" of pods (isolation for ingress and egress, coverage, default deny);
//  - the namespace table's columns "Ingress isolated" and "Egress isolated" (#239, `coverageColumns.tsx`).
import { registerDetailsSection } from "../../layout/details/registry";
import { extendColumns } from "../../resources";
import "./ConnectivityPage";
import { COVERAGE_COLUMNS } from "./coverageColumns";
import { PodIsolationSection, PolicySection } from "./details";
import { isPolicyKind } from "./hooks";
import "./netpol.css";

// In place of the generic fields (20), before the conditions (30).
registerDetailsSection({ id: "netpolPolicy", order: 20, appliesTo: isPolicyKind, Component: PolicySection });

// After the pod's own fields (20), before the conditions (30).
registerDetailsSection({
  id: "netpolPodIsolation",
  order: 28,
  appliesTo: (kind) => kind.group === "" && kind.kind === "Pod",
  Component: PodIsolationSection,
});

// After the namespace's status.
extendColumns({ group: "", kind: "Namespace" }, COVERAGE_COLUMNS);

export { ConnectivityPage } from "./ConnectivityPage";
export { CONNECTIVITY_PAGE, openConnectivity } from "./state";
