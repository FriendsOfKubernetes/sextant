// What the cert-manager section reads from cert-manager objects: the kinds it knows, their readiness, a Certificate's
// fields, the chain Certificate → CertificateRequest → Order → Challenge (by owner references, as cert-manager sets
// them), plain-language explanations of the common failures, and how close a certificate is to expiry. Pure
// functions, no React; the texts are i18n keys under `certmanager:` with their values.
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import type { Tone } from "../../resources/status";
import { issuanceFailed } from "../problems/model";

const { arr, get, num, str } = status;

export const CERT_MANAGER_GROUP = "cert-manager.io";
export const ACME_GROUP = "acme.cert-manager.io";

const k = (group: string, version: string, kind: string): KindRef => ({ group, version, kind });

export const CERTIFICATE = k(CERT_MANAGER_GROUP, "v1", "Certificate");
export const CERTIFICATE_REQUEST = k(CERT_MANAGER_GROUP, "v1", "CertificateRequest");
export const ISSUER = k(CERT_MANAGER_GROUP, "v1", "Issuer");
export const CLUSTER_ISSUER = k(CERT_MANAGER_GROUP, "v1", "ClusterIssuer");
export const ORDER = k(ACME_GROUP, "v1", "Order");
export const CHALLENGE = k(ACME_GROUP, "v1", "Challenge");

/** One cert-manager kind and its sidebar entry. */
export interface CertManagerKind {
  kind: KindRef;
  order: number;
  /** Key under `certmanager:sidebar`. */
  label: string;
  namespaced: boolean;
}

export const CERT_MANAGER_KINDS: CertManagerKind[] = [
  { kind: CERTIFICATE, order: 10, label: "certificates", namespaced: true },
  { kind: CERTIFICATE_REQUEST, order: 20, label: "certificateRequests", namespaced: true },
  { kind: ISSUER, order: 30, label: "issuers", namespaced: true },
  { kind: CLUSTER_ISSUER, order: 31, label: "clusterIssuers", namespaced: false },
  { kind: ORDER, order: 40, label: "orders", namespaced: true },
  { kind: CHALLENGE, order: 41, label: "challenges", namespaced: true },
];

export const isKind = (a: Pick<KindRef, "group" | "kind">, ...of: Pick<KindRef, "group" | "kind">[]): boolean =>
  of.some((b) => a.group === b.group && a.kind === b.kind);

/** The registered kind of `kind`, if it is one of cert-manager's. */
export function certManagerKind(kind: Pick<KindRef, "group" | "kind">): CertManagerKind | undefined {
  return CERT_MANAGER_KINDS.find((d) => isKind(kind, d.kind));
}

// ---------- Conditions ----------

export interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export function conditionOf(obj: KubeObject, type: string): Condition | undefined {
  const c = arr(get(obj, "status", "conditions")).find((x) => get(x, "type") === type);
  if (!c) return undefined;
  return {
    type,
    status: str(get(c, "status")) ?? "Unknown",
    reason: str(get(c, "reason")),
    message: str(get(c, "message")),
    lastTransitionTime: str(get(c, "lastTransitionTime")),
  };
}

/** `True` / `False` / `Unknown` of the Ready condition; `undefined` without one. */
export const readyStatus = (obj: KubeObject): string | undefined => conditionOf(obj, "Ready")?.status;
export const readyReason = (obj: KubeObject): string | undefined => conditionOf(obj, "Ready")?.reason;
export const readyMessage = (obj: KubeObject): string | undefined => conditionOf(obj, "Ready")?.message;

export function readyTone(value: string | undefined): Tone {
  if (value === "True") return "success";
  if (value === "False") return "danger";
  return "warning";
}

/** The ACME `status.state` of an Order or a Challenge (`valid`, `pending`, `invalid`, …). */
export const acmeState = (obj: KubeObject): string | undefined => str(get(obj, "status", "state"));
export const acmeReason = (obj: KubeObject): string | undefined => str(get(obj, "status", "reason"));

/** Final failures of ACME objects. */
const ACME_FAILED = new Set(["invalid", "errored", "expired"]);

