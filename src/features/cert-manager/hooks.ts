// Live data of the cert-manager views: the expiry warning setting, and the CertificateRequests, Orders and
// Challenges of one namespace for the chain in the details panel. A kind the cluster does not serve is never watched,
// nothing is watched before discovery, and every watch is of one namespace and ends with the component.
import { useSettings, useWatch, type ClusterId, type KindRef, type KubeObject, type WatchSpec } from "../../api";
import { findKind, useClusterKinds } from "../../resources";
import { CERTIFICATE_REQUEST, CHALLENGE, clampExpiryDays, DEFAULT_CERT_EXPIRY_DAYS, ORDER } from "./model";

/** Days before expiry a certificate shows as expiring (`notifications.certExpiryDays`). */
export function useExpiryDays(): number {
  const { settings } = useSettings();
  const value = settings?.notifications.certExpiryDays;
  return value === undefined ? DEFAULT_CERT_EXPIRY_DAYS : clampExpiryDays(value);
}

/** The version of `kind` the cluster serves; `null` when it does not; `undefined` while discovery is coming. */
function useServed(clusterId: ClusterId, kind: KindRef): KindRef | null | undefined {
  const kinds = useClusterKinds(clusterId);
  if (kinds.kinds) return findKind(kinds.kinds, kind)?.kindRef ?? null;
  return kinds.error ? null : undefined;
}

function inNamespace(kind: KindRef | null | undefined, namespace: string | null): WatchSpec | null {
  return kind && namespace ? { kind, namespaces: [namespace], labelSelector: null, fieldSelector: null } : null;
}

export interface ChainLists {
  requests: KubeObject[];
  orders: KubeObject[];
  challenges: KubeObject[];
  /** A list has not come yet. */
  loading: boolean;
  /** The cluster serves the ACME kinds (Orders, Challenges). */
  acme: boolean;
}

/** The CertificateRequests, Orders and Challenges of `namespace` (watched only while `namespace` is set). */
export function useChainLists(clusterId: ClusterId, namespace: string | null): ChainLists {
  const requestKind = useServed(clusterId, CERTIFICATE_REQUEST);
  const orderKind = useServed(clusterId, ORDER);
  const challengeKind = useServed(clusterId, CHALLENGE);
  const requests = useWatch(clusterId, inNamespace(requestKind, namespace));
  const orders = useWatch(clusterId, inNamespace(orderKind, namespace));
  const challenges = useWatch(clusterId, inNamespace(challengeKind, namespace));
  const pending = (kind: KindRef | null | undefined, status: string) => kind === undefined || (kind !== null && status === "loading");
  return {
    requests: [...requests.items.values()],
    orders: [...orders.items.values()],
    challenges: [...challenges.items.values()],
    loading: pending(requestKind, requests.status) || pending(orderKind, orders.status) || pending(challengeKind, challenges.status),
    acme: Boolean(orderKind),
  };
}
