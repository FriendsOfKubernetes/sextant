// Details of cert-manager objects: one section (`certManager`) for every kind of the section, and the chain
// Certificate → CertificateRequest → Order → Challenge (`certManagerChain`) for the four kinds that form it.
//   Certificate        — the plain-language state, Secret and issuer links, the names asked for, validity with days
//                        left (by the expiry warning setting), renewal time, key, revision and the last failure;
//   CertificateRequest — approval, readiness in plain words, its Certificate and issuer;
//   Issuer/ClusterIssuer — type, readiness in plain words, the ACME server and account, the CA Secret;
//   Order / Challenge  — ACME state and reason in plain words, names, solver.
// Conditions and YAML are the panel's own sections. Read-only.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KindRef, KubeObject } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { status, StatusText } from "../../resources";
import { Block, chips, Fields, KINDS, link, type FieldRow } from "../details";
import { formatDateTime } from "../../i18n";
import { approvalOf } from "./columns";
import { useChainLists, useExpiryDays } from "./hooks";
import {
  ACME_GROUP,
  acmeReason,
  acmeState,
  acmeTone,
  CERT_MANAGER_GROUP,
  CERTIFICATE,
  CERTIFICATE_REQUEST,
  certificateFields,
  certificateNameOf,
  CHALLENGE,
  challengesOf,
  challengeType,
  CLUSTER_ISSUER,
  EXPIRY_TONE,
  expiryOf,
  explainCertificate,
  explainChallenge,
  explainIssuer,
  explainOrder,
  explainRequest,
  isKind,
  ISSUER,
  issuerRefOf,
  issuerType,
  lastFailure,
  ORDER,
  ordersOf,
  ownerName,
  readyReason,
  readyStatus,
  readyTone,
  requestsOf,
  revisionOf,
  rootCertificateName,
  type IssuerRef,
  type Phrase,
} from "./model";
import { useNow } from "../problems/hooks";

const { arr, get, str } = status;

const LABELS = "certmanager:fields";
const CM_API = `${CERT_MANAGER_GROUP}/v1`;
const ACME_API = `${ACME_GROUP}/v1`;
/** Newest CertificateRequests shown in the chain. */
export const CHAIN_REQUESTS = 3;

const typeRef = (kind: KindRef) => ({ apiVersion: kind.group === ACME_GROUP ? ACME_API : CM_API, kind: kind.kind });

function Explanation({ phrase }: { phrase: Phrase | undefined }) {
  const { t } = useTranslation();
  if (!phrase) return null;
  return <p className="cm-explain">{t(`certmanager:explain.${phrase.key}`, phrase.params ?? {})}</p>;
}

