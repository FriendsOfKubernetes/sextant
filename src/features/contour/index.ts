// Contour (#233): the discovered sidebar section "Contour" — HTTPProxies, TLSCertificateDelegations and
// ExtensionServices — with each proxy's state as Contour writes it (valid / invalid / orphaned / waiting for Contour)
// and its first error, details that explain a failure from the status (Contour's errors and warnings), the virtual
// host and TLS (a delegated Secret with the TLSCertificateDelegation that allows it), routes with conditions and
// services with their share or mirror percent, includes and the delegation tree, the policies attached to the host
// and each route; a traffic diagnosis that follows a proxy through its includes to Services and pods. Invalid and
// orphaned proxies feed the problems screen, the notifications and the section counter (category `contour`, never
// for agents). Read-only (ADR in docs/adr, #233).
import { registerSectionBadge } from "../../layout/sectionBadges";
import "../cert-manager/cert-manager.css";
import "./contour.css";
import { useContourProblemCount } from "./badge";
import "./register";

registerSectionBadge("contour", useContourProblemCount, { tone: "danger", labelKey: "contour:badge" });