export function acmeTone(state: string | undefined): Tone {
  if (state === "valid") return "success";
  if (state && ACME_FAILED.has(state)) return "danger";
  return "warning";
}

/** Whether an object is in trouble (the tables' "Only problems" filter). */
export function isProblem(obj: KubeObject, kind: Pick<KindRef, "group" | "kind">): boolean {
  if (isKind(kind, ORDER, CHALLENGE)) return ACME_FAILED.has(acmeState(obj) ?? "");
  if (isKind(kind, CERTIFICATE_REQUEST)) {
    return conditionOf(obj, "Denied")?.status === "True" || conditionOf(obj, "InvalidRequest")?.status === "True" || readyReason(obj) === "Failed";
  }
  if (isKind(kind, CERTIFICATE)) {
    return (readyStatus(obj) === "False" && !CERT_IN_PROGRESS.has(readyReason(obj) ?? "")) || issuanceFailed(obj);
  }
  return readyStatus(obj) === "False";
}

/** Ready=False reasons of a Certificate being issued for the first time or renewed, not of a failure. */
const CERT_IN_PROGRESS = new Set(["DoesNotExist", "Issuing", "InProgress", "Pending", "MissingData"]);

// ---------- Issuers ----------

export interface IssuerRef {
  name: string;
  kind: string;
  group: string;
}

/** `spec.issuerRef` of a Certificate, CertificateRequest, Order or Challenge. */
export function issuerRefOf(obj: KubeObject): IssuerRef | undefined {
  const name = str(get(obj, "spec", "issuerRef", "name"));
  if (!name) return undefined;
  return {
    name,
    // Empty or missing: cert-manager's defaults.
    kind: str(get(obj, "spec", "issuerRef", "kind")) || "Issuer",
    group: str(get(obj, "spec", "issuerRef", "group")) || CERT_MANAGER_GROUP,
  };
}

/** `Kind/name` of an issuer reference (`ClusterIssuer/letsencrypt`). */
export const issuerText = (ref: IssuerRef | undefined): string | undefined => (ref ? `${ref.kind}/${ref.name}` : undefined);

/** The issuer types cert-manager has built in; an external issuer (another group) is none of them. */
const ISSUER_TYPES = ["acme", "ca", "selfSigned", "vault", "venafi"] as const;
export type IssuerType = (typeof ISSUER_TYPES)[number];

/** Which built-in issuer an Issuer or ClusterIssuer is. */
export function issuerType(obj: KubeObject): IssuerType | undefined {
  return ISSUER_TYPES.find((type) => get(obj, "spec", type) !== undefined);
}

// ---------- Certificates ----------

export interface CertificateFields {
  secretName?: string;
  commonName?: string;
  dnsNames: string[];
  ipAddresses: string[];
  uris: string[];
  emailAddresses: string[];
  duration?: string;
  renewBefore?: string;
  notBefore?: string;
  notAfter?: string;
  renewalTime?: string;
  revision?: number;
  lastFailureTime?: string;
  failedIssuanceAttempts?: number;
  keyAlgorithm?: string;
  keySize?: number;
  rotationPolicy?: string;
  isCA: boolean;
}

const strings = (value: unknown): string[] => arr(value).filter((v): v is string => typeof v === "string");

export function certificateFields(cert: KubeObject): CertificateFields {
  return {
    secretName: str(get(cert, "spec", "secretName")),
    commonName: str(get(cert, "spec", "commonName")),
    dnsNames: strings(get(cert, "spec", "dnsNames")),
    ipAddresses: strings(get(cert, "spec", "ipAddresses")),
    uris: strings(get(cert, "spec", "uris")),
    emailAddresses: strings(get(cert, "spec", "emailAddresses")),
    duration: str(get(cert, "spec", "duration")),
    renewBefore: str(get(cert, "spec", "renewBefore")),
    notBefore: str(get(cert, "status", "notBefore")),
    notAfter: str(get(cert, "status", "notAfter")),
    renewalTime: str(get(cert, "status", "renewalTime")),
    revision: num(get(cert, "status", "revision")),
    lastFailureTime: str(get(cert, "status", "lastFailureTime")),
    failedIssuanceAttempts: num(get(cert, "status", "failedIssuanceAttempts")),
    keyAlgorithm: str(get(cert, "spec", "privateKey", "algorithm")),
    keySize: num(get(cert, "spec", "privateKey", "size")),
    rotationPolicy: str(get(cert, "spec", "privateKey", "rotationPolicy")),
    isCA: get(cert, "spec", "isCA") === true,
  };
}