function ReadyText({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const value = readyStatus(obj);
  if (!value) return null;
  const reason = readyReason(obj);
  const text = reason ? t("certmanager:readyWithReason", { status: value, reason }) : value;
  return <StatusText value={text} tone={readyTone(value)} />;
}

const date = (value: string | undefined): ReactNode => (value ? <time dateTime={value}>{formatDateTime(value)}</time> : null);

/** A link to the issuer a reference names; an external issuer (another group) as text. */
function issuerLink(ref: IssuerRef | undefined, namespace: string | null, external: (ref: IssuerRef) => string): ReactNode {
  if (!ref) return null;
  if (ref.group !== CERT_MANAGER_GROUP) return external(ref);
  const kind = ref.kind === "ClusterIssuer" ? CLUSTER_ISSUER : ISSUER;
  return link(typeRef(kind), ref.name, kind === ISSUER ? namespace : null, `${kind.kind}/${ref.name}`);
}

/** How an issuer of another group (an external issuer) is shown. */
function useExternalIssuerText(): (ref: IssuerRef) => string {
  const { t } = useTranslation();
  return (ref) => t("certmanager:externalIssuer", { kind: ref.kind, name: ref.name, group: ref.group });
}

/** Expiry of a certificate, colored by the warning setting. */
export function ExpiryText({ notAfter, notBefore }: { notAfter: string | undefined; notBefore?: string }) {
  const { t } = useTranslation();
  const days = useExpiryDays();
  const now = useNow(60_000);
  const expiry = expiryOf(notAfter, now, days, notBefore);
  if (!notAfter || !expiry) return null;
  const text =
    expiry.state === "expired"
      ? t("certmanager:expiry.expiredOn", { date: formatDateTime(notAfter) })
      : expiry.state === "notYetValid"
        ? t("certmanager:expiry.notYetValid", { date: formatDateTime(notBefore ?? notAfter) })
        : t("certmanager:expiry.until", { date: formatDateTime(notAfter), count: expiry.daysLeft });
  return <StatusText value={text} tone={EXPIRY_TONE[expiry.state]} />;
}

function CertificateView({ obj }: { obj: KubeObject }) {
  const external = useExternalIssuerText();
  const { t } = useTranslation();
  const f = certificateFields(obj);
  const ns = obj.metadata?.namespace ?? null;
  const failure = lastFailure(obj);
  const key = [f.keyAlgorithm, f.keySize ? String(f.keySize) : undefined].filter(Boolean).join(" ");
  const rows: FieldRow[] = [
    ["ready", <ReadyText key="r" obj={obj} />],
    ["secret", link(KINDS.secret, f.secretName, ns)],
    ["issuer", issuerLink(issuerRefOf(obj), ns, external)],
    ["commonName", f.commonName],
    ["dnsNames", chips(f.dnsNames)],
    ["ipAddresses", chips(f.ipAddresses)],
    ["uris", chips(f.uris)],
    ["emailAddresses", chips(f.emailAddresses)],
    ["notBefore", date(f.notBefore)],
    ["notAfter", <ExpiryText key="e" notAfter={f.notAfter} notBefore={f.notBefore} />],
    ["renewalTime", date(f.renewalTime)],
    ["duration", f.duration],
    ["renewBefore", f.renewBefore],
    ["privateKey", key || undefined],
    ["rotationPolicy", f.rotationPolicy],
    ["isCA", f.isCA ? t("certmanager:yes") : undefined],
    ["revision", f.revision === undefined ? undefined : String(f.revision)],
  ];
  return (
    <>
      <Explanation phrase={explainCertificate(obj)} />
      <Fields rows={rows} labelPrefix={LABELS} />
      {failure && (
        <Block title={t("certmanager:lastFailure.title")}>
          <p className="cm-explain cm-explain--danger">
            {failure.attempts
              ? t("certmanager:lastFailure.withAttempts", { date: formatDateTime(failure.time), count: failure.attempts })
              : t("certmanager:lastFailure.at", { date: formatDateTime(failure.time) })}
          </p>
          {failure.message && <p className="cm-message">{failure.message}</p>}
        </Block>
      )}
    </>
  );
}

function RequestView({ obj }: { obj: KubeObject }) {
  const external = useExternalIssuerText();
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const approval = approvalOf(obj);
  const rows: FieldRow[] = [
    [
      "approval",
      <StatusText
        key="a"
        value={t(`certmanager:approval.${approval}`)}
        tone={approval === "approved" ? "success" : approval === "denied" ? "danger" : "warning"}
      />,
    ],
    ["ready", <ReadyText key="r" obj={obj} />],
    ["certificate", link(typeRef(CERTIFICATE), certificateNameOf(obj), ns)],
    ["issuer", issuerLink(issuerRefOf(obj), ns, external)],
    ["revision", revisionOf(obj) === undefined ? undefined : String(revisionOf(obj))],
    ["failureTime", date(str(get(obj, "status", "failureTime")))],
  ];
  return (
    <>
      <Explanation phrase={explainRequest(obj)} />
      <Fields rows={rows} labelPrefix={LABELS} />
    </>
  );
}

function IssuerView({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const type = issuerType(obj);
  const solvers = arr(get(obj, "spec", "acme", "solvers")).map((s) =>
    get(s, "http01") !== undefined ? "HTTP-01" : get(s, "dns01") !== undefined ? "DNS-01" : undefined,
  );
  // A ClusterIssuer's CA Secret is in cert-manager's cluster resource namespace, which Sextant does not know.
  const caSecret = str(get(obj, "spec", "ca", "secretName"));
  const rows: FieldRow[] = [
    ["ready", <ReadyText key="r" obj={obj} />],
    ["issuerType", type ? t(`certmanager:issuerTypes.${type}`) : undefined],
    ["acmeServer", str(get(obj, "spec", "acme", "server"))],
    ["acmeEmail", str(get(obj, "spec", "acme", "email"))],
    ["acmeAccount", str(get(obj, "status", "acme", "uri"))],
    ["solvers", chips([...new Set(solvers)])],
    ["caSecret", ns ? link(KINDS.secret, caSecret, ns) : caSecret],
    ["vaultServer", str(get(obj, "spec", "vault", "server"))],
    ["vaultPath", str(get(obj, "spec", "vault", "path"))],
  ];
  return (
    <>
      <Explanation phrase={explainIssuer(obj)} />
      <Fields rows={rows} labelPrefix={LABELS} />
    </>
  );
}

function AcmeState({ obj }: { obj: KubeObject }) {
  const state = acmeState(obj);
  return state ? <StatusText value={state} tone={acmeTone(state)} /> : null;
}

function OrderView({ obj }: { obj: KubeObject }) {
  const external = useExternalIssuerText();
  const ns = obj.metadata?.namespace ?? null;
  const rows: FieldRow[] = [
    ["state", <AcmeState key="s" obj={obj} />],
    ["acmeReason", acmeReason(obj)],
    ["request", link(typeRef(CERTIFICATE_REQUEST), ownerName(obj, "CertificateRequest"), ns)],
    ["issuer", issuerLink(issuerRefOf(obj), ns, external)],
    ["commonName", str(get(obj, "spec", "commonName"))],
    ["dnsNames", chips(arr(get(obj, "spec", "dnsNames")).map((v) => str(v)))],
    ["orderUrl", str(get(obj, "status", "url"))],
    ["failureTime", date(str(get(obj, "status", "failureTime")))],
  ];
  return (
    <>
      <Explanation phrase={explainOrder(obj)} />
      <Fields rows={rows} labelPrefix={LABELS} />
    </>
  );
}

function ChallengeView({ obj }: { obj: KubeObject }) {
  const external = useExternalIssuerText();
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const rows: FieldRow[] = [
    ["state", <AcmeState key="s" obj={obj} />],
    ["domain", str(get(obj, "spec", "dnsName"))],
    ["challengeType", challengeType(obj)],
    ["wildcard", get(obj, "spec", "wildcard") === true ? t("certmanager:yes") : undefined],
    ["presented", get(obj, "status", "presented") === true ? t("certmanager:yes") : undefined],
    ["acmeReason", acmeReason(obj)],
    ["order", link(typeRef(ORDER), ownerName(obj, "Order"), ns)],
    ["issuer", issuerLink(issuerRefOf(obj), ns, external)],
  ];
  return (
    <>
      <Explanation phrase={explainChallenge(obj)} />
      <Fields rows={rows} labelPrefix={LABELS} />
    </>
  );
}

/** The `certManager` details section. */
export function CertManagerSection({ objectRef, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  if (!obj) return null;
  const kind = objectRef.kind;
  const view = isKind(kind, CERTIFICATE) ? (
    <CertificateView obj={obj} />
  ) : isKind(kind, CERTIFICATE_REQUEST) ? (
    <RequestView obj={obj} />
  ) : isKind(kind, ISSUER, CLUSTER_ISSUER) ? (
    <IssuerView obj={obj} />
  ) : isKind(kind, ORDER) ? (
    <OrderView obj={obj} />
  ) : isKind(kind, CHALLENGE) ? (
    <ChallengeView obj={obj} />
  ) : null;
  return <Block title={t("details:sections.fields", { kind: kind.kind })}>{view}</Block>;
}

// ---------- The chain ----------

function ChainItem({
  kind,
  obj,
  current,
  children,
}: {
  kind: KindRef;
  obj: KubeObject;
  current: boolean;
  children?: ReactNode;
}) {
  const ns = obj.metadata?.namespace ?? null;
  const name = obj.metadata?.name ?? "";
  const isAcme = isKind(kind, ORDER, CHALLENGE);
  const state = isAcme ? acmeState(obj) : readyStatus(obj);
  const tone = isAcme ? acmeTone(state) : readyTone(state);
  const extra = isKind(kind, CHALLENGE) ? str(get(obj, "spec", "dnsName")) : isAcme ? acmeReason(obj) : readyReason(obj);
  return (
    <li className="cm-chain__item" aria-current={current ? "true" : undefined}>
      <span className="cm-chain__row">
        <span className="cm-chain__kind">{kind.kind}</span>
        {current ? <strong>{name}</strong> : link(typeRef(kind), name, ns)}
        {state && <StatusText value={state} tone={tone} />}
        {extra && <span className="cm-chain__extra">{extra}</span>}
      </span>
      {children}
    </li>
  );
}

/** Certificate → its newest CertificateRequests → their Orders → their Challenges, the opened object marked. */
export function ChainView({
  clusterId,
  kind,
  obj,
}: {
  clusterId: ClusterId;
  kind: KindRef;
  obj: KubeObject;
}) {
  const { t } = useTranslation();
  const namespace = obj.metadata?.namespace ?? null;
  const lists = useChainLists(clusterId, namespace);
  const certName = rootCertificateName(obj, kind, lists.requests, lists.orders);
  const uid = obj.metadata?.uid;
  const isCurrent = (o: KubeObject) => (uid ? o.metadata?.uid === uid : o.metadata?.name === obj.metadata?.name);

  if (!certName) {
    if (lists.loading) return <p className="cm-muted">{t("certmanager:chain.loading")}</p>;
    return <p className="cm-muted">{t("certmanager:chain.noCertificate")}</p>;
  }
  // The Certificate itself is not watched here: a stand-in with its name is enough for the links and the owners.
  const cert: KubeObject = isKind(kind, CERTIFICATE)
    ? obj
    : { apiVersion: CM_API, kind: "Certificate", metadata: { name: certName, namespace: namespace ?? undefined } };
  const all = requestsOf(cert, lists.requests);
  // The newest ones, and always the request the opened object belongs to.
  const holdsCurrent = (r: KubeObject) =>
    isCurrent(r) || ordersOf(r, lists.orders).some((o) => isCurrent(o) || challengesOf(o, lists.challenges).some(isCurrent));
  const shown = all.filter((r, i) => i < CHAIN_REQUESTS || holdsCurrent(r));
  const hidden = all.length - shown.length;

  return (
    <ul className="cm-chain">
      <ChainItem kind={CERTIFICATE} obj={cert} current={isKind(kind, CERTIFICATE)}>
        {shown.length > 0 ? (
          <ul>
            {shown.map((request) => (
              <ChainItem key={request.metadata?.uid ?? request.metadata?.name} kind={CERTIFICATE_REQUEST} obj={request} current={isCurrent(request)}>
                <OrdersOf request={request} lists={lists} isCurrent={isCurrent} />
              </ChainItem>
            ))}
          </ul>
        ) : (
          <p className="cm-muted">{lists.loading ? t("certmanager:chain.loading") : t("certmanager:chain.noRequests")}</p>
        )}
        {hidden > 0 && <p className="cm-muted">{t("certmanager:chain.older", { count: hidden })}</p>}
      </ChainItem>
    </ul>
  );
}

function OrdersOf({
  request,
  lists,
  isCurrent,
}: {
  request: KubeObject;
  lists: ReturnType<typeof useChainLists>;
  isCurrent: (o: KubeObject) => boolean;
}) {
  const orders = ordersOf(request, lists.orders);
  if (orders.length === 0) return null;
  return (
    <ul>
      {orders.map((order) => {
        const challenges = challengesOf(order, lists.challenges);
        return (
          <ChainItem key={order.metadata?.uid ?? order.metadata?.name} kind={ORDER} obj={order} current={isCurrent(order)}>
            {challenges.length > 0 && (
              <ul>
                {challenges.map((c) => (
                  <ChainItem key={c.metadata?.uid ?? c.metadata?.name} kind={CHALLENGE} obj={c} current={isCurrent(c)} />
                ))}
              </ul>
            )}
          </ChainItem>
        );
      })}
    </ul>
  );
}

/** The `certManagerChain` details section. */
export function ChainSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  if (!obj) return null;
  return (
    <Block title={t("certmanager:chain.title")}>
      <ChainView clusterId={clusterId} kind={objectRef.kind} obj={obj} />
    </Block>
  );
}

export const isChainKind = (kind: KindRef) => isKind(kind, CERTIFICATE, CERTIFICATE_REQUEST, ORDER, CHALLENGE);
