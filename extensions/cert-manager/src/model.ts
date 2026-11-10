// What the extension reads from cert-manager objects: the kinds it knows, their readiness, a Certificate's fields, the
// chain Certificate → CertificateRequest → Order → Challenge (by owner references, as cert-manager sets them),
// plain-language explanations of the common failures, and how close a certificate is to expiry. Pure functions; the
// texts are keys of `src/locales/<lang>.json` with their values. It is the former built-in view's model
// (src/features/cert-manager/model.ts, ADR-0069), ported unchanged, with the built-in problem detector of the
// `certificates` category (`certificateProblems`) and the tables' "Only problems" (`isProblem`) kept as the reference
// the manifest's rules, kinds and columns are tested against.
import type { KubeObject } from "@sextant/extension-sdk";

export type Tone = "success" | "warning" | "danger" | "neutral";

/** A value at a path of keys, as Sextant's `status.get` reads it (an array index as a key too). */
export function get(obj: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}
export const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
export const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
export const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const CERT_MANAGER_GROUP = "cert-manager.io";
export const ACME_GROUP = "acme.cert-manager.io";

export interface KindOf {
  group: string;
  version: string;
  kind: string;
}

const k = (group: string, version: string, kind: string): KindOf => ({ group, version, kind });

export const CERTIFICATE = k(CERT_MANAGER_GROUP, "v1", "Certificate");
export const CERTIFICATE_REQUEST = k(CERT_MANAGER_GROUP, "v1", "CertificateRequest");
export const ISSUER = k(CERT_MANAGER_GROUP, "v1", "Issuer");
export const CLUSTER_ISSUER = k(CERT_MANAGER_GROUP, "v1", "ClusterIssuer");
export const ORDER = k(ACME_GROUP, "v1", "Order");
export const CHALLENGE = k(ACME_GROUP, "v1", "Challenge");
export const SECRET = k("", "v1", "Secret");

/** One cert-manager kind and its sidebar entry. */
export interface CertManagerKind {
  kind: KindOf;
  order: number;
  /** Key under `sidebar.`. */
  label: string;
  /** The built-in sidebar icon. */
  icon: string;
  namespaced: boolean;
}

export const CERT_MANAGER_KINDS: CertManagerKind[] = [
  { kind: CERTIFICATE, order: 10, label: "certificates", icon: "certificate", namespaced: true },
  { kind: CERTIFICATE_REQUEST, order: 20, label: "certificateRequests", icon: "certificateRequest", namespaced: true },
  { kind: ISSUER, order: 30, label: "issuers", icon: "issuer", namespaced: true },
  { kind: CLUSTER_ISSUER, order: 31, label: "clusterIssuers", icon: "clusterIssuer", namespaced: false },
  { kind: ORDER, order: 40, label: "orders", icon: "acmeOrder", namespaced: true },
  { kind: CHALLENGE, order: 41, label: "challenges", icon: "acmeChallenge", namespaced: true },
];

export const isKind = (a: { group: string; kind: string }, ...of: { group: string; kind: string }[]): boolean =>
  of.some((b) => a.group === b.group && a.kind === b.kind);

