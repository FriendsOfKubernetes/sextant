// TLS certificates of Secrets (#138, ADR-0069), with or without cert-manager: for any TLS Secret the details show the
// certificate (parsed by the backend from `tls.crt`; no Secret value reaches the window), and the Config section gets
// "TLS certificates": the TLS Secrets of the namespaces in view by expiry. "Expiring" means within
// `notifications.certExpiryDays` (Settings → Notifications, and on the TLS certificates page), the setting the problem
// rules of Sextant's own cert-manager extension (`extensions/cert-manager`) use for Certificates too.
//
// TLS Secrets feed no problems or notifications: judging them needs their `tls.crt`, which a watch never carries, so a
// background check would re-read every TLS Secret of every connected cluster — private keys included — on a timer.
// Their expiry is shown on demand instead (details, the TLS page).
import { registerDetailsSection } from "../../layout/details/registry";
import { registerPage } from "../../layout/pages";
import { TlsCertificatesPage } from "./TlsPage";
import { registerCertificateView } from "../../extensions/certificateView";
import { SecretCertificate, TlsCertificateSection } from "./TlsSection";
import "./tls.css";

export const TLS_PAGE_ID = "tlsCertificates";

// Any Secret that holds a certificate (the section draws nothing for other Secrets).
registerDetailsSection({
  id: "tlsCertificate",
  order: 22,
  appliesTo: (kind) => kind.group === "" && kind.kind === "Secret",
  Component: TlsCertificateSection,
});

// Extensions' `certificate` details sections draw this view of the Secret an object names (ADR-0167 amendment).
registerCertificateView(SecretCertificate);

registerPage({
  id: TLS_PAGE_ID,
  section: "config",
  order: 90,
  labelKey: "tls:page.sidebar",
  icon: "tlsCertificates",
  Component: TlsCertificatesPage,
});

export { holdsCertificate } from "./TlsSection";
export { ExpiryText } from "./ExpiryText";
export { useExpiryDays } from "./hooks";
export * from "./model";