/** The names a Certificate asks for: the common name, then the DNS names (without repeats). */
export function requestedNames(cert: KubeObject): string[] {
  const f = certificateFields(cert);
  return [...new Set([f.commonName, ...f.dnsNames, ...f.ipAddresses, ...f.uris, ...f.emailAddresses].filter((v): v is string => Boolean(v)))];
}

// ---------- Expiry ----------

export const DAY_MS = 24 * 3600_000;
// The expiry warning setting's bounds and default are the problems rules' (one source for both).
export { clampExpiryDays, DEFAULT_CERT_EXPIRY_DAYS, MAX_CERT_EXPIRY_DAYS, MIN_CERT_EXPIRY_DAYS } from "../problems/model";

export type ExpiryState = "expired" | "expiring" | "valid" | "notYetValid";

export interface Expiry {
  state: ExpiryState;
  /** Whole days until `notAfter` (rounded down; negative once expired). */
  daysLeft: number;
}

/** How a certificate valid `notBefore`..`notAfter` stands at `now`, warning `warnDays` ahead. */
export function expiryOf(notAfter: string | undefined, now: number, warnDays: number, notBefore?: string): Expiry | undefined {
  const end = notAfter ? Date.parse(notAfter) : NaN;
  if (Number.isNaN(end)) return undefined;
  const left = end - now;
  const daysLeft = Math.floor(left / DAY_MS);
  if (left <= 0) return { state: "expired", daysLeft };
  const start = notBefore ? Date.parse(notBefore) : NaN;
  if (!Number.isNaN(start) && now < start) return { state: "notYetValid", daysLeft };
  if (left <= warnDays * DAY_MS) return { state: "expiring", daysLeft };
  return { state: "valid", daysLeft };
}

export const EXPIRY_TONE: Record<ExpiryState, Tone> = {
  expired: "danger",
  expiring: "warning",
  notYetValid: "warning",
  valid: "success",
};

// ---------- The chain ----------

interface Owner {
  kind: string;
  name: string;
  uid?: string;
}

function ownersOf(obj: KubeObject): Owner[] {
  return arr(get(obj, "metadata", "ownerReferences")).flatMap((o) => {
    const kind = str(get(o, "kind"));
    const name = str(get(o, "name"));
    return kind && name ? [{ kind, name, uid: str(get(o, "uid")) }] : [];
  });
}

const sameNamespace = (a: KubeObject, b: KubeObject) => (a.metadata?.namespace ?? "") === (b.metadata?.namespace ?? "");

/** Whether `child` is owned by `parent` (by uid when both have one, else by kind and name). */
function ownedBy(child: KubeObject, parent: KubeObject, parentKind: string): boolean {
  if (!sameNamespace(child, parent)) return false;
  const uid = parent.metadata?.uid;
  return ownersOf(child).some((o) => o.kind === parentKind && (uid && o.uid ? o.uid === uid : o.name === parent.metadata?.name));
}

/** cert-manager's annotations on a CertificateRequest. */
export const CERTIFICATE_NAME_ANNOTATION = "cert-manager.io/certificate-name";
export const CERTIFICATE_REVISION_ANNOTATION = "cert-manager.io/certificate-revision";

/** An annotation of an object. */
export const annotationOf = (obj: KubeObject, key: string): string | undefined => str(get(obj, "metadata", "annotations", key));

