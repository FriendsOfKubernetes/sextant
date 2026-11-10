// Sextant's own TLS certificate view, as extensions' `certificate` details sections draw it (ADR-0167 amendment):
// registered by the TLS feature (`src/features/tls/index.ts`), so the extension host imports no feature.
import type { ComponentType } from "react";
import type { ClusterId } from "../api";

export type CertificateView = ComponentType<{ clusterId: ClusterId; namespace: string; name: string }>;

let view: CertificateView | null = null;

/** The TLS feature's view of a Secret's certificate. */
export function registerCertificateView(next: CertificateView): void {
  view = next;
}

/** The registered view; `null` before the TLS feature registered it. */
export function certificateView(): CertificateView | null {
  return view;
}
