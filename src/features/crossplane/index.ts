// Crossplane (#213): the discovered sidebar section "Crossplane" — the "Composite resources" page (every claim and
// composite of the kinds the XRDs define, with Synced / Ready and the first failing condition), XRDs, Compositions,
// Providers, Configurations and Functions — and details that explain each state and follow the chain Claim →
// composite → composed (managed) resources by the references Crossplane writes. Claims and composites that are not
// Synced or not Ready (other than being created or deleted) feed the problems screen, the notifications and the
// section counter (category `crossplane`, `provider.ts`). Read-only (ADR in docs/adr, #213).
import { registerSectionBadge } from "../../layout/sectionBadges";
import "../cert-manager/cert-manager.css";
import { useCrossplaneProblemCount } from "./badge";
import "./provider";
import "./register";

registerSectionBadge("crossplane", useCrossplaneProblemCount, { tone: "danger", labelKey: "crossplane:badge" });