export function revisionOf(request: KubeObject): number | undefined {
  const value = Number(annotationOf(request, CERTIFICATE_REVISION_ANNOTATION));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

const created = (o: KubeObject) => {
  const t = Date.parse(String(o.metadata?.creationTimestamp ?? ""));
  return Number.isNaN(t) ? 0 : t;
};

/** Newest first: by revision, then by creation. */
function newestFirst(a: KubeObject, b: KubeObject): number {
  return (revisionOf(b) ?? 0) - (revisionOf(a) ?? 0) || created(b) - created(a);
}

/** The CertificateRequests of a Certificate, newest first. */
export function requestsOf(cert: KubeObject, requests: Iterable<KubeObject>): KubeObject[] {
  const name = cert.metadata?.name;
  return [...requests]
    .filter(
      (r) =>
        ownedBy(r, cert, "Certificate") ||
        (sameNamespace(r, cert) && name !== undefined && annotationOf(r, CERTIFICATE_NAME_ANNOTATION) === name),
    )
    .sort(newestFirst);
}

/** The Orders of a CertificateRequest, newest first. */
export function ordersOf(request: KubeObject, orders: Iterable<KubeObject>): KubeObject[] {
  return [...orders].filter((o) => ownedBy(o, request, "CertificateRequest")).sort((a, b) => created(b) - created(a));
}

/** The Challenges of an Order. */
export function challengesOf(order: KubeObject, challenges: Iterable<KubeObject>): KubeObject[] {
  return [...challenges]
    .filter((c) => ownedBy(c, order, "Order"))
    .sort((a, b) => (str(get(a, "spec", "dnsName")) ?? "").localeCompare(str(get(b, "spec", "dnsName")) ?? ""));
}

/** The owner of `kind` of an object, by name. */
export function ownerName(obj: KubeObject, kind: string): string | undefined {
  return ownersOf(obj).find((o) => o.kind === kind)?.name;
}

/** The Certificate a CertificateRequest belongs to: its owner, else cert-manager's annotation. */
export function certificateNameOf(request: KubeObject): string | undefined {
  return ownerName(request, "Certificate") ?? annotationOf(request, CERTIFICATE_NAME_ANNOTATION);
}

/**
 * The name of the Certificate at the top of the chain an object of `kind` is in: the object itself for a Certificate,
 * else up its owners through the lists given (an Order's request, a Challenge's order). `undefined`: not known.
 */
export function rootCertificateName(
  obj: KubeObject,
  kind: Pick<KindRef, "group" | "kind">,
  requests: Iterable<KubeObject>,
  orders: Iterable<KubeObject>,
): string | undefined {
  const find = (list: Iterable<KubeObject>, name: string | undefined) =>
    name === undefined ? undefined : [...list].find((o) => o.metadata?.name === name && sameNamespace(o, obj));
  if (isKind(kind, CERTIFICATE)) return obj.metadata?.name;
  if (isKind(kind, CERTIFICATE_REQUEST)) return certificateNameOf(obj);
  if (isKind(kind, ORDER)) {
    const request = find(requests, ownerName(obj, "CertificateRequest"));
    return request ? certificateNameOf(request) : undefined;
  }
  if (isKind(kind, CHALLENGE)) {
    const order = find(orders, ownerName(obj, "Order"));
    const request = order ? find(requests, ownerName(order, "CertificateRequest")) : undefined;
    return request ? certificateNameOf(request) : undefined;
  }
  return undefined;
}

// ---------- Plain words ----------

/** A sentence Sextant writes: a key under `certmanager:explain` and its values. */
export interface Phrase {
  key: string;
  params?: Record<string, string | number>;
}

/** Ready=False reasons of a Certificate with a sentence of their own. */
const CERT_READY_REASONS = new Set([
  "DoesNotExist",
  "MissingData",
  "InvalidKeyPair",
  "InvalidCertificate",
  "Expired",
  "IncorrectIssuer",
  "SecretMismatch",
  "ManuallyTriggered",
  "Renewing",
]);

/** Why a Certificate is not ready, or what it is doing, in plain words; `undefined` for a ready one at rest. */
export function explainCertificate(cert: KubeObject): Phrase | undefined {
  const f = certificateFields(cert);
  const ready = conditionOf(cert, "Ready");
  const issuing = conditionOf(cert, "Issuing");
  if (issuing?.status === "False" && issuing.reason === "Failed") {
    return { key: "certificate.failed" };
  }
  if (issuing?.status === "True") return { key: "certificate.issuing", params: { revision: (f.revision ?? 0) + 1 } };
  if (ready?.status === "False" && ready.reason && CERT_READY_REASONS.has(ready.reason)) {
    return { key: `certificate.${ready.reason}`, params: { secret: f.secretName ?? "" } };
  }
  if (ready?.status === "False") return { key: "certificate.notReady" };
  return undefined;
}

/** The last failed issuance of a Certificate: when, how many attempts, and the message cert-manager left. */
export function lastFailure(cert: KubeObject): { time: string; attempts?: number; message?: string } | undefined {
  const f = certificateFields(cert);
  if (!f.lastFailureTime) return undefined;
  const issuing = conditionOf(cert, "Issuing");
  const message = issuing?.status === "False" && issuing.reason === "Failed" ? issuing.message : undefined;
  return { time: f.lastFailureTime, attempts: f.failedIssuanceAttempts, message };
}

const REQUEST_REASONS = new Set(["Pending", "Failed", "Issued", "Denied"]);

export function explainRequest(request: KubeObject): Phrase | undefined {
  if (conditionOf(request, "Denied")?.status === "True") return { key: "request.Denied" };
  if (conditionOf(request, "InvalidRequest")?.status === "True") return { key: "request.InvalidRequest" };
  if (conditionOf(request, "Approved") === undefined && readyStatus(request) !== "True") return { key: "request.notApproved" };
  const reason = readyReason(request);
  if (reason && REQUEST_REASONS.has(reason) && reason !== "Issued") return { key: `request.${reason}` };
  return undefined;
}

const ISSUER_REASONS = new Set(["ErrRegisterACMEAccount", "ErrInitIssuer", "ErrGetKeyPair", "ErrInvalidKeyPair"]);

export function explainIssuer(issuer: KubeObject): Phrase | undefined {
  if (readyStatus(issuer) !== "False") return undefined;
  const reason = readyReason(issuer);
  if (reason && ISSUER_REASONS.has(reason)) return { key: `issuer.${reason}` };
  return { key: "issuer.notReady" };
}

const ORDER_STATES = new Set(["pending", "ready", "processing", "invalid", "errored", "expired"]);

export function explainOrder(order: KubeObject): Phrase | undefined {
  const state = acmeState(order);
  if (state && ORDER_STATES.has(state)) return { key: `order.${state}` };
  return undefined;
}

/**
 * A Challenge that is not valid, in plain words: what the ACME server or cert-manager's self-check saw (the HTTP-01
 * answer, the DNS-01 record), from `status.reason`.
 */
export function explainChallenge(challenge: KubeObject): Phrase | undefined {
  const state = acmeState(challenge);
  if (state === "valid") return undefined;
  const reason = acmeReason(challenge) ?? "";
  const domain = str(get(challenge, "spec", "dnsName")) ?? "";
  const http = /wrong status code '(\d+)'/.exec(reason);
  if (http) return { key: "challenge.httpStatus", params: { domain, code: http[1] ?? "" } };
  if (/no such host|NXDOMAIN|could not resolve/i.test(reason)) return { key: "challenge.noHost", params: { domain } };
  if (/connection refused|i\/o timeout|timeout/i.test(reason)) return { key: "challenge.unreachable", params: { domain } };
  if (/propagation|TXT record/i.test(reason)) return { key: "challenge.dnsPropagation", params: { domain } };
  if (state === "invalid" || state === "errored" || state === "expired") return { key: `challenge.${state}`, params: { domain } };
  if (get(challenge, "status", "presented") === true) return { key: "challenge.presented", params: { domain } };
  return { key: "challenge.pending", params: { domain } };
}

/** `HTTP-01` / `DNS-01` of a Challenge. */
export function challengeType(challenge: KubeObject): string | undefined {
  return str(get(challenge, "spec", "type"));
}
