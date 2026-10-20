// Kyverno (#213): the discovered sidebar section "Kyverno" — ClusterPolicies, Policies, PolicyReports,
// ClusterPolicyReports and Kyverno's ephemeral reports — with each policy's readiness and mode (Enforce / Audit, per
// rule since Kyverno 1.13) and each report's counts; a policy's details sum up its results over the reports that carry
// its label and list the objects that fail; and every object's details show its own policy results ("Policy results",
// read from the one report Kyverno names after the object's uid). Failing objects feed the problems screen, the
// notifications and the section counter only through the opt-in category `policies`. Read-only (ADR in docs/adr, #213).
import { registerSectionBadge } from "../../layout/sectionBadges";
import "../cert-manager/cert-manager.css";
import { useKyvernoProblemCount } from "./badge";
import "./register";

registerSectionBadge("kyverno", useKyvernoProblemCount, { tone: "danger", labelKey: "kyverno:badge" });
