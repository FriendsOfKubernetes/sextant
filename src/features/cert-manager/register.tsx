// Registers the cert-manager kinds in the sidebar section `certManager` (shown only for kinds the cluster serves),
// their details and the chain; the "Certificate" section of TLS Secrets; and the "TLS certificates" page of the Config
// section. Read-only: the kinds offer the generic Edit and Delete only (see index.ts on "renew").
import type { IconName } from "../../components";
import { registerDetailsSection } from "../../layout/details/registry";
import { registerPage } from "../../layout/pages";
import { registerResource, type ColumnDef } from "../../resources";
import { certificateColumns, challengeColumns, issuerColumns, orderColumns, requestColumns } from "./columns";
import { CertManagerSection, ChainSection, isChainKind } from "./details";
import {
  CERT_MANAGER_KINDS,
  CERTIFICATE,
  CERTIFICATE_REQUEST,
  certManagerKind,
  CHALLENGE,
  CLUSTER_ISSUER,
  isKind,
  isProblem,
  ISSUER,
  ORDER,
  type CertManagerKind,
} from "./model";
import { TlsCertificatesPage } from "./TlsPage";
import { TlsCertificateSection } from "./TlsSection";

export const TLS_PAGE_ID = "tlsCertificates";

/** Sidebar icon by the label of the kind in `CERT_MANAGER_KINDS`. */
const ICONS: Record<string, IconName> = {
  certificates: "certificate",
  certificateRequests: "certificateRequest",
  issuers: "issuer",
  clusterIssuers: "clusterIssuer",
  orders: "acmeOrder",
  challenges: "acmeChallenge",
};

function columnsOf({ kind, namespaced }: CertManagerKind): ColumnDef[] {
  if (isKind(kind, CERTIFICATE)) return certificateColumns;
  if (isKind(kind, CERTIFICATE_REQUEST)) return requestColumns;
  if (isKind(kind, ISSUER, CLUSTER_ISSUER)) return issuerColumns(namespaced);
  if (isKind(kind, ORDER)) return orderColumns;
  if (isKind(kind, CHALLENGE)) return challengeColumns;
  return [];
}

for (const def of CERT_MANAGER_KINDS) {
  registerResource({
    kind: def.kind,
    sidebar: { section: "certManager", order: def.order, labelKey: `certmanager:sidebar.${def.label}`, icon: ICONS[def.label] },
    columns: columnsOf(def),
    actions: ["edit", "delete"],
    namespaced: def.namespaced,
    problem: (obj) => isProblem(obj, def.kind),
  });
}

// In place of the generic fields (20), before the conditions (30).
registerDetailsSection({
  id: "certManager",
  order: 20,
  appliesTo: (kind) => certManagerKind(kind) !== undefined,
  Component: CertManagerSection,
});

// The chain, after the kind's fields and before the conditions.
registerDetailsSection({ id: "certManagerChain", order: 24, appliesTo: isChainKind, Component: ChainSection });

// Any Secret that holds a certificate (the section draws nothing for other Secrets).
registerDetailsSection({
  id: "tlsCertificate",
  order: 22,
  appliesTo: (kind) => kind.group === "" && kind.kind === "Secret",
  Component: TlsCertificateSection,
});

registerPage({
  id: TLS_PAGE_ID,
  section: "config",
  order: 90,
  labelKey: "certmanager:tlsPage.sidebar",
  icon: "tlsCertificates",
  Component: TlsCertificatesPage,
});
