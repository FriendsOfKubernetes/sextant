// cert-manager and certificate expiry (#138): the sidebar section "cert-manager" — Certificates, CertificateRequests,
// Issuers, ClusterIssuers, Orders and Challenges with their Ready state and reasons, the chain Certificate →
// CertificateRequest → Order → Challenge in the details, and plain-language explanations of the common failures. The
// section shows only the kinds the cluster serves. For any TLS Secret, with or without cert-manager, the details show
// the certificate (parsed by the backend from `tls.crt`; no Secret value reaches the window), and the Config section
// gets "TLS certificates": the TLS Secrets of the namespaces in view by expiry. "Expiring" means within
// `notifications.certExpiryDays` (Settings → Notifications, and on the TLS certificates page).
//
// Expiring and failing cert-manager Certificates feed the problems screen and the notifications through the
// existing `certificates` category (src/features/problems/model.ts), by the same setting. TLS Secrets do not: judging them needs their
// `tls.crt`, which a watch never carries, so a background check would re-read every TLS Secret of every connected
// cluster — private keys included — on a timer. Their expiry is shown on demand instead (details, the TLS page).
//
// No "renew": cert-manager's renew (`cmctl renew`) sets the Issuing condition through the status subresource, which
// Sextant's patch does not reach, and deleting the Secret takes the certificate away until a new one is issued. The
// generic Edit and Delete stay, under their usual confirmations.
import { registerSectionBadge } from "../../layout/sectionBadges";
import { useCertificateProblemCount } from "./problems";
import "./cert-manager.css";
import "./register";

registerSectionBadge("certManager", useCertificateProblemCount, { tone: "danger", labelKey: "certmanager:badge" });

export * from "./model";
export { holdsCertificate } from "./TlsSection";
export { TLS_PAGE_ID } from "./register";
