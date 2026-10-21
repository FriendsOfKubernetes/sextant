// Knative Serving (#213): the discovered sidebar section "Knative" — Services, Configurations, Revisions, Routes and
// DomainMappings — with each object's state in words (ready / progressing / failed) and the failing condition's reason,
// details that explain why an object is not ready, the URL, the latest created and latest ready revisions and the
// traffic split with links to the revisions, and a Revision's replicas. Not-ready Services and Configurations of their
// own feed the problems screen, the notifications and the section counter (category `knative`): only the latest
// revision's failure counts, through them (`problemRules.ts`). Read-only (ADR in docs/adr, #213).
// Knative Eventing (#234): the discovered section "Knative Eventing" — Brokers, Triggers, Channels, Subscriptions,
// Sequences, Parallels and the sources — with the same states, details that explain a failure and show the event path
// (sources → Broker → Triggers → subscribers), and not-ready objects as problems of the same category.
import { registerSectionBadge } from "../../layout/sectionBadges";
import "../cert-manager/cert-manager.css";
import { useKnativeEventingProblemCount, useKnativeProblemCount } from "./badge";
import "./eventingRegister";
import "./register";

registerSectionBadge("knative", useKnativeProblemCount, { tone: "danger", labelKey: "knative:badge" });
registerSectionBadge("knativeEventing", useKnativeEventingProblemCount, { tone: "danger", labelKey: "knative:eventing.badge" });
