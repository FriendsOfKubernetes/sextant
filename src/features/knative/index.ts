// Knative Serving (#213): the discovered sidebar section "Knative" — Services, Configurations, Revisions, Routes and
// DomainMappings — with each object's state in words (ready / progressing / failed) and the failing condition's reason,
// details that explain why an object is not ready, the URL, the latest created and latest ready revisions and the
// traffic split with links to the revisions, and a Revision's replicas. Not-ready Services and Configurations of their
// own feed the problems screen, the notifications and the section counter (category `knative`): only the latest
// revision's failure counts, through them (`problemRules.ts`). Read-only (ADR in docs/adr, #213).
import { registerSectionBadge } from "../../layout/sectionBadges";
import "../cert-manager/cert-manager.css";
import { useKnativeProblemCount } from "./badge";
import "./register";

registerSectionBadge("knative", useKnativeProblemCount, { tone: "danger", labelKey: "knative:badge" });