/** The kind of an object by its `apiVersion` and `kind`. */
export function kindOfObject(obj: KubeObject): KindOf {
  const api = obj.apiVersion ?? "";
  const slash = api.lastIndexOf("/");
  return { group: slash < 0 ? "" : api.slice(0, slash), version: slash < 0 ? api : api.slice(slash + 1), kind: obj.kind ?? "" };
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
export const ACME_FAILED_STATES = ["invalid", "errored", "expired"] as const;
const ACME_FAILED = new Set<string>(ACME_FAILED_STATES);

export function acmeTone(state: string | undefined): Tone {
  if (state === "valid") return "success";
  if (state && ACME_FAILED.has(state)) return "danger";
  return "warning";
}

/** Ready=False reasons of a Certificate being issued for the first time or renewed, not of a failure. */
export const CERT_IN_PROGRESS_REASONS = ["DoesNotExist", "Issuing", "InProgress", "Pending", "MissingData"] as const;
const CERT_IN_PROGRESS = new Set<string>(CERT_IN_PROGRESS_REASONS);

/** cert-manager gave up the current issuance attempt (it retries later with a growing delay). */
export function issuanceFailed(cert: KubeObject): boolean {
  const issuing = conditionOf(cert, "Issuing");
  return issuing?.status === "False" && issuing.reason === "Failed";
}

/** Whether an object is in trouble (the tables' "Only problems" filter). */
export function isProblem(obj: KubeObject, kind: { group: string; kind: string }): boolean {
  if (isKind(kind, ORDER, CHALLENGE)) return ACME_FAILED.has(acmeState(obj) ?? "");
  if (isKind(kind, CERTIFICATE_REQUEST)) {
    return conditionOf(obj, "Denied")?.status === "True" || conditionOf(obj, "InvalidRequest")?.status === "True" || readyReason(obj) === "Failed";
  }
  if (isKind(kind, CERTIFICATE)) {
    return (readyStatus(obj) === "False" && !CERT_IN_PROGRESS.has(readyReason(obj) ?? "")) || issuanceFailed(obj);
  }
  return readyStatus(obj) === "False";
}

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
export const ISSUER_TYPES = ["acme", "ca", "selfSigned", "vault", "venafi"] as const;
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

// ---------- Expiry ----------

export const DAY_MS = 24 * 3600_000;
/**
 * Days before its `notAfter` a certificate is "expiring" by default: Sextant's `notifications.certExpiryDays` when it
 * sends none in the frame's context (`warnDaysOf` in details.ts).
 */
export const DEFAULT_CERT_EXPIRY_DAYS = 14;

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

/** A CertificateRequest's approval: Denied wins, then Approved=True; `pending` without either. */
export function approvalOf(o: KubeObject): "approved" | "denied" | "pending" {
  const conditions = arr(get(o, "status", "conditions"));
  const has = (type: string) => conditions.some((c) => get(c, "type") === type && get(c, "status") === "True");
  if (has("Denied")) return "denied";
  return has("Approved") ? "approved" : "pending";
}

export const APPROVAL_TONE = { approved: "success", denied: "danger", pending: "warning" } as const;

/**
 * The name of the Certificate at the top of the chain an object of `kind` is in: the object itself for a Certificate,
 * else up its owners through the lists given (an Order's request, a Challenge's order). `undefined`: not known.
 */
export function rootCertificateName(
  obj: KubeObject,
  kind: { group: string; kind: string },
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

/** A sentence Sextant writes: a key under `explain.` and its values. */
export interface Phrase {
  key: string;
  params?: Record<string, string | number>;
}

/** Ready=False reasons of a Certificate with a sentence of their own. */
export const CERT_READY_REASONS = [
  "DoesNotExist",
  "MissingData",
  "InvalidKeyPair",
  "InvalidCertificate",
  "Expired",
  "IncorrectIssuer",
  "SecretMismatch",
  "ManuallyTriggered",
  "Renewing",
] as const;
const CERT_READY = new Set<string>(CERT_READY_REASONS);

/** Why a Certificate is not ready, or what it is doing, in plain words; `undefined` for a ready one at rest. */
export function explainCertificate(cert: KubeObject): Phrase | undefined {
  const f = certificateFields(cert);
  const ready = conditionOf(cert, "Ready");
  const issuing = conditionOf(cert, "Issuing");
  if (issuing?.status === "False" && issuing.reason === "Failed") {
    return { key: "certificate.failed" };
  }
  if (issuing?.status === "True") return { key: "certificate.issuing", params: { revision: (f.revision ?? 0) + 1 } };
  if (ready?.status === "False" && ready.reason && CERT_READY.has(ready.reason)) {
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

export const REQUEST_REASONS = ["Pending", "Failed", "Issued", "Denied"] as const;
const REQUEST = new Set<string>(REQUEST_REASONS);

export function explainRequest(request: KubeObject): Phrase | undefined {
  if (conditionOf(request, "Denied")?.status === "True") return { key: "request.Denied" };
  if (conditionOf(request, "InvalidRequest")?.status === "True") return { key: "request.InvalidRequest" };
  if (conditionOf(request, "Approved") === undefined && readyStatus(request) !== "True") return { key: "request.notApproved" };
  const reason = readyReason(request);
  if (reason && REQUEST.has(reason) && reason !== "Issued") return { key: `request.${reason}` };
  return undefined;
}

export const ISSUER_REASONS = ["ErrRegisterACMEAccount", "ErrInitIssuer", "ErrGetKeyPair", "ErrInvalidKeyPair"] as const;
const ISSUER_REASON = new Set<string>(ISSUER_REASONS);

export function explainIssuer(issuer: KubeObject): Phrase | undefined {
  if (readyStatus(issuer) !== "False") return undefined;
  const reason = readyReason(issuer);
  if (reason && ISSUER_REASON.has(reason)) return { key: `issuer.${reason}` };
  return { key: "issuer.notReady" };
}

export const ORDER_STATES = ["pending", "ready", "processing", "invalid", "errored", "expired"] as const;
const ORDER_STATE = new Set<string>(ORDER_STATES);

export function explainOrder(order: KubeObject): Phrase | undefined {
  const state = acmeState(order);
  if (state && ORDER_STATE.has(state)) return { key: `order.${state}` };
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

// ---------- The built-in problems of the `certificates` category ----------

/** A problem as the built-in detector found it (src/features/problems/model.ts, `certificateProblems`). */
export interface Found {
  reason: string;
  group?: string;
  message?: string;
  /** A message Sextant wrote: `messages.expires` / `messages.expired` of its problems texts, with `{{date}}`. */
  messageKey?: "messages.expires" | "messages.expired";
  date?: string;
  since?: string;
  graceMs?: number;
  activeFrom?: number;
  until?: number;
  notify: boolean;
}

/** The built-in short grace (`SHORT_GRACE_MS`). */
export const SHORT_GRACE_MS = 2 * 60_000;

/** The problems of a Certificate as the built-in category `certificates` found them, warning `warnDays` ahead. */
export function certificateProblems(cert: KubeObject, warnDays = DEFAULT_CERT_EXPIRY_DAYS): Found[] {
  const found: Found[] = [];
  const ready = conditionOf(cert, "Ready");
  if (ready?.status === "False" && !CERT_IN_PROGRESS.has(ready.reason ?? "")) {
    found.push({
      reason: ready.reason ?? "NotReady",
      group: "notReady",
      message: ready.message,
      since: ready.lastTransitionTime,
      graceMs: SHORT_GRACE_MS,
      notify: true,
    });
  } else if (issuanceFailed(cert)) {
    // A first issuance that keeps failing stays Ready=False/DoesNotExist, a failing renewal Ready=True: the Issuing
    // condition (False, reason Failed) is what says so.
    const issuing = conditionOf(cert, "Issuing")!;
    found.push({
      reason: "IssuanceFailed",
      group: "notReady",
      message: issuing.message,
      since: issuing.lastTransitionTime,
      graceMs: SHORT_GRACE_MS,
      notify: true,
    });
  }
  const notAfterText = str(get(cert, "status", "notAfter"));
  const notAfter = notAfterText ? Date.parse(notAfterText) : NaN;
  if (!Number.isNaN(notAfter) && notAfterText) {
    found.push({
      reason: "Expiring",
      messageKey: "messages.expires",
      date: notAfterText,
      activeFrom: notAfter - warnDays * DAY_MS,
      until: notAfter,
      notify: true,
    });
    found.push({ reason: "Expired", messageKey: "messages.expired", date: notAfterText, activeFrom: notAfter, notify: true });
  }
  return found;
}
